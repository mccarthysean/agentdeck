const { execSync, execFileSync, exec } = require('child_process');

/**
 * tmux session discovery and management.
 *
 * Parses `tmux list-sessions` output to find running sessions and
 * heuristically detects which ones are running Claude Code.
 */

function listSessions({ includeHidden = false } = {}) {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}\t#{session_attached}\t#{pane_current_command}"',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    if (!output) return [];

    const sessions = output.split('\n').map(line => {
      const [name, attached, command] = line.split('\t');
      return {
        name,
        attached: parseInt(attached, 10) || 0,
        command: command || '',
        isClaude: isClaudeSession(command, name),
      };
    });

    if (includeHidden) return sessions;
    return sessions.filter(s => !s.name.startsWith('_'));
  } catch {
    // tmux not running or not installed
    return [];
  }
}

function isClaudeSession(command, name) {
  const cmd = (command || '').toLowerCase();
  const n = (name || '').toLowerCase();
  // Detect by process name or session name
  return cmd.includes('claude') || n.includes('claude');
}

function sessionExists(name) {
  try {
    execSync(`tmux has-session -t ${shellEscape(name)} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function createSession(name, command) {
  const safeName = shellEscape(name);
  if (command) {
    // Launch the command inside the detached tmux session
    // Use shell -c to handle commands with arguments (e.g., "claude --flag")
    execSync(
      `tmux new-session -d -s ${safeName} "exec ${command}"`,
      { encoding: 'utf-8', timeout: 10000, shell: '/bin/bash' }
    );
  } else {
    execSync(
      `tmux new-session -d -s ${safeName}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
  }
}

/**
 * Auto-incrementing session name: claude-1, claude-2, ...
 * Uses max+1 (not gap-fill) so numbers always increase.
 */
function nextSessionName(prefix = 'claude') {
  const sessions = listSessions({ includeHidden: true });
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const s of sessions) {
    const m = s.name.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

/**
 * Hand the current terminal to a tmux session.
 * Blocks until the user detaches (Ctrl+B d).
 */
function attachSession(name) {
  execFileSync('tmux', ['attach-session', '-t', shellEscape(name)], {
    stdio: 'inherit',
  });
}

/**
 * Pre-flight check: is tmux installed?
 */
function isTmuxInstalled() {
  try {
    execSync('which tmux', { encoding: 'utf-8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// Minimal shell escaping for session names (alphanumeric + dash + underscore)
function shellEscape(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '');
}

module.exports = {
  listSessions,
  sessionExists,
  createSession,
  nextSessionName,
  attachSession,
  isTmuxInstalled,
  shellEscape,
};
