// ═══════════════════════════════════════════
// AgentDeck — Mobile PWA Frontend
// ═══════════════════════════════════════════

// Global error handler — shows errors on screen for mobile debugging
window.onerror = function(msg, url, line) {
  console.error('AgentDeck error:', msg, 'line', line);
};

// Section 1: State Management
// ═══════════════════════════════════════════
var state = {
  token: localStorage.getItem('agentdeck-token'),
  ws: null,
  terminal: null,
  fitAddon: null,
  currentSession: null,
  _lastSessionList: '',
  pendingPermissions: new Map(),
  reconnectAttempts: 0,
  maxReconnectAttempts: 15,
  reconnectTimer: null,
  hasConnected: false,  // true after first successful WebSocket open
};

// ═══════════════════════════════════════════
// Section 2: Authentication
// ═══════════════════════════════════════════

async function authenticate(pin) {
  var btn = document.getElementById('auth-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 10000);

    var res = await fetch('/api/auth?pin=' + encodeURIComponent(pin), {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      var errText = await res.text();
      throw new Error(res.status === 401 ? 'Invalid PIN' : 'Server error: ' + res.status);
    }

    var data = await res.json();
    if (!data.token) {
      throw new Error('No token in response');
    }

    state.token = data.token;
    localStorage.setItem('agentdeck-token', data.token);
    // Close any stale WebSocket before switching to app
    if (state.ws) {
      try { state.ws.onclose = null; state.ws.close(); } catch(_) {}
      state.ws = null;
    }
    state.hasConnected = false;
    state.reconnectAttempts = 0;
    showApp();
    return true;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Connect';
    var msg = err.name === 'AbortError' ? 'Request timed out — server not responding' : (err.message || 'Connection failed');
    showAuthError(msg);
    return false;
  }
}

function showApp() {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app').hidden = false;

  if (typeof Terminal !== 'undefined') {
    initTerminal();
  }

  connect();
  setupActionBar();
  setupTextInput();
  setupKeyboardHandler();
}

function showAuth() {
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app').hidden = true;
  // Reset button state
  var btn = document.getElementById('auth-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function showAuthError(message) {
  const el = document.getElementById('auth-error');
  el.textContent = message;
  el.hidden = false;
  // Shake animation
  const input = document.getElementById('pin-input');
  input.style.animation = 'none';
  input.offsetHeight; // Reflow
  input.style.animation = 'shake 0.4s ease-in-out';
  input.value = '';
  input.focus();
}

function authHeaders() {
  return { 'Authorization': 'Bearer ' + state.token };
}

// ═══════════════════════════════════════════
// Section 3: Terminal Setup (xterm.js)
// ═══════════════════════════════════════════

function initTerminal() {
  if (state.terminal) return;

  state.terminal = new Terminal({
    theme: {
      background: '#000000',
      foreground: '#d4d4d8',
      cursor: '#a78bfa',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(167, 139, 250, 0.3)',
      selectionForeground: '#ffffff',
      // ANSI colors (Catppuccin-inspired)
      black: '#1e1e2e',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#cba6f7',
      cyan: '#94e2d5',
      white: '#cdd6f4',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#cba6f7',
      brightCyan: '#94e2d5',
      brightWhite: '#ffffff',
    },
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: true,
    convertEol: true,
  });

  state.fitAddon = new FitAddon.FitAddon();
  state.terminal.loadAddon(state.fitAddon);

  if (typeof WebLinksAddon !== 'undefined') {
    state.terminal.loadAddon(new WebLinksAddon.WebLinksAddon());
  }

  const container = document.getElementById('terminal-container');
  state.terminal.open(container);
  state.fitAddon.fit();

  // Send keystrokes to server
  state.terminal.onData(function(data) {
    sendMessage({ type: 'terminal_input', data: data });
  });
}

// ═══════════════════════════════════════════
// Section 4: WebSocket Connection
// ═══════════════════════════════════════════

function connect() {
  // Close any existing connection first
  if (state.ws) {
    if (state.ws.readyState === WebSocket.OPEN) return; // already connected
    try { state.ws.onclose = null; state.ws.onerror = null; state.ws.close(); } catch(_) {}
    state.ws = null;
  }

  setConnectionStatus('connecting');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = protocol + '//' + location.host + '/ws?token=' + state.token;

  state.ws = new WebSocket(url);

  state.ws.onopen = function() {
    setConnectionStatus('connected');
    state.reconnectAttempts = 0;
    state.hasConnected = true;
    hideReconnectOverlay();

    // Request resize to match terminal dimensions
    if (state.fitAddon) {
      state.fitAddon.fit();
      var dims = state.fitAddon.proposeDimensions();
      if (dims) {
        sendMessage({ type: 'terminal_resize', cols: dims.cols, rows: dims.rows });
      }
    }
  };

  state.ws.onclose = function(e) {
    setConnectionStatus('disconnected');

    // Auth failure — code 4001, 1008, or never successfully connected (stale token)
    if (e.code === 1008 || e.code === 4001 || (!state.hasConnected && e.code !== 1000)) {
      localStorage.removeItem('agentdeck-token');
      state.token = null;
      // Reset terminal state so fresh login works
      if (state.terminal) {
        state.terminal.dispose();
        state.terminal = null;
        state.fitAddon = null;
      }
      hideReconnectOverlay();
      showAuth();
      showAuthError('Session expired — enter PIN again');
      return;
    }

    // Auto-reconnect with exponential backoff
    if (state.reconnectAttempts < state.maxReconnectAttempts) {
      var delay = Math.min(1000 * Math.pow(1.5, state.reconnectAttempts), 30000);
      state.reconnectAttempts++;
      showReconnectOverlay();
      state.reconnectTimer = setTimeout(connect, delay);
    }
  };

  state.ws.onmessage = function(e) {
    var msg;
    try {
      msg = JSON.parse(e.data);
    } catch (_) {
      return;
    }
    handleMessage(msg);
  };

  state.ws.onerror = function() {
    // onclose will fire after this
  };
}

function sendMessage(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'terminal_output':
      handleTerminalOutput(msg);
      break;
    case 'terminal_catchup':
      handleTerminalCatchup(msg);
      break;
    case 'sessions':
      handleSessions(msg);
      break;
    case 'attached':
      handleAttached(msg);
      break;
    case 'detached':
      handleDetached();
      break;
    case 'permission_request':
      handlePermissionRequest(msg);
      break;
    case 'permission_resolved':
      handlePermissionResolved(msg);
      break;
    case 'notification':
      handleNotification(msg);
      break;
    case 'error':
      handleError(msg);
      break;
  }
}

// ── Message Handlers ────────────────────

function handleTerminalOutput(msg) {
  if (state.terminal && msg.data) {
    state.terminal.write(msg.data);
  }
}

function handleTerminalCatchup(msg) {
  if (state.terminal && msg.data) {
    // Clear terminal first, then write catch-up, then request a redraw
    state.terminal.clear();
    state.terminal.write(msg.data);
    // Ask tmux to redraw the screen (Ctrl+L equivalent sent to PTY)
    sendMessage({ type: 'terminal_input', data: '\x0c' });
  }
}

function handleSessions(msg) {
  // Skip DOM rebuild if session list hasn't changed
  var names = (msg.sessions || []).map(function(s) { return s.name; }).join(',');
  if (names === state._lastSessionList) return;
  state._lastSessionList = names;

  var picker = document.getElementById('session-picker');
  picker.innerHTML = '';

  if (!msg.sessions || msg.sessions.length === 0) {
    picker.innerHTML = '<option value="">No sessions</option>';
    return;
  }

  msg.sessions.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name + (s.isClaude ? ' \u2605' : '');
    if (s.name === state.currentSession) {
      opt.selected = true;
    }
    picker.appendChild(opt);
  });
}

