#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Uptime Detective — Install Script
# Installs and configures the application for bare-metal / LXC deployment
# Requires: root privileges (Node.js 24 is installed automatically if missing)
# ─────────────────────────────────────────────────────────────────────────────

APP_NAME="uptime-detective"
APP_DIR="/opt/${APP_NAME}"
DATA_DIR="${APP_DIR}/data"
CONFIG_DIR="/etc/${APP_NAME}"
SERVICE_USER="${APP_NAME}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

# Colours for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Colour

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─────────────────────────────────────────────────────────────────────────────
# Pre-checks
# ─────────────────────────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root (or with sudo)."
    exit 1
fi

REQUIRED_NODE_MAJOR=24

if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt "$REQUIRED_NODE_MAJOR" ]]; then
    info "Installing Node.js ${REQUIRED_NODE_MAJOR}.x..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | bash -
        apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
        curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | bash -
        dnf install -y nodejs
    elif command -v yum &>/dev/null; then
        curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | bash -
        yum install -y nodejs
    else
        error "Unsupported package manager. Install Node.js ${REQUIRED_NODE_MAJOR}+ manually."
        exit 1
    fi
fi

NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [[ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]]; then
    error "Node.js ${REQUIRED_NODE_MAJOR}+ is required. Found: $(node -v)"
    exit 1
fi

if ! command -v npm &>/dev/null; then
    error "npm is not installed."
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Create system user
# ─────────────────────────────────────────────────────────────────────────────

if ! id "$SERVICE_USER" &>/dev/null; then
    info "Creating system user '${SERVICE_USER}'..."
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Install application
# ─────────────────────────────────────────────────────────────────────────────

info "Installing to ${APP_DIR}..."
mkdir -p "$APP_DIR"

# Determine source directory (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Install dependencies and build
info "Installing dependencies..."
cd "$SCRIPT_DIR"
npm ci

info "Building application..."
npm run build

# Copy built artefacts to install directory
info "Copying built files..."
cp -f "$SCRIPT_DIR/package.json" "$APP_DIR/"
cp -rf "$SCRIPT_DIR/node_modules" "$APP_DIR/"
cp -rf "$SCRIPT_DIR/shared/package.json" "$APP_DIR/shared/" 2>/dev/null || mkdir -p "$APP_DIR/shared"
cp -rf "$SCRIPT_DIR/shared/dist" "$APP_DIR/shared/"
cp -rf "$SCRIPT_DIR/server/package.json" "$APP_DIR/server/" 2>/dev/null || mkdir -p "$APP_DIR/server"
cp -rf "$SCRIPT_DIR/server/dist" "$APP_DIR/server/"
cp -rf "$SCRIPT_DIR/client/dist" "$APP_DIR/client/" 2>/dev/null || mkdir -p "$APP_DIR/client"

# Prune dev dependencies from install dir
info "Pruning dev dependencies..."
cd "$APP_DIR"
npm prune --omit=dev 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────────────
# Data directory
# ─────────────────────────────────────────────────────────────────────────────

info "Setting up data directory..."
mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

info "Setting up configuration..."
mkdir -p "$CONFIG_DIR"

if [[ ! -f "${CONFIG_DIR}/env" ]]; then
    JWT_SECRET=$(openssl rand -base64 32)
    cat > "${CONFIG_DIR}/env" <<EOF
# Uptime Detective configuration
# See .env.example for all available options

PORT=3300
HOST=0.0.0.0
DB_PATH=${DATA_DIR}/${APP_NAME}.db
JWT_SECRET=${JWT_SECRET}
SESSION_EXPIRY=7d
ALLOW_PRIVATE_IPS=true

# Optional: SMTP for email notifications
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=
EOF
    chmod 600 "${CONFIG_DIR}/env"
    chown root:${SERVICE_USER} "${CONFIG_DIR}/env"
    info "Generated config at ${CONFIG_DIR}/env (edit as needed)."
else
    warn "Config file ${CONFIG_DIR}/env already exists — skipping."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Systemd service
# ─────────────────────────────────────────────────────────────────────────────

info "Installing systemd service..."
cp "$SCRIPT_DIR/uptime-detective.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable "$APP_NAME"

# ─────────────────────────────────────────────────────────────────────────────
# Set ownership
# ─────────────────────────────────────────────────────────────────────────────

chown -R root:root "$APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────

info ""
info "════════════════════════════════════════════════════════════"
info " Uptime Detective installed successfully!"
info "════════════════════════════════════════════════════════════"
info ""
info " Config:   ${CONFIG_DIR}/env"
info " Data:     ${DATA_DIR}/"
info " Service:  ${APP_NAME}.service"
info ""
info " Commands:"
info "   systemctl start ${APP_NAME}     # Start the service"
info "   systemctl status ${APP_NAME}    # Check status"
info "   journalctl -u ${APP_NAME} -f    # Follow logs"
info ""
info " The app will be available at http://<your-ip>:3300"
info ""
