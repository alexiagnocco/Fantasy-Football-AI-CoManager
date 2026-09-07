# espn-draft-mcp-server

Interactive ESPN Fantasy Football **draft agent** as an MCP server. Point Claude Desktop (or any MCP client) at it during a live draft and it tracks the board in real time and recommends picks.

Unlike the removed legacy `mcp-server/` draft tools, this module is standalone (no `shared/` dependency), compiles clean under strict TypeScript, and its recommendations account for:

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

## In-person drafts: offline mode + web draft board

If your league drafts in person (ESPN updated later), use manual mode. One bulk load before draft day, then everything runs offline:

```bash
# At home, with network + ESPN cookies in the environment:
npm run snapshot        # saves player pool + league config to data/snapshot.json

# On draft day (no network needed):
npm run web             # opens the draft board at http://localhost:3210
```

The web UI walks you through setup (teams, rounds, your slot), then you click **Drafted** as each pick is announced in the room — snake math attributes every pick to the right team automatically, so your roster builds itself. The **Optimal pick** panel re-scores the board after every pick with the same engine the MCP tools use.

State lives in `data/draft-state.json`, so the MCP server and the web UI stay in sync: while a manual session is active, all four MCP tools automatically use it instead of the ESPN live feed. That means you can click picks in the browser and simultaneously ask Claude Desktop "who should I take and why?" for a deeper discussion. Undo and session reset are in the UI header; a browser or laptop restart loses nothing.

## Non-ESPN leagues (Yahoo): league profiles

Manual mode also covers leagues hosted elsewhere. A **league profile** (`profiles/*.json`) describes the league's lineup, bench, and a scoring map; the snapshot then pulls ESPN's *public, league-independent* projection feed (no league id, no cookies) and re-scores every player with the profile's rules. The result is a board that knows nothing about your ESPN league — different data directory, different port, different MCP server entry, no shared state.

`profiles/yahoo-816469.json` is Jake's Agreeable League (Yahoo): 10 teams, 1 QB / 2 RB / 2 WR / 1 TE / 2 W/R/T / K / DEF + 6 bench = 16 rounds, full PPR, 6-pt passing TDs.

```bash
npm run snapshot:yahoo   # -> data/yahoo/snapshot.json (already committed; re-run for fresh injury flags)
npm run web:yahoo        # draft board at http://localhost:3211, state in data/yahoo/draft-state.json
```

In the Yahoo draft room, click **Drafted** on the board for every pick as it happens (yours included); the Optimal pick panel is scored for the Yahoo format. To also have Claude Desktop in the loop, add a **separate** MCP entry pinned to the Yahoo data directory. `DRAFT_MODE=manual` guarantees it can never fall back to the ESPN live feed:

```json
"yahoo-draft": {
  "command": "node",
  "args": ["/absolute/path/to/fantasy-engine/draft-agent/dist/index.js"],
  "env": {
    "DRAFT_MODE": "manual",
    "DRAFT_DATA_DIR": "/absolute/path/to/fantasy-engine/draft-agent/data/yahoo"
  }
}
```

To profile another league, copy the JSON, edit `starterSlots` (use the agent's slot names: `FLEX` for W/R/T, `DST` for DEF, `OP` for superflex) and the `scoring` map (ESPN stat ids -> points). Offensive ids are verified against live ESPN totals; K and DST ids are best-effort, which is fine for positions drafted in the last two rounds.

Known limits of profile mode: ADP is ESPN's, not Yahoo's, so the "gone by your next pick" estimate reflects ESPN drafters; and player ids are ESPN ids, which only matters if you try to reconcile against a Yahoo export later.

## Using it during a live online draft

1. Before the draft: *"Give me the strategy guide for my league."*
2. When the draft opens: *"What's the draft state?"*
3. On (or near) your turn: *"Who should I pick?"* — repeat every turn; each call refetches the live board.

The recommendation engine is deterministic and explainable: every candidate comes back with its score components (open-slot fit, tier cliff to your next pick, ADP value, bye conflicts, injury flags) so the model driving it can argue with it intelligently.
