#!/usr/bin/env node

const http = require('http');
const { AgentDeckServer, STATUS_PATH } = require('../lib/server');
const { startTunnel } = require('../lib/tunnel');
const { setup, getHookPort } = require('../lib/setup');
const {
  listSessions, sessionExists, createSession,
  nextSessionName, attachSession, isTmuxInstalled,
} = require('../lib/tmux');
const config = require('../lib/config');

const args = process.argv.slice(2);

// ═══════════════════════════════════════════
// Subcommands
// ═══════════════════════════════════════════

// agentdeck setup [--port N] [--ntfy-topic TOPIC] [--no-ntfy]
if (args[0] === 'setup') {
  console.log('');
  console.log('  \u{1F3AE} AgentDeck \u2014 Configuring Claude Code hooks');
  console.log('');
  const cfg = config.load();
  config.mergeCliArgs(cfg, args);
  setup({ port: cfg.port });

  // Auto-generate ntfy topic unless --no-ntfy or already set via --ntfy-topic
  if (!cfg.ntfyTopic && !args.includes('--no-ntfy')) {
    const generated = config.generateNtfyTopic();
    if (generated) {
      cfg.ntfyTopic = generated;
    }
  }

  // Save and display ntfy config
  if (cfg.ntfyTopic) {
    config.save(cfg);
    console.log('');
    console.log(`  \u{1F514} ntfy topic: ${cfg.ntfyTopic}`);
    console.log('  Subscribe to this topic in the ntfy app on your phone.');
    console.log('  https://ntfy.sh');
  } else if (args.includes('--no-ntfy')) {
    console.log('');
    console.log('  \u{1F514} ntfy:       disabled');
  } else {
    console.log('');
    console.log('  \u{1F514} ntfy:       could not auto-detect git email');
    console.log('  Use --ntfy-topic <name> to set a topic manually.');
  }

  process.exit(0);
}

// agentdeck config --agent claude [--port N] [--session name] ...
if (args[0] === 'config') {
  console.log('');
  console.log('  \u{1F3AE} AgentDeck \u2014 Saving configuration');
  console.log('');
  const cfg = config.load();
  config.mergeCliArgs(cfg, args.slice(1));
  config.save(cfg);
  console.log(`  Saved to: ${config.CONFIG_PATH}`);
  console.log('');
  for (const [key, value] of Object.entries(cfg)) {
    if (value !== null && value !== undefined && value !== config.DEFAULTS[key]) {
      console.log(`  ${key}: ${value}`);
    }
  }
  console.log('');
  console.log('  These settings will be used every time you run agentdeck.');
  console.log('  CLI flags always override saved config.');
  console.log('');
  process.exit(0);
}

// agentdeck status — show server info, QR, sessions
if (args[0] === 'status') {
  statusCommand();
  process.exit(0);
}

// agentdeck stop — kill background server, preserve user sessions
if (args[0] === 'stop') {
  stopCommand();
  process.exit(0);
}

// agentdeck help
if (args[0] === 'help' || args.includes('--help')) {
  console.log(`
  \u{1F3AE} AgentDeck \u2014 Mobile control for your coding agents

  Usage:
    agentdeck                           Start server + create session + attach
    agentdeck                           (again) Detect server + new session + attach
    agentdeck status                    Show QR code, PIN, tunnel URL, sessions
    agentdeck stop                      Stop background server (sessions survive)
    agentdeck setup                     Configure hooks + auto-enable phone notifications

  Options:
    --agent <cmd>       Command to launch in sessions (default: claude)
    --port <n>          Server port (default: 3300)
    --pin <n>           Set PIN manually (default: random 4-digit)
    --subdomain <name>  Consistent tunnel URL across restarts
    --no-auth           Disable PIN authentication
    --no-tunnel         Skip localtunnel (use with Tailscale or local network)
    --verbose           Show debug output
    --ntfy-topic <t>    Override auto-generated ntfy topic
    --ntfy-url <url>    ntfy server URL (default: https://ntfy.sh)
    --no-ntfy           Disable ntfy notifications

  How it works:
    1. First run: starts server in background, shows QR code
    2. Creates session (e.g., claude-1) and attaches you
    3. Next run: detects server, creates next session (claude-2), attaches you
    4. Detach with Ctrl+B d to return to your shell
    5. Phone clients auto-update when new sessions appear

  Config:
    agentdeck config --agent claude     Save default agent (or codex, aider, etc.)
    agentdeck config --port 8080        Save custom port
    Config file: ~/.agentdeck/config.json
`);
  process.exit(0);
}

