# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ESPN Fantasy Football AI Manager — automates team management for ESPN Fantasy Football private leagues using AI-driven decisions. Scheduled analysis runs as a Claude cloud routine (daily reports committed to the `reports` branch); interactive use goes through MCP servers for Claude Desktop / Claude Code, providing lineup optimization, waiver analysis, and trade recommendations.

There is **no web frontend**. This is a backend/automation-only repository.

## Tech Stack

**Automation**: Claude Code cloud routine (scheduled daily reports); TypeScript/Node.js Commander CLI in `automation/` for manual runs
**MCP Server**: Model Context Protocol for Claude Desktop integration
**Backend API**: Node.js, Express 4, TypeScript, Puppeteer (ESPN auth), node-cache
**LLM Provider**: Claude only (`claude-sonnet-5` default via `CLAUDE_MODEL`)
**Architecture**: Dual-mode system (Claude cloud routine scheduled jobs + Claude Desktop interactive)

## Project Structure

```
fantasy-engine/
├── shared/           # Core library — everything else depends on this
│   └── src/
│       ├── config/       # LLM provider config + selection
│       ├── constants/    # ESPN roster slot maps
│       ├── services/     # espnApi, fantasyProsApi, costMonitor, abTesting, llm/providers
│       ├── tools/        # aiWorkflowOrchestrator, feedbackLoop
│       └── types/
├── automation/       # Analysis CLI (formerly driven by GitHub Actions; now manual-run only)
│   └── src/commands/     # thursday, sunday, monday, tuesday, phase4, workflow
├── mcp-server/       # Claude Desktop MCP integration (see Known Issues)
│   └── src/tools/        # MCP tools for fantasy operations
├── draft-agent/      # Standalone interactive draft MCP server (no shared/ dependency; compiles clean)
│   ├── src/              # espnClient, draftMath (snake picks), strategy (VORP/needs/scoring), 4 MCP tools
│   │                     # plus snapshot.ts (offline bulk load), webServer.ts (local draft board :3210)
│   ├── web/              # single-page manual draft board served by webServer
│   └── analysis/         # Python league-history toolkit (fetch_history.py, analyze_history.py)
└── server/           # Local Express API for ESPN auth + manual exploration
    └── src/
        ├── routes/       # auth, espn, test
        └── services/     # espnAuth (Puppeteer), manualAuth, espnApi, espnDebug
```

Historical docs and one-off scripts live in `docs/archive/` (see its README); nothing there is maintained. `mcp-server/`'s seven usage guides were archived there — the draft agent replaced its draft features.

`shared/` is consumed via `file:../shared` by both `automation/` and `mcp-server/`. Changing anything in `shared/` requires rebuilding it before dependents pick it up — the `build` scripts in those two modules do this automatically.

## Essential Commands

### Build & Test
```bash
# Automation CLI (this is what CI builds — build shared first, handled by the script)
cd fantasy-engine/automation && npm ci && npm run build
node dist/cli.js --help          # or: npm test

# Shared library on its own
cd fantasy-engine/shared && npm ci && npm run build

# Local API server
cd fantasy-engine/server && npm run dev     # http://localhost:3003
cd fantasy-engine/server && npm run build && npm start

# Draft agent
cd fantasy-engine/draft-agent && npm ci && npm run build
npm test                # pick math + strategy unit tests
npm run snapshot        # bulk-load player pool to data/snapshot.json (offline drafting)
npm run web             # manual draft board at http://localhost:3210
python3 analysis/fetch_history.py    # pull all past seasons from ESPN leagueHistory API
python3 analysis/analyze_history.py  # champions/rivals/H2H/transactions digest -> analysis/out/
```

### Automation CLI commands
```bash
node dist/cli.js <command>
# Scheduled day jobs: thursday | sunday | monday | tuesday
# Intelligence:       intelligence | realtime | learning | analytics | seasonal | emergency
# Utility:            init | roster | workflow | cost
```

