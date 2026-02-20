# AgentDeck

**Mobile control for your coding agents.**

One command. Background server, tunnel, Claude session, phone access — all automatic. Monitor, approve, and interact with your AI coding agents from your phone.

AgentDeck handles everything: it starts a background server, opens a Cloudflare tunnel, creates a Claude Code session, and attaches you — in one command. Your phone gets a live terminal, push notifications, and one-tap approve/deny. Non-blocking by design — you can respond from your phone or the terminal.

---

## Install

One line. Installs everything (tmux, Node.js, curl, cloudflared) if not already present:

```bash
curl -fsSL https://raw.githubusercontent.com/mccarthysean/agentdeck/main/install.sh | bash
```

Or if you already have Node.js and tmux:

```bash
npx agentdeck
```

That's it. No config files, no build step, no accounts.

---

## Features

- **One command to start** — `agentdeck` starts the server, creates a session, and attaches you. Run it again for another session.
- **Auto-named sessions** — sessions are named `claude-1`, `claude-2`, etc. No naming, no conflicts.
- **Background server** — the server runs hidden in the background. No dedicated terminal needed.
- **`status` / `stop` subcommands** — check what's running or shut down the server without losing sessions
- **Live terminal on your phone** — full xterm.js rendering with touch-friendly controls
- **Push notifications** — get notified instantly when Claude Code asks for permission (Web Push + ntfy)
- **Phone notifications via ntfy** — auto-enabled from your git email. Install the ntfy app, subscribe to the topic, done. No account, no tokens, no third-party service signup.
- **One-tap approve/deny** — respond to permission requests right from the notification
- **Non-blocking** — never stalls your agent; phone and terminal both work simultaneously
- **Auto-tunnel** — public HTTPS URL via Cloudflare Tunnel (no interstitial page), falls back to localtunnel
- **QR code** — scan from your phone to connect instantly, no typing URLs
- **Phone auto-refresh** — session list updates every 5 seconds, so new sessions appear on your phone automatically
- **PIN authentication** — random 4-digit PIN with HMAC-SHA256 session tokens
- **Installable PWA** — add to home screen, works offline-capable with Service Worker
- **Session picker** — switch between multiple sessions from the phone as they appear
- **Quick action bar** — y/n, Enter, Esc, Ctrl+C, Ctrl+D buttons for common inputs
- **Agent-agnostic** — works with ANY terminal agent (Claude Code, Codex, Aider, etc.)
- **Claude Code hooks** — richer UX for Claude Code with push notifications and one-tap approve/deny
- **Zero build step** — vanilla JS frontend, xterm.js loaded from CDN
- **5 dependencies** — node-pty, ws, web-push, localtunnel, qrcode-terminal

---

## Quick Start

### 1. Run AgentDeck

```bash
agentdeck
```

That's it. AgentDeck will:
- Start a background server with a Cloudflare tunnel
- Create a `claude-1` session running Claude Code
- Attach you to the session
- Show a QR code and PIN for your phone

Output:

```
  🎮 AgentDeck
  ────────────────────────────────────────────────

  Starting server...
  📡 Local:      http://localhost:3300
  🌐 Tunnel:     https://random-words.trycloudflare.com
  🔑 PIN:        4821

  Scan to connect:

  [QR CODE]

  🚀 Created session: claude-1

  Attaching to claude-1... (detach: Ctrl+B d)
```

When you're done (or want to start another session), press **Ctrl+B d** to detach:

```
  👋 Detached from claude-1

  Quick commands:
    tmux attach -t claude-1       Re-attach to this session
    agentdeck                     Create a new session
    agentdeck status              Show QR code and sessions
    agentdeck stop                Stop the background server
```

### 2. (Optional) Set up hooks + phone notifications

```bash
agentdeck setup
```

This does two things:
1. Configures Claude Code hooks to POST permission requests to AgentDeck
2. Auto-generates an ntfy topic from your git email (e.g., `claude-a1b2c3d4e5f6`)

