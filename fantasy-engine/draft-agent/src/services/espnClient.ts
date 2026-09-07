import axios, { AxiosError } from "axios";
import {
  ESPN_BASE_URL,
  getCurrentNFLSeasonYear,
  LINEUP_SLOT_BY_ID,
  POSITION_BY_ID,
  PRO_TEAM_BY_ID,
} from "../constants.js";
import { DraftState, LeagueConfig, PlayerInfo, DraftPickRecord } from "../types.js";
import { ScoringMap, scoreStatLine } from "../profile.js";

const PLAYER_POOL_SIZE = 500;
/** Profile snapshots keep a slightly deeper pool: ADP-ordered, so RB/WR depth thins out fast. */
const GLOBAL_POOL_SIZE = 600;
const PLAYER_CACHE_TTL_MS = 5 * 60 * 1000;
const BYE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export class EspnClient {
  private year = getCurrentNFLSeasonYear();
  private playerCache: CacheEntry<PlayerInfo[]> | null = null;
  private byeCache: CacheEntry<Record<number, number>> | null = null;

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ...extra,
    };
    const s2 = process.env.ESPN_S2;
    const swid = process.env.ESPN_SWID;
    if (s2 && swid) {
      h.Cookie = `espn_s2=${s2}; SWID=${swid}`;
    }
    return h;
  }

  private leagueUrl(leagueId: string): string {
    return `${ESPN_BASE_URL}/seasons/${this.year}/segments/0/leagues/${leagueId}`;
  }

  /** Bye week by pro team id, from the season-wide pro team schedules. */
  async getByeWeeks(): Promise<Record<number, number>> {
    if (this.byeCache && this.byeCache.expires > Date.now()) {
      return this.byeCache.value;
    }
    const url = `${ESPN_BASE_URL}/seasons/${this.year}?view=proTeamSchedules_wl`;
    const { data } = await axios.get(url, { headers: this.headers(), timeout: 30000 });
    const byes: Record<number, number> = {};
    for (const team of data?.settings?.proTeams ?? []) {
      if (typeof team.id === "number" && typeof team.byeWeek === "number") {
        byes[team.id] = team.byeWeek;
      }
    }
    this.byeCache = { value: byes, expires: Date.now() + BYE_CACHE_TTL_MS };
    return byes;
  }

  /** Live league + draft snapshot. Never cached - this is the live draft feed. */
  async getDraftState(leagueId: string): Promise<{ state: DraftState; raw: unknown }> {
    const url = `${this.leagueUrl(leagueId)}?view=mDraftDetail&view=mSettings&view=mTeam`;
    const { data } = await axios.get(url, { headers: this.headers(), timeout: 30000 });

    const settings = data.settings ?? {};
    const draftSettings = settings.draftSettings ?? {};
    const rosterSettings = settings.rosterSettings ?? {};
    const scoringItems: Array<{ statId: number; points: number }> =
      settings.scoringSettings?.scoringItems ?? [];

    const ppr = scoringItems.find((s) => s.statId === 53)?.points ?? 0;
    const scoringLabel =
      ppr >= 1 ? "PPR" : ppr > 0 ? `Half PPR (${ppr}/reception)` : "Standard";

    const starterSlots: Record<string, number> = {};
    let benchSlots = 0;
    for (const [slotId, count] of Object.entries(
      (rosterSettings.lineupSlotCounts ?? {}) as Record<string, number>
    )) {
      if (!count) continue;
      const name = LINEUP_SLOT_BY_ID[Number(slotId)] ?? `SLOT_${slotId}`;
      if (name === "BENCH") benchSlots = count;
      else if (name !== "IR") starterSlots[name] = count;
    }

    const teams: Array<{ id: number; name?: string; location?: string; nickname?: string; abbrev?: string }> =
      data.teams ?? [];
    const teamNames: Record<number, string> = {};
    for (const t of teams) {
      teamNames[t.id] =
        t.name || [t.location, t.nickname].filter(Boolean).join(" ") || t.abbrev || `Team ${t.id}`;
    }

    const config: LeagueConfig = {
      leagueId,
      seasonYear: this.year,
      teamCount: teams.length || settings.size || 0,
      starterSlots,
      benchSlots,
      pointsPerReception: ppr,
      scoringLabel,
    };

    const draftDetail = data.draftDetail ?? {};
    const pickOrder: number[] = draftSettings.pickOrder ?? [];
    const teamCount = config.teamCount || pickOrder.length;
    const totalRounds: number =
      draftSettings.rounds ??
      Object.values(starterSlots).reduce((a, b) => a + b, 0) + benchSlots;

    const rawPicks: Array<Record<string, unknown>> = draftDetail.picks ?? [];
    const madePicks = rawPicks.filter((p) => (p.playerId as number) > 0);

    const picks: DraftPickRecord[] = madePicks.map((p, i) => {
      const overall = (p.overallPickNumber as number) || i + 1;
      const teamId = p.teamId as number;
      return {
        overallPick: overall,
        round: (p.roundId as number) || Math.ceil(overall / teamCount),
        pickInRound: (p.roundPickNumber as number) || ((overall - 1) % teamCount) + 1,
        teamId,
        teamName: teamNames[teamId] ?? `Team ${teamId}`,
        playerId: p.playerId as number,
        playerName: "", // resolved by the caller against the player pool
        position: "",
        proTeam: "",
        keeper: Boolean(p.reservedForKeeper || p.keeper),
      };
    });

    const completed = Boolean(draftDetail.drafted);
    const inProgress = Boolean(draftDetail.inProgress);
    const currentOverallPick = picks.length + 1;
    const currentRound = Math.min(totalRounds, Math.ceil(currentOverallPick / Math.max(1, teamCount)));

    let onTheClockTeamId: number | null = null;
    if (!completed && pickOrder.length > 0) {
      const idx = (currentOverallPick - 1) % teamCount;
      const reversed = currentRound % 2 === 0 && draftSettings.type !== 1; // snake reverses even rounds
      onTheClockTeamId = reversed
        ? pickOrder[teamCount - 1 - idx]
        : pickOrder[idx];
    }

    const draftTypeMap: Record<number, "snake" | "linear" | "auction"> = {
      0: "snake",
      1: "linear",
      2: "auction",
    };

    const state: DraftState = {
      config,
      draftType: draftTypeMap[draftSettings.type as number] ?? "snake",
      inProgress,
      completed,
      totalRounds,
      totalPicks: totalRounds * teamCount,
      pickOrder,
      picks,
      currentOverallPick,
      currentRound,
      onTheClockTeamId,
      onTheClockTeamName: onTheClockTeamId != null ? teamNames[onTheClockTeamId] ?? null : null,
      teamNames,
    };
    return { state, raw: data };
  }

  /**
   * Full draftable player pool (top ~500 by draft rank), with projections,
   * ADP and bye weeks. Cached briefly - projections/ADP don't move mid-draft.
   */
  async getPlayerPool(leagueId: string): Promise<PlayerInfo[]> {
    if (this.playerCache && this.playerCache.expires > Date.now()) {
      return this.playerCache.value;
    }
    const byes = await this.getByeWeeks();
    const filter = {
      players: {
        limit: PLAYER_POOL_SIZE,
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
      },
    };
    const url = `${this.leagueUrl(leagueId)}?view=kona_player_info`;
    const { data } = await axios.get(url, {
      headers: this.headers({ "X-Fantasy-Filter": JSON.stringify(filter) }),
      timeout: 30000,
    });

    const posRankCounters: Record<string, number> = {};
    const pool: PlayerInfo[] = [];
    for (const entry of data.players ?? []) {
      const player = entry.player ?? entry.playerPoolEntry?.player;
      const parsed = this.parsePlayer(player, byes);
      if (!parsed) continue;
      // ESPN league mode: projection is ESPN's own total under the league's scoring.
      parsed.projectedPoints = Math.round(((parsed.rawProjection?.appliedTotal as number) ?? 0) * 10) / 10;
      posRankCounters[parsed.position] = (posRankCounters[parsed.position] ?? 0) + 1;
      parsed.positionalRank = posRankCounters[parsed.position];
      pool.push(stripRaw(parsed));
    }

    this.playerCache = { value: pool, expires: Date.now() + PLAYER_CACHE_TTL_MS };
    return pool;
  }

  /**
   * League-INDEPENDENT player pool for manual-mode profiles (Yahoo etc.).
   *
   * Uses ESPN's public, season-wide players feed - no league id, no cookies -
   * and re-scores every projection from the raw stat line with the supplied
   * scoring map, so nothing about any ESPN league (its scoring, its roster,
   * its id) influences the result. ADP and ownership are ESPN-wide market
   * data. Never cached: snapshot.ts calls this once and persists to disk.
   */
  async getGlobalPlayerPool(scoring: ScoringMap, limit = GLOBAL_POOL_SIZE): Promise<PlayerInfo[]> {
    const byes = await this.getByeWeeks();
    // The season-wide endpoint ignores most filter fields but a large limit is harmless.
    const filter = { players: { limit: 5000, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "PPR" } } };
    const url = `${ESPN_BASE_URL}/seasons/${this.year}/players?scoringPeriodId=0&view=kona_player_info`;
    const { data } = await axios.get(url, {
      headers: { Accept: "application/json", "X-Fantasy-Filter": JSON.stringify(filter) },
      timeout: 90000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const entries: unknown[] = Array.isArray(data) ? data : data?.players ?? [];
    const parsed: ParsedPlayer[] = [];
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      const player = (e.player ?? e) as Record<string, unknown>;
      const p = this.parsePlayer(player, byes);
      // Keep only players ESPN actually projects this season - the feed
      // includes thousands of retired/practice-squad names with no line.
      if (!p || !p.rawProjection) continue;
      p.projectedPoints = scoreStatLine(
        (p.rawProjection.stats as Record<string, number>) ?? {},
        scoring
      );
      parsed.push(p);
    }

    // Draftable pool = best by market rank (ADP), with a projection-based
    // fallback for players ESPN has not assigned an ADP to.
    parsed.sort((a, b) => a.adp - b.adp || b.projectedPoints - a.projectedPoints);
    const pool = parsed.slice(0, limit);

    // Positional rank by THIS profile's projection, since that is what the
    // board ranks by - ESPN's own draft order is meaningless here.
    const byPos = new Map<string, ParsedPlayer[]>();
    for (const p of pool) {
      if (!byPos.has(p.position)) byPos.set(p.position, []);
      byPos.get(p.position)!.push(p);
    }
    for (const list of byPos.values()) {
      list.sort((a, b) => b.projectedPoints - a.projectedPoints);
      list.forEach((p, i) => (p.positionalRank = i + 1));
    }
    return pool.map(stripRaw);
  }

  /** Shared field extraction for both pool endpoints. Null = not a fantasy position. */
  private parsePlayer(
    player: Record<string, unknown> | undefined,
    byes: Record<number, number>
  ): ParsedPlayer | null {
    if (!player?.id) return null;
    const position = POSITION_BY_ID[player.defaultPositionId as number];
    if (!position || position === "Unknown") return null;

    // Season projection: statSourceId 1 = projected, statSplitTypeId 0 = full season
    const stats: Array<Record<string, unknown>> = (player.stats as Array<Record<string, unknown>>) ?? [];
    const proj = stats.find(
      (s) => s.statSourceId === 1 && s.statSplitTypeId === 0 && s.seasonId === this.year
    );

    const ownership = player.ownership as Record<string, number> | undefined;
    const adpRaw = ownership?.averageDraftPosition;
    const adp = adpRaw && adpRaw > 0 ? Math.round(adpRaw * 10) / 10 : 999;

    return {
      id: player.id as number,
      name: (player.fullName as string) ?? "Unknown",
      position,
      proTeam: PRO_TEAM_BY_ID[player.proTeamId as number] ?? "FA",
      byeWeek: byes[player.proTeamId as number] ?? null,
      projectedPoints: 0,
      adp,
      positionalRank: 0,
      injuryStatus:
        player.injuryStatus && player.injuryStatus !== "ACTIVE"
          ? (player.injuryStatus as string)
          : null,
      percentOwned: Math.round((ownership?.percentOwned ?? 0) * 10) / 10,
      rawProjection: proj ?? null,
    };
  }
}

/** PlayerInfo plus the raw ESPN projection entry, used only while parsing. */
interface ParsedPlayer extends PlayerInfo {
  rawProjection: Record<string, unknown> | null;
}

function stripRaw(p: ParsedPlayer): PlayerInfo {
  const { rawProjection: _raw, ...rest } = p;
  return rest;
}

export function describeEspnError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 401) {
      return "Error: ESPN returned 401 Unauthorized. Your ESPN_S2/ESPN_SWID cookies are missing, expired, or invalid. Refresh them from a logged-in browser (DevTools > Application > Cookies > fantasy.espn.com).";
    }
    if (status === 404) {
      return "Error: ESPN returned 404. Check the league ID, and note ESPN may not have opened this season yet during the spring offseason.";
    }
    if (status === 429) {
      return "Error: ESPN rate limit hit (429). Wait a few seconds and try again.";
    }
    if (status) {
      return `Error: ESPN API request failed with status ${status}.`;
    }
    if (error.code === "ECONNABORTED") {
      return "Error: ESPN API request timed out. Try again.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export const espnClient = new EspnClient();
