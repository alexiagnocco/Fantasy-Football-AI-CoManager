#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Installs dependencies and pre-builds the modules that matter:
#  - shared:     core library everything depends on (must be built first)
#  - automation: the only module CI builds
#  - server:     local Express API (installed so it can be type-checked/edited)
#  - mcp-server: deps installed for editing only — it has known pre-existing
#    TypeScript errors and is intentionally NOT built here (see CLAUDE.md)
set -euo pipefail

# Only run in Claude Code on the web (remote) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ENGINE="$CLAUDE_PROJECT_DIR/fantasy-engine"

echo "[session-start] Installing shared dependencies..."
cd "$ENGINE/shared"
npm install --no-audit --no-fund
echo "[session-start] Building shared..."
npm run build

echo "[session-start] Installing automation dependencies..."
cd "$ENGINE/automation"
npm install --no-audit --no-fund
echo "[session-start] Building automation..."
# Use tsc directly: the package's build script re-runs `npm ci` in shared,
# which we've already installed and built above.
npx tsc

echo "[session-start] Installing and building draft-agent..."
cd "$ENGINE/draft-agent"
npm install --no-audit --no-fund
npx tsc

echo "[session-start] Installing server dependencies..."
cd "$ENGINE/server"
npm install --no-audit --no-fund

echo "[session-start] Installing mcp-server dependencies (no build - known TS errors)..."
cd "$ENGINE/mcp-server"
npm install --no-audit --no-fund || echo "[session-start] mcp-server install failed (non-fatal)"

echo "[session-start] Done."
