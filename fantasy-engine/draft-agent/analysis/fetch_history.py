#!/usr/bin/env python3
"""Fetch full ESPN league history (drafts, rosters, standings, matchups) into
per-year JSON files under analysis/out/.

Usage:  python3 fetch_history.py [firstYear] [lastYear]
Env:    LEAGUE_ID, ESPN_S2, ESPN_SWID (read from ../.env if not set)
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_env() -> None:
    """Minimal .env loader mirroring src/env.ts: existing env vars win."""
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
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

LEAGUE = os.environ.get("LEAGUE_ID") or os.environ.get("LEAGUE_1_ID")
if not LEAGUE:
    sys.exit("Set LEAGUE_ID (or LEAGUE_1_ID)")
COOKIE = f"espn_s2={os.environ.get('ESPN_S2', '')}; SWID={os.environ.get('ESPN_SWID', '')}"
BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
VIEWS = "view=mTeam&view=mDraftDetail&view=mRoster&view=mSettings&view=mMatchup"


def get(url: str, extra: dict | None = None):
    req = urllib.request.Request(url, headers={"Cookie": COOKIE, **(extra or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def current_nfl_season_year() -> int:
    """Mirror src/constants.ts getCurrentNFLSeasonYear: Jan/Feb -> previous season."""
    from datetime import date

    today = date.today()
    return today.year - 1 if today.month <= 2 else today.year


first = int(sys.argv[1]) if len(sys.argv) > 1 else 2016
last = int(sys.argv[2]) if len(sys.argv) > 2 else current_nfl_season_year()

for y in range(first, last + 1):
    url = (
        f"{BASE}/seasons/{y}/segments/0/leagues/{LEAGUE}?{VIEWS}"
        if y == last
        else f"{BASE}/leagueHistory/{LEAGUE}?seasonId={y}&{VIEWS}"
    )
    try:
        data = get(url)
        if isinstance(data, list):
            data = data[0]
        (OUT / f"season-{y}.json").write_text(json.dumps(data))
        print(f"{y}: teams={len(data.get('teams', []))} picks={len((data.get('draftDetail') or {}).get('picks', []))}")
    except Exception as e:  # noqa: BLE001 - report and keep going per year
        print(f"{y}: FAILED {e}")
        continue
    try:
        players = get(
            f"{BASE}/seasons/{y}/players?scoringPeriodId=0&view=players_wl",
            {"X-Fantasy-Filter": json.dumps({"filterActive": None})},
        )
        pmap = {str(p["id"]): {"name": p.get("fullName"), "pos": p.get("defaultPositionId")} for p in players}
        (OUT / f"players-{y}.json").write_text(json.dumps(pmap))
        print(f"{y}: players={len(pmap)}")
    except Exception as e:  # noqa: BLE001
        print(f"{y}: players FAILED {e}")
