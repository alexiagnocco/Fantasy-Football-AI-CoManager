/**
 * League profiles for manual (offline) drafting on any platform.
 *
 * A profile fully describes a league's draft-relevant shape - lineup slots,
 * bench size, and a scoring map - so the draft board can be built from a
 * platform-neutral player pool without ever reading that platform's API.
 * This is what keeps a Yahoo league completely separate from the ESPN one:
 * the only ESPN data used is the public, league-independent projection feed,
 * and every projection is re-scored with the profile's own rules.
 *
 * Profile file: JSON, see profiles/*.json. Selected with DRAFT_PROFILE (path)
 * or `--profile <path>` on the snapshot CLI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LeagueConfig } from "./types.js";

/** Points per unit of an ESPN stat id (e.g. "53" receptions -> 1 in full PPR). */
export type ScoringMap = Record<string, number>;

export interface LeagueProfile {
  name: string;
  platform: "espn" | "yahoo" | "sleeper" | "other";
  leagueId: string;
  teamCount: number;
  /** Uses the agent's canonical slot names (FLEX, DST, ...) - see constants.ts. */
  starterSlots: Record<string, number>;
  benchSlots: number;
  pointsPerReception: number;
  scoringLabel: string;
  scoring: ScoringMap;
}

const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve a profile path relative to the draft-agent module root (or cwd if absolute). */
export function resolveProfilePath(path: string): string {
  return isAbsolute(path) ? path : resolve(MODULE_ROOT, path);
}

/** Load and validate a profile file. Throws with a readable message on any problem. */
export function loadProfile(path: string): LeagueProfile {
  const full = resolveProfilePath(path);
  if (!existsSync(full)) throw new Error(`Profile not found: ${full}`);
  const raw = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;

  const scoring: ScoringMap = {};
  for (const [k, v] of Object.entries((raw.scoring ?? {}) as Record<string, unknown>)) {
    if (k.startsWith("$")) continue; // allow "$comment" keys
    if (!/^\d+$/.test(k) || typeof v !== "number") {
      throw new Error(`Profile ${path}: scoring entry "${k}" must map a numeric stat id to a number`);
    }
    scoring[k] = v;
  }

  const profile: LeagueProfile = {
    name: String(raw.name ?? "Manual league"),
    platform: (raw.platform as LeagueProfile["platform"]) ?? "other",
    leagueId: String(raw.leagueId ?? "manual"),
    teamCount: Number(raw.teamCount),
    starterSlots: raw.starterSlots as Record<string, number>,
    benchSlots: Number(raw.benchSlots),
    pointsPerReception: Number(raw.pointsPerReception ?? scoring["53"] ?? 0),
    scoringLabel: String(raw.scoringLabel ?? ""),
    scoring,
  };

  if (!(profile.teamCount >= 2 && profile.teamCount <= 20)) {
    throw new Error(`Profile ${path}: teamCount must be 2-20`);
  }
  if (!profile.starterSlots || typeof profile.starterSlots !== "object") {
    throw new Error(`Profile ${path}: starterSlots is required`);
  }
  if (!(profile.benchSlots >= 0)) throw new Error(`Profile ${path}: benchSlots is required`);
  if (Object.keys(scoring).length === 0) throw new Error(`Profile ${path}: scoring map is empty`);
  return profile;
}

/** The LeagueConfig the strategy engine consumes, built purely from the profile. */
export function configFromProfile(profile: LeagueProfile, seasonYear: number): LeagueConfig {
  return {
    leagueId: `${profile.platform}:${profile.leagueId}`,
    seasonYear,
    teamCount: profile.teamCount,
    starterSlots: { ...profile.starterSlots },
    benchSlots: profile.benchSlots,
    pointsPerReception: profile.pointsPerReception,
    scoringLabel: profile.scoringLabel,
    platform: profile.platform,
    name: profile.name,
  };
}

/** Draft rounds = every starter slot plus every bench slot (IR never drafts). */
export function totalRoundsFromProfile(profile: LeagueProfile): number {
  const starters = Object.values(profile.starterSlots).reduce((a, b) => a + b, 0);
  return starters + profile.benchSlots;
}

/**
 * Apply a scoring map to ESPN's raw projected stat line (stat id -> season
 * total). Any stat not in the map scores zero, so a profile only needs to list
 * the stats its league actually pays for.
 */
export function scoreStatLine(rawStats: Record<string, number>, scoring: ScoringMap): number {
  let total = 0;
  for (const [statId, points] of Object.entries(scoring)) {
    const value = rawStats[statId];
    if (typeof value === "number" && Number.isFinite(value)) total += value * points;
  }
  return Math.round(total * 10) / 10;
}
