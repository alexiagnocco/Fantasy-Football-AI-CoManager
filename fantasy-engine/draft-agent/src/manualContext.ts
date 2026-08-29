/** Builds a DraftContext from the offline snapshot + manually recorded picks. */
import { nextPickAtOrAfter, followingPick } from "./lib/draftMath.js";
import { rankPool } from "./lib/strategy.js";
import {
  ManualState,
  Snapshot,
  overallPicksForSlot,
  slotForOverallPick,
} from "./manualSession.js";
import { DraftContext, DraftPickRecord, DraftState, PlayerInfo } from "./types.js";

export function buildManualDraftContext(
  snapshot: Snapshot,
  manual: ManualState
): DraftContext {
  const { teamCount, totalRounds, mySlot } = manual;
  const config = { ...snapshot.config, teamCount };
  const totalPicks = teamCount * totalRounds;

  const teamNames: Record<number, string> = {};
  for (let s = 1; s <= teamCount; s++) {
    teamNames[s] = s === mySlot ? `You (slot ${s})` : `Slot ${s}`;
  }

  const byId = new Map(snapshot.players.map((p) => [p.id, p]));
  const picks: DraftPickRecord[] = manual.pickedPlayerIds.map((playerId, i) => {
    const overall = i + 1;
    const slot = slotForOverallPick(teamCount, overall);
    const p = byId.get(playerId);
    return {
      overallPick: overall,
      round: Math.ceil(overall / teamCount),
      pickInRound: ((overall - 1) % teamCount) + 1,
      teamId: slot,
      teamName: teamNames[slot],
      playerId,
      playerName: p?.name ?? `Player #${playerId}`,
      position: p?.position ?? "",
      proTeam: p?.proTeam ?? "",
      keeper: false,
    };
  });

  const currentOverallPick = picks.length + 1;
  const completed = picks.length >= totalPicks;
  const onTheClock = completed ? null : slotForOverallPick(teamCount, currentOverallPick);

  const state: DraftState = {
    config,
    draftType: "snake",
    inProgress: !completed && picks.length > 0,
    completed,
    totalRounds,
    totalPicks,
    pickOrder: Array.from({ length: teamCount }, (_, i) => i + 1),
    picks,
    currentOverallPick,
    currentRound: Math.min(totalRounds, Math.ceil(currentOverallPick / teamCount)),
    onTheClockTeamId: onTheClock,
    onTheClockTeamName: onTheClock != null ? teamNames[onTheClock] : null,
    teamNames,
  };

  const draftedIds = new Set(manual.pickedPlayerIds);
  const ranked = rankPool(snapshot.players, config);
  const available = ranked.filter((p) => !draftedIds.has(p.id)).sort((a, b) => b.vorp - a.vorp);
  const myPlayers = picks
    .filter((p) => p.teamId === mySlot)
    .map((p) => byId.get(p.playerId))
    .filter((p): p is PlayerInfo => Boolean(p));
  const myPicks = overallPicksForSlot(teamCount, mySlot, totalRounds);

  return {
    state,
    pool: snapshot.players,
    ranked,
    available,
    myPlayers,
    myPicks,
    myNextPick: nextPickAtOrAfter(myPicks, currentOverallPick),
    myFollowingPick: followingPick(myPicks, currentOverallPick),
    myTeamId: mySlot,
    manualMode: true,
  };
}
