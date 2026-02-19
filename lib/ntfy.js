const https = require('https');
const http = require('http');

/**
 * ntfy push notification client.
 *
 * Uses Node.js built-in https/http modules — no extra dependencies.
 * Sends notifications to ntfy.sh (or a self-hosted instance) with
 * dedup to prevent notification floods.
 */

const DEDUP_WINDOW_MS = 10_000;           // 10s per event type
const IDLE_SUPPRESS_AFTER_PERM_MS = 180_000; // 3min — skip idle if permission was recent

class NtfyClient {
  constructor({ url = 'https://ntfy.sh', topic = null } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.topic = topic;

    // Dedup: track last-sent timestamp per event type
    this._lastSent = {};
  }

  get enabled() {
    return !!this.topic;
  }

  /**
   * Send a permission-request notification (high priority).
   */
  async sendPermission(hookData) {
    if (!this.enabled) return;
    if (this._isDuplicate('permission')) return;

    const tool = hookData?.tool_name || hookData?.toolName || 'Unknown tool';
    const command = hookData?.tool_input?.command
      || hookData?.tool_input?.file_path
      || hookData?.input?.command
      || '';

    const lines = [`Tool: ${tool}`];
    if (command) lines.push(`Command: ${command}`);

    return this._post({
      title: 'Claude Permission',
      message: lines.join('\n'),
      priority: 5,
      tags: 'warning,claude,permission',
    });
  }

  /**
   * Send an idle/notification event (default priority).
   */
  async sendIdle(hookData) {
    if (!this.enabled) return;
    if (this._isDuplicate('idle')) return;

    // Suppress idle if a permission was sent recently
    const lastPerm = this._lastSent['permission'] || 0;
    if (Date.now() - lastPerm < IDLE_SUPPRESS_AFTER_PERM_MS) return;

    const title = hookData?.title || 'Claude Idle';
    const body = hookData?.message || hookData?.body || 'Agent is waiting for input';

    return this._post({
      title,
      message: body,
      priority: 3,
      tags: 'checkered_flag,claude,idle',
    });
  }

  // ── Internal ──────────────────────────────

  _isDuplicate(eventType) {
    const now = Date.now();
    const last = this._lastSent[eventType] || 0;
    if (now - last < DEDUP_WINDOW_MS) return true;
    this._lastSent[eventType] = now;
    return false;
  }

  _post({ title, message, priority, tags }) {
    const topicUrl = `${this.url}/${this.topic}`;
    const parsed = new URL(topicUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const options = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      headers: {
        'Title': title,
        'Priority': String(priority),
        'Tags': tags,
        'Content-Type': 'text/plain',
      },
    };

    return new Promise((resolve) => {
      const req = transport.request(options, (res) => {
        res.resume(); // drain response
        resolve(res.statusCode);
      });

      req.on('error', () => resolve(null)); // never throw
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end(message);
    });
  }
}

module.exports = { NtfyClient };
