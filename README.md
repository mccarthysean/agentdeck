# AgentDeck

**Mobile control for your coding agents.**

Monitor, approve, and interact with your AI coding agents from your phone. One command, 30 seconds, no port forwarding.

AgentDeck attaches to your tmux sessions via node-pty, streams the terminal to your phone over WebSocket + xterm.js, and sends push notifications when your agent needs permission. Non-blocking by design -- you can respond from your phone or the terminal.

---

## Install

One line. Installs everything (tmux, Node.js, curl) if not already present:

```bash
curl -fsSL https://raw.githubusercontent.com/ijack-technologies/agentdeck/main/install.sh | bash
```

Or if you already have Node.js and tmux:

```bash
npx agentdeck
```

That's it. No config files, no build step, no accounts.

---

## Features

- **Live terminal on your phone** -- full xterm.js rendering with touch-friendly controls
- **Push notifications** -- get notified instantly when Claude Code asks for permission
- **One-tap approve/deny** -- respond to permission requests right from the notification
- **Non-blocking** -- never stalls your agent; phone and terminal both work simultaneously
- **Auto-tunnel** -- public HTTPS URL via localtunnel, no VPN or port forwarding needed
- **PIN authentication** -- random 4-digit PIN with HMAC-SHA256 session tokens
- **Installable PWA** -- add to home screen, works offline-capable with Service Worker
- **Session picker** -- switch between multiple tmux sessions from the phone
- **Quick action bar** -- y/n, Enter, Esc, Ctrl+C, Ctrl+D buttons for common inputs
- **Agent-agnostic** -- the tmux layer works with ANY terminal agent (Claude Code, Codex, Aider, etc.)
- **Claude Code hooks** -- richer UX for Claude Code with push notifications and one-tap approve/deny
- **Zero build step** -- vanilla JS frontend, xterm.js loaded from CDN
- **4 dependencies** -- node-pty, ws, web-push, localtunnel

---

## Quick Start

### 1. Start your agent in tmux

```bash
tmux new -s claude
claude   # or any coding agent
```

### 2. Run AgentDeck (in a second terminal)

```bash
npx agentdeck
```

Output:

```
  AgentDeck -- Mobile control for your coding agents
  ------------------------------------------------

  Server:     http://localhost:3300
  PIN:        4821
  Tunnel:     https://abc123.loca.lt

  Open on phone: https://abc123.loca.lt

  tmux sessions:
     claude (claude) <- Claude Code
```

### 3. Open the URL on your phone

Enter the PIN. You now have a live terminal and push notifications.

### 4. (Optional) Set up Claude Code hooks

```bash
npx agentdeck setup
```

This configures Claude Code to POST permission requests to AgentDeck, enabling push notifications and one-tap approve/deny.

---

## How It Works

```
Phone (PWA)  <-->  WebSocket  <-->  AgentDeck Server  <-->  node-pty  <-->  tmux session
                                          |
                                Claude Code hooks POST here
                                (non-blocking, sends push notification)
```

### The non-blocking hook design

When Claude Code asks for permission (e.g., to run a shell command), this is what happens:

1. The Claude Code hook POSTs the permission request to AgentDeck's `/api/hook` endpoint
2. AgentDeck **immediately** responds with `{"decision": {"behavior": "ask"}}`, telling Claude to show its normal terminal prompt
3. AgentDeck sends a push notification to your phone with the tool name and summary
4. You can tap **Allow** on your phone (sends `y` keystroke to the PTY) or just type `y` in the terminal

Either way works. The agent is never blocked waiting for AgentDeck to decide. This means AgentDeck can go offline, crash, or be slow -- your agent keeps working normally.

---

## CLI Usage

```
agentdeck                         Start server + auto-tunnel
agentdeck setup                   Auto-configure Claude Code hooks
agentdeck --port 3300             Custom port (default: 3300)
agentdeck --pin 1234              Set PIN manually (default: random 4-digit)
agentdeck --no-auth               Disable PIN authentication (trusted networks only)
agentdeck --no-tunnel             Skip localtunnel (use with Tailscale, local network, etc.)
agentdeck --subdomain myproject   Request a consistent tunnel URL
agentdeck --verbose               Show debug output (HTTP requests, WS connections)
```

### Examples

Run with a custom port and fixed PIN:

```bash
agentdeck --port 8080 --pin 9999
```

Local network only (no tunnel), auth disabled:

```bash
agentdeck --no-tunnel --no-auth
```

Use a stable subdomain for bookmarking:

```bash
agentdeck --subdomain my-dev-machine
# -> https://my-dev-machine.loca.lt
```

---

## Claude Code Hooks Setup

AgentDeck uses Claude Code's [hook system](https://docs.anthropic.com/en/docs/claude-code/hooks) to receive permission requests and notifications.

### Automatic setup

```bash
npx agentdeck setup
```

This writes the hook configuration to `~/.claude/settings.json` (or `.claude/settings.json` in your project directory if it exists).

### Manual setup

Add this to your Claude Code `settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sS -X POST http://localhost:3300/api/hook -H 'Content-Type: application/json' -d @- || true",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sS -X POST http://localhost:3300/api/hook -H 'Content-Type: application/json' -d @-"
          }
        ]
      }
    ]
  }
}
```

