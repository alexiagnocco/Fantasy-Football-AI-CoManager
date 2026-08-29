#!/usr/bin/env node
/**
 * One-off bulk load: fetch the ESPN player pool + league config and save it
 * to data/snapshot.json for fully-offline in-person drafting.
 *
 * Usage:  node dist/snapshot.js [leagueId]
 * Env:    LEAGUE_ID / LEAGUE_1_ID, plus ESPN_S2 / ESPN_SWID for private leagues.
 */
import "./env.js";
import { espnClient } from "./services/espnClient.js";
import { saveSnapshot, SNAPSHOT_PATH } from "./manualSession.js";

async function main(): Promise<void> {
  const leagueId = process.argv[2] || process.env.LEAGUE_ID || process.env.LEAGUE_1_ID;
  if (!leagueId) {
    console.error("Usage: node dist/snapshot.js <leagueId>  (or set LEAGUE_ID)");
    process.exit(1);
  }
  console.log(`Fetching league ${leagueId} settings + player pool from ESPN...`);
  const [{ state }, players] = await Promise.all([
    espnClient.getDraftState(leagueId),
    espnClient.getPlayerPool(leagueId),
  ]);
  saveSnapshot({
    createdAt: new Date().toISOString(),
    config: state.config,
    totalRounds: state.totalRounds,
    players,
  });
  console.log(
    `Saved ${players.length} players (${state.config.scoringLabel}, ${state.config.teamCount} teams, ${state.totalRounds} rounds) -> ${SNAPSHOT_PATH}`
  );
  console.log("You can now draft fully offline: npm run web");
}

main().catch((e) => {
  console.error("Snapshot failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