function handleAttached(msg) {
  state.currentSession = msg.session;
  var picker = document.getElementById('session-picker');
  for (var i = 0; i < picker.options.length; i++) {
    if (picker.options[i].value === msg.session) {
      picker.selectedIndex = i;
      break;
    }
  }
}

function handleDetached() {
  state.currentSession = null;
}

function handlePermissionRequest(msg) {
  state.pendingPermissions.set(msg.id, msg);
  showPermissionCard(msg);
}

function handlePermissionResolved(msg) {
  state.pendingPermissions.delete(msg.id);
  // If no more pending, hide card
  if (state.pendingPermissions.size === 0) {
    hidePermissionCard();
  }
}

function handleNotification(msg) {
  showToast(msg.title || 'Notification', msg.body || '');
}

function handleError(msg) {
  showToast('Error', msg.message || 'Unknown error');
}

// ═══════════════════════════════════════════
// Section 5: Permission Card UI
// ═══════════════════════════════════════════

function showPermissionCard(msg) {
  var card = document.getElementById('permission-card');
  var toolName = msg.data ? msg.data.tool_name : 'Unknown';
  document.getElementById('permission-tool').textContent = toolName;

  // Format tool input
  var input = msg.data ? msg.data.tool_input : {};
  var detail;
  if (typeof input === 'object') {
    detail = input.command || input.file_path || JSON.stringify(input, null, 2);
  } else {
    detail = String(input);
  }
  document.getElementById('permission-detail').textContent = detail;

  // Store current permission ID on buttons
  card.dataset.permissionId = msg.id;

  card.hidden = false;
  requestAnimationFrame(function() {
    card.classList.add('visible');
  });

  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(50);
}