// ═══════════════════════════════════════════
// Internal server mode: agentdeck --_server
// Runs inside the hidden _agentdeck tmux session.
// ═══════════════════════════════════════════

if (args.includes('--_server')) {
  serverMode().catch(err => {
    console.error('  Fatal:', err.message);
    if (args.includes('--verbose')) console.error(err.stack);
    AgentDeckServer.deleteStatus();
    process.exit(1);
  });
}

// ═══════════════════════════════════════════
// Default: Orchestrator mode
// ═══════════════════════════════════════════

else {
  orchestrator().catch(err => {
    console.error('  Fatal:', err.message);
    if (args.includes('--verbose')) console.error(err.stack);
    process.exit(1);
  });
}

// ═══════════════════════════════════════════
// Server mode (--_server)
// ═══════════════════════════════════════════

async function serverMode() {
  const cfg = config.load();
  config.mergeCliArgs(cfg, args);

  // Auto-generate ntfy topic if not configured and not disabled
  if (!cfg.ntfyTopic && !args.includes('--no-ntfy')) {
    cfg.ntfyTopic = config.generateNtfyTopic();
  }

  const server = new AgentDeckServer({
    port: cfg.port,
    pin: cfg.pin,
    noAuth: !cfg.auth,
    verbose: cfg.verbose,
    ntfyTopic: cfg.ntfyTopic,
    ntfyUrl: cfg.ntfyUrl,
  });

  try {
    await server.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`  Error: Port ${cfg.port} is already in use`);
      process.exit(1);
    }
    throw err;
  }

  // Write initial status (no tunnel URL yet)
  server.writeStatus();

  // Start periodic session refresh for phone clients
  server.startSessionRefresh();

  console.log(`  AgentDeck server running on port ${cfg.port} (pid ${process.pid})`);

  // Port mismatch warning
  const hookPort = getHookPort();
  if (hookPort && hookPort !== cfg.port) {
    console.log(`  WARNING: Hooks POST to port ${hookPort}, server on ${cfg.port}`);
    console.log(`  Fix: agentdeck setup --port ${cfg.port}`);
  }

  // Start tunnel
  if (cfg.tunnel) {
    console.log('  Connecting tunnel...');
    const tunnel = await startTunnel(cfg.port, { subdomain: cfg.subdomain });
    if (tunnel) {
      server.setTunnelUrl(tunnel.url);
      console.log(`  Tunnel: ${tunnel.url}`);
    } else {
      console.log('  Tunnel: unavailable (local only)');
      // Re-write status to confirm no tunnel
      server.writeStatus();
    }
  } else {
    // No tunnel — write final status
    server.writeStatus();
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  Shutting down...');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ═══════════════════════════════════════════
// Orchestrator mode (default)
// ═══════════════════════════════════════════

async function orchestrator() {
  const cfg = config.load();
  config.mergeCliArgs(cfg, args);

  // Pre-flight: tmux required
  if (!isTmuxInstalled()) {
    console.error('');
    console.error('  Error: tmux is not installed');
    console.error('  Install it: sudo apt install tmux  (or brew install tmux)');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('  \u{1F3AE} AgentDeck');
  console.log('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('');

  // ── Step 1: Ensure server is running ────
  const serverRunning = await isServerRunning(cfg.port);

  if (!serverRunning) {
    console.log('  Starting server...');

    // Build the command for the hidden tmux session
    const scriptPath = process.argv[1];
    const serverArgs = forwardArgs();
    const serverCmd = `${process.argv[0]} ${scriptPath} --_server ${serverArgs}`;

    createSession('_agentdeck', serverCmd);

    // Wait for server to become healthy
    const healthy = await waitForServer(cfg.port, 20000);
    if (!healthy) {
      console.error('');
      console.error('  Error: Server failed to start within 20s');
      console.error('  Check logs: tmux attach -t _agentdeck');
      console.error('');
      process.exit(1);
    }

    // Wait for tunnel URL to appear in status file
    const status = await waitForTunnel(15000);
    showServerInfo(status);

    // Pause so the user can scan the QR code before the agent takes over
    console.log('  Tip: You can always view this again with: agentdeck status');
    console.log('');
    await waitForEnter('  Press Enter to launch your session...');
    console.log('');
  } else {
    const status = AgentDeckServer.readStatus();
    console.log('  Server already running');
    showServerInfo(status);
  }

  // ── Step 2: Create agent session ───────
  const agent = cfg.agent || 'claude';
  const sessionName = nextSessionName(agent);

  // Retry loop for race condition (two terminals creating simultaneously)
  let created = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const name = attempt === 0 ? sessionName : nextSessionName(agent);
    try {
      createSession(name, agent);
      console.log(`  \u{1F680} Created session: ${name}`);
      console.log('');

      // ── Step 3: Attach to the session ─────
      console.log(`  Attaching to ${name}... (detach: Ctrl+B d)`);
      console.log('');

      attachSession(name);
      created = true;

      // User detached — show hints
      console.log('');
      console.log('  \u{1F44B} Detached from ' + name);
      console.log('');
      console.log('  Quick commands:');
      console.log(`    tmux attach -t ${name}       Re-attach to this session`);
      console.log('    agentdeck                    Create a new session');
      console.log('    agentdeck status             Show QR code and sessions');
      console.log('    agentdeck stop               Stop the background server');
      console.log('');
      break;
    } catch (err) {
      if (attempt < 2 && err.message && err.message.includes('duplicate')) {
        continue; // Try next name
      }
      // If attach fails (e.g., session ended), that's fine
      if (attempt === 0) {
        created = true; // Session was created even if attach failed
        console.log(`  Session ${name} exited.`);
      }
      break;
    }
  }

  if (!created) {
    console.error('  Error: Could not create session');
    process.exit(1);
  }
}

// ═══════════════════════════════════════════
// Status subcommand
// ═══════════════════════════════════════════

function statusCommand() {
  const status = AgentDeckServer.readStatus();

  if (!status) {
    console.log('');
    console.log('  AgentDeck server is not running.');
    console.log('  Run: agentdeck');
    console.log('');
    return;
  }

  // Verify PID is alive
  if (!isPidAlive(status.pid)) {
    AgentDeckServer.deleteStatus();
    console.log('');
    console.log('  AgentDeck server is not running (stale status cleaned up).');
    console.log('  Run: agentdeck');
    console.log('');
    return;
  }

  console.log('');
  console.log('  \u{1F3AE} AgentDeck — Status');
  console.log('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('');
  showServerInfo(status);

  // Show sessions
  const sessions = listSessions();
  if (sessions.length > 0) {
    console.log('  Sessions:');
    for (const s of sessions) {
      const marker = s.isClaude ? ' \u2605' : '';
      const att = s.attached ? ' (attached)' : '';
      console.log(`    ${s.name}${marker}${att}`);
    }
  } else {
    console.log('  No active sessions');
  }
  console.log('');
}

// ═══════════════════════════════════════════
// Stop subcommand
// ═══════════════════════════════════════════

function stopCommand() {
  const status = AgentDeckServer.readStatus();

  if (!status) {
    console.log('');
    console.log('  AgentDeck server is not running.');
    console.log('');
    return;
  }

  console.log('');
  console.log('  Stopping AgentDeck server...');

  // Send SIGTERM to server process
  if (status.pid && isPidAlive(status.pid)) {
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch {}
  }

  // Kill the hidden tmux session
  if (sessionExists('_agentdeck')) {
    try {
      require('child_process').execSync('tmux kill-session -t _agentdeck', {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch {}
  }

  // Clean up status file
  AgentDeckServer.deleteStatus();

  const sessions = listSessions();
  console.log('  Server stopped.');
  if (sessions.length > 0) {
    console.log(`  ${sessions.length} session(s) still running (your work is safe).`);
  }
  console.log('');
}

// ═══════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════

/**
 * Check if the AgentDeck server is running:
 * 1. Read status file
 * 2. Verify PID is alive
 * 3. Health check HTTP endpoint
 */
async function isServerRunning(port) {
  const status = AgentDeckServer.readStatus();
  if (!status) return false;

  // Check PID is alive
  if (!status.pid || !isPidAlive(status.pid)) {
    AgentDeckServer.deleteStatus();
    return false;
  }

  // Health check
  const healthy = await checkHealth(status.port || port);
  if (!healthy) {
    AgentDeckServer.deleteStatus();
    return false;
  }

  return true;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

function checkHealth(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 3000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.app === 'agentdeck');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function waitForServer(port, timeout = 20000) {
  const start = Date.now();
  return new Promise(resolve => {
    const poll = async () => {
      if (Date.now() - start > timeout) return resolve(false);
      const ok = await checkHealth(port);
      if (ok) return resolve(true);
      setTimeout(poll, 500);
    };
    poll();
  });
}

function waitForTunnel(timeout = 15000) {
  const start = Date.now();
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() - start > timeout) {
        // Return whatever we have
        return resolve(AgentDeckServer.readStatus());
      }
      const status = AgentDeckServer.readStatus();
      if (status && status.tunnelUrl) return resolve(status);
      setTimeout(poll, 500);
    };
    // Give the tunnel a moment before first check
    setTimeout(poll, 1000);
  });
}

function showServerInfo(status) {
  if (!status) return;

  const localUrl = `http://localhost:${status.port}`;
  console.log(`  \u{1F4E1} Local:      ${localUrl}`);

  if (status.tunnelUrl) {
    console.log(`  \u{1F310} Tunnel:     ${status.tunnelUrl}`);
  } else {
    console.log('  \u{1F310} Tunnel:     unavailable');
  }

  if (status.pin) {
    console.log(`  \u{1F511} PIN:        ${status.pin}`);
  }

  console.log('');

  // Show QR code
  const connectUrl = status.tunnelUrl || localUrl;
  showQrCode(connectUrl);

  if (status.pin) {
    console.log(`  PIN: ${status.pin}`);
    console.log('');
  }
}

function showQrCode(url) {
  try {
    const qrcode = require('qrcode-terminal');
    console.log('  Scan to connect:');
    console.log('');
    qrcode.generate(url, { small: true }, (qr) => {
      const indented = qr.split('\n').map(line => '  ' + line).join('\n');
      console.log(indented);
    });
  } catch {
    console.log(`  \u{1F4F1} Open on phone: ${url}`);
  }
  console.log('');
}

/**
 * Wait for the user to press Enter.
 */
function waitForEnter(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.once('line', () => { rl.close(); resolve(); });
  });
}

/**
 * Forward relevant CLI args to the --_server process.
 * Excludes subcommands and --_server itself.
 */
function forwardArgs() {
  const skip = new Set(['status', 'stop', 'setup', 'config', 'help', '--_server']);
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    if (skip.has(args[i])) continue;
    forwarded.push(args[i]);
  }
  return forwarded.join(' ');
}