Install the [ntfy app](https://ntfy.sh) on your phone and subscribe to the topic shown. You'll get urgent notifications for permission requests and info notifications when the agent goes idle.

---

## How It Works

```
agentdeck (orchestrator)
  ├── Starts background server in hidden tmux session "_agentdeck"
  ├── Creates claude-1 session, attaches you
  └── On detach: prints helpful hints

_agentdeck (hidden, background)
  └── HTTP/WS server + Cloudflare tunnel
      ├── Writes ~/.agentdeck/status.json
      ├── Serves phone PWA
      └── Refreshes session list every 5s → phone auto-updates

Phone (PWA)  <-->  WebSocket  <-->  AgentDeck Server  <-->  node-pty  <-->  tmux sessions
                                          |         \
                                Claude Code hooks    ntfy.sh --> phone notification
                                POST here               (auto-enabled from git email)
```

### The non-blocking hook design

When Claude Code asks for permission (e.g., to run a shell command), this is what happens:

1. The Claude Code hook POSTs the permission request to AgentDeck's `/api/hook` endpoint
2. AgentDeck **immediately** responds with `{"decision": {"behavior": "ask"}}`, telling Claude to show its normal terminal prompt
3. AgentDeck sends notifications in parallel: WebSocket toast to connected clients, Web Push, and ntfy (if configured)
4. You can tap **Allow** on your phone (sends `y` keystroke to the PTY) or just type `y` in the terminal

Either way works. The agent is never blocked waiting for AgentDeck to decide. This means AgentDeck can go offline, crash, or be slow — your agent keeps working normally.

---

## CLI Usage

### Subcommands

```
agentdeck                           Start server + create session + attach
agentdeck                           (again) Detect server + new session + attach
agentdeck status                    Show QR code, PIN, tunnel URL, sessions
agentdeck stop                      Stop background server (sessions survive)
agentdeck setup                     Configure hooks + auto-enable phone notifications
agentdeck config --agent <cmd>      Save default agent (persists across runs)
```

### Options

```
--agent <cmd>       Command to launch in sessions (default: claude)
--port <n>          Server port (default: 3300)
--pin <n>           Set PIN manually (default: random 4-digit)
--subdomain <name>  Consistent tunnel URL across restarts
--no-auth           Disable PIN authentication
--no-tunnel         Skip tunnel (use with Tailscale or local network)
--verbose           Show debug output
--ntfy-topic <t>    Override auto-generated ntfy topic
--ntfy-url <url>    ntfy server URL (default: https://ntfy.sh)
--no-ntfy           Disable ntfy notifications
```

### Examples

First run — server starts, session created, you're attached:

```bash
agentdeck
# → Starts server, creates claude-1, attaches you
```

Second run — server already running, new session created:

```bash
agentdeck
# → Detects server, creates claude-2, attaches you
```

Check what's running:

```bash
agentdeck status
# → Shows QR code, PIN, tunnel URL, and active sessions
```

Stop the server (sessions keep running):

```bash
agentdeck stop
# → Server stopped. 2 session(s) still running (your work is safe).
```

Run with a custom port and fixed PIN:

```bash
agentdeck --port 8080 --pin 9999
```

Local network only (no tunnel), auth disabled:

```bash
agentdeck --no-tunnel --no-auth
```

Save a default agent so you never have to specify it:

```bash
agentdeck config --agent claude
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
            "command": "curl -sS --max-time 5 -X POST http://localhost:3300/api/hook -H 'Content-Type: application/json' -d @- || true",
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
            "command": "curl -sS --max-time 5 -X POST http://localhost:3300/api/hook -H 'Content-Type: application/json' -d @- || true"
          }
        ]
      }
    ]
  }
}
```

The `|| true` ensures Claude Code does not fail if AgentDeck is not running. The `--max-time 5` prevents curl from hanging if the server is unresponsive.

Restart Claude Code after configuring hooks.

---

## Phone Notifications (ntfy)

[ntfy](https://ntfy.sh) is a free, open-source push notification service. AgentDeck can send notifications to ntfy so you get alerted on your phone when Claude Code needs permission or goes idle — no account required.

### Setup (30 seconds)

1. **Run setup** — AgentDeck auto-generates a topic from your git email:

```bash
npx agentdeck setup
```

```
  🔔 ntfy topic: claude-a1b2c3d4e5f6
  Subscribe to this topic in the ntfy app on your phone.
```

2. **Install the ntfy app** on your phone ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/app/ntfy/id1625396347))
3. **Subscribe** to the topic shown (e.g., `claude-a1b2c3d4e5f6`)

That's it. AgentDeck now sends:
- **Permission requests** — priority 5 (urgent), buzzes immediately
- **Idle/completion notifications** — priority 3 (default), silent badge

### Dedup