function hidePermissionCard() {
  var card = document.getElementById('permission-card');
  card.classList.remove('visible');
  setTimeout(function() { card.hidden = true; }, 300);
}

function decide(behavior) {
  var card = document.getElementById('permission-card');
  var id = card.dataset.permissionId;
  if (id) {
    sendMessage({ type: 'decision', id: id, behavior: behavior });
    state.pendingPermissions.delete(id);
  }
  hidePermissionCard();
}

// ═══════════════════════════════════════════
// Section 6: Quick Action Bar
// ═══════════════════════════════════════════

function setupActionBar() {
  document.querySelectorAll('.action-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.dataset.input) {
        sendMessage({ type: 'terminal_input', data: btn.dataset.input });
      } else if (btn.dataset.key === 'Enter') {
        sendMessage({ type: 'terminal_input', data: '\r' });
      } else if (btn.dataset.key === 'Escape') {
        sendMessage({ type: 'terminal_input', data: '\x1b' });
      } else if (btn.dataset.ctrl) {
        var code = btn.dataset.ctrl.charCodeAt(0) - 96; // ctrl+c = 0x03
        sendMessage({ type: 'terminal_input', data: String.fromCharCode(code) });
      }
      if (navigator.vibrate) navigator.vibrate(25);
    });
  });
}

// ═══════════════════════════════════════════
// Section 7: Text Input
// ═══════════════════════════════════════════

function setupTextInput() {
  var input = document.getElementById('text-input');
  var sendBtn = document.getElementById('send-btn');

  function send() {
    var text = input.value;
    if (!text) return;
    input.value = '';
    // Send text first, then Enter separately — more reliable with agents
    // that process input character-by-character
    sendMessage({ type: 'terminal_input', data: text });
    setTimeout(function() {
      sendMessage({ type: 'terminal_input', data: '\r' });
    }, 30);
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      sendMessage({ type: 'terminal_input', data: '\t' });
    }
  });
}

// ═══════════════════════════════════════════
// Section 8: Session Picker
// ═══════════════════════════════════════════

function setupSessionPicker() {
  var picker = document.getElementById('session-picker');
  picker.addEventListener('change', function() {
    var sessionName = picker.value;
    if (sessionName) {
      sendMessage({ type: 'attach', session: sessionName });
    }
  });
}

