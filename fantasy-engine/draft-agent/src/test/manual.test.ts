import { test } from "node:test";
import assert from "node:assert/strict";
import { slotForOverallPick, overallPicksForSlot, Snapshot, ManualState } from "../manualSession.js";
import { buildManualDraftContext } from "../manualContext.js";
import { LeagueConfig, PlayerInfo } from "../types.js";

test("slotForOverallPick snakes correctly for 11 teams", () => {
  assert.equal(slotForOverallPick(11, 1), 1);
  assert.equal(slotForOverallPick(11, 11), 11);
  assert.equal(slotForOverallPick(11, 12), 11); // round 2 reverses
  assert.equal(slotForOverallPick(11, 22), 1);
  assert.equal(slotForOverallPick(11, 23), 1); // round 3 forward again
});

test("overallPicksForSlot matches slotForOverallPick", () => {
  for (let slot = 1; slot <= 11; slot++) {
    for (const overall of overallPicksForSlot(11, slot, 4)) {
      assert.equal(slotForOverallPick(11, overall), slot);
    }
  }
});

const config: LeagueConfig = {
  leagueId: "manual",
  seasonYear: 2026,
  teamCount: 11,
  starterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1 },
  benchSlots: 7,
  pointsPerReception: 0.5,
  scoringLabel: "Half PPR (0.5/reception)",
};

function mkPlayer(id: number, position: string, proj: number): PlayerInfo {
  return {
    id, name: `P${id}`, position, proTeam: "KC", byeWeek: 7,
    projectedPoints: proj, adp: id, positionalRank: 1, injuryStatus: null, percentOwned: 50,
  };
}

test("manual context assigns picks to snake slots and builds my roster", () => {
  const players = Array.from({ length: 40 }, (_, i) =>
    mkPlayer(i + 1, ["RB", "WR", "QB", "TE"][i % 4], 300 - i)
  );
  const snapshot: Snapshot = { createdAt: "now", config, totalRounds: 15, players };
  // 3 picks made; I'm slot 2, so pick #2 (player id 2) is mine.
  const manual: ManualState = {
    active: true, teamCount: 11, totalRounds: 15, mySlot: 2,
    pickedPlayerIds: [1, 2, 3],
  };
  const ctx = buildManualDraftContext(snapshot, manual);
  assert.equal(ctx.state.currentOverallPick, 4);
  assert.equal(ctx.state.onTheClockTeamId, 4);
  assert.equal(ctx.myPlayers.length, 1);
  assert.equal(ctx.myPlayers[0].id, 2);
  assert.equal(ctx.available.length, 37);
  assert.ok(!ctx.available.some((p) => [1, 2, 3].includes(p.id)));
  // My next picks: slot 2 in 11 teams -> 2, then round 2 pick = 11+10=21
  assert.deepEqual(ctx.myPicks.slice(0, 2), [2, 21]);
  assert.equal(ctx.myNextPick, 21);
  assert.equal(ctx.manualMode, true);
});
