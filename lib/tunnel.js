/**
 * localtunnel networking — auto-generates a public HTTPS URL.
 *
 * This lets phones connect without VPN or port forwarding.
 * localtunnel is pure JS, creates an outbound tunnel to their relay
 * server, which assigns you a random HTTPS URL.
 */

async function startTunnel(port, options = {}) {
  let localtunnel;
  try {
    localtunnel = require('localtunnel');
  } catch {
    console.log('  localtunnel not available — local-only mode');
    return null;
  }

  try {
    const tunnelOpts = { port };
    if (options.subdomain) {
      tunnelOpts.subdomain = options.subdomain;
    }

    const tunnel = await localtunnel(tunnelOpts);

    tunnel.on('close', () => {
      console.log('  Tunnel closed. Reconnecting...');
      // Auto-reconnect after a delay
      setTimeout(() => {
        startTunnel(port, options).catch(() => {});
      }, 5000);
    });

    tunnel.on('error', (err) => {
      console.error('  Tunnel error:', err.message);
    });

    return tunnel;
  } catch (err) {
    console.log(`  Could not start tunnel: ${err.message}`);
    console.log('  Running in local-only mode (use Tailscale or local network)');
    return null;
  }
}

module.exports = { startTunnel };
