#!/usr/bin/env node
/**
 * ESPN Fantasy Football interactive draft agent - MCP server (stdio).
 *
 * Tools:
 *   draft_get_state       - live draft snapshot: picks, whose turn, your roster & open slots
 *   draft_best_available  - remaining players ranked with VORP, tiers, ADP, bye weeks
 *   draft_recommend_pick  - scored pick recommendation for your next selection
 *   draft_strategy_guide  - round-by-round strategy for this league's exact format
 *
 * Env: LEAGUE_ID (or LEAGUE_1_ID), TEAM_ID (or LEAGUE_1_TEAM_ID),
 *      ESPN_S2 + ESPN_SWID (required for private leagues).
 */
import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { espnClient, describeEspnError } from "./services/espnClient.js";
import { teamPickNumbers, nextPickAtOrAfter, followingPick } from "./lib/draftMath.js";
import {
  rankPool,
  computeRosterNeeds,
  scoreCandidates,
  roundAdvice,
  strategyGuide,
  availabilityAtPick,
} from "./lib/strategy.js";
import { buildRecommendation } from "./lib/recommend.js";
import { loadManualState, loadSnapshot } from "./manualSession.js";
import { buildManualDraftContext } from "./manualContext.js";
import { DraftContext, PlayerInfo, RankedPlayer } from "./types.js";

const server = new McpServer({
  name: "espn-draft-mcp-server",
  version: "1.0.0",
});

function resolveLeagueId(arg?: string): string {
  const id = arg || process.env.LEAGUE_ID || process.env.LEAGUE_1_ID;
  if (!id) {
    throw new Error(
      "No league ID. Pass leagueId or set LEAGUE_ID / LEAGUE_1_ID in the environment."
    );
  }
  return id;
}

function resolveTeamId(arg?: number): number {
  const id = arg ?? Number(process.env.TEAM_ID || process.env.LEAGUE_1_TEAM_ID || NaN);
  if (!Number.isFinite(id)) {
    throw new Error(
      "No team ID. Pass teamId or set TEAM_ID / LEAGUE_1_TEAM_ID in the environment."
    );
  }
  return id;
}

/**
 * One pass shared by every tool. If a manual (in-person) draft session is
 * active on disk, it takes precedence over the ESPN live feed - see
 * manualSession.ts and the web UI (npm run web).
 */
async function loadContext(leagueIdArg?: string, teamIdArg?: number): Promise<DraftContext> {
  const manual = loadManualState();
  if (manual) {
    const snapshot = loadSnapshot();
    if (!snapshot) {
      throw new Error(
        "A manual draft session is active but no snapshot exists. Run `npm run snapshot` in draft-agent first (needs network + ESPN cookies)."
      );
    }
    return buildManualDraftContext(snapshot, manual);
  }
  const leagueId = resolveLeagueId(leagueIdArg);
  const teamId = resolveTeamId(teamIdArg);
  const [{ state }, pool] = await Promise.all([
    espnClient.getDraftState(leagueId),
    espnClient.getPlayerPool(leagueId),
  ]);

  const byId = new Map(pool.map((p) => [p.id, p]));
  for (const pick of state.picks) {
    const p = byId.get(pick.playerId);
    if (p) {
      pick.playerName = p.name;
      pick.position = p.position;
      pick.proTeam = p.proTeam;
    } else {
      pick.playerName = `Player #${pick.playerId}`;
    }
  }

  const draftedIds = new Set(state.picks.map((p) => p.playerId));
  const ranked = rankPool(pool, state.config);
  const available = ranked
    .filter((p) => !draftedIds.has(p.id))
    .sort((a, b) => b.vorp - a.vorp);

  const myPlayers = state.picks
    .filter((p) => p.teamId === teamId)
    .map((p) => byId.get(p.playerId))
    .filter((p): p is PlayerInfo => Boolean(p));

  const snake = state.draftType === "snake";
  const myPicks = teamPickNumbers(state.pickOrder, teamId, state.totalRounds, snake);
  return {
    state,
    pool,
    ranked,
    available,
    myPlayers,
    myPicks,
    myNextPick: nextPickAtOrAfter(myPicks, state.currentOverallPick),
    myFollowingPick: followingPick(myPicks, state.currentOverallPick),
    myTeamId: teamId,
    manualMode: false,
  };
}

function playerLine(p: RankedPlayer, extra = ""): string {
  const inj = p.injuryStatus ? ` ⚠${p.injuryStatus}` : "";
  return `${p.name} (${p.position}${p.positionalRank} ${p.proTeam}, bye ${p.byeWeek ?? "?"}) - proj ${p.projectedPoints}, VORP ${p.vorp}, tier ${p.tier}, ADP ${p.adp}${inj}${extra}`;
}

