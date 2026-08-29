export const ESPN_BASE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
export const CHARACTER_LIMIT = 25000;

/**
 * The NFL season is named for the year it starts in (Sep-Jan); Jan/Feb
 * still belong to the previous season's playoffs/offseason.
 * (Same logic as getCurrentNFLSeasonYear() in shared/ - kept local so this
 * module stays dependency-free for Claude Desktop installs.)
 */
export function getCurrentNFLSeasonYear(): number {
  const now = new Date();
  return now.getMonth() <= 1 ? now.getFullYear() - 1 : now.getFullYear();
}

export const POSITION_BY_ID: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "DST",
};

/** ESPN lineup slot ids -> human names (subset relevant to drafting). */
export const LINEUP_SLOT_BY_ID: Record<number, string> = {
  0: "QB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  16: "DST",
  17: "K",
  20: "BENCH",
  21: "IR",
  23: "FLEX",
};

/** Which player positions can fill each lineup slot. */
export const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DST: ["DST"],
  FLEX: ["RB", "WR", "TE"],
  "RB/WR": ["RB", "WR"],
  "WR/TE": ["WR", "TE"],
  OP: ["QB", "RB", "WR", "TE"],
};

export const PRO_TEAM_BY_ID: Record<number, string> = {
  0: "FA",
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
  7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC",
  13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO",
  19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};
