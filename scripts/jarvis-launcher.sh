#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export JARVIS_ALLOWED_ROOT="${JARVIS_ALLOWED_ROOT:-$ROOT_DIR}"
npm run bridge &
BRIDGE_PID=$!
trap 'kill "$BRIDGE_PID" 2>/dev/null || true' EXIT INT TERM
npm run dev
