const { spawn, execSync } = require('child_process');

/**
 * Tunnel networking — auto-generates a public HTTPS URL.
 *
 * Strategy (in order of preference):
 * 1. cloudflared (Cloudflare Tunnel) — no interstitial, free, reliable
 * 2. localtunnel — pure JS fallback, but has an annoying password page
 *
 * cloudflared "quick tunnels" require no account or config:
 *   cloudflared tunnel --url http://localhost:3300
 * It prints a URL like https://random-words.trycloudflare.com
 */

async function startTunnel(port, options = {}) {
  // Try cloudflared first
  const cf = await tryCloudflared(port);
  if (cf) return cf;

  // Fallback to localtunnel
  const lt = await tryLocaltunnel(port, options);
  if (lt) return lt;

  console.log('  No tunnel available — local-only mode');
  console.log('  Install cloudflared for best experience:');
  console.log('    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | apt-key add -');
  console.log('    apt install cloudflared');
  return null;
}

async function tryCloudflared(port) {
  // Check if cloudflared is installed
  try {
    execSync('which cloudflared', { encoding: 'utf-8', timeout: 3000 });
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const proc = spawn('cloudflared', [
      'tunnel', '--url', `http://localhost:${port}`,
      '--no-autoupdate',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let url = null;
    let resolved = false;

    function checkOutput(data) {
      const text = data.toString();
      // cloudflared prints the URL to stderr:
      // "... https://random-words.trycloudflare.com ..."
      const match = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
      if (match && !resolved) {
        url = match[1];
        resolved = true;
        resolve({ url, close: () => proc.kill() });
      }
    }

    proc.stdout.on('data', checkOutput);
    proc.stderr.on('data', checkOutput);

    proc.on('error', () => {
      if (!resolved) { resolved = true; resolve(null); }
    });

    proc.on('exit', () => {
      if (!resolved) { resolved = true; resolve(null); }
    });

    // Timeout after 15s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve(null);
      }
    }, 15000);
  });
}

async function tryLocaltunnel(port, options = {}) {
  let localtunnel;
  try {
    localtunnel = require('localtunnel');
  } catch {
    return null;
  }

  try {
    const tunnelOpts = { port };
    if (options.subdomain) {
      tunnelOpts.subdomain = options.subdomain;
    }

    const tunnel = await localtunnel(tunnelOpts);

    tunnel.on('close', () => {
      setTimeout(() => {
        tryLocaltunnel(port, options).catch(() => {});
      }, 5000);
    });

    // Note: localtunnel has an interstitial page that requires the
    // server's public IP as a "tunnel password". This is a poor UX.
    // Prefer cloudflared when available.
    return { url: tunnel.url + ' (may show password page)', close: () => tunnel.close() };
  } catch {
    return null;
  }
}

module.exports = { startTunnel };
