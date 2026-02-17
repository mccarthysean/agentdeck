#!/usr/bin/env node

const { AgentDeckServer } = require('../lib/server');
const { startTunnel } = require('../lib/tunnel');
const { setup } = require('../lib/setup');
const { listSessions } = require('../lib/tmux');

// ═══════════════════════════════════════════
// Argument parsing (no dependencies)
// ═══════════════════════════════════════════

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  return args[idx + 1] || defaultValue;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

// Handle `agentdeck setup` subcommand
if (args[0] === 'setup') {
  console.log('');
  console.log('  \u{1F3AE} AgentDeck — Configuring Claude Code hooks');
  console.log('');
  const port = parseInt(getArg('port', '3300'), 10);
  setup({ port });
  process.exit(0);
}

// Handle --help
if (hasFlag('help') || args[0] === 'help') {
  console.log(`
  \u{1F3AE} AgentDeck — Mobile control for your coding agents

  Usage:
    agentdeck                         Start server + tunnel
    agentdeck setup                   Auto-configure Claude Code hooks
    agentdeck --port 3300             Custom port (default: 3300)
    agentdeck --pin 1234              Set PIN manually
    agentdeck --no-auth               Disable PIN (trusted networks)
    agentdeck --no-tunnel             Local only (use with Tailscale)
    agentdeck --subdomain myproject   Consistent tunnel URL
    agentdeck --verbose               Show debug output
`);
  process.exit(0);
}

// ═══════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════

const config = {
  port: parseInt(getArg('port', '3300'), 10),
  pin: getArg('pin', undefined),
  noAuth: hasFlag('no-auth'),
  noTunnel: hasFlag('no-tunnel'),
  subdomain: getArg('subdomain', undefined),
  verbose: hasFlag('verbose'),
};

// ═══════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════

async function main() {
  console.log('');
  console.log('  \u{1F3AE} AgentDeck — Mobile control for your coding agents');
  console.log('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('');

  // Start server
  const server = new AgentDeckServer(config);

  try {
    await server.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`  Error: Port ${config.port} is already in use`);
      console.error(`  Try: agentdeck --port ${config.port + 1}`);
      process.exit(1);
    }
    throw err;
  }

  const localUrl = `http://localhost:${config.port}`;
  console.log(`  \u{1F4E1} Server:     ${localUrl}`);

  // Show PIN
  if (!config.noAuth) {
    console.log(`  \u{1F511} PIN:        ${server.auth.pin}`);
  } else {
    console.log('  \u{1F513} Auth:       disabled (--no-auth)');
  }

  // Start tunnel
  let tunnelUrl = null;
  if (!config.noTunnel) {
    console.log('  \u{1F310} Tunnel:     connecting...');
    const tunnel = await startTunnel(config.port, {
      subdomain: config.subdomain,
    });
    if (tunnel) {
      tunnelUrl = tunnel.url;
      // Clear the "connecting..." line and rewrite
      process.stdout.write('\x1b[1A\x1b[2K');
      console.log(`  \u{1F310} Tunnel:     ${tunnelUrl}`);
    } else {
      process.stdout.write('\x1b[1A\x1b[2K');
      console.log('  \u{1F310} Tunnel:     unavailable (local only)');
    }
  } else {
    console.log('  \u{1F310} Tunnel:     disabled (--no-tunnel)');
  }

  console.log('');

  // Show phone connection URL
  const connectUrl = tunnelUrl || localUrl;
  console.log(`  \u{1F4F1} Open on phone: ${connectUrl}`);
  console.log('');

  // Discover tmux sessions
  const sessions = listSessions();
  if (sessions.length > 0) {
    console.log('  \u{1F50D} tmux sessions:');
    for (const s of sessions) {
      const marker = s.isClaude ? ' \u2190 Claude Code' : '';
      console.log(`     ${s.name} (${s.command})${marker}`);
    }
  } else {
    console.log('  \u{1F50D} No tmux sessions found');
    console.log('     Start one: tmux new -s claude && claude');
  }

  console.log('');
  console.log('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('  Press Ctrl+C to stop');
  console.log('');

  // Graceful shutdown
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
  process.exit(1);
});
