const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * Configuration management.
 *
 * Loads config from ~/.agentdeck/config.json, merged with CLI flags.
 * CLI flags always win over config file values.
 */

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.agentdeck');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  port: 3300,
  agent: null,       // e.g., "claude" — command to launch in tmux
  session: 'agent',  // tmux session name
  tunnel: true,
  auth: true,
  pin: null,         // auto-generated if null
  subdomain: null,
  verbose: false,
  ntfyTopic: null,              // null = disabled
  ntfyUrl: 'https://ntfy.sh',
};

function load() {
  let fileConfig = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      // Ignore malformed config
    }
  }

  return { ...DEFAULTS, ...fileConfig };
}

function save(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Only save non-default values
  const toSave = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== DEFAULTS[key] && value !== null && value !== undefined) {
      toSave[key] = value;
    }
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2) + '\n');
}

function mergeCliArgs(config, args) {
  // Parse CLI args and overlay onto config
  if (getArg(args, 'port')) config.port = parseInt(getArg(args, 'port'), 10);
  if (getArg(args, 'agent')) config.agent = getArg(args, 'agent');
  if (getArg(args, 'session')) config.session = getArg(args, 'session');
  if (getArg(args, 'pin')) config.pin = getArg(args, 'pin');
  if (getArg(args, 'subdomain')) config.subdomain = getArg(args, 'subdomain');
  if (hasFlag(args, 'no-tunnel')) config.tunnel = false;
  if (hasFlag(args, 'no-auth')) config.auth = false;
  if (hasFlag(args, 'verbose')) config.verbose = true;
  if (getArg(args, 'ntfy-topic')) config.ntfyTopic = getArg(args, 'ntfy-topic');
  if (getArg(args, 'ntfy-url')) config.ntfyUrl = getArg(args, 'ntfy-url');

  return config;
}

function getArg(args, name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

/**
 * Auto-generate an ntfy topic from git email.
 * Deterministic: same email always gives the same topic.
 * Returns null if git email is not configured.
 */
function generateNtfyTopic() {
  try {
    const email = execSync('git config user.email', { encoding: 'utf-8' }).trim();
    if (!email) return null;
    const hash = crypto.createHash('md5').update(email).digest('hex').slice(0, 12);
    return `claude-${hash}`;
  } catch {
    return null;
  }
}

module.exports = { load, save, mergeCliArgs, generateNtfyTopic, CONFIG_DIR, CONFIG_PATH, DEFAULTS };
