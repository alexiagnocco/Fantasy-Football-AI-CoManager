export interface LeagueConfig {
  leagueId: string;
  seasonYear: number;
  teamCount: number;
  /** Starting lineup slots (bench/IR excluded), e.g. { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1 } */
  starterSlots: Record<string, number>;
  benchSlots: number;
  /** Points per reception (1 = full PPR, 0.5 = half, 0 = standard). */
  pointsPerReception: number;
  scoringLabel: string;
}

export interface DraftPickRecord {
  overallPick: number;
  round: number;
  pickInRound: number;
  teamId: number;
  teamName: string;
  playerId: number;
  playerName: string;
  position: string;
  proTeam: string;
  keeper: boolean;
}

export interface DraftState {
  config: LeagueConfig;
  draftType: "snake" | "linear" | "auction";
  inProgress: boolean;
  completed: boolean;
  totalRounds: number;
  totalPicks: number;
  pickOrder: number[];
  picks: DraftPickRecord[];
  currentOverallPick: number;
  currentRound: number;
  onTheClockTeamId: number | null;
  onTheClockTeamName: string | null;
  teamNames: Record<number, string>;
}

export interface PlayerInfo {
  id: number;
  name: string;
  position: string;
  proTeam: string;
  byeWeek: number | null;
  projectedPoints: number;
  adp: number;
  positionalRank: number;
  injuryStatus: string | null;
  percentOwned: number;
}

export interface RankedPlayer extends PlayerInfo {
  vorp: number;
  tier: number;
}

/** Everything the tools need for one decision, from ESPN live or manual mode. */
export interface DraftContext {
  state: DraftState;
  pool: PlayerInfo[];
  ranked: RankedPlayer[];
  available: RankedPlayer[];
  myPlayers: PlayerInfo[];
  myPicks: number[];
  myNextPick: number | null;
  myFollowingPick: number | null;
  /** Team id to score for (ESPN team id, or slot number in manual mode). */
  myTeamId: number;
  manualMode: boolean;
}

export interface RosterNeeds {
  /** Starter slots still unfilled, e.g. { RB: 1, TE: 1, FLEX: 1, K: 1 } */
  openStarterSlots: Record<string, number>;
  /** Count of drafted players by position. */
  positionCounts: Record<string, number>;
  benchSpotsLeft: number;
  totalSpotsLeft: number;
  byeWeeksByPosition: Record<string, number[]>;
}
