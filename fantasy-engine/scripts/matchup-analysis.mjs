#!/usr/bin/env node
// Matchup-adjusted (strength-of-schedule / defense-vs-position) analysis for lineup and waiver decisions.
//
//   node fantasy-engine/scripts/matchup-analysis.mjs            # markdown report to stdout
//
// Needs ESPN_S2, ESPN_SWID, LEAGUE_1_ID, LEAGUE_1_TEAM_ID. No npm dependencies; uses curl so it
// behaves the same as the daily routine's own curl calls behind proxies.
//
// Method, per position (QB/RB/WR/TE):
//   1. DvP: for every defense, fantasy points allowed to that position group per game, shrunk toward
//      the league average by PRIOR_GAMES phantom league-average games (small samples lie early on).
//      factor = shrunk allowed / league average  (1.15 = gives up 15% more than average).
//   2. Adjusted PPG: each past game's points divided by that opponent's factor, computed without the
//      game itself, so a player isn't credited or penalized for who he happened to play.
//   3. Matchup projection = adjusted PPG x this week's opponent factor.
//   4. Blend with ESPN's projection (which knows injuries, roles, news): weight on the matchup number
//      is games/(games+BLEND_GAMES), capped at MAX_WEIGHT.
import { execFileSync } from "node:child_process";

const PRIOR_GAMES = 3;
const BLEND_GAMES = 4;
const MAX_WEIGHT = 0.7;
const DISAGREE_PTS = 4;
const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE" };
const SLOT_NAMES = { 0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 23: "FLEX" };
const OUT_STATUSES = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION", "DOUBTFUL"]);

for (const v of ["ESPN_S2", "ESPN_SWID", "LEAGUE_1_ID", "LEAGUE_1_TEAM_ID"]) {
  if (!process.env[v]) fail(`missing env var ${v}`);
}
const MY_TEAM = Number(process.env.LEAGUE_1_TEAM_ID);
const now = new Date();
const YEAR = now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
const BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${YEAR}`;
const LEAGUE = `${BASE}/segments/0/leagues/${process.env.LEAGUE_1_ID}`;

function fail(msg) {
  console.error(`matchup-analysis: ${msg}`);
  process.exit(1);
}

function espn(url, filter) {
  const args = ["-sS", "--max-time", "90", "-w", "\n%{http_code}",
    "-H", `Cookie: espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`];
  if (filter) args.push("-H", `X-Fantasy-Filter: ${JSON.stringify(filter)}`);
  let out;
  try {
    out = execFileSync("curl", [...args, url], { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" });
  } catch (e) {
    fail(`network error calling ESPN: ${e.message.split("\n")[0]}`);
  }
  const cut = out.lastIndexOf("\n");
  const code = out.slice(cut + 1).trim();
  const body = out.slice(0, cut);
  if (code === "401" || code === "403" || body.trimStart().startsWith("<")) {
    fail(`ESPN returned ${code}${body.trimStart().startsWith("<") ? " (HTML login page)" : ""} — cookies expired?`);
  }
  if (code !== "200") fail(`ESPN returned HTTP ${code}`);
  return JSON.parse(body);
}

const league = espn(`${LEAGUE}?view=mSettings&view=mRoster&view=mTeam`);
const WEEK = league.scoringPeriodId;
const sched = espn(`${BASE}?view=proTeamSchedules_wl`);
const pool = espn(`${LEAGUE}?view=kona_player_info`, {
  players: {
    filterSlotIds: { value: [0, 2, 4, 6] },
    limit: 1500,
    sortPercOwned: { sortPriority: 1, sortAsc: false },
    filterStatsForSourceIds: { value: [0, 1] },
    filterStatsForSplitTypeIds: { value: [1] },
    filterStatsForScoringPeriodIds: { value: Array.from({ length: WEEK }, (_, i) => i + 1) },
  },
});

const TEAM_ABBR = {};
const opp = {}; // opp[proTeamId][week] = opposing proTeamId (absent = bye)
for (const t of sched.settings.proTeams) {
  TEAM_ABBR[t.id] = t.abbrev;
  opp[t.id] = {};
  for (const [wk, games] of Object.entries(t.proGamesByScoringPeriod || {})) {
    for (const g of games) opp[t.id][wk] = g.homeProTeamId === t.id ? g.awayProTeamId : g.homeProTeamId;
  }
}
const abbr = (id) => TEAM_ABBR[id] || "FA";

// ---- game logs (completed weeks only) ----
const players = new Map();
const logs = [];
for (const e of pool.players) {
  const p = e.player;
  const pos = POS[p.defaultPositionId];
  if (!pos) continue;
  const info = {
    id: p.id, name: p.fullName, pos, proTeamId: p.proTeamId, injury: p.injuryStatus || "ACTIVE",
    eligibleSlots: p.eligibleSlots || [], onTeamId: e.onTeamId || 0, status: e.status,
    own: p.ownership?.percentOwned ?? 0, ownChg: p.ownership?.percentChange ?? 0, games: [], espnProj: null,
  };
  for (const s of p.stats || []) {
    if (s.seasonId !== YEAR) continue;
    if (s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === WEEK) info.espnProj = s.appliedTotal;
    if (s.statSourceId !== 0 || s.statSplitTypeId !== 1 || s.scoringPeriodId >= WEEK) continue;
    if (!Object.values(s.stats || {}).some((v) => v !== 0)) continue;
    const team = s.proTeamId ?? p.proTeamId;
    const o = opp[team]?.[s.scoringPeriodId];
    if (o == null) continue;
    const g = { pid: p.id, pos, wk: s.scoringPeriodId, team, opp: o, pts: s.appliedTotal };
    info.games.push(g);
    logs.push(g);
  }
  players.set(p.id, info);
}
if (!logs.length) {
  console.log(`## Matchup-adjusted analysis (Week ${WEEK})\n\nNo completed games yet this season — nothing to adjust. Use ESPN projections.`);
  process.exit(0);
}

