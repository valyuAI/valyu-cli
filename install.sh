#!/bin/sh
# Valyu CLI installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/valyuAI/valyu-cli/main/install.sh | bash
#
# Install specific version:
#   curl -fsSL https://raw.githubusercontent.com/valyuAI/valyu-cli/main/install.sh | bash -s -- v1.0.2
#
set -e

VERSION="${1:-}"
REPO="valyuAI/valyu-cli"
INSTALL_DIR="${VALYU_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="valyu"
GITHUB_API="https://api.github.com/repos/${REPO}"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

info() { printf "${CYAN}==> ${NC}%s\n" "$1"; }
ok()   { printf "${GREEN} ✓  ${NC}%s\n" "$1"; }
err()  { printf "${RED}Error:${NC} %s\n" "$1" >&2; exit 1; }

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)   OS="linux" ;;
  Darwin*)  OS="darwin" ;;
  *)        err "Unsupported OS: $OS" ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             err "Unsupported architecture: $ARCH" ;;
esac

TARGET="valyu-${OS}-${ARCH}"

# Resolve version
if [ -z "$VERSION" ]; then
  info "Fetching latest release..."
  VERSION=$(curl -fsSL "${GITHUB_API}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
  [ -z "$VERSION" ] && err "Could not determine latest release"
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARGET}.tar.gz"
CHECKSUM_URL="${DOWNLOAD_URL}.sha256"

info "Installing Valyu CLI ${VERSION} (${OS}/${ARCH})..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download to temp dir
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/valyu.tar.gz"

# Verify SHA256 checksum if available
if curl -fsSL "$CHECKSUM_URL" -o "$TMPDIR/valyu.tar.gz.sha256" 2>/dev/null; then
  EXPECTED=$(cat "$TMPDIR/valyu.tar.gz.sha256" | awk '{print $1}')
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$TMPDIR/valyu.tar.gz" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$TMPDIR/valyu.tar.gz" | awk '{print $1}')
  else
    ACTUAL=""
  fi
  if [ -n "$ACTUAL" ] && [ "$EXPECTED" != "$ACTUAL" ]; then
    err "Checksum verification failed.\n  Expected: $EXPECTED\n  Actual:   $ACTUAL"
  fi
  [ -n "$ACTUAL" ] && ok "Checksum verified"
fi

# Extract and install
tar -xzf "$TMPDIR/valyu.tar.gz" -C "$TMPDIR"
mv "$TMPDIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

ok "Valyu CLI ${VERSION} installed to ${INSTALL_DIR}/${BINARY_NAME}"

# Check if in PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    printf "${DIM}Add to your PATH:${NC}\n"
    SHELL_NAME="$(basename "$SHELL")"
    case "$SHELL_NAME" in
      zsh)  echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
      bash) echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
      fish) echo "  fish_add_path ${INSTALL_DIR}" ;;
      *)    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
    esac
    ;;
esac

echo ""
echo "Run 'valyu --help' to get started."
