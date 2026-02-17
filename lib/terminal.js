const pty = require('node-pty');
const { shellEscape } = require('./tmux');

/**
 * Terminal manager — bridges node-pty ↔ tmux sessions.
 *
 * Each TerminalSession wraps a PTY process attached to a tmux session.
 * Multiple WebSocket clients can watch the same session (broadcast),
 * and any client can send input (shared keyboard).
 */

class TerminalSession {
  constructor(sessionName, options = {}) {
    this.sessionName = sessionName;
    this.clients = new Set();
    this.ptyProcess = null;

    // Ring buffer for catch-up on reconnect (last N bytes)
    this.bufferSize = options.bufferSize || 50000;
    this.buffer = Buffer.alloc(0);

    this.cols = options.cols || 80;
    this.rows = options.rows || 24;
  }

  attach() {
    if (this.ptyProcess) return; // Already attached

    this.ptyProcess = pty.spawn('tmux', [
      'attach-session', '-t', shellEscape(this.sessionName)
    ], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    this.ptyProcess.onData(data => {
      this._appendBuffer(data);
      this._broadcast(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.ptyProcess = null;
      // Notify clients the session ended
      for (const client of this.clients) {
        client.onSessionExit?.(this.sessionName, exitCode);
      }
    });
  }

  write(data) {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.ptyProcess) {
      try {
        this.ptyProcess.resize(cols, rows);
      } catch {
        // Resize can fail if PTY is closing
      }
    }
  }

  addClient(client) {
    this.clients.add(client);
    // Send catch-up buffer to new client
    if (this.buffer.length > 0) {
      client.onData?.(this.buffer.toString('utf-8'), true);
    }
  }

  removeClient(client) {
    this.clients.delete(client);
  }

  destroy() {
    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
    this.clients.clear();
  }

  get isAlive() {
    return this.ptyProcess !== null;
  }

  _appendBuffer(data) {
    const chunk = Buffer.from(data, 'utf-8');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Trim to max size (keep tail)
    if (this.buffer.length > this.bufferSize) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.bufferSize);
    }
  }

  _broadcast(data) {
    for (const client of this.clients) {
      client.onData?.(data, false);
    }
  }
}

/**
 * Manages multiple terminal sessions.
 */
class TerminalManager {
  constructor() {
    this.sessions = new Map(); // sessionName → TerminalSession
  }

  getOrCreate(sessionName, options) {
    let session = this.sessions.get(sessionName);
    if (!session) {
      session = new TerminalSession(sessionName, options);
      this.sessions.set(sessionName, session);
    }
    return session;
  }

  get(sessionName) {
    return this.sessions.get(sessionName);
  }

  remove(sessionName) {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.destroy();
      this.sessions.delete(sessionName);
    }
  }

  destroyAll() {
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }
}

module.exports = { TerminalSession, TerminalManager };
