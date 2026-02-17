const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Auth } = require('./auth');
const { TerminalManager } = require('./terminal');
const { HookHandler } = require('./hooks');
const { PushManager } = require('./push');
const { listSessions } = require('./tmux');
const proto = require('./protocol');

/**
 * AgentDeck server — HTTP + WebSocket.
 *
 * Uses Node.js built-in http module (no Express).
 * Serves static files, handles API routes, and manages WebSocket
 * connections for terminal streaming and structured events.
 */

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

class AgentDeckServer {
  constructor(options = {}) {
    this.port = options.port || 3300;
    this.verbose = options.verbose || false;

    // Core modules
    this.auth = new Auth({
      pin: options.pin,
      disabled: options.noAuth,
    });
    this.terminals = new TerminalManager();
    this.hooks = new HookHandler();
    this.push = new PushManager();

    // Track connected WebSocket clients
    this.clients = new Set();

    // Wire up hook callbacks
    this.hooks.onPermissionRequest = (id, hookData) => {
      this._broadcastToClients(proto.permissionRequest(id, hookData));
      this.push.sendPermissionNotification(id, hookData).catch(() => {});
    };

    this.hooks.onNotification = (hookData) => {
      const title = hookData.title || 'Claude Code';
      const body = hookData.message || hookData.body || '';
      this._broadcastToClients(proto.notification(title, body));
      this.push.sendInfoNotification(title, body).catch(() => {});
    };

    // Create HTTP server
    this.server = http.createServer((req, res) => this._handleHTTP(req, res));

    // Create WebSocket server
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    this.terminals.destroyAll();
    for (const client of this.clients) {
      client.ws.close();
    }
    return new Promise(resolve => this.server.close(resolve));
  }

  // ═══════════════════════════════════════════
  // HTTP Request Handler
  // ═══════════════════════════════════════════

