import { SLOT_ELIGIBILITY } from "../constants.js";
import { LeagueConfig, PlayerInfo, RankedPlayer, RosterNeeds } from "../types.js";

/* ------------------------------------------------------------------ */
/* Replacement level + VORP + tiers                                    */
/* ------------------------------------------------------------------ */

/**
 * How many players at each position are effectively "startable" league-wide.
 * Direct slots count fully; flex-style slots are apportioned across eligible
 * positions (RB/WR absorb nearly all flex starts in half-PPR leagues).
 */
export function startableCounts(config: LeagueConfig): Record<string, number> {
  const flexShare: Record<string, number> = { RB: 0.5, WR: 0.4, TE: 0.1, QB: 0 };
  const counts: Record<string, number> = {};
  for (const [slot, n] of Object.entries(config.starterSlots)) {
    const eligible = SLOT_ELIGIBILITY[slot] ?? [];
    if (eligible.length === 1) {
      counts[eligible[0]] = (counts[eligible[0]] ?? 0) + n * config.teamCount;
    } else {
      for (const pos of eligible) {
        counts[pos] = (counts[pos] ?? 0) + n * config.teamCount * (flexShare[pos] ?? 1 / eligible.length);
      }
    }
  }
  return counts;
}

/**
 * Rank the full pool: VORP against a replacement baseline derived from this
 * league's actual lineup requirements, plus projection-gap tiers per position.
 * Baselines use the FULL pool (drafted included) so VORP stays stable all draft.
 */
export function rankPool(pool: PlayerInfo[], config: LeagueConfig): RankedPlayer[] {
  const startable = startableCounts(config);
  const byPos = new Map<string, PlayerInfo[]>();
  for (const p of pool) {
    if (!byPos.has(p.position)) byPos.set(p.position, []);
    byPos.get(p.position)!.push(p);
  }

  const baseline: Record<string, number> = {};
  const tierByPlayer = new Map<number, number>();
  for (const [pos, players] of byPos) {
    players.sort((a, b) => b.projectedPoints - a.projectedPoints);
    // Replacement = best freely-available player once every startable slot plus
    // a little bench churn is accounted for.
    const churn = pos === "RB" || pos === "WR" ? config.teamCount * 0.5 : 1;
    const replacementRank = Math.min(
      players.length - 1,
      Math.max(1, Math.round((startable[pos] ?? config.teamCount) + churn))
    );
    baseline[pos] = players[replacementRank]?.projectedPoints ?? 0;

    // Tier breaks at meaningful projection gaps.
    let tier = 1;
    for (let i = 0; i < players.length; i++) {
      if (i > 0) {
        const gap = players[i - 1].projectedPoints - players[i].projectedPoints;
        if (gap > Math.max(5, players[i - 1].projectedPoints * 0.035)) tier++;
      }
      tierByPlayer.set(players[i].id, tier);
    }
  }

  return pool.map((p) => ({
    ...p,
    vorp: Math.round((p.projectedPoints - (baseline[p.position] ?? 0)) * 10) / 10,
    tier: tierByPlayer.get(p.id) ?? 99,
  }));
}

/* ------------------------------------------------------------------ */
/* Roster needs                                                        */
/* ------------------------------------------------------------------ */

export function computeRosterNeeds(
  myPlayers: PlayerInfo[],
  config: LeagueConfig
): RosterNeeds {
  const open: Record<string, number> = { ...config.starterSlots };
  const positionCounts: Record<string, number> = {};
  const byesByPos: Record<string, number[]> = {};
  let benchUsed = 0;

  // Best players claim starting slots first; direct slots before flex.
  const sorted = [...myPlayers].sort((a, b) => b.projectedPoints - a.projectedPoints);
  for (const p of sorted) {
    positionCounts[p.position] = (positionCounts[p.position] ?? 0) + 1;
    if (p.byeWeek) {
      (byesByPos[p.position] ??= []).push(p.byeWeek);
    }
    const direct = Object.keys(open).find(
      (slot) => (open[slot] ?? 0) > 0 && SLOT_ELIGIBILITY[slot]?.length === 1 && SLOT_ELIGIBILITY[slot][0] === p.position
    );
    const flex = Object.keys(open).find(
      (slot) => (open[slot] ?? 0) > 0 && (SLOT_ELIGIBILITY[slot]?.length ?? 0) > 1 && SLOT_ELIGIBILITY[slot].includes(p.position)
    );
    const slot = direct ?? flex;
    if (slot) open[slot]--;
    else benchUsed++;
  }

  const openStarterSlots = Object.fromEntries(
    Object.entries(open).filter(([, n]) => n > 0)
  );
  const starterGap = Object.values(openStarterSlots).reduce((a, b) => a + b, 0);
  return {
    openStarterSlots,
    positionCounts,
    benchSpotsLeft: Math.max(0, config.benchSlots - benchUsed),
    totalSpotsLeft: starterGap + Math.max(0, config.benchSlots - benchUsed),
    byeWeeksByPosition: byesByPos,
  };
}

/* ------------------------------------------------------------------ */
/* Pick recommendation scoring                                         */
/* ------------------------------------------------------------------ */

