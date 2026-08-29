/**
 * Manual (in-person) draft mode.
 *
 * A one-off snapshot of the ESPN player pool + league config is bulk-loaded
 * to disk before the draft (see snapshot.ts). During the draft, picks are
 * recorded in order - by the web UI or by MCP - into a state file. Whose pick
 * each one was is derived from snake math, so the only input needed per pick
 * is "this player just went".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LeagueConfig, PlayerInfo } from "./types.js";

const DATA_DIR =
  process.env.DRAFT_DATA_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "data");
export const SNAPSHOT_PATH = join(DATA_DIR, "snapshot.json");
export const STATE_PATH = join(DATA_DIR, "draft-state.json");

export interface Snapshot {
  createdAt: string;
  config: LeagueConfig;
  totalRounds: number;
  players: PlayerInfo[];
}

export interface ManualState {
  active: boolean;
  teamCount: number;
  totalRounds: number;
  /** Your slot in round 1, 1-based. */
  mySlot: number;
  /** Player IDs in overall-pick order. Index i = overall pick i+1. */
  pickedPlayerIds: number[];
}

export function loadSnapshot(): Snapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
}

export function saveSnapshot(s: Snapshot): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(s));
}

export function loadManualState(): ManualState | null {
  if (!existsSync(STATE_PATH)) return null;
  const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as ManualState;
  return s.active ? s : null;
}

export function saveManualState(s: ManualState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s));
}

/** Which round-1 slot (1-based) owns a given overall pick in a snake draft. */
export function slotForOverallPick(teamCount: number, overall: number): number {
  const round = Math.ceil(overall / teamCount);
  const idx = (overall - 1) % teamCount; // 0-based within round
  return round % 2 === 0 ? teamCount - idx : idx + 1;
}

/** All overall pick numbers for a slot. */
export function overallPicksForSlot(
  teamCount: number,
  slot: number,
  totalRounds: number
): number[] {
  const picks: number[] = [];
  for (let r = 1; r <= totalRounds; r++) {
    const idx = r % 2 === 0 ? teamCount - slot : slot - 1;
    picks.push((r - 1) * teamCount + idx + 1);
  }
  return picks;
}