The `|| true` on PermissionRequest ensures Claude Code does not fail if AgentDeck is not running. The short timeout (10s) prevents delays.

Restart Claude Code after configuring hooks.

---

## Docker Usage

AgentDeck works in Docker containers and dev containers. It only needs tmux and Node.js, both of which are common in development images.

```dockerfile
FROM node:20

RUN apt-get update && apt-get install -y tmux

# Your dev setup here...

EXPOSE 3300
```

Then inside the container:

```bash
tmux new -s claude -d "claude"
npx agentdeck --no-tunnel   # Use Docker port mapping instead
```

With Docker Compose:

```yaml
services:
  dev:
    build: .
    ports:
      - "3300:3300"
    command: >
      bash -c "tmux new -s claude -d 'claude' && npx agentdeck --no-tunnel --no-auth"
```

If the container has internet access, you can use `--subdomain` with localtunnel instead of port mapping.

---

## Comparison

| Feature | AgentDeck | SSH + tmux | ttyd | claude-relay |
|---|---|---|---|---|
| Phone-optimized UI | Yes | No | Partial | Yes |
| Push notifications | Yes | No | No | Yes |
| One-tap approve/deny | Yes | No | No | Yes |
| No port forwarding | Yes (localtunnel) | No | No | Yes (relay) |
| Works offline/disconnected | Yes (non-blocking) | N/A | N/A | No (blocking) |
| Agent-agnostic | Yes (any tmux session) | Yes | Yes | Claude Code only |
| Zero config networking | Yes | No | No | Yes |
| PIN auth | Yes | SSH keys | Optional | Token |
| Dependencies | 4 npm packages | None | C build | Cloud service |
| Self-hosted | Yes | Yes | Yes | No |
| Installable PWA | Yes | No | No | No |

---

## Security Model

AgentDeck is designed for personal use on development machines. The security model reflects this:

- **PIN authentication** -- a random 4-digit PIN is generated on each server start. Clients exchange the PIN for an HMAC-SHA256 session token. Timing-safe comparison prevents timing attacks.
- **Hooks are localhost-only** -- the `/api/hook` endpoint only accepts connections from `127.0.0.1` / `::1`. Remote clients cannot inject fake permission requests.
- **No secrets in push notifications** -- push payloads contain only the tool name and a truncated summary (command name or file path). No source code or credentials are sent.
- **VAPID keys** -- Web Push uses per-installation VAPID keys stored in `~/.agentdeck/vapid.json`. No third-party push service.
- **Directory traversal protection** -- static file serving validates that resolved paths stay within the `public/` directory.
- **localtunnel** -- the tunnel provides a public HTTPS URL. Combined with the PIN, this is suitable for personal use. For higher security, use `--no-tunnel` with Tailscale or a VPN.
- **Token per session** -- tokens are derived from the PIN using a per-startup random secret. Restarting the server invalidates all existing tokens.
- **No persistent state** -- no database, no user accounts. Push subscriptions and VAPID keys in `~/.agentdeck/` are the only persisted data.

For production or shared environments, use `--no-tunnel` and put AgentDeck behind a reverse proxy with TLS.

---

## Project Structure

```
agentdeck/
├── bin/cli.js           # CLI entry point and argument parsing
├── lib/
│   ├── server.js        # HTTP + WebSocket server (no Express)
│   ├── terminal.js      # node-pty <-> tmux bridge with ring buffer
│   ├── tmux.js          # Session discovery and management
│   ├── hooks.js         # Non-blocking Claude Code hook handler
│   ├── push.js          # Web Push notification manager
│   ├── auth.js          # PIN + HMAC-SHA256 authentication
│   ├── protocol.js      # WebSocket message type definitions
│   ├── tunnel.js        # localtunnel auto-reconnect wrapper
│   └── setup.js         # Auto-configure Claude Code hooks
├── public/
│   ├── index.html       # PWA shell
│   ├── app.js           # Frontend application
│   ├── style.css        # Mobile-first styles
│   ├── sw.js            # Service Worker (offline + push)
│   ├── manifest.json    # PWA manifest
│   └── icons/           # SVG icons
├── package.json
├── LICENSE
└── README.md
```

---

## Roadmap

- **Multi-agent dashboard** -- monitor multiple agents across multiple tmux sessions from a single phone view
- **Session grouping** -- organize agents by project
- **History view** -- browse past permission requests and decisions
- **Tailscale integration** -- auto-detect Tailscale and skip localtunnel
- **Custom quick actions** -- configurable action bar buttons
- **Audio alerts** -- optional sound on permission requests
- **Agent metrics** -- token usage, tool call counts, session duration

---

## Contributing

Contributions are welcome. Please open an issue to discuss larger changes before submitting a PR.

```bash
git clone https://github.com/ijack-technologies/agentdeck.git
cd agentdeck
bun install
bun run dev   # Starts with --verbose
```

### Requirements

- Node.js >= 18
- tmux installed and at least one session running

### Design principles

- **Zero build step** -- no bundler, no transpiler. Vanilla JS served directly.
- **Minimal dependencies** -- every dependency must justify its existence.
- **Non-blocking** -- AgentDeck must never stall the agent it is monitoring.
- **Phone-first** -- UI decisions favor mobile touch interactions.

---

## License

[MIT](LICENSE) -- IJACK Technologies