## Scheduled automation (Claude cloud routine)

The GitHub Actions workflow was retired (2026-08-29). Scheduled analysis now runs as the **"fantasy-daily-report" Claude Code cloud routine** on a Claude subscription:

- **NFL-season-only** cron `0 13 * 9-12,1 *` (13:01 UTC daily, September–January).
- Each run: preflight env-var check → curl the ESPN API directly → write a ~1-page report (roster health, matchup, start/sit, top-5 waivers with FAAB, urgent item) → commit `reports/<YYYY-MM-DD>.md` to the `reports` branch. Pre-draft/preseason it writes a status note instead.
- Runs in the DEVKIT cloud environment, which holds `ESPN_S2`, `ESPN_SWID`, `LEAGUE_1_ID`, `LEAGUE_1_TEAM_ID` as env vars and allows outbound HTTPS to `lm-api-reads.fantasy.espn.com` (the other environments block it).
- Manage/debug at claude.ai → Code → Routines, or via the RemoteTrigger API (`list_runs` / `get_run_log`).
- **There is no CI.** Nothing builds on push or PR; verify with the local build commands above before pushing.

## ESPN Integration

### Season year — computed, not hardcoded
`getCurrentNFLSeasonYear()` derives the season from the current date: Jan/Feb belong to the previous season's playoffs/offseason, everything else to the season starting that year.

It is currently **duplicated in four places** that must be kept in sync:
- `shared/src/services/espnApi.ts` (exported; also used by `fantasyProsApi.ts`)
- `server/src/services/espnApi.ts` (exported; used by all three route files)
- `mcp-server/src/services/espnApi.ts` (private static) and an inline copy in `mcp-server/src/services/draftApi.ts`
- `draft-agent/src/constants.ts` (exported; kept local so that module stays standalone)

Known edge: from March onward the helper returns the current year, but ESPN may not have opened that season yet, which can 404 during the spring offseason.

### Authentication
Dual strategy against ESPN's DisneyID login:

1. **Puppeteer automation** (`server/src/services/espnAuth.ts`) — headless Chrome, handles iframe and modal login forms, extracts `espn_s2` and `SWID`, caches the session for 1 hour via node-cache.
2. **Manual cookie input** (`server/src/services/manualAuth.ts`) — fallback when ESPN changes break automation. Cookies are validated against the ESPN API before being stored.

In the cloud routine there is no Puppeteer step; cookies come straight from the cloud environment's `ESPN_S2` / `ESPN_SWID` env vars.

### Cookie handling
- `espn_s2`: long auth token (200+ chars)
- `SWID`: UUID in curly braces, e.g. `{UUID}`
- Both required for private leagues; cookie domain is `fantasy.espn.com`
- Stored server-side only; passed to the local API via `X-ESPN-S2` / `X-ESPN-SWID` headers

### Base URL
`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/`

### Local server endpoints
```
POST /api/auth/login                                    Puppeteer authentication
POST /api/auth/manual-login                             Manual cookie authentication
POST /api/auth/public-login                             Public-league access check
POST /api/auth/logout
GET  /api/auth/cookie-instructions
GET  /api/auth/debug-login
GET  /api/espn/league/:leagueId                         League metadata
GET  /api/espn/league/:leagueId/teams
GET  /api/espn/league/:leagueId/team/:teamId/roster     Roster with players
GET  /api/espn/league/:leagueId/players                 Available players
GET  /api/espn/league/:leagueId/matchups/:week
GET  /api/espn/league/:leagueId/transactions
POST /api/test/test-cookies | test-public-league | test-endpoint
```

## LLM Layer

Claude is the only provider (`shared/src/services/llm/providers/`: `base`, `claude`). The Gemini, OpenAI, and Perplexity providers were removed 2026-08-29.