AgentDeck deduplicates notifications to prevent floods:
- Only one notification per event type per 10 seconds
- Idle notifications are suppressed for 3 minutes after a permission notification (you're already engaged)

### Self-hosted ntfy

If you run your own ntfy server, point AgentDeck at it:

```bash
npx agentdeck setup --ntfy-topic my-topic --ntfy-url https://ntfy.example.com
```

### How topics are generated

The auto-generated topic is an MD5 hash of your `git config user.email`, truncated to 12 hex characters and prefixed with `claude-`. This is:
- **Deterministic** — same email always gives the same topic, so reinstalling doesn't break your phone subscription
- **Private** — the topic reveals nothing about your email address
- **Unique** — different developers get different topics

You can override with `--ntfy-topic <name>` or disable with `--no-ntfy`.

### Security note

ntfy topics on ntfy.sh are **public by default** — anyone who knows (or guesses) your topic name can read your notifications. The auto-generated hash makes this very unlikely. Notifications contain only the tool name and a short summary, never source code or credentials.

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
npx agentdeck --no-tunnel   # Uses Docker port mapping instead of a tunnel
```

AgentDeck will start the server, create a session, and attach you — same as on a host machine.

With Docker Compose:

```yaml
services:
  dev:
    build: .
    ports:
      - "3300:3300"
    stdin_open: true
    tty: true
    command: >
      bash -c "npx agentdeck --no-tunnel --no-auth"
```

If the container has internet access, you can use `--subdomain` with localtunnel instead of port mapping.

---

## Comparison

| Feature | AgentDeck | SSH + tmux | ttyd | claude-relay |
|---|---|---|---|---|
| Phone-optimized UI | Yes | No | Partial | Yes |
| Push notifications | Yes | No | No | Yes |
| One-tap approve/deny | Yes | No | No | Yes |
| No port forwarding | Yes (cloudflared) | No | No | Yes (relay) |
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

- **PIN authentication** — a random 4-digit PIN is generated on each server start. Clients exchange the PIN for an HMAC-SHA256 session token. Timing-safe comparison prevents timing attacks.
- **Status file** — `~/.agentdeck/status.json` stores the server PID, port, PIN, and tunnel URL. It contains no secrets beyond the PIN and is readable only by the current user.
- **Hooks are localhost-only** — the `/api/hook` endpoint only accepts connections from `127.0.0.1` / `::1`. Remote clients cannot inject fake permission requests.
- **Health endpoint is localhost-only** — `/api/health` is used internally by the orchestrator to detect a running server. It is not exposed through the tunnel.
- **No secrets in push notifications** — push payloads contain only the tool name and a truncated summary (command name or file path). No source code or credentials are sent.
- **VAPID keys** — Web Push uses per-installation VAPID keys stored in `~/.agentdeck/vapid.json`. No third-party push service.
- **Directory traversal protection** — static file serving validates that resolved paths stay within the `public/` directory.
- **Cloudflare Tunnel** — cloudflared quick tunnels provide a public HTTPS URL with no interstitial page. Combined with the PIN, this is suitable for personal use. Falls back to localtunnel if cloudflared is not installed. For higher security, use `--no-tunnel` with Tailscale or a VPN.
- **Token per session** — tokens are derived from the PIN using a per-startup random secret. Restarting the server invalidates all existing tokens.
- **No persistent state** — no database, no user accounts. Push subscriptions and VAPID keys in `~/.agentdeck/` are the only persisted data.

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
│   ├── ntfy.js          # ntfy push notification client (zero dependencies)
│   ├── push.js          # Web Push notification manager
│   ├── auth.js          # PIN + HMAC-SHA256 authentication
│   ├── protocol.js      # WebSocket message type definitions
│   ├── tunnel.js        # Cloudflare Tunnel / localtunnel wrapper
│   ├── config.js        # Persistent configuration management
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

- **History view** — browse past permission requests and decisions
- **Tailscale integration** — auto-detect Tailscale and skip tunnel
- **Custom quick actions** — configurable action bar buttons
- **Audio alerts** — optional sound on permission requests
- **Agent metrics** — token usage, tool call counts, session duration

---

## Contributing

Contributions are welcome. Please open an issue to discuss larger changes before submitting a PR.

```bash
git clone https://github.com/mccarthysean/agentdeck.git
cd agentdeck
bun install
bun run dev   # Starts with --verbose
```

### Requirements

- Node.js >= 18
- tmux installed

### Design principles

- **Zero build step** — no bundler, no transpiler. Vanilla JS served directly.
- **Minimal dependencies** — every dependency must justify its existence.
- **Non-blocking** — AgentDeck must never stall the agent it is monitoring.
- **Phone-first** — UI decisions favor mobile touch interactions.

---

## License

[MIT](LICENSE) — Sean McCarthy
