const crypto = require('crypto');

/**
 * Claude Code hook handler — NON-BLOCKING design.
 *
 * When Claude Code fires a PermissionRequest hook, the hook script
 * POSTs to our /api/hook endpoint. We:
 *   1. Send a push notification + WebSocket event to the phone
 *   2. IMMEDIATELY respond with { decision: { behavior: "ask" } }
 *      so Claude falls through to its normal terminal prompt
 *   3. If the user taps Allow/Deny on the phone, we send the
 *      corresponding keystroke (y/n + Enter) to the PTY via tmux
 *
 * This means the user can respond EITHER from the phone OR from
 * the terminal — whichever is more convenient. No blocking.
 */

class HookHandler {
  constructor() {
    // Recent permission requests (for display in PWA)
    this.recentRequests = new Map(); // id → { hookData, timestamp }
    this.maxRecent = 50;

    // Callbacks set by server
    this.onPermissionRequest = null; // (id, hookData) => void
    this.onNotification = null;      // (hookData) => void
  }

  /**
   * Handle an incoming hook POST body.
   * Returns the JSON response to send back to the hook script.
   */
  handleHook(hookData) {
    if (!hookData || !hookData.type) {
      return { error: 'Missing hook type' };
    }

    if (hookData.type === 'Notification') {
      this.onNotification?.(hookData);
      // Notifications don't need a response body
      return {};
    }

    if (hookData.type === 'PermissionRequest') {
      const id = crypto.randomUUID();
      const entry = {
        id,
        hookData,
        timestamp: Date.now(),
      };

      this.recentRequests.set(id, entry);
      this._trimRecent();

      // Notify connected clients (PWA + push)
      this.onPermissionRequest?.(id, hookData);

      // NON-BLOCKING: immediately tell Claude to show its normal prompt
      // The user can approve from phone (sends keystroke to PTY) or terminal
      return {
        decision: { behavior: 'ask' },
      };
    }

    return { error: `Unknown hook type: ${hookData.type}` };
  }

  /**
   * Get recent permission requests (for PWA to show on connect).
   */
  getRecent() {
    return Array.from(this.recentRequests.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);
  }

  _trimRecent() {
    if (this.recentRequests.size > this.maxRecent) {
      // Delete oldest entries
      const entries = Array.from(this.recentRequests.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, entries.length - this.maxRecent);
      for (const [key] of toDelete) {
        this.recentRequests.delete(key);
      }
    }
  }
}

module.exports = { HookHandler };