const leagueTeamShape = {
  leagueId: z.string().optional().describe("ESPN league ID (defaults to LEAGUE_ID env var)"),
  teamId: z.number().int().optional().describe("Your ESPN team ID (defaults to TEAM_ID env var)"),
};

/* ------------------------------------------------------------------ */
server.registerTool(
  "draft_get_state",
  {
    title: "Get Live Draft State",
    description: `Live snapshot of an ESPN fantasy draft: league format and scoring, draft progress, who is on the clock, recent picks, your roster so far, your open starter slots, and your upcoming pick numbers (snake-aware).

Use this first at the start of a draft session and again whenever picks have been made.

Returns markdown plus structuredContent with: config, currentOverallPick, currentRound, onTheClock, myRoster, openStarterSlots, myUpcomingPicks, recentPicks.`,
    inputSchema: leagueTeamShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const ctx = await loadContext(args.leagueId, args.teamId);
      const { state } = ctx;
      const teamId = ctx.myTeamId;
      const needs = computeRosterNeeds(ctx.myPlayers, state.config);

      const recent = state.picks.slice(-10);
      const upcoming = ctx.myPicks.filter((p) => p >= state.currentOverallPick).slice(0, 5);

      const status = state.completed
        ? "COMPLETED"
        : state.inProgress
          ? "IN PROGRESS"
          : "NOT STARTED";

      const lines = [
        `# Draft State - ${state.config.scoringLabel}, ${state.config.teamCount} teams (${state.draftType}${ctx.manualMode ? ", MANUAL in-person mode" : ""})`,
        `**Status**: ${status} | **Pick**: ${state.currentOverallPick}/${state.totalPicks} (round ${state.currentRound}/${state.totalRounds})`,
        state.onTheClockTeamName ? `**On the clock**: ${state.onTheClockTeamName}${state.onTheClockTeamId === teamId ? " ← **THAT'S YOU**" : ""}` : "",
        `**Your upcoming picks**: ${upcoming.join(", ") || "none left"}`,
        "",
        `## Your roster (${ctx.myPlayers.length} players)`,
        ...ctx.myPlayers.map((p) => `- ${p.name} (${p.position} ${p.proTeam}, bye ${p.byeWeek ?? "?"}) - proj ${p.projectedPoints}`),
        "",
        `**Open starter slots**: ${Object.entries(needs.openStarterSlots).map(([s, n]) => `${s}×${n}`).join(", ") || "all filled"} | **Bench left**: ${needs.benchSpotsLeft}`,
        "",
        "## Last 10 picks",
        ...recent.map((p) => `- #${p.overallPick} (R${p.round}) ${p.teamName}: ${p.playerName} ${p.position ? `(${p.position} ${p.proTeam})` : ""}${p.keeper ? " [keeper]" : ""}`),
      ].filter((l) => l !== "");

      const output = {
        status,
        config: state.config,
        draftType: state.draftType,
        currentOverallPick: state.currentOverallPick,
        currentRound: state.currentRound,
        totalRounds: state.totalRounds,
        onTheClock: state.onTheClockTeamName,
        youAreOnTheClock: state.onTheClockTeamId === teamId,
        myUpcomingPicks: upcoming,
        myRoster: ctx.myPlayers,
        openStarterSlots: needs.openStarterSlots,
        benchSpotsLeft: needs.benchSpotsLeft,
        recentPicks: recent,
      };
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: output as Record<string, unknown>,
      };
    } catch (e) {
      return { content: [{ type: "text", text: describeEspnError(e) }], isError: true };
    }
  }
);

