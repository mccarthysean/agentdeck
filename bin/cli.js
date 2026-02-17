#!/usr/bin/env node

const { AgentDeckServer } = require('../lib/server');
const { startTunnel } = require('../lib/tunnel');
const { setup } = require('../lib/setup');
const { listSessions, sessionExists, createSession } = require('../lib/tmux');
const config = require('../lib/config');

const args = process.argv.slice(2);

// ═══════════════════════════════════════════
// Subcommands
// ═══════════════════════════════════════════

// agentdeck setup [--port N]
if (args[0] === 'setup') {
  console.log('');
  console.log('  \u{1F3AE} AgentDeck \u2014 Configuring Claude Code hooks');
  console.log('');
  const cfg = config.load();
  config.mergeCliArgs(cfg, args);
  setup({ port: cfg.port });
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

// agentdeck help
if (args[0] === 'help' || args.includes('--help')) {
  console.log(`
  \u{1F3AE} AgentDeck \u2014 Mobile control for your coding agents

  Usage:
    agentdeck                           Start everything (server + tunnel + agent)
    agentdeck --agent claude            Start and launch "claude" in tmux
    agentdeck setup                     Auto-configure Claude Code hooks
    agentdeck config --agent claude     Save default agent (persists across runs)

  Options:
    --agent <cmd>       Command to launch in tmux (e.g., claude, aider, cursor)
    --session <name>    tmux session name (default: agent)
    --port <n>          Server port (default: 3300)
    --pin <n>           Set PIN manually (default: random 4-digit)
    --subdomain <name>  Consistent tunnel URL across restarts
    --no-auth           Disable PIN authentication
    --no-tunnel         Skip localtunnel (use with Tailscale or local network)
    --verbose           Show debug output

  Config:
    agentdeck config --agent claude     Save "claude" as your default agent
    agentdeck config --port 8080        Save custom port
    Config file: ~/.agentdeck/config.json

  Examples:
    agentdeck                           # Auto-detects running agent or starts configured one
    agentdeck --agent claude            # Launches Claude Code, shows QR, ready to scan
    agentdeck --agent aider             # Works with any terminal agent
    agentdeck --no-tunnel               # Local only (use Tailscale IP instead)
`);
  process.exit(0);
}

// ═══════════════════════════════════════════
// Main startup
// ═══════════════════════════════════════════

async function main() {
  // Load config file, then overlay CLI args
  const cfg = config.load();
  config.mergeCliArgs(cfg, args);

  console.log('');
  console.log('  \u{1F3AE} AgentDeck \u2014 Mobile control for your coding agents');
  console.log('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('');

  // ── Step 1: Ensure tmux session with agent ──

  const sessions = listSessions();
  let targetSession = null;

  if (sessions.length > 0) {
    // Prefer a session already running a known agent
    const agentSession = sessions.find(s => s.isClaude) || sessions[0];
    targetSession = agentSession.name;
    const marker = agentSession.isClaude ? ' (Claude Code)' : '';
    console.log(`  \u{1F50D} Found:      tmux "${targetSession}"${marker}`);
  } else if (cfg.agent) {
    // No sessions — create one with the configured agent
    targetSession = cfg.session || 'agent';
    console.log(`  \u{1F680} Launching:  ${cfg.agent} in tmux "${targetSession}"`);
    createSession(targetSession, cfg.agent);
  } else {
    // No sessions, no agent configured
    console.log('  \u{1F50D} No tmux sessions found');
    console.log('');
    console.log('  To auto-launch an agent, configure one:');
    console.log('    agentdeck config --agent claude');
    console.log('  Or start manually:');
    console.log('    tmux new -s agent && claude');
    console.log('');
    console.log('  Starting server anyway (will attach when a session appears)...');
    console.log('');
  }

  // ── Step 2: Start HTTP/WS server ───────────

  const server = new AgentDeckServer({
    port: cfg.port,
    pin: cfg.pin,
    noAuth: !cfg.auth,
    verbose: cfg.verbose,
  });

  try {
    await server.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`  Error: Port ${cfg.port} is already in use`);
      console.error(`  Try: agentdeck --port ${cfg.port + 1}`);
      process.exit(1);
    }
    throw err;
  }

  // ── Step 3: Start tunnel ───────────────────

  let tunnelUrl = null;
  if (cfg.tunnel) {
    process.stdout.write('  \u{1F310} Tunnel:     connecting...');
    const tunnel = await startTunnel(cfg.port, { subdomain: cfg.subdomain });
    if (tunnel) {
      tunnelUrl = tunnel.url;
      process.stdout.write('\r\x1b[2K');
      console.log(`  \u{1F310} Tunnel:     ${tunnelUrl}`);
    } else {
      process.stdout.write('\r\x1b[2K');
      console.log('  \u{1F310} Tunnel:     unavailable (local only)');
    }
  }

  const localUrl = `http://localhost:${cfg.port}`;
  console.log(`  \u{1F4E1} Local:      ${localUrl}`);

  // ── Step 4: Show PIN ──────────────────────

  if (cfg.auth) {
    console.log(`  \u{1F511} PIN:        ${server.auth.pin}`);
  } else {
    console.log('  \u{1F513} Auth:       disabled');
  }

  console.log('');

  // ── Step 5: Show QR code ──────────────────

  const connectUrl = tunnelUrl || localUrl;

  try {
    const qrcode = require('qrcode-terminal');
    console.log('  Scan to connect:');
    console.log('');
    // Generate QR with small mode for terminal
    qrcode.generate(connectUrl, { small: true }, (qr) => {
      // Indent each line
      const indented = qr.split('\n').map(line => '  ' + line).join('\n');
      console.log(indented);
    });
  } catch {
    // Fallback if qrcode-terminal not available
    console.log(`  \u{1F4F1} Open on phone: ${connectUrl}`);
  }

  console.log('');
  if (cfg.auth) {
    console.log(`  PIN: ${server.auth.pin}`);
    console.log('');
  }
  console.log('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('  Press Ctrl+C to stop');
  console.log('');

  // ── Graceful shutdown ─────────────────────

  process.on('SIGINT', async () => {
    console.log('\n  Shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('  Fatal:', err.message);
  if (err.stack && process.argv.includes('--verbose')) {
    console.error(err.stack);
  }
  process.exit(1);
});
