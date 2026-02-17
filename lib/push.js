const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

/**
 * Web Push notification manager.
 *
 * Generates VAPID keys on first run, persists them to ~/.agentdeck/.
 * Manages push subscriptions and sends notifications to all registered
 * devices (phones).
 */

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.agentdeck');
const VAPID_PATH = path.join(CONFIG_DIR, 'vapid.json');
const SUBS_PATH = path.join(CONFIG_DIR, 'subscriptions.json');

class PushManager {
  constructor() {
    this.subscriptions = [];
    this.vapidKeys = null;
    this._init();
  }

  _init() {
    // Ensure config directory exists
    fs.mkdirSync(CONFIG_DIR, { recursive: true });

    // Load or generate VAPID keys
    if (fs.existsSync(VAPID_PATH)) {
      this.vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf-8'));
    } else {
      this.vapidKeys = webpush.generateVAPIDKeys();
      fs.writeFileSync(VAPID_PATH, JSON.stringify(this.vapidKeys, null, 2));
    }

    webpush.setVapidDetails(
      'mailto:agentdeck@example.com',
      this.vapidKeys.publicKey,
      this.vapidKeys.privateKey
    );

    // Load existing subscriptions
    if (fs.existsSync(SUBS_PATH)) {
      try {
        this.subscriptions = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf-8'));
      } catch {
        this.subscriptions = [];
      }
    }
  }

  getPublicKey() {
    return this.vapidKeys.publicKey;
  }

  subscribe(subscription) {
    // Deduplicate by endpoint
    const existing = this.subscriptions.findIndex(
      s => s.endpoint === subscription.endpoint
    );
    if (existing >= 0) {
      this.subscriptions[existing] = subscription;
    } else {
      this.subscriptions.push(subscription);
    }
    this._save();
  }

  async sendNotification(payload) {
    if (this.subscriptions.length === 0) return;

    const body = JSON.stringify(payload);
    const failed = [];

    await Promise.allSettled(
      this.subscriptions.map(async (sub, i) => {
        try {
          await webpush.sendNotification(sub, body);
        } catch (err) {
          // 410 Gone or 404 = subscription expired
          if (err.statusCode === 410 || err.statusCode === 404) {
            failed.push(i);
          }
        }
      })
    );

    // Remove expired subscriptions
    if (failed.length > 0) {
      this.subscriptions = this.subscriptions.filter(
        (_, i) => !failed.includes(i)
      );
      this._save();
    }
  }

  /**
   * Send permission request notification.
   * Minimal data — no source code or secrets.
   */
  async sendPermissionNotification(id, hookData) {
    const toolName = hookData.tool_name || hookData.tool || 'Unknown tool';
    const input = hookData.tool_input || hookData.input || {};
    // Extract a short summary — just the command or file path
    const summary = input.command || input.file_path || toolName;

    await this.sendNotification({
      type: 'permission_request',
      id,
      title: `Agent wants to use: ${toolName}`,
      body: truncate(summary, 100),
      actions: [
        { action: 'allow', title: '\u2713 Allow' },
        { action: 'deny', title: '\u2717 Deny' },
      ],
    });
  }

  async sendInfoNotification(title, body) {
    await this.sendNotification({
      type: 'notification',
      title,
      body: truncate(body, 200),
    });
  }

  _save() {
    try {
      fs.writeFileSync(SUBS_PATH, JSON.stringify(this.subscriptions, null, 2));
    } catch {
      // Non-critical
    }
  }
}

function truncate(str, max) {
  if (!str) return '';
  str = String(str);
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

module.exports = { PushManager };
