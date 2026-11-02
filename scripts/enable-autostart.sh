#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
printf '[Desktop Entry]\nType=Application\nName=JARVIS Voice\nExec=%s/scripts/jarvis-launcher.sh\nTerminal=true\nX-GNOME-Autostart-enabled=true\n' "$ROOT_DIR" > "$AUTOSTART_DIR/jarvis-voice.desktop"
echo "Enabled JARVIS autostart. Run npm run disable-autostart to remove it."
