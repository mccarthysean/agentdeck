#!/usr/bin/env bash
# AgentDeck — One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/mccarthysean/agentdeck/main/install.sh | bash
set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
PURPLE='\033[35m'
RESET='\033[0m'

log()  { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
err()  { echo -e "  ${RED}✗${RESET} $1"; exit 1; }
info() { echo -e "  ${DIM}$1${RESET}"; }

echo ""
echo -e "  ${PURPLE}${BOLD}AgentDeck${RESET} — Mobile control for your coding agents"
echo -e "  ────────────────────────────────────────────────"
echo ""

# ── Detect package manager ─────────────────────

install_pkg() {
  local pkg=$1
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq "$pkg" >/dev/null 2>&1
  elif command -v apk &>/dev/null; then
    apk add --no-cache "$pkg" >/dev/null 2>&1
  elif command -v yum &>/dev/null; then
    yum install -y -q "$pkg" >/dev/null 2>&1
  elif command -v dnf &>/dev/null; then
    dnf install -y -q "$pkg" >/dev/null 2>&1
  elif command -v pacman &>/dev/null; then
    pacman -Sy --noconfirm "$pkg" >/dev/null 2>&1
  elif command -v brew &>/dev/null; then
    brew install "$pkg" >/dev/null 2>&1
  else
    err "Could not find a package manager. Install $pkg manually and retry."
  fi
}

# ── Check / Install tmux ──────────────────────

if command -v tmux &>/dev/null; then
  log "tmux $(tmux -V | cut -d' ' -f2) found"
else
  warn "tmux not found — installing..."
  install_pkg tmux
  if command -v tmux &>/dev/null; then
    log "tmux installed"
  else
    err "Failed to install tmux. Install it manually: apt install tmux"
  fi
fi

# ── Check / Install Node.js ───────────────────

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
    log "Node.js $(node -v) found"
  else
    warn "Node.js $(node -v) is too old (need >= 18)"
    NEED_NODE=1
  fi
else
  warn "Node.js not found — installing..."
  NEED_NODE=1
fi

if [ "${NEED_NODE:-0}" = "1" ]; then
  # Try package manager first (may have recent enough version)
  if command -v apt-get &>/dev/null; then
    # Use NodeSource for a recent version on Debian/Ubuntu
    if command -v curl &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
      apt-get install -y -qq nodejs >/dev/null 2>&1
    else
      install_pkg nodejs
    fi
  else
    install_pkg nodejs
  fi

  if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
      log "Node.js $(node -v) installed"
    else
      err "Installed Node.js $(node -v) but need >= 18. Install manually: https://nodejs.org"
    fi
  else
    err "Failed to install Node.js. Install manually: https://nodejs.org"
  fi
fi

# ── Check / Install curl (needed for hooks) ───

if command -v curl &>/dev/null; then
  log "curl found"
else
  warn "curl not found — installing..."
  install_pkg curl
  if command -v curl &>/dev/null; then
    log "curl installed"
  else
    warn "curl not installed — hook integration won't work without it"
  fi
fi

# ── Check / Install cloudflared (tunnel) ───────

if command -v cloudflared &>/dev/null; then
  log "cloudflared $(cloudflared --version 2>&1 | head -1 | awk '{print $3}') found"
else
  warn "cloudflared not found — installing..."
  if command -v apt-get &>/dev/null; then
    # Debian/Ubuntu — install from Cloudflare's repo
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null 2>&1
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo $VERSION_CODENAME) main" | tee /etc/apt/sources.list.d/cloudflared.list >/dev/null 2>&1
    apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq cloudflared >/dev/null 2>&1
  elif command -v brew &>/dev/null; then
    brew install cloudflared >/dev/null 2>&1
  else
    # Direct binary download as fallback
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64)  CF_ARCH="amd64" ;;
      aarch64) CF_ARCH="arm64" ;;
      armv7l)  CF_ARCH="arm" ;;
      *)       CF_ARCH="amd64" ;;
    esac
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /usr/local/bin/cloudflared 2>/dev/null
    chmod +x /usr/local/bin/cloudflared 2>/dev/null
  fi

  if command -v cloudflared &>/dev/null; then
    log "cloudflared installed"
  else
    warn "cloudflared not installed — will fall back to localtunnel (has password page)"
  fi
fi

# ── Install AgentDeck ──────────────────────────

if command -v npx &>/dev/null; then
  log "npm/npx available"
else
  # npx comes with npm which comes with node, but check anyway
  warn "npx not found — installing npm..."
  install_pkg npm
fi

echo ""
info "Installing agentdeck..."
npm install -g agentdeck 2>/dev/null || npx agentdeck --help >/dev/null 2>&1 || true

echo ""
echo -e "  ${GREEN}${BOLD}Done!${RESET} Start AgentDeck:"
echo ""
echo -e "  ${BOLD}npx agentdeck${RESET}"
echo ""
echo -e "  ${DIM}Or with Claude Code hooks:${RESET}"
echo -e "  ${BOLD}npx agentdeck setup${RESET}  ${DIM}# auto-configure hooks${RESET}"
echo -e "  ${BOLD}npx agentdeck${RESET}        ${DIM}# start server${RESET}"
echo ""
