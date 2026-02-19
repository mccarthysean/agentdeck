const fs = require('fs');
const path = require('path');

/**
 * Auto-configure Claude Code hooks to POST to AgentDeck.
 *
 * The hook is NON-BLOCKING: it POSTs the event to our server for
 * notification purposes, then immediately outputs { behavior: "ask" }
 * so Claude falls through to the normal terminal prompt. The user
 * can then respond from either the phone or the terminal.
 */

const HOOK_COMMAND =
  'curl -sS --max-time 5 -X POST http://localhost:3300/api/hook ' +
  "-H 'Content-Type: application/json' -d @- || true";

const HOOKS_CONFIG = {
  PermissionRequest: [
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: HOOK_COMMAND,
          timeout: 10, // Short timeout — we respond immediately anyway
        },
      ],
    },
  ],
  Notification: [
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: HOOK_COMMAND,
        },
      ],
    },
  ],
};

function findSettingsFile() {
  // Check project-local first, then user-global
  const candidates = [
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(process.env.HOME || '', '.claude', 'settings.json'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Default to user-global (will create if needed)
  return path.join(process.env.HOME || '', '.claude', 'settings.json');
}

function setup(options = {}) {
  const settingsPath = options.settingsPath || findSettingsFile();
  const port = options.port || 3300;

  // Update hook command with custom port if needed
  let hookCommand = HOOK_COMMAND;
  if (port !== 3300) {
    hookCommand = hookCommand.replace('localhost:3300', `localhost:${port}`);
  }

  // Read existing settings or start fresh
  let settings = {};
  const dir = path.dirname(settingsPath);

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error(`  Warning: Could not parse ${settingsPath}, creating new`);
    }
  }

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  // Build hooks config with potentially custom port
  const hooksConfig = JSON.parse(JSON.stringify(HOOKS_CONFIG));
  if (port !== 3300) {
    for (const key of Object.keys(hooksConfig)) {
      for (const entry of hooksConfig[key]) {
        for (const hook of entry.hooks) {
          hook.command = hookCommand;
        }
      }
    }
  }

  // Merge hooks (preserve other existing hooks)
  settings.hooks = settings.hooks || {};
  settings.hooks.PermissionRequest = hooksConfig.PermissionRequest;
  settings.hooks.Notification = hooksConfig.Notification;

  // Write back
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  console.log(`  Hooks configured in: ${settingsPath}`);
  console.log('  PermissionRequest → POST to AgentDeck (non-blocking)');
  console.log('  Notification → POST to AgentDeck');
  console.log('');
  console.log('  Restart Claude Code for hooks to take effect.');

  return settingsPath;
}

/**
 * Read the port that hooks are currently configured to POST to.
 * Returns the port number, or null if hooks are not configured.
 */
function getHookPort() {
  const settingsPath = findSettingsFile();

  if (!fs.existsSync(settingsPath)) return null;

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = settings?.hooks?.PermissionRequest;
    if (!Array.isArray(hooks) || hooks.length === 0) return null;

    // Find the AgentDeck hook command
    for (const entry of hooks) {
      for (const hook of entry.hooks || []) {
        const match = hook.command?.match(/localhost:(\d+)\/api\/hook/);
        if (match) return parseInt(match[1], 10);
      }
    }
  } catch {
    // Can't read or parse — not configured
  }

  return null;
}

module.exports = { setup, findSettingsFile, getHookPort };