/* ------------------------------------------------------------------ */
server.registerTool(
  "draft_best_available",
  {
    title: "Best Available Players",
    description: `Ranked list of undrafted players with season projections, VORP (value over replacement, computed from THIS league's lineup requirements), tier, ADP, bye week and injury flags. Filter by position (QB/RB/WR/TE/K).

Use during a draft to see the board; use draft_recommend_pick for an actual scored recommendation.`,
    inputSchema: {
      ...leagueTeamShape,
      position: z.enum(["QB", "RB", "WR", "TE", "K", "DST"]).optional().describe("Only show this position"),
      limit: z.number().int().min(1).max(50).default(15).describe("Max players to return"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const ctx = await loadContext(args.leagueId, args.teamId);
      let list = ctx.available;
      if (args.position) list = list.filter((p) => p.position === args.position);
      list = list.slice(0, args.limit ?? 15);

      const lines = [
        `# Best available${args.position ? ` - ${args.position}` : ""} (pick ${ctx.state.currentOverallPick}, your next: ${ctx.myNextPick ?? "n/a"})`,
        ...list.map((p, i) => {
          const avail = availabilityAtPick(p.adp, ctx.myNextPick);
          return `${i + 1}. ${playerLine(p, ` - ${avail} at your next pick`)}`;
        }),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { players: list, myNextPick: ctx.myNextPick } as Record<string, unknown>,
      };
    } catch (e) {
      return { content: [{ type: "text", text: describeEspnError(e) }], isError: true };
    }
  }
);

/* ------------------------------------------------------------------ */
server.registerTool(
  "draft_recommend_pick",
  {
    title: "Recommend Next Pick",
    description: `The core draft-agent tool: scores every available player for YOUR next pick and returns the top candidates with reasons.

The score combines: VORP for this league's exact lineup (1 QB, 2 RB, 2 WR, 1 TE, FLEX, K in an 11-team half-PPR league, or whatever ESPN reports), open starter slots, positional scarcity (projection cliff between now and your next snake pick, using ADP survival), value vs ADP, bye-week stacking, and injury flags. Hard rules: kicker only in the final two rounds, no backup QB/TE.

Also reports which of the top candidates will likely be gone by your next pick, and the strategy note for the current round.`,
    inputSchema: {
      ...leagueTeamShape,
      limit: z.number().int().min(1).max(20).default(8).describe("Number of candidates to return"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const ctx = await loadContext(args.leagueId, args.teamId);
      const { state } = ctx;

      if (state.completed) {
        return { content: [{ type: "text", text: "Draft is already completed - nothing to recommend." }] };
      }

      const rec = buildRecommendation(ctx, args.limit ?? 8);
      const lines = [
        `# Pick recommendation - overall #${rec.currentOverallPick}, round ${rec.round}${rec.onTheClock ? " (YOU ARE ON THE CLOCK)" : ""}${ctx.manualMode ? " [manual mode]" : ""}`,
        `**Round strategy**: ${rec.roundStrategy}`,
        `**Open starters**: ${Object.entries(rec.openStarterSlots).map(([s, n]) => `${s}×${n}`).join(", ") || "all filled"} | your next pick after this turn: ${rec.planningPick ?? "none"}`,
        "",
        "## Top candidates",
        ...rec.candidates.map(
          (c, i) =>
            `${i + 1}. **${c.name}** (${c.position}${c.positionalRank} ${c.proTeam}, bye ${c.byeWeek ?? "?"}) - score ${c.score}\n   proj ${c.projectedPoints} | VORP ${c.vorp} | tier ${c.tier} | ADP ${c.adp} | ${c.availabilityAtNextPick} at your next pick\n   ${c.reasons.map((r) => `• ${r}`).join(" ")}`
        ),
        "",
        rec.likelyGoneByNextPick.length
          ? `## Likely gone before your next pick (#${rec.planningPick ?? "-"})\n${rec.likelyGoneByNextPick.map((p) => `- ${p.name} (${p.position}, ADP ${p.adp})`).join("\n")}`
          : "",
      ].filter(Boolean);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: rec as unknown as Record<string, unknown>,
      };
    } catch (e) {
      return { content: [{ type: "text", text: describeEspnError(e) }], isError: true };
    }
  }
);

/* ------------------------------------------------------------------ */
server.registerTool(
  "draft_strategy_guide",
  {
    title: "Draft Strategy Guide",
    description: `Round-by-round draft strategy tailored to this league's actual format (team count, scoring, lineup slots read live from ESPN). Research-backed for half-PPR: RB-anchored early rounds, QB/TE in the middle-round value window, kicker last, upside-first bench.

Call once before the draft to brief the user; the per-round advice also appears in every draft_recommend_pick response.`,
    inputSchema: leagueTeamShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const manual = loadManualState();
      const snapshot = manual ? loadSnapshot() : null;
      if (manual && snapshot) {
        return {
          content: [{ type: "text", text: strategyGuide({ ...snapshot.config, teamCount: manual.teamCount }, manual.totalRounds) }],
        };
      }
      const leagueId = resolveLeagueId(args.leagueId);
      const { state } = await espnClient.getDraftState(leagueId);
      const text = strategyGuide(state.config, state.totalRounds);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: describeEspnError(e) }], isError: true };
    }
  }
);

/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("espn-draft-mcp-server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
