/** Shared recommendation payload builder - used by the MCP tool and the web UI. */
import { computeRosterNeeds, roundAdvice, scoreCandidates } from "./strategy.js";
import { DraftContext } from "../types.js";

export interface RecommendationPayload {
  onTheClock: boolean;
  currentOverallPick: number;
  round: number;
  totalRounds: number;
  roundStrategy: string;
  openStarterSlots: Record<string, number>;
  benchSpotsLeft: number;
  planningPick: number | null;
  recommendation: { name: string; position: string; score: number; reasons: string[] } | null;
  candidates: Array<
    DraftContext["available"][number] & {
      score: number;
      availabilityAtNextPick: string;
      reasons: string[];
    }
  >;
  likelyGoneByNextPick: Array<{ name: string; position: string; adp: number }>;
}

export function buildRecommendation(ctx: DraftContext, limit: number): RecommendationPayload {
  const { state } = ctx;
  const needs = computeRosterNeeds(ctx.myPlayers, state.config);
  // Scarcity is measured to the pick AFTER the one being made now: if it's my
  // turn, "can I wait?" means waiting until my following snake turn.
  const planningPick =
    ctx.myNextPick === state.currentOverallPick ? ctx.myFollowingPick : ctx.myNextPick;

  const scored = scoreCandidates(
    ctx.available,
    needs,
    state.config,
    state.currentOverallPick,
    planningPick,
    state.currentRound,
    state.totalRounds
  );

  const top = scored.slice(0, limit);
  const goneByNext = scored
    .slice(0, 25)
    .filter((c) => c.availabilityAtNextPick === "likely gone")
    .slice(0, 8);

  return {
    onTheClock: state.onTheClockTeamId === ctx.myTeamId,
    currentOverallPick: state.currentOverallPick,
    round: state.currentRound,
    totalRounds: state.totalRounds,
    roundStrategy: roundAdvice(state.currentRound, state.totalRounds, needs, state.config),
    openStarterSlots: needs.openStarterSlots,
    benchSpotsLeft: needs.benchSpotsLeft,
    planningPick,
    recommendation: top[0]
      ? {
          name: top[0].player.name,
          position: top[0].player.position,
          score: top[0].score,
          reasons: top[0].reasons,
        }
      : null,
    candidates: top.map((c) => ({
      ...c.player,
      score: c.score,
      availabilityAtNextPick: c.availabilityAtNextPick,
      reasons: c.reasons,
    })),
    likelyGoneByNextPick: goneByNext.map((c) => ({
      name: c.player.name,
      position: c.player.position,
      adp: c.player.adp,
    })),
  };
}
