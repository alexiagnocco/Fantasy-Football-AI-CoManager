import { test } from "node:test";
import assert from "node:assert/strict";
import { teamPickNumbers, nextPickAtOrAfter, followingPick } from "../lib/draftMath.js";
import {
  startableCounts,
  rankPool,
  computeRosterNeeds,
  scoreCandidates,
  availabilityAtPick,
} from "../lib/strategy.js";
import { LeagueConfig, PlayerInfo } from "../types.js";

const config: LeagueConfig = {
  leagueId: "test",
  seasonYear: 2026,
  teamCount: 11,
  starterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1 },
  benchSlots: 7,
  pointsPerReception: 0.5,
  scoringLabel: "Half PPR (0.5/reception)",
};

function mkPlayer(overrides: Partial<PlayerInfo> & { id: number }): PlayerInfo {
  return {
    name: `P${overrides.id}`,
    position: "RB",
    proTeam: "KC",
    byeWeek: 7,
    projectedPoints: 100,
    adp: 50,
    positionalRank: 1,
    injuryStatus: null,
    percentOwned: 50,
    ...overrides,
  };
}

test("snake pick numbers reverse on even rounds", () => {
  // 11 teams, teamId 3 drafts 5th (index 4)
  const order = [7, 2, 9, 1, 3, 6, 11, 4, 8, 10, 5];
  const picks = teamPickNumbers(order, 3, 4, true);
  // Round 1: pick 5. Round 2 (reversed): 11 + (11-4) = pick 18.
  // Round 3: 22 + 5 = 27. Round 4: 33 + 7 = 40.
  assert.deepEqual(picks, [5, 18, 27, 40]);
});

test("linear draft keeps same slot every round", () => {
  const order = [1, 2, 3];
  assert.deepEqual(teamPickNumbers(order, 2, 3, false), [2, 5, 8]);
});

test("next and following picks", () => {
  const picks = [5, 18, 27, 40];
  assert.equal(nextPickAtOrAfter(picks, 6), 18);
  assert.equal(nextPickAtOrAfter(picks, 5), 5);
  assert.equal(followingPick(picks, 5), 18);
  assert.equal(nextPickAtOrAfter(picks, 41), null);
});

test("startable counts reflect 11-team lineup with flex apportioned", () => {
  const c = startableCounts(config);
  assert.equal(c["QB"], 11);
  assert.equal(c["K"], 11);
  assert.ok(c["RB"] > 22 && c["RB"] < 33, `RB=${c["RB"]}`); // 22 direct + flex share
  assert.ok(c["WR"] > 22 && c["WR"] < 33, `WR=${c["WR"]}`);
  assert.ok(c["TE"] > 11 && c["TE"] < 14, `TE=${c["TE"]}`);
});

test("roster needs: starters fill before bench, flex catches third RB", () => {
  const mine = [
    mkPlayer({ id: 1, position: "RB", projectedPoints: 250 }),
    mkPlayer({ id: 2, position: "RB", projectedPoints: 220 }),
    mkPlayer({ id: 3, position: "RB", projectedPoints: 180 }),
    mkPlayer({ id: 4, position: "WR", projectedPoints: 210 }),
  ];
  const needs = computeRosterNeeds(mine, config);
  assert.equal(needs.openStarterSlots["RB"], undefined); // both filled
  assert.equal(needs.openStarterSlots["FLEX"], undefined); // 3rd RB takes flex
  assert.equal(needs.openStarterSlots["WR"], 1);
  assert.equal(needs.openStarterSlots["QB"], 1);
  assert.equal(needs.benchSpotsLeft, config.benchSlots);
});

test("kicker is buried before the final two rounds and boosted in them", () => {
  const pool = [
    mkPlayer({ id: 1, position: "K", projectedPoints: 150, adp: 160 }),
    mkPlayer({ id: 2, position: "RB", projectedPoints: 120, adp: 100 }),
  ];
  const ranked = rankPool(pool, config);
  const needs = computeRosterNeeds([], config);
  const early = scoreCandidates(ranked, needs, config, 30, 52, 3, 15);
  const earlyK = early.find((c) => c.player.position === "K")!;
  assert.ok(earlyK.score < 0, "K should be heavily penalized early");
  assert.equal(early[0].player.position, "RB");

  const late = scoreCandidates(ranked, needs, config, 155, null, 15, 15);
  const lateK = late.find((c) => c.player.position === "K")!;
  assert.ok(lateK.reasons.some((r) => r.includes("K slot")), "K boosted in final rounds");
});

test("backup QB penalized in a 1-QB league", () => {
  const pool = [
    mkPlayer({ id: 1, position: "QB", projectedPoints: 320, adp: 60 }),
    mkPlayer({ id: 2, position: "WR", projectedPoints: 150, adp: 70 }),
  ];
  const myQB = mkPlayer({ id: 9, position: "QB", projectedPoints: 340 });
  const ranked = rankPool(pool, config);
  const needs = computeRosterNeeds([myQB], config);
  const scored = scoreCandidates(ranked, needs, config, 70, 92, 7, 15);
  const qb = scored.find((c) => c.player.position === "QB")!;
  assert.ok(qb.reasons.some((r) => r.includes("Backup QB")));
});

test("availability estimate from ADP vs next pick", () => {
  assert.equal(availabilityAtPick(20, 40), "likely gone");
  assert.equal(availabilityAtPick(42, 40), "at risk");
  assert.equal(availabilityAtPick(80, 40), "safe");
  assert.equal(availabilityAtPick(20, null), "safe");
});

test("bye stacking penalty applies", () => {
  const pool = [mkPlayer({ id: 1, position: "WR", byeWeek: 9, projectedPoints: 150, adp: 45 })];
  const mine = [mkPlayer({ id: 8, position: "WR", byeWeek: 9, projectedPoints: 160 })];
  const ranked = rankPool(pool, config);
  const needs = computeRosterNeeds(mine, config);
  const scored = scoreCandidates(ranked, needs, config, 44, 66, 4, 15);
  assert.ok(scored[0].reasons.some((r) => r.includes("bye")));
});