- Default model is **`claude-sonnet-5`**; override with the `CLAUDE_MODEL` env var rather than editing code. Key comes from `CLAUDE_API_KEY` or `ANTHROPIC_API_KEY`.
- Current Claude models reject the `temperature` parameter with a 400, so `ClaudeProvider.chat()` intentionally never sends it.
- Model pricing tables are hardcoded in `getPricing()` (per 1M tokens) and `enhancedCostMonitor.ts` (per 1K tokens). Both need updating together when rates change.

## Development Patterns

### Adding a new ESPN endpoint
1. Add the method to `shared/src/services/espnApi.ts` (and mirror it in `server/src/services/espnApi.ts` if the local API needs it)
2. Add types to `shared/src/types/`
3. Expose a route in `server/src/routes/espn.ts` if it should be reachable locally
4. Surface it to automation via `shared/src/tools/` or to Claude Desktop via `mcp-server/src/tools/`

### Error handling
- **401**: cookies expired or invalid — re-authenticate
- **HTML response instead of JSON**: ESPN returned a login page — auth failed
- **Empty roster**: expected before the league drafts; only treat as a credential problem if the draft has already happened
- **Network errors**: handled by Axios interceptors

## Environment Setup

Copy `.env.example` and fill in. Required for any real run:

```bash
ESPN_S2=...            # ESPN auth cookie
ESPN_SWID={...}        # ESPN SWID, braces included
LEAGUE_1_ID=...        # plus LEAGUE_1_TEAM_ID, LEAGUE_1_NAME
CLAUDE_API_KEY=...     # or ANTHROPIC_API_KEY (only needed for API-based CLI runs)
```

Optional: `LEAGUE_2_*`, `CLAUDE_MODEL`, `FANTASYPROS_SESSION_ID` (or email/password), `DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `NEWS_API_KEY`, `OPENWEATHER_API_KEY`, `ENABLE_FANTASYPROS` / `ENABLE_NEWS` / `ENABLE_WEATHER`, and the cost limits (`DAILY_COST_LIMIT`, `WEEKLY_COST_LIMIT`, `MONTHLY_COST_LIMIT`, `PER_ANALYSIS_LIMIT`).

For the cloud routine, these live as env vars on the DEVKIT cloud environment (claude.ai → Code → environment settings); no API key is needed there.

`PORT` (default 3003) applies to the local server only.

### Puppeteer / Chromium
Only needed for the local server's automated login path.
```bash
brew install chromium                        # macOS
sudo apt-get install -y chromium-browser     # Debian/Ubuntu
# or let Puppeteer download its own
```

## Known Issues & Limitations

- **`mcp-server/` does not compile.** It has ~40 pre-existing TypeScript errors: missing deps in its `package.json` and imports referencing exports `shared` no longer has (including the removed Gemini/OpenAI/Perplexity providers). Nothing builds it.
- **`shared/` and `mcp-server/` contain duplicated copies** of `enhancedCostMonitor.ts`, `costMonitor.ts`, `abTesting.ts`, `espnApi.ts`, and `feedbackLoop.ts` (mcp-server also still carries the removed providers). `mcp-server/` is legacy and was not updated in the Claude-only migration — treat `shared/` as authoritative.
- ESPN cookies (`espn_s2`/`SWID`) expire roughly monthly; the cloud routine's reports will flag a 401 when they do — refresh them in the DEVKIT environment settings.
- The local server's CORS origin is still pinned to `http://localhost:5173`, left over from a removed React client. Harmless but vestigial.
- Single concurrent user session in the local server (last login wins); no database persistence (memory only).
- ESPN rate limiting is not handled and will surface as 429s.

## Development Guidelines

1. **Build `shared/` first** — dependents consume its compiled `dist/`
2. **Mirror edits into `mcp-server/`** while the duplication exists
3. **Never hardcode a season year** — use `getCurrentNFLSeasonYear()`
4. **Never hardcode a model name** — use `CLAUDE_MODEL` and the provider config
5. **Verify with `cd fantasy-engine/automation && npm run build`** — there is no CI, so this local check is the only gate
6. Respect ESPN rate limits; test locally before pushing changes
