#!/usr/bin/env python3
"""Analyze fetched league history: champions' draft construction, rival draft
tendencies, head-to-head vs your franchise, transaction patterns.

Run fetch_history.py first; reads analysis/out/, writes analysis/out/analysis.json.
Env: ESPN_SWID identifies your franchise (read from ../.env if not set).
"""
import json
import os
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_env() -> None:
    for f in (HERE.parent / ".env", HERE.parent.parent / ".env"):
        if not f.exists():
            continue
        for line in f.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


load_env()
DIR = HERE / "out"
MY_SWID = os.environ["ESPN_SWID"].upper()

POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}

seasons = {}
for y in range(2016, 2026):
    f = DIR / f"season-{y}.json"
    if f.exists():
        seasons[y] = json.loads(f.read_text())

players = {}
for y in seasons:
    pf = DIR / f"players-{y}.json"
    players[y] = json.loads(pf.read_text()) if pf.exists() else {}

# ---- franchise identity: owner guid -> display name (latest wins) ----
owner_name = {}
for y in sorted(seasons):
    for m in seasons[y].get("members", []):
        gid = m["id"].upper()
        nm = m.get("displayName") or f"{m.get('firstName','')} {m.get('lastName','')}".strip()
        owner_name[gid] = nm

def team_owner(team):
    owners = [o.upper() for o in team.get("owners", [])]
    return owners[0] if owners else None

def team_label(team, y):
    loc = team.get("location") or ""
    nick = team.get("nickname") or ""
    name = (loc + " " + nick).strip() or team.get("name") or f"Team {team['id']}"
    return name

out = {"seasons": {}, "franchises": {}, "h2h": {}, "champDraft": []}

# per-franchise accumulators
fr = defaultdict(lambda: {
    "seasons": 0, "wins": 0, "losses": 0, "ties": 0, "pf": 0.0, "pa": 0.0,
    "titles": [], "runnerUps": [], "regSeasonTitles": [], "lastPlaces": [],
    "playoffs": 0, "finishes": [],
    "qbRounds": [], "teRounds": [], "kRounds": [], "dstRounds": [],
    "r13pos": defaultdict(int),  # positions taken rounds 1-3
    "acquisitions": 0, "trades": 0, "faabSpent": 0, "faabSeasons": 0,
    "names": set(),
})
h2h = defaultdict(lambda: {"w": 0, "l": 0, "t": 0, "pf": 0.0, "pa": 0.0, "playoffW": 0, "playoffL": 0})
my_guid = None

for y in sorted(seasons):
    S = seasons[y]
    teams = {t["id"]: t for t in S["teams"]}
    pmap = players.get(y, {})
    id2owner = {tid: team_owner(t) for tid, t in teams.items()}
    for t in teams.values():
        g = id2owner[t["id"]]
        if g:
            fr[g]["names"].add(team_label(t, y))
            if g == MY_SWID:
                my_guid = g

    # standings / finishes
    yr = {"year": y, "teams": []}
    for t in sorted(teams.values(), key=lambda t: t.get("rankCalculatedFinal") or 99):
        rec = t["record"]["overall"]
        g = id2owner[t["id"]]
        fin = t.get("rankCalculatedFinal") or 0
        seed = t.get("playoffSeed") or 0
        yr["teams"].append({
            "owner": owner_name.get(g, "?"), "guid": g, "team": team_label(t, y),
            "finish": fin, "seed": seed, "w": rec["wins"], "l": rec["losses"],
            "t": rec.get("ties", 0), "pf": round(rec["pointsFor"], 1), "pa": round(rec["pointsAgainst"], 1),
        })
        if g:
            F = fr[g]
            F["seasons"] += 1
            F["wins"] += rec["wins"]; F["losses"] += rec["losses"]; F["ties"] += rec.get("ties", 0)
            F["pf"] += rec["pointsFor"]; F["pa"] += rec["pointsAgainst"]
            F["finishes"].append((y, fin))
            if fin == 1: F["titles"].append(y)
            if fin == 2: F["runnerUps"].append(y)
            if seed == 1: F["regSeasonTitles"].append(y)
            if fin == len(teams): F["lastPlaces"].append(y)
            if seed and seed <= (S.get("settings", {}).get("scheduleSettings", {}).get("playoffTeamCount") or 6):
                F["playoffs"] += 1
            tc = t.get("transactionCounter") or {}
            F["acquisitions"] += tc.get("acquisitions", 0)
            F["trades"] += tc.get("trades", 0)
            spent = tc.get("acquisitionBudgetSpent", 0)
            if spent:
                F["faabSpent"] += spent; F["faabSeasons"] += 1

    # draft
    picks = (S.get("draftDetail") or {}).get("picks", [])
    draft_by_team = defaultdict(list)
    for p in picks:
        info = pmap.get(str(p["playerId"]), {})
        pos = POS.get(info.get("pos"), "?")
        draft_by_team[p["teamId"]].append({
            "round": p["roundId"], "overall": p["overallPickNumber"],
            "player": info.get("name", f"#{p['playerId']}"), "pos": pos,
            "keeper": p.get("reservedForKeeper", False),
        })
        g = id2owner.get(p["teamId"])
        if g and p["roundId"] <= 3:
            fr[g]["r13pos"][pos] += 1
    # first QB/TE/K/DST round per team per year
    for tid, plist in draft_by_team.items():
        g = id2owner.get(tid)
        if not g: continue
        for pos_key, field in (("QB", "qbRounds"), ("TE", "teRounds"), ("K", "kRounds"), ("D/ST", "dstRounds")):
            rounds = [pk["round"] for pk in plist if pk["pos"] == pos_key]
            if rounds:
                fr[g][field].append(min(rounds))

    # champion draft construction + final roster origin
    champ = next((t for t in teams.values() if t.get("rankCalculatedFinal") == 1), None)
    if champ:
        cpicks = sorted(draft_by_team.get(champ["id"], []), key=lambda p: p["overall"])
        drafted_ids = {p["player"] for p in cpicks}
        roster = [(e.get("playerPoolEntry") or {}).get("player", {}) for e in (champ.get("roster") or {}).get("entries", [])]
        final_names = [r.get("fullName") for r in roster if r]
        kept = [n for n in final_names if n in drafted_ids]
        yr["champion"] = {
            "owner": owner_name.get(id2owner[champ["id"]], "?"),
            "team": team_label(champ, y),
            "picks": cpicks,
            "finalRoster": final_names,
            "draftedStillOnRoster": len(kept),
            "finalRosterSize": len(final_names),
        }
        out["champDraft"].append({"year": y, **yr["champion"]})
    out["seasons"][y] = yr

    # H2H vs my franchise
    for m in S.get("schedule", []):
        home, away = m.get("home"), m.get("away")
        if not home or not away: continue
        sides = {id2owner.get(home.get("teamId")): home, id2owner.get(away.get("teamId")): away}
        if my_guid not in sides: continue
        opp_guid = next((g for g in sides if g != my_guid), None)
        if not opp_guid: continue
        me, opp = sides[my_guid], sides[opp_guid]
        mp, op = me.get("totalPoints", 0), opp.get("totalPoints", 0)
        if mp == 0 and op == 0: continue
        H = h2h[opp_guid]
        playoff = m.get("playoffTierType") == "WINNERS_BRACKET" and (m.get("matchupPeriodId", 0) > 13)
        if mp > op:
            H["w"] += 1
            if playoff: H["playoffW"] += 1
        elif op > mp:
            H["l"] += 1
            if playoff: H["playoffL"] += 1
        else:
            H["t"] += 1
        H["pf"] += mp; H["pa"] += op