// ---- defense vs position ----
const allowed = {}; // allowed[pos][def][wk] = points allowed to that position group that week
for (const g of logs) {
  ((allowed[g.pos] ??= {})[g.opp] ??= {})[g.wk] = (allowed[g.pos][g.opp][g.wk] || 0) + g.pts;
}
const leagueAvg = {};
for (const pos of Object.values(POS)) {
  const vals = Object.values(allowed[pos] || {}).flatMap((w) => Object.values(w));
  leagueAvg[pos] = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
}
function factor(pos, def, excludeWk) {
  const lg = leagueAvg[pos];
  if (!lg) return 1;
  const wks = Object.entries(allowed[pos]?.[def] || {}).filter(([wk]) => Number(wk) !== excludeWk);
  const total = wks.reduce((a, [, v]) => a + v, 0);
  return (total + PRIOR_GAMES * lg) / ((wks.length + PRIOR_GAMES) * lg);
}
function defRank(pos, def) {
  const defs = Object.keys(allowed[pos] || {}).map(Number).sort((a, b) => factor(pos, a) - factor(pos, b));
  return { rank: defs.indexOf(def) + 1, of: defs.length };
}

// ---- per-player metrics ----
for (const pl of players.values()) {
  const n = pl.games.length;
  pl.n = n;
  pl.ppg = n ? pl.games.reduce((a, g) => a + g.pts, 0) / n : 0;
  pl.adjPpg = n ? pl.games.reduce((a, g) => a + g.pts / factor(pl.pos, g.opp, g.wk), 0) / n : 0;
  const o = opp[pl.proTeamId]?.[WEEK];
  pl.oppThisWeek = o;
  pl.bye = o == null;
  pl.factorNow = o == null ? 0 : factor(pl.pos, o);
  pl.matchupProj = pl.adjPpg * pl.factorNow;
  const w = Math.min(MAX_WEIGHT, n / (n + BLEND_GAMES));
  pl.weight = w;
  const out = pl.bye || OUT_STATUSES.has(pl.injury);
  if (out) pl.blend = 0;
  else if (pl.espnProj == null) pl.blend = n ? pl.matchupProj : 0;
  else if (pl.espnProj === 0) pl.blend = 0; // ESPN zeroes players it expects not to play
  else pl.blend = w * pl.matchupProj + (1 - w) * pl.espnProj;
  pl.out = out || pl.espnProj === 0;
  // next 3 weeks (bye = 0) for waiver value
  let ros = 0;
  for (let wk = WEEK; wk < WEEK + 3; wk++) {
    const ow = opp[pl.proTeamId]?.[wk];
    if (ow != null) ros += pl.adjPpg * factor(pl.pos, ow);
  }
  pl.next3 = ros / 3;
}

const f1 = (x) => (x == null ? "–" : x.toFixed(1));
const pct = (fac) => (fac ? `${fac >= 1 ? "+" : "−"}${Math.abs((fac - 1) * 100).toFixed(0)}%` : "bye");
const oppLabel = (pl) => (pl.bye ? "BYE" : `${abbr(pl.oppThisWeek)} (${pct(pl.factorNow)}, #${defRank(pl.pos, pl.oppThisWeek).rank} vs ${pl.pos})`);

// ---- my roster + optimal lineup ----
const myTeam = league.teams.find((t) => t.id === MY_TEAM);
if (!myTeam) fail(`team ${MY_TEAM} not found in league`);
const roster = (myTeam.roster?.entries || [])
  .map((e) => ({ slot: e.lineupSlotId, pl: players.get(e.playerId) }))
  .filter((r) => r.pl);
