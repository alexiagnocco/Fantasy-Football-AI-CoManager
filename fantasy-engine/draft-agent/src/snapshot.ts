#!/usr/bin/env node
/**
 * One-off bulk load of the player pool + league config to <data dir>/snapshot.json
 * for fully-offline manual drafting.
 *
 * Two modes:
 *
 *   ESPN league (default):
 *     node dist/snapshot.js [leagueId]
 *     Env: LEAGUE_ID / LEAGUE_1_ID, plus ESPN_S2 / ESPN_SWID for private leagues.
 *     League settings + projections come from that ESPN league.
 *
 *   Profile (any platform, e.g. Yahoo):
 *     node dist/snapshot.js --profile profiles/yahoo-816469.json
 *     Env alternative: DRAFT_PROFILE=<path>
 *     League settings come from the profile; projections come from ESPN's
 *     public season-wide feed re-scored with the profile's scoring map. No
 *     league id and no cookies are used, so nothing bleeds in from the ESPN
 *     league. Pair with DRAFT_DATA_DIR so each league keeps its own files.
 */
import "./env.js";
import { getCurrentNFLSeasonYear } from "./constants.js";
import { espnClient } from "./services/espnClient.js";
import { saveSnapshot, SNAPSHOT_PATH } from "./manualSession.js";
import { configFromProfile, loadProfile, totalRoundsFromProfile } from "./profile.js";

function parseArgs(argv: string[]): { profile?: string; leagueId?: string } {
  const out: { profile?: string; leagueId?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") out.profile = argv[++i];
    else if (argv[i].startsWith("--profile=")) out.profile = argv[i].slice("--profile=".length);
    else if (!argv[i].startsWith("-")) out.leagueId = argv[i];
  }
  return out;
}

async function snapshotFromProfile(profilePath: string): Promise<void> {
  const profile = loadProfile(profilePath);
  const config = configFromProfile(profile, getCurrentNFLSeasonYear());
  const totalRounds = totalRoundsFromProfile(profile);
  console.log(
    `Profile: ${profile.name} (${profile.platform} ${profile.leagueId}) - ${config.teamCount} teams, ${totalRounds} rounds, ${config.scoringLabel}`
  );
  console.log("Fetching ESPN's public player projections (no league, no cookies) and re-scoring...");
  const players = await espnClient.getGlobalPlayerPool(profile.scoring);
  saveSnapshot({ createdAt: new Date().toISOString(), config, totalRounds, players });
  const top = players.slice().sort((a, b) => b.projectedPoints - a.projectedPoints).slice(0, 5);
  console.log(`Saved ${players.length} players -> ${SNAPSHOT_PATH}`);
  console.log("Top projections under this scoring: " + top.map((p) => `${p.name} ${p.projectedPoints}`).join(", "));
}

async function snapshotFromEspnLeague(leagueId: string): Promise<void> {
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
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const profile = args.profile || process.env.DRAFT_PROFILE;
  if (profile) {
    await snapshotFromProfile(profile);
  } else {
    const leagueId = args.leagueId || process.env.LEAGUE_ID || process.env.LEAGUE_1_ID;
    if (!leagueId) {
      console.error(
        "Usage: node dist/snapshot.js <espnLeagueId>   (or set LEAGUE_ID)\n" +
          "       node dist/snapshot.js --profile profiles/<league>.json   (or set DRAFT_PROFILE)"
      );
      process.exit(1);
    }
    await snapshotFromEspnLeague(leagueId);
  }
  console.log("You can now draft fully offline: npm run web (same DRAFT_DATA_DIR)");
}

main().catch((e) => {
  console.error("Snapshot failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