export interface ScoredCandidate {
  player: RankedPlayer;
  score: number;
  availabilityAtNextPick: "safe" | "at risk" | "likely gone";
  reasons: string[];
}

export function availabilityAtPick(
  adp: number,
  futurePick: number | null
): "safe" | "at risk" | "likely gone" {
  if (futurePick == null) return "safe";
  if (adp < futurePick - 2) return "likely gone";
  if (adp <= futurePick + 6) return "at risk";
  return "safe";
}

export function scoreCandidates(
  available: RankedPlayer[],
  needs: RosterNeeds,
  config: LeagueConfig,
  currentOverall: number,
  myNextPick: number | null,
  currentRound: number,
  totalRounds: number
): ScoredCandidate[] {
  const roundsLeft = totalRounds - currentRound + 1;
  // K and DST are streaming positions: draft one each, only in the final rounds.
  const openStreaming = ["K", "DST"].filter(
    (pos) => (needs.openStarterSlots[pos] ?? 0) > 0
  ).length;

  // Best projection still expected to be around at my NEXT pick, per position -
  // this is what makes waiting a real, quantified alternative.
  const bestLaterByPos: Record<string, number> = {};
  for (const p of available) {
    if (availabilityAtPick(p.adp, myNextPick) !== "likely gone") {
      bestLaterByPos[p.position] = Math.max(bestLaterByPos[p.position] ?? 0, p.projectedPoints);
    }
  }

  const flexOpen = Object.entries(needs.openStarterSlots).some(
    ([slot]) => (SLOT_ELIGIBILITY[slot]?.length ?? 0) > 1
  );

  const scored: ScoredCandidate[] = [];
  for (const p of available) {
    const reasons: string[] = [];
    let score = p.vorp;

    // --- Roster fit ---
    const directOpen = (needs.openStarterSlots[p.position] ?? 0) > 0;
    const flexFits = flexOpen && (SLOT_ELIGIBILITY["FLEX"] ?? []).includes(p.position);
    const have = needs.positionCounts[p.position] ?? 0;

    if (p.position === "K" || p.position === "DST") {
      const slotOpen = (needs.openStarterSlots[p.position] ?? 0) > 0;
      if (!slotOpen) {
        score -= 100;
        reasons.push(`Already have a ${p.position}; never roster two`);
      } else if (roundsLeft > openStreaming + 1) {
        score -= 100;
        reasons.push(`Never draft a ${p.position} before the final rounds`);
      } else {
        score += 40;
        reasons.push(`${p.position} slot must be filled - now is the time`);
      }
    } else if (directOpen) {
      score += 15;
      reasons.push(`Fills your open ${p.position} starter slot`);
    } else if (flexFits) {
      score += 8;
      reasons.push("Strong FLEX candidate");
    } else if (p.position === "QB" || p.position === "TE") {
      if (have >= 1) {
        score -= 25;
        reasons.push(`Backup ${p.position} - low value in a 1-${p.position} league; only for elite upside or bye insurance late`);
      }
    } else {
      score += 3; // RB/WR bench depth always plays
      reasons.push("Bench depth at a position that always matters (injuries, byes, flex)");
    }

    // --- Scarcity urgency: what do I lose by waiting until my next pick? ---
    const bestLater = bestLaterByPos[p.position] ?? 0;
    const dropoff = p.projectedPoints - bestLater;
    if (myNextPick != null && dropoff > 0) {
      const urgency = Math.min(20, dropoff * 0.5);
      score += urgency;
      if (dropoff >= 10) {
        reasons.push(
          `Position cliff: best ${p.position} likely left at pick ${myNextPick} projects ${dropoff.toFixed(0)} pts lower`
        );
      }
    }

    // --- Value vs ADP ---
    const slide = currentOverall - p.adp;
    if (p.adp < 900 && slide >= 8) {
      score += Math.min(10, slide * 0.3);
      reasons.push(`Falling in this draft: ADP ${p.adp} vs current pick ${currentOverall}`);
    } else if (p.adp < 900 && slide <= -15 && roundsLeft > 3) {
      score -= 5;
      reasons.push(`Reach alert: ADP ${p.adp} is well after this pick`);
    }

    // --- Bye week stacking among same-position pieces ---
    if (p.byeWeek && (needs.byeWeeksByPosition[p.position] ?? []).includes(p.byeWeek)) {
      score -= 3;
      reasons.push(`Shares week-${p.byeWeek} bye with your other ${p.position}(s)`);
    }

    // --- Injury flags ---
    if (p.injuryStatus) {
      const severe = ["OUT", "INJURY_RESERVE", "SUSPENSION", "DOUBTFUL"].includes(p.injuryStatus);
      score -= severe ? 10 : 4;
      reasons.push(`Injury flag: ${p.injuryStatus}`);
    }

    if (p.tier <= 2 && p.vorp > 0) {
      reasons.push(`Tier ${p.tier} at ${p.position} (top of what's left)`);
    }

    scored.push({
      player: p,
      score: Math.round(score * 10) / 10,
      availabilityAtNextPick: availabilityAtPick(p.adp, myNextPick),
      reasons,
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------ */
/* Strategy text (research-backed, tuned to this league shape)         */
/* ------------------------------------------------------------------ */

export function roundAdvice(
  round: number,
  totalRounds: number,
  needs: RosterNeeds,
  config: LeagueConfig
): string {
  const roundsLeft = totalRounds - round + 1;
  const starterGap = Object.values(needs.openStarterSlots).reduce((a, b) => a + b, 0);
  const streamOpen = ["K", "DST"].filter((pos) => (needs.openStarterSlots[pos] ?? 0) > 0);

  if (streamOpen.length && roundsLeft <= streamOpen.length) {
    return `Final rounds: fill ${streamOpen.join(" and ")} now - highest projection with a late bye.`;
  }
  if (streamOpen.length && roundsLeft <= streamOpen.length + 1) {
    return `Last ${roundsLeft} rounds: ${streamOpen.join(" and ")} still open - one pick each, use any spare pick on your best upside stash.`;
  }
  if (round <= 3) {
    return "Rounds 1-3: lock in elite RB/WR anchors. In half-PPR with only 2 WR slots, workhorse RBs carry extra weight; take the best combination of two RBs and one WR (or 2/2 by round 4) unless a top-3 positional player falls.";
  }
  if (round <= 6) {
    return "Rounds 4-6: finish your RB/WR starter core and pounce on a falling elite QB or TE - but don't reach; a dozen startable QBs/TEs exist for 11 teams.";
  }
  if (round <= 9) {
    const qbNote = (needs.positionCounts["QB"] ?? 0) === 0 ? " Get your QB in this window before the tier empties." : "";
    const teNote = (needs.positionCounts["TE"] ?? 0) === 0 ? " Same for TE - grab one before you're picking from the scraps." : "";
    return `Rounds 7-9: best value on the board, favoring RB/WR depth for FLEX and byes.${qbNote}${teNote}`;
  }
  if (starterGap > roundsLeft) {
    return `Warning: ${starterGap} starter slots open with only ${roundsLeft} picks left - fill required slots immediately.`;
  }
  return "Late rounds: swing for upside - handcuffs to your own RBs, ambiguous-backfield RBs, breakout WRs. Never a second QB/TE/K/DST in this roster format; a bench spot on upside beats insurance.";
}

export function strategyGuide(config: LeagueConfig, totalRounds: number): string {
  const starters = Object.entries(config.starterSlots)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  const hasDst = (config.starterSlots["DST"] ?? 0) > 0;
  const stream = hasDst ? "K and D/ST" : "your kicker";
  return `# Draft Strategy - ${config.teamCount}-team, ${config.scoringLabel}
**Lineup**: ${starters} + ${config.benchSlots} bench | **Rounds**: ${totalRounds}

## Why this league shape changes standard advice
- **${config.teamCount} teams is shallow**: the waiver wire stays useful all season, so upside beats safety on the bench, and QB/TE/K replacement level is high - never reach for them.
- **Only 2 WR + 1 FLEX**: WR depth is less valuable than in 3-WR leagues; elite RBs (scarcer, and boosted less by receptions in half-PPR than WRs in full PPR) are the premium asset.
- **Half PPR** narrows the RB-vs-WR gap vs full PPR: pass-catching RBs are gold; volume TDs matter more for WRs.
${hasDst
  ? "- **K and D/ST are pure streaming positions**: one each, in the final rounds only - the projection spread among startable options is tiny."
  : "- **No D/ST slot** means one fewer throwaway pick - that's an extra lottery ticket for your bench."}

## Round-by-round plan
| Rounds | Plan |
|---|---|
| 1-3 | Elite RB/WR anchors. Ideal: 2 RB + 1 WR or 2/1 flipped if WRs fall. Take a top-2 TE or top-3 QB only if they slide a full round past ADP. |
| 4-6 | Complete RB2/WR2, then best value. This is the sweet spot for a top-6 QB or top-tier TE *if one falls*. |
| 7-9 | QB and TE must be secured in this window. Otherwise RB/WR value + FLEX depth. |
| 10-${Math.max(11, totalRounds - 2)} | Upside bench: handcuffs, rookies with paths to volume, bye-week cover for RB/WR. No QB2/TE2. |
| ${Math.max(12, totalRounds - 1)}-${totalRounds} | ${stream} in the final picks (never earlier), best stash with anything left over. |

## Standing rules the recommend tool enforces
1. **${hasDst ? "K and D/ST last" : "Kicker last"}** - the projection spread among startable options is smaller than one good RB handcuff hitting.
2. **One QB, one TE${hasDst ? ", one K, one D/ST" : ""}** - backups at one-starter positions are wasted roster spots in a ${config.teamCount}-team league.
3. **Tier cliffs beat need** - when a position's last tier-2 player will be gone by your next pick, take them even if the "need" says otherwise.
4. **Don't triple-stack byes** at RB/WR among starters.
5. **ADP is a market price** - falling players are discounts; reaching 15+ picks early is paying retail for nothing.`;
}
