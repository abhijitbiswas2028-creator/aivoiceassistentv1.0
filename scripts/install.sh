#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
npm install
npx playwright install chromium
mkdir -p "$HOME/.local/share/applications"
DESKTOP_FILE="$HOME/.local/share/applications/jarvis-voice.desktop"
printf '[Desktop Entry]\nType=Application\nName=JARVIS Voice\nExec=%s/scripts/jarvis-launcher.sh\nTerminal=true\nCategories=Utility;\n' "$ROOT_DIR" > "$DESKTOP_FILE"
chmod +x scripts/jarvis-launcher.sh scripts/install.sh scripts/uninstall.sh
echo "Installed launcher: $DESKTOP_FILE"