const slotCounts = league.settings?.rosterSettings?.lineupSlotCounts || {};
const fillOrder = [0, 2, 4, 6, 3, 5, 23, 7].filter((s) => slotCounts[s] > 0);
const used = new Set();
const optimal = [];
for (const slot of fillOrder) {
  for (let i = 0; i < slotCounts[slot]; i++) {
    const best = roster
      .filter((r) => !used.has(r.pl.id) && r.pl.eligibleSlots.includes(slot) && r.slot !== 21)
      .sort((a, b) => b.pl.blend - a.pl.blend)[0];
    if (!best) continue;
    used.add(best.pl.id);
    optimal.push({ slot, pl: best.pl });
  }
}
const startingNow = new Set(roster.filter((r) => SLOT_NAMES[r.slot]).map((r) => r.pl.id));
const optimalIds = new Set(optimal.map((o) => o.pl.id));

const out = [];
out.push(`## Matchup-adjusted analysis (Week ${WEEK})`);
out.push("");
out.push(`Opponent factor = how much that defense gives up to the position vs league average, regressed toward average (${PRIOR_GAMES} phantom average games). Adj PPG = points per game after removing the strength of defenses already faced. Blend = ${"matchup projection"} weighted by games played (max ${MAX_WEIGHT * 100}%) + ESPN projection for the rest.`);
out.push("");
out.push("### My roster");
out.push("| Player | Pos | Opp this week | PPG | Adj PPG | ESPN proj | Matchup proj | **Blend** | Optimal |");
out.push("|---|---|---|---|---|---|---|---|---|");
const ordered = [...roster].sort((a, b) => b.pl.blend - a.pl.blend);
for (const { pl } of ordered) {
  const flag = Math.abs(pl.matchupProj - (pl.espnProj ?? pl.matchupProj)) >= DISAGREE_PTS && !pl.out && pl.n ? " ⚠" : "";
  const inj = pl.injury !== "ACTIVE" ? ` (${pl.injury.replaceAll("_", " ").toLowerCase()})` : "";
  out.push(`| ${pl.name}${inj} | ${pl.pos} | ${oppLabel(pl)} | ${f1(pl.ppg)} | ${f1(pl.adjPpg)} | ${f1(pl.espnProj)} | ${f1(pl.matchupProj)}${flag} | **${f1(pl.blend)}** | ${optimalIds.has(pl.id) ? "START" : ""} |`);
}
out.push("");
out.push("⚠ = matchup projection and ESPN disagree by ≥" + DISAGREE_PTS + " pts — read why before locking.");
out.push("");
const toStart = optimal.filter((o) => !startingNow.has(o.pl.id));
const toBench = roster.filter((r) => startingNow.has(r.pl.id) && !optimalIds.has(r.pl.id));
if (toStart.length || toBench.length) {
  out.push("**Suggested lineup changes:** " +
    toStart.map((o) => `start ${o.pl.name} (${SLOT_NAMES[o.slot]}, ${f1(o.pl.blend)})`).join("; ") +
    (toBench.length ? `; bench ${toBench.map((r) => `${r.pl.name} (${f1(r.pl.blend)})`).join(", ")}` : ""));
} else {
  out.push("**Current lineup already matches the matchup-adjusted optimum.**");
}
out.push("");

// ---- waivers ----
out.push("### Waiver targets (free agents, top 3 per position by matchup-adjusted value over the next 3 weeks)");
out.push("| Player | Pos | Team | Own% (Δ) | Games | Adj PPG | Next-3 avg | This week (blend) |");
out.push("|---|---|---|---|---|---|---|---|");
for (const pos of Object.values(POS)) {
  const fas = [...players.values()]
    .filter((p) => p.pos === pos && (p.status === "FREEAGENT" || p.status === "WAIVERS") && p.n >= 2 && !OUT_STATUSES.has(p.injury))
    .sort((a, b) => b.next3 - a.next3)
    .slice(0, 3);
  for (const p of fas) {
    out.push(`| ${p.name}${p.injury !== "ACTIVE" ? ` (${p.injury.replaceAll("_", " ").toLowerCase()})` : ""} | ${p.pos} | ${abbr(p.proTeamId)} | ${f1(p.own)} (${p.ownChg >= 0 ? "+" : ""}${f1(p.ownChg)}) | ${p.n} | ${f1(p.adjPpg)} | ${f1(p.next3)} | ${p.bye ? "BYE" : `${f1(p.blend)} vs ${abbr(p.oppThisWeek)}`} |`);
  }
}
out.push("");
out.push("Compare a target's Next-3 avg against the blend of the roster player you'd drop at the same position; adds that don't beat your worst rostered option at that spot aren't worth FAAB.");
out.push("");

// ---- defense table ----
out.push("### Defense vs position (toughest → softest), factor vs league average");
for (const pos of Object.values(POS)) {
  const defs = Object.keys(allowed[pos] || {}).map(Number).sort((a, b) => factor(pos, a) - factor(pos, b));
  const fmt = (d) => `${abbr(d)} ${pct(factor(pos, d))}`;
  out.push(`- **${pos}** (avg ${f1(leagueAvg[pos])}/g) — toughest: ${defs.slice(0, 5).map(fmt).join(", ")} · softest: ${defs.slice(-5).reverse().map(fmt).join(", ")}`);
}
console.log(out.join("\n"));
