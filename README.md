# Fantasy Football AI CoManager 🏈🤖

AI-driven management for ESPN Fantasy Football private leagues. The system runs as a scheduled Claude cloud routine and as MCP servers for Claude Desktop / Claude Code — daily reports, lineup optimization, waiver analysis, and a live draft agent. Backend/automation only; there is no web frontend (the draft agent ships a small local draft board for in-person drafts).

## What's in the repo

```
fantasy-engine/
├── shared/           # Core library: ESPN API client, Claude LLM provider, cost monitoring
├── automation/       # CLI for scheduled/manual analysis runs (legacy GitHub Actions era)
├── draft-agent/      # Standalone draft MCP server + offline draft board + league history analysis
└── server/           # Local Express API for ESPN auth (Puppeteer) + manual exploration
docs/archive/         # Historical docs and scripts, kept for reference only
reports/ (branch)     # Daily reports committed by the Claude cloud routine
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

## Scheduled automation (Claude cloud routine)

Daily analysis runs as a **Claude Code cloud routine** ("fantasy-daily-report") on a Claude subscription — no API keys, no GitHub Actions:

- **NFL season only** (September–January), daily at 13:01 UTC (9:01am ET).
- Each run checks the ESPN league state, writes a ~1-page report (roster health, matchup outlook, start/sit, waiver targets with FAAB bids), and commits it as `reports/<date>.md` on the `reports` branch.
- Configuration lives in the routine (claude.ai → Code → Routines) and its cloud environment's env vars: `ESPN_S2`, `ESPN_SWID`, `LEAGUE_1_ID`, `LEAGUE_1_TEAM_ID` (optional `DISCORD_WEBHOOK_URL`).
- ESPN cookies expire roughly monthly; refresh them in the environment settings when reports flag a 401.

The old GitHub Actions workflow (`fantasy-phase4-intelligence.yml`) was retired in favor of this routine. The `automation/` CLI it drove still builds and can be run manually:

```bash
cd fantasy-engine/automation && npm ci && npm run build
node dist/cli.js --help
```

## ESPN authentication

Private leagues need two cookies from a logged-in browser (DevTools → Application → Cookies → `fantasy.espn.com`):

- `espn_s2` — long auth token (200+ chars), keep it URL-encoded exactly as shown
- `SWID` — UUID in curly braces, e.g. `{123-456-789}`

Cookies expire after ~30 days. They go in the cloud environment's env vars (scheduled routine), the MCP `env` block or `.env` (draft agent), or headers to the local server. The local server (`fantasy-engine/server`, port 3003) can alternatively automate login with Puppeteer.

League and team IDs come from your league URL: `…/league?leagueId=XXXX` and `…/team?…&teamId=N`.

## LLM

Claude is the only provider (`shared/src/services/llm/providers/claude.ts`). Set `CLAUDE_API_KEY` (or `ANTHROPIC_API_KEY`) for API-based runs of the `automation/` CLI; override the model with `CLAUDE_MODEL` (default `claude-sonnet-5`) — never hardcode model names. Cost limits (`DAILY_COST_LIMIT`, etc.) are enforced by the cost monitor. The scheduled cloud routine needs no API key — it runs on the Claude subscription. Gemini, OpenAI, and Perplexity providers were removed.

## Known issues

See the **Known Issues & Limitations** section of [CLAUDE.md](./CLAUDE.md) for the authoritative list. Highlights:

- ESPN rate limiting is not handled (surfaces as 429s), and the unofficial ESPN API can change without notice.

## License

MIT. Not affiliated with ESPN or Disney — use responsibly and within ESPN's terms of service.
