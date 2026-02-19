/**
 * Claude Code hook handler — non-blocking notification relay.
 *
 * When Claude Code fires a hook, the hook script may POST to
 * our /api/hook endpoint. We simply relay the event to connected
 * WebSocket clients (for in-app toast notifications) and optionally
 * forward to ntfy for phone push notifications.
 *
 * Permission approvals are handled through the terminal UI —
 * user sees the prompt and taps y + Enter via the quick action bar.
 */

class HookHandler {
  constructor() {
    // Callbacks set by server
    this.onNotification = null;      // (hookData) => void
    this.onPermissionRequest = null; // (hookData) => void
  }

  /**
   * Handle an incoming hook POST body.
   * Returns immediately — never blocks.
   */
  handleHook(hookData) {
    if (!hookData) return {};

    const eventName = hookData.hook_event_name || hookData.type;

    if (eventName === 'PermissionRequest') {
      this.onPermissionRequest?.(hookData);
      // Tell Claude Code to show its normal terminal prompt
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'ask' },
        },
      };
    }

    if (eventName === 'Notification') {
      this.onNotification?.(hookData);
    }

    return {};
  }
}

module.exports = { HookHandler };
