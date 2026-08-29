# espn-draft-mcp-server

Interactive ESPN Fantasy Football **draft agent** as an MCP server. Point Claude Desktop (or any MCP client) at it during a live draft and it tracks the board in real time and recommends picks.

Unlike the legacy `mcp-server/` draft tools, this module is standalone (no `shared/` dependency), compiles clean under strict TypeScript, and its recommendations account for:

- **Your draft position** - snake-aware pick math: it knows your exact upcoming pick numbers and plans against them.
- **Who remains** - live board from ESPN's draft detail feed; VORP computed against replacement level derived from *your league's actual lineup slots*.
- **Spots to be filled** - open starter slots vs bench, with FLEX eligibility handled properly.
- **The season schedule** - real bye weeks from ESPN's pro-team schedules; warns on bye stacking.
- **Format-specific strategy** - tuned for half-PPR, 11 teams, 1 QB / 2 RB / 2 WR / 1 TE / 1 FLEX / 1 K (read live from ESPN, so it adapts if settings differ): RB-anchored early rounds, QB/TE in the middle-round value window, kicker never before the final two rounds, no backup QB/TE, upside-first bench.

## Tools

| Tool | Purpose |
|---|---|
| `draft_get_state` | Live snapshot: progress, who's on the clock, your roster, open slots, your upcoming picks |
| `draft_best_available` | Remaining players ranked by VORP with tiers, ADP, byes, injury flags (position filter) |
| `draft_recommend_pick` | Scored recommendation with reasons + who'll be gone by your next pick |
| `draft_strategy_guide` | Round-by-round plan for this league's exact format |

## Setup

```bash
cd fantasy-engine/draft-agent
npm install && npm run build
npm test            # unit tests for pick math + strategy engine
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "espn-draft": {
      "command": "node",
      "args": ["/absolute/path/to/fantasy-engine/draft-agent/dist/index.js"],
      "env": {
        "ESPN_S2": "<espn_s2 cookie>",
        "ESPN_SWID": "{<uuid>}",
        "LEAGUE_ID": "<league id>",
        "TEAM_ID": "<your team id>"
      }
    }
  }
}
```

`ESPN_S2`/`ESPN_SWID` are required for private leagues (grab them from a logged-in browser: DevTools → Application → Cookies → fantasy.espn.com). `LEAGUE_1_ID` / `LEAGUE_1_TEAM_ID` are also accepted, matching the rest of this repo.

## Using it during a live draft

1. Before the draft: *"Give me the strategy guide for my league."*
2. When the draft opens: *"What's the draft state?"*
3. On (or near) your turn: *"Who should I pick?"* — repeat every turn; each call refetches the live board.

The recommendation engine is deterministic and explainable: every candidate comes back with its score components (open-slot fit, tier cliff to your next pick, ADP value, bye conflicts, injury flags) so the model driving it can argue with it intelligently.
