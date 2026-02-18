/**
 * WebSocket message protocol for AgentDeck.
 *
 * All messages are JSON with a `type` field.
 * Helper functions for creating typed messages.
 */

// ═══════════════════════════════════════════
// Client → Server message types
// ═══════════════════════════════════════════
// terminal_input   { data: string }            Keystrokes to send to PTY
// terminal_resize  { cols: number, rows: number }  Resize PTY
// attach           { session: string }         Attach to tmux session
// detach           {}                          Detach from current session
// push_subscribe   { subscription: PushSubscription }  Register push

// ═══════════════════════════════════════════
// Server → Client message types
// ═══════════════════════════════════════════

function terminalOutput(data, isCatchup = false) {
  return JSON.stringify({
    type: isCatchup ? 'terminal_catchup' : 'terminal_output',
    data,
  });
}

function sessionsList(sessions) {
  return JSON.stringify({ type: 'sessions', sessions });
}

function attached(sessionName) {
  return JSON.stringify({ type: 'attached', session: sessionName });
}

function detached() {
  return JSON.stringify({ type: 'detached' });
}

function notification(title, body) {
  return JSON.stringify({ type: 'notification', title, body });
}

function error(message) {
  return JSON.stringify({ type: 'error', message });
}

function parse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  terminalOutput,
  sessionsList,
  attached,
  detached,
  notification,
  error,
  parse,
};