  async _handleHTTP(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (this.verbose) {
      console.log(`  ${req.method} ${pathname}`);
    }

    // CORS headers for localtunnel
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API routes
      if (pathname === '/api/auth' && req.method === 'POST') {
        return this._handleAuth(req, res);
      }
      if (pathname === '/api/sessions' && req.method === 'GET') {
        return this._handleSessions(req, res);
      }
      if (pathname === '/api/hook' && req.method === 'POST') {
        return this._handleHook(req, res);
      }
      if (pathname === '/api/hook/decide' && req.method === 'POST') {
        return this._handleHookDecide(req, res);
      }
      if (pathname === '/api/push/vapid-key' && req.method === 'GET') {
        return this._handleVapidKey(req, res);
      }
      if (pathname === '/api/push/subscribe' && req.method === 'POST') {
        return this._handlePushSubscribe(req, res);
      }

      // Static files
      if (pathname.startsWith('/public/') || pathname === '/') {
        return this._serveStatic(req, res, pathname);
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error('  HTTP error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  // ── Auth ────────────────────────────────────

  async _handleAuth(req, res) {
    const body = await readJSON(req);
    const token = this.auth.createToken(body.pin);

    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid PIN' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token }));
  }

  // ── Sessions ────────────────────────────────

  _handleSessions(req, res) {
    if (!this.auth.check(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const sessions = listSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  }

  // ── Hook (from Claude Code — localhost only) ─

  async _handleHook(req, res) {
    // Only accept from localhost
    const remoteAddr = req.socket.remoteAddress;
    if (!isLocalhost(remoteAddr)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Hooks only accepted from localhost' }));
      return;
    }

    const body = await readJSON(req);
    const result = this.hooks.handleHook(body);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // ── Hook Decide (from Service Worker notification action) ─

  async _handleHookDecide(req, res) {
    const body = await readJSON(req);
    const { id, behavior } = body;

    if (!id || !behavior) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id or behavior' }));
      return;
    }

    // In our non-blocking design, deciding from push means sending
    // the keystroke to the terminal. The server handles this via the
    // _handleDecision method.
    this._handleDecision(id, behavior);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  // ── Push ────────────────────────────────────

  _handleVapidKey(req, res) {
    if (!this.auth.check(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: this.push.getPublicKey() }));
  }

  async _handlePushSubscribe(req, res) {
    if (!this.auth.check(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const subscription = await readJSON(req);
    this.push.subscribe(subscription);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  // ── Static Files ────────────────────────────

  _serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/public/index.html';

    const publicDir = path.join(__dirname, '..', 'public');
    const filePath = path.join(publicDir, pathname.replace(/^\/public\/?/, ''));

    // Prevent directory traversal
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Cache static assets (not HTML)
    if (ext !== '.html') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  }

  // ═══════════════════════════════════════════
  // WebSocket Handler
  // ═══════════════════════════════════════════

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Verify auth token
    const token = url.searchParams.get('token');
    if (!this.auth.disabled && !this.auth.validateToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this._onWebSocketConnection(ws, req);
    });
  }

  _onWebSocketConnection(ws, req) {
    const client = {
      ws,
      sessionName: null,
      // Callbacks for terminal events
      onData: (data, isCatchup) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(proto.terminalOutput(data, isCatchup));
        }
      },
      onSessionExit: (name, code) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(proto.notification('Session ended', `${name} exited (code ${code})`));
        }
      },
    };

    this.clients.add(client);
    if (this.verbose) console.log(`  WS connected (${this.clients.size} clients)`);

    // Send available sessions
    const sessions = listSessions();
    ws.send(proto.sessionsList(sessions));

    // Auto-attach to first Claude session if available
    const claudeSession = sessions.find(s => s.isClaude);
    if (claudeSession) {
      this._attachClient(client, claudeSession.name);
    }

    ws.on('message', (raw) => {
      const msg = proto.parse(raw.toString());
      if (!msg) return;
      this._handleWSMessage(client, msg);
    });

    ws.on('close', () => {
      this._detachClient(client);
      this.clients.delete(client);
      if (this.verbose) console.log(`  WS disconnected (${this.clients.size} clients)`);
    });

    ws.on('error', () => {
      this._detachClient(client);
      this.clients.delete(client);
    });
  }

  _handleWSMessage(client, msg) {
    switch (msg.type) {
      case 'terminal_input':
        if (client.sessionName) {
          const session = this.terminals.get(client.sessionName);
          if (session) session.write(msg.data);
        }
        break;

      case 'terminal_resize':
        if (client.sessionName && msg.cols && msg.rows) {
          const session = this.terminals.get(client.sessionName);
          if (session) session.resize(msg.cols, msg.rows);
        }
        break;

      case 'attach':
        if (msg.session) {
          this._detachClient(client);
          this._attachClient(client, msg.session);
        }
        break;

      case 'detach':
        this._detachClient(client);
        client.ws.send(proto.detached());
        break;

      case 'decision':
        // User tapped Allow/Deny on phone — send keystroke to terminal
        this._handleDecision(msg.id, msg.behavior);
        break;

      case 'push_subscribe':
        if (msg.subscription) {
          this.push.subscribe(msg.subscription);
        }
        break;

      default:
        if (this.verbose) console.log(`  Unknown WS message type: ${msg.type}`);
    }
  }

  _attachClient(client, sessionName) {
    const session = this.terminals.getOrCreate(sessionName);

    // Start PTY if not already running
    if (!session.isAlive) {
      session.attach();
    }

    session.addClient(client);
    client.sessionName = sessionName;
    client.ws.send(proto.attached(sessionName));
  }

  _detachClient(client) {
    if (client.sessionName) {
      const session = this.terminals.get(client.sessionName);
      if (session) {
        session.removeClient(client);
        // Don't destroy session when last client disconnects — keep PTY alive
      }
      client.sessionName = null;
    }
  }

  /**
   * Handle a permission decision from the phone.
   *
   * In our non-blocking design, the hook already returned "ask" to Claude,
   * so Claude is showing its normal terminal prompt. We send the appropriate
   * keystroke (y + Enter for allow, n + Enter for deny) to the PTY.
   */
  _handleDecision(id, behavior) {
    // Broadcast to all clients that this permission was resolved
    this._broadcastToClients(proto.permissionResolved(id, behavior));

    // Send keystroke to ALL active terminal sessions
    // (The active Claude session will receive the y/n input)
    for (const session of this.terminals.sessions.values()) {
      if (session.isAlive) {
        if (behavior === 'allow') {
          session.write('y');
        } else {
          session.write('n');
        }
      }
    }
  }

  _broadcastToClients(message) {
    for (const client of this.clients) {
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(message);
      }
    }
  }
}

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function isLocalhost(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

module.exports = { AgentDeckServer };