for g, F in fr.items():
    F["names"] = sorted(F["names"])
    F["r13pos"] = dict(F["r13pos"])
    F["owner"] = owner_name.get(g, "?")
    out["franchises"][g] = F
out["h2h"] = {g: dict(v, owner=owner_name.get(g, "?")) for g, v in h2h.items()}
out["myGuid"] = my_guid
out["ownerNames"] = owner_name

(DIR / "analysis.json").write_text(json.dumps(out, indent=1))

# ---- printed digest ----
print("=== CHAMPIONS ===")
for y in sorted(out["seasons"]):
    c = out["seasons"][y].get("champion")
    if c:
        top3 = ", ".join(f"R{p['round']} {p['player']} ({p['pos']})" for p in c["picks"][:3])
        print(f"{y}: {c['owner']} ({c['team']}) | first 3 picks: {top3} | drafted still on final roster: {c['draftedStillOnRoster']}/{c['finalRosterSize']}")

print("\n=== CHAMPION DRAFT SHAPE (rounds 1-6 positions) ===")
for c in out["champDraft"]:
    shape = "-".join(p["pos"] for p in c["picks"][:6])
    print(f"{c['year']}: {shape}  ({c['owner']})")

print("\n=== FRANCHISES (all-time) ===")
for g, F in sorted(out["franchises"].items(), key=lambda kv: -len(kv[1]["titles"])):
    gp = F["wins"] + F["losses"] + F["ties"]
    wpct = F["wins"] / gp if gp else 0
    avg_qb = sum(F["qbRounds"]) / len(F["qbRounds"]) if F["qbRounds"] else 0
    avg_te = sum(F["teRounds"]) / len(F["teRounds"]) if F["teRounds"] else 0
    print(f"{F['owner']:22s} seasons={F['seasons']:2d} W-L={F['wins']}-{F['losses']} ({wpct:.3f}) "
          f"titles={F['titles']} 2nds={len(F['runnerUps'])} last={len(F['lastPlaces'])} "
          f"avgQBrd={avg_qb:.1f} avgTErd={avg_te:.1f} R1-3={F['r13pos']} "
          f"adds={F['acquisitions']} trades={F['trades']} faab={F['faabSpent']}/{F['faabSeasons']}yr")

print(f"\n=== H2H vs {owner_name.get(my_guid, '?')} ===")
for g, H in sorted(out["h2h"].items(), key=lambda kv: -(kv[1]["w"] + kv[1]["l"])):
    print(f"vs {H['owner']:22s} {H['w']}-{H['l']}-{H['t']}  (playoffs {H['playoffW']}-{H['playoffL']})  avg {H['pf']/max(1,H['w']+H['l']+H['t']):.1f}-{H['pa']/max(1,H['w']+H['l']+H['t']):.1f}")
