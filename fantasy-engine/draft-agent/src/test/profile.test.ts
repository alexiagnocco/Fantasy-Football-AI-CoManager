/**
 * Manual-mode league profiles: scoring re-computation and the Yahoo profile
 * that ships in profiles/yahoo-816469.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configFromProfile,
  loadProfile,
  scoreStatLine,
  totalRoundsFromProfile,
} from "../profile.js";
import { computeRosterNeeds, roundAdvice, startableCounts, strategyGuide } from "../lib/strategy.js";
import { PlayerInfo } from "../types.js";

const YAHOO = "profiles/yahoo-816469.json";

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

test("scoreStatLine applies only mapped stats and rounds to 0.1", () => {
  const scoring = { "3": 0.04, "4": 6, "20": -2, "53": 1 };
  // 4000 pass yds (160) + 30 TD (180) - 10 INT (-20) + 5 rec (5); stat 999 ignored
  const pts = scoreStatLine({ "3": 4000, "4": 30, "20": 10, "53": 5, "999": 1000 }, scoring);
  assert.equal(pts, 325);
  assert.equal(scoreStatLine({}, scoring), 0);
});

test("Yahoo profile loads with the league's exact shape", () => {
  const profile = loadProfile(YAHOO);
  assert.equal(profile.platform, "yahoo");
  assert.equal(profile.leagueId, "816469");
  assert.equal(profile.teamCount, 10);
  // QB, WR, WR, RB, RB, TE, W/R/T, W/R/T, K, DEF = 10 starters; 6 BN; IR never drafts
  assert.deepEqual(profile.starterSlots, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1 });
  assert.equal(profile.benchSlots, 6);
  assert.equal(totalRoundsFromProfile(profile), 16);
  assert.equal(profile.pointsPerReception, 1);
  // Yahoo scoring: 6-pt pass TD, full PPR, -2 INT, 5-pt 50+ FG
  assert.equal(profile.scoring["4"], 6);
  assert.equal(profile.scoring["53"], 1);
  assert.equal(profile.scoring["20"], -2);
  assert.equal(profile.scoring["74"], 5);
  // "$comment" keys inside scoring are ignored, never scored
  assert.equal(profile.scoring["$comment"], undefined);

  const config = configFromProfile(profile, 2026);
  assert.equal(config.leagueId, "yahoo:816469");
  assert.equal(config.name, "Jake's Agreeable League");
  assert.equal(config.platform, "yahoo");
});

test("QB projection gains ~2 pts per TD under 6-pt passing TDs vs 4-pt", () => {
  const yahoo = loadProfile(YAHOO).scoring;
  const espnDefault = { ...yahoo, "4": 4 };
  const line = { "3": 4000, "4": 30, "20": 10, "24": 300, "25": 3 };
  assert.equal(scoreStatLine(line, yahoo) - scoreStatLine(line, espnDefault), 60);
});

test("two flex slots + full PPR: startable counts and roster needs", () => {
  const config = configFromProfile(loadProfile(YAHOO), 2026);
  const c = startableCounts(config);
  assert.equal(c["QB"], 10);
  assert.equal(c["DST"], 10);
  // 20 direct RB/WR each + a share of 20 flex starts
  assert.ok(c["RB"] > 20 && c["RB"] < 35, `RB=${c["RB"]}`);
  assert.ok(c["WR"] > 20 && c["WR"] < 35, `WR=${c["WR"]}`);
  // Full PPR: WRs absorb at least as many flex starts as RBs
  assert.ok(c["WR"] >= c["RB"], `WR=${c["WR"]} RB=${c["RB"]}`);

  // 3 RB + 3 WR fills both RB, both WR and both FLEX; 4th WR goes to bench.
  const mine = [
    mkPlayer({ id: 1, position: "RB", projectedPoints: 250 }),
    mkPlayer({ id: 2, position: "RB", projectedPoints: 220 }),
    mkPlayer({ id: 3, position: "RB", projectedPoints: 180 }),
    mkPlayer({ id: 4, position: "WR", projectedPoints: 240 }),
    mkPlayer({ id: 5, position: "WR", projectedPoints: 200 }),
    mkPlayer({ id: 6, position: "WR", projectedPoints: 190 }),
    mkPlayer({ id: 7, position: "WR", projectedPoints: 150 }),
  ];
  const needs = computeRosterNeeds(mine, config);
  assert.equal(needs.openStarterSlots["RB"], undefined);
  assert.equal(needs.openStarterSlots["WR"], undefined);
  assert.equal(needs.openStarterSlots["FLEX"], undefined);
  assert.deepEqual(Object.keys(needs.openStarterSlots).sort(), ["DST", "K", "QB", "TE"]);
  assert.equal(needs.benchSpotsLeft, 5);
});

test("strategy text reflects the profile's format, not the ESPN league's", () => {
  const config = configFromProfile(loadProfile(YAHOO), 2026);
  const guide = strategyGuide(config, 16);
  assert.ok(guide.includes("10-team"), guide);
  assert.ok(guide.includes("Full PPR"), guide);
  assert.ok(guide.includes("2 FLEX"), guide);
  assert.ok(!guide.includes("Half PPR"), guide);
  assert.ok(!guide.includes("Only 2 WR + 1 FLEX"), guide);

  const early = roundAdvice(1, 16, computeRosterNeeds([], config), config);
  assert.ok(!early.includes("half-PPR"), early);
  assert.ok(early.toLowerCase().includes("ppr"), early);
  const mid = roundAdvice(5, 16, computeRosterNeeds([], config), config);
  assert.ok(mid.includes("10 teams"), mid);
});
