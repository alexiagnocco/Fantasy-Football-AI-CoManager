# Fantasy Football AI CoManager 🏈🤖

AI-driven management for ESPN Fantasy Football private leagues. The system runs as scheduled GitHub Actions automation and as MCP servers for Claude Desktop / Claude Code — lineup optimization, waiver analysis, trade recommendations, and a live draft agent. Backend/automation only; there is no web frontend (the draft agent ships a small local draft board for in-person drafts).

## What's in the repo

```
fantasy-engine/
├── shared/           # Core library: ESPN API client, LLM providers, cost monitoring
├── automation/       # GitHub Actions CLI (the only module CI builds)
├── draft-agent/      # Standalone draft MCP server + offline draft board + league history analysis
├── mcp-server/       # Legacy Claude Desktop MCP integration (unmaintained, does not compile)
└── server/           # Local Express API for ESPN auth (Puppeteer) + manual exploration
docs/archive/         # Historical docs and scripts, kept for reference only
```

- **[CLAUDE.md](./CLAUDE.md)** — full developer guide: build commands, architecture, known issues.
- **[fantasy-engine/draft-agent/README.md](./fantasy-engine/draft-agent/README.md)** — draft agent setup and usage.

## The draft agent (start here)

The newest and healthiest module. An MCP server that tracks a live ESPN draft (or a fully offline in-person draft) and recommends picks with snake-aware pick math, VORP from your league's real lineup slots, bye-week awareness, and format-tuned strategy.

```bash
cd fantasy-engine/draft-agent
npm install && npm run build
npm test

npm run snapshot     # one-time bulk load of the player pool (for offline drafting)
npm run web          # local draft board at http://localhost:3210
```

Point Claude Desktop or Claude Code at `dist/index.js` (config in the module README). The web board and the MCP tools share state, so you can click picks in the browser while asking Claude "who should I take and why?"

It also includes a **league history analysis toolkit** (`analysis/`): pulls every past season from ESPN's `leagueHistory` API and reports champion draft construction, rival draft tendencies, head-to-head records, and trade/waiver patterns.

```bash
python3 analysis/fetch_history.py      # pulls all seasons (uses .env credentials)
python3 analysis/analyze_history.py    # prints the digest, writes analysis/out/analysis.json
```

## GitHub Actions automation

A single workflow, `.github/workflows/fantasy-phase4-intelligence.yml`, drives everything:

- **NFL season only** (September–January). Nothing runs February–August except manual dispatch.
- Daily analysis at 13:00 UTC; game-day monitoring every 4h on Sun/Mon/Thu; waiver analysis Tuesdays 14:00 UTC.
- Manual runs via `workflow_dispatch` with `intelligence_mode` (full / realtime / learning / analytics / seasonal / emergency), `week`, and `force_execution`.
- Results post to Discord via webhook.

Setup: fork, then add repository **secrets** (`ESPN_S2`, `ESPN_SWID`, `LEAGUE_1_ID`, `LEAGUE_1_TEAM_ID`, `GEMINI_API_KEY`, `DISCORD_WEBHOOK_URL`, …) and optional **variables** (`GEMINI_MODEL`, `PRIMARY_LLM_PROVIDER`). See `.env.example` for the full list.

```bash
# What CI builds — verify changes against this
cd fantasy-engine/automation && npm ci && npm run build
node dist/cli.js --help
```

## ESPN authentication

Private leagues need two cookies from a logged-in browser (DevTools → Application → Cookies → `fantasy.espn.com`):

- `espn_s2` — long auth token (200+ chars), keep it URL-encoded exactly as shown
- `SWID` — UUID in curly braces, e.g. `{123-456-789}`

Cookies expire after ~30 days. They go in GitHub secrets (automation), the MCP `env` block or `.env` (draft agent), or headers to the local server. The local server (`fantasy-engine/server`, port 3003) can alternatively automate login with Puppeteer.

League and team IDs come from your league URL: `…/league?leagueId=XXXX` and `…/team?…&teamId=N`.

## LLM providers

Gemini is the default; Claude, OpenAI, and Perplexity are supported (`shared/src/services/llm/providers/`). Select with `PRIMARY_LLM_PROVIDER` / `FALLBACK_LLM_PROVIDER`; override the Gemini model with `GEMINI_MODEL` — never hardcode model names. Cost limits (`DAILY_COST_LIMIT`, etc.) are enforced by the cost monitor.

## Known issues

See the **Known Issues & Limitations** section of [CLAUDE.md](./CLAUDE.md) for the authoritative list. Highlights:

- `mcp-server/` does not compile (~40 pre-existing TypeScript errors) and is effectively legacy; the draft agent replaced its draft features. CI only builds `automation/`.
- `shared/` and `mcp-server/` contain duplicated service files that must be edited in both places.
- ESPN rate limiting is not handled (surfaces as 429s), and the unofficial ESPN API can change without notice.

## License

MIT. Not affiliated with ESPN or Disney — use responsibly and within ESPN's terms of service.
