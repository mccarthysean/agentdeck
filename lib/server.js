const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Auth } = require('./auth');
const { TerminalManager } = require('./terminal');
const { HookHandler } = require('./hooks');
const { NtfyClient } = require('./ntfy');
const { PushManager } = require('./push');
const { listSessions } = require('./tmux');
const proto = require('./protocol');

const STATUS_DIR = path.join(process.env.HOME || '/tmp', '.agentdeck');
const STATUS_PATH = path.join(STATUS_DIR, 'status.json');

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
    this.ntfy = new NtfyClient({ url: options.ntfyUrl, topic: options.ntfyTopic });
    this.push = new PushManager();

    // Track connected WebSocket clients
    this.clients = new Set();
    this.tunnelUrl = null;
    this._refreshInterval = null;

    // Wire up hook callbacks
    this.hooks.onPermissionRequest = (hookData) => {
      const tool = hookData?.tool_name || hookData?.toolName || 'Tool';
      this._broadcastToClients(proto.notification('Permission Request', `${tool} needs approval`));
      this.push.sendInfoNotification('Permission Request', `${tool} needs approval`).catch(() => {});
      this.ntfy.sendPermission(hookData).catch(() => {});
    };

    this.hooks.onNotification = (hookData) => {
      const title = hookData.title || 'Claude Code';
      const body = hookData.message || hookData.body || '';
      this._broadcastToClients(proto.notification(title, body));
      this.push.sendInfoNotification(title, body).catch(() => {});
      this.ntfy.sendIdle(hookData).catch(() => {});
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
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
    this.terminals.destroyAll();
    for (const client of this.clients) {
      client.ws.close();
    }
    AgentDeckServer.deleteStatus();
    return new Promise(resolve => this.server.close(resolve));
  }

  /** Store tunnel URL and update status file. */
  setTunnelUrl(url) {
    this.tunnelUrl = url;
    this.writeStatus();
  }

  /** Write server status to ~/.agentdeck/status.json for orchestrator IPC. */
  writeStatus() {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const data = {
      pid: process.pid,
      port: this.port,
      tunnelUrl: this.tunnelUrl || null,
      pin: this.auth.pin || null,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATUS_PATH, JSON.stringify(data, null, 2) + '\n');
  }

  static readStatus() {
    try {
      return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8'));
    } catch {
      return null;
    }
  }

  static deleteStatus() {
    try { fs.unlinkSync(STATUS_PATH); } catch {}
  }

  /** Broadcast session list to all connected clients every 5s. */
  startSessionRefresh() {
    if (this._refreshInterval) return;
    this._refreshInterval = setInterval(() => {
      const sessions = listSessions();
      const msg = proto.sessionsList(sessions);
      for (const client of this.clients) {
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(msg);
        }
      }
    }, 5000);
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
      // Health check — localhost only, no auth
      if (pathname === '/api/health' && req.method === 'GET') {
        if (!isLocalhost(req.socket.remoteAddress)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Localhost only' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ app: 'agentdeck' }));
        return;
      }

      // API routes
      if (pathname === '/api/auth' && (req.method === 'POST' || req.method === 'GET')) {
        return this._handleAuth(req, res, url);
      }
      if (pathname === '/api/sessions' && req.method === 'GET') {
        return this._handleSessions(req, res);
      }
      if (pathname === '/api/hook' && req.method === 'POST') {
        return this._handleHook(req, res);
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

  async _handleAuth(req, res, url) {
    // Accept PIN from query param (GET) or JSON body (POST)
    let pin;
    if (req.method === 'GET') {
      pin = url.searchParams.get('pin');
    } else {
      const body = await readJSON(req);
      pin = body.pin;
    }
    const token = this.auth.createToken(pin);

    if (!token) {
      const errBody = JSON.stringify({ error: 'Invalid PIN' });
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errBody),
      });
      res.end(errBody);
      return;
    }

    const resBody = JSON.stringify({ token });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(resBody),
    });
    res.end(resBody);
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

    const resBody = JSON.stringify(result);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(resBody),
    });
    res.end(resBody);
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

    // Cache static assets (not HTML or JS — JS changes frequently during development)
    if (ext !== '.html' && ext !== '.js') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
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
    if (this.verbose) console.log('  WS upgrade, token:', token ? token.substring(0, 12) + '...' : 'none');

    if (!this.auth.disabled && !this.auth.validateToken(token)) {
      if (this.verbose) console.log('  WS auth failed — rejecting');
      // Complete the WebSocket handshake first, then close with proper code
      // so the browser gets a clean close event with code 4001
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(4001, 'Invalid token');
      });
      return;
    }

    if (this.verbose) console.log('  WS auth OK');
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

    // Auto-attach to a session — prefer Claude, fall back to any
    const targetSession = sessions.find(s => s.isClaude) || sessions[0];
    if (targetSession) {
      this._attachClient(client, targetSession.name);
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

module.exports = { AgentDeckServer, STATUS_PATH };