// ═══════════════════════════════════════════
// Section 9: Push Notifications
// ═══════════════════════════════════════════

// Unregister any existing service workers to stop stale push notifications.
// Push notifications are disabled — ntfy handles phone notifications instead.
async function cleanupServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  try {
    var regs = await navigator.serviceWorker.getRegistrations();
    for (var reg of regs) {
      await reg.unregister();
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════
// Section 10: Virtual Keyboard Handling
// ═══════════════════════════════════════════

function setupKeyboardHandler() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      var vv = window.visualViewport;
      var keyboardHeight = window.innerHeight - vv.height;
      document.documentElement.style.setProperty('--keyboard-height', keyboardHeight + 'px');
      if (state.fitAddon) {
        state.fitAddon.fit();
      }
    });
  }
}

// ═══════════════════════════════════════════
// Section 11: UI Helpers
// ═══════════════════════════════════════════

function setConnectionStatus(status) {
  var dot = document.getElementById('connection-status');
  dot.className = 'connection-dot';
  if (status === 'connected') {
    dot.classList.add('connected');
    dot.title = 'Connected';
  } else if (status === 'connecting') {
    dot.classList.add('connecting');
    dot.title = 'Connecting...';
  } else {
    dot.title = 'Disconnected';
  }
}

function showReconnectOverlay() {
  var overlay = document.getElementById('reconnect-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'reconnect-overlay';
    overlay.innerHTML = '<div class="reconnect-message"><div class="spinner"></div><p>Reconnecting...</p></div>';
    document.getElementById('app').appendChild(overlay);
  }
  requestAnimationFrame(function() { overlay.classList.add('visible'); });
}

function hideReconnectOverlay() {
  var overlay = document.getElementById('reconnect-overlay');
  if (overlay) {
    overlay.classList.remove('visible');
  }
}

var toastTimer = null;
function showToast(title, body) {
  var existing = document.querySelector('.toast');
  if (existing) existing.remove();

  var toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = '<strong>' + escapeHtml(title) + '</strong> ' + escapeHtml(body);
  document.body.appendChild(toast);

  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      toast.classList.add('visible');
    });
  });

  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    toast.classList.remove('visible');
    setTimeout(function() { toast.remove(); }, 300);
  }, 4000);
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ═══════════════════════════════════════════
// Section 12: Initialization
// ═══════════════════════════════════════════

function init() {
  // Auth screen handlers
  document.getElementById('auth-btn').addEventListener('click', function() {
    var pin = document.getElementById('pin-input').value;
    authenticate(pin);
  });

  document.getElementById('pin-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      authenticate(e.target.value);
    }
  });

  // Permission card handlers
  document.getElementById('btn-allow').addEventListener('click', function() {
    decide('allow');
  });
  document.getElementById('btn-deny').addEventListener('click', function() {
    decide('deny');
  });
  document.getElementById('permission-close').addEventListener('click', function() {
    hidePermissionCard();
  });

  // Session picker
  setupSessionPicker();

  // Clean up any stale push notification subscriptions
  cleanupServiceWorkers();

  // Check for existing token
  if (state.token) {
    showApp();
  } else {
    showAuth();
  }

  // Handle window resize
  window.addEventListener('resize', function() {
    if (state.fitAddon) {
      state.fitAddon.fit();
      // Send new dimensions to server
      var dims = state.fitAddon.proposeDimensions();
      if (dims) {
        sendMessage({ type: 'terminal_resize', cols: dims.cols, rows: dims.rows });
      }
    }
  });

  // Reconnect when app comes to foreground
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
      state.reconnectAttempts = 0;
      connect();
    }
  });
}

// Add shake animation to stylesheet
var shakeStyle = document.createElement('style');
shakeStyle.textContent = '@keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-8px); } 75% { transform: translateX(8px); } }';
document.head.appendChild(shakeStyle);

document.addEventListener('DOMContentLoaded', init);
