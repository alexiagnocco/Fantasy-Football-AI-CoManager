/** Snake-draft pick arithmetic. Rounds are 1-indexed; overall picks are 1-indexed. */

/** Overall pick numbers belonging to a team across the whole draft. */
export function teamPickNumbers(
  pickOrder: number[],
  teamId: number,
  totalRounds: number,
  snake: boolean
): number[] {
  const teamCount = pickOrder.length;
  const slot = pickOrder.indexOf(teamId); // 0-based position in round 1
  if (slot === -1) return [];
  const picks: number[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const indexInRound = snake && round % 2 === 0 ? teamCount - 1 - slot : slot;
    picks.push((round - 1) * teamCount + indexInRound + 1);
  }
  return picks;
}

/** The team's next pick at or after the given overall pick (null if none left). */
export function nextPickAtOrAfter(myPicks: number[], currentOverall: number): number | null {
  for (const p of myPicks) {
    if (p >= currentOverall) return p;
  }
  return null;
}

/** The team's pick after that one (for two-turn planning). */
export function followingPick(myPicks: number[], currentOverall: number): number | null {
  let found = 0;
  for (const p of myPicks) {
    if (p >= currentOverall) {
      found++;
      if (found === 2) return p;
    }
  }
  return null;
}
