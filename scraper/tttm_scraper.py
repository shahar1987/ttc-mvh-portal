#!/usr/bin/env python3
"""
סקרייפר TTTM -> Firestore   (מועדון 160, הפועל מבואות חרמון)

מה הוא אוסף בכל ריצה:
  1. רשימת השחקנים של המועדון (/c/160-ap/) + דירוג ונקודות (/c/160-p/)
  2. הקבוצות של העונה הנוכחית וטבלאות הליגה שלהן (/c/160-c/ + דף הבית של כל ליגה)
  3. כל משחקי הקבוצות (עבר + עתיד) מדפי הליגות
  4. לכל משחק שהסתיים ועדיין לא נקלט -> /api/matchs/{id} (JSON) -> תוצאות אישיות
  5. מעדכן ב-Firestore רק מסמכים שהשתנו

הרצה:
  python tttm_scraper.py                 # כתיבה ל-Firestore (דורש GOOGLE_APPLICATION_CREDENTIALS)
  python tttm_scraper.py --dry-run       # רק מדפיס JSON, בלי Firestore
  python tttm_scraper.py --dry-run --out snapshot.json

מבנה ב-Firestore:
  tttm/players/items/{tttmId}   name, category, rank, rating, ratingPrev, ratingUpdatedAt,
                                teamKey (M1/M2/M4), lastMatches[], updatedAt
  tttm/teams/items/{teamId}     teamKey, name, eventId, drawId, league, drawName,
                                position, played, won, drawn, lost, points, table[],
                                nextMatch, lastResults[], updatedAt
  tttm/matches/items/{matchId}  date, time, eventId, drawId, league, drawName, round,
                                homeId, homeName, awayId, awayName, homeScore, awayScore,
                                played, ourTeamId, ourTeamKey, isHome, individual[] , updatedAt
  tttm/meta/items/status        lastRun, counts
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

BASE = "https://tttm.co.il"
CLUB_ID = int(os.environ.get("TTTM_CLUB_ID", "160"))
CLUB_NAME_HINT = "מבואות חרמון"
# TTTM יושב מאחורי Cloudflare וחוסם User-Agent שנראה כמו בוט (403).
# לכן שולחים כותרות של דפדפן אמיתי.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
BROWSER_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Connection": "keep-alive",
}
# Cloudflare חוסם גם לפי טביעת האצבע של ה-TLS (JA3), לא רק לפי הכותרות.
# curl_cffi מחקה את ה-TLS של Chrome אמיתי ולכן עובר. אם הוא לא מותקן —
# נופלים חזרה ל-requests רגיל (יעבוד מרשת ביתית, לא משרתי GitHub).
try:
    from curl_cffi import requests as _curl
    SESSION = _curl.Session(impersonate="chrome")
    USING_CURL_CFFI = True
except Exception:  # pragma: no cover
    SESSION = requests.Session()
    USING_CURL_CFFI = False
SESSION.headers.update(BROWSER_HEADERS)

# אופציונלי: אם TTTM חוסם את שרתי GitHub, אפשר להעביר את הבקשות דרך ה-Worker
# (משתנה סביבה TTTM_PROXY, למשל https://ttc-mvh-login.<שם>.workers.dev/fetch?url=)
PROXY_PREFIX = os.environ.get("TTTM_PROXY", "").strip()

LAST_MATCHES_PER_PLAYER = 5


# ---------------------------------------------------------------- HTTP helpers
def get(path, retries=4, sleep=2.0):
    url = path if path.startswith("http") else BASE + path
    fetch_url = (PROXY_PREFIX + quote(url, safe="")) if PROXY_PREFIX else url
    last = None
    for i in range(retries):
        try:
            headers = {}
            if not path.startswith("http") and path != "/":
                headers["Referer"] = BASE + "/"
            if "/api/" in path:
                headers["Accept"] = "application/json, text/plain, */*"
                headers["Sec-Fetch-Dest"] = "empty"
                headers["Sec-Fetch-Mode"] = "cors"
                headers["Sec-Fetch-Site"] = "same-origin"
                headers["X-Requested-With"] = "XMLHttpRequest"
            r = SESSION.get(fetch_url, timeout=40, headers=headers)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code in (401, 403, 429, 503):
                time.sleep(sleep * (i + 2))
        except Exception as e:  # pragma: no cover  (curl_cffi has its own exception types)
            last = f"{type(e).__name__}: {e}"
        time.sleep(sleep * (i + 1))
    raise RuntimeError(f"GET {url} failed: {last} (curl_cffi={USING_CURL_CFFI}, proxy={bool(PROXY_PREFIX)})")


def soup(path):
    return BeautifulSoup(get(path).text, "html.parser")


def txt(el):
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)) if el else ""


def parse_date(s):
    """'20/10/26' or "ג' 20/10/26" -> '2026-10-20'"""
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s or "")
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000
    return f"{y:04d}-{mo:02d}-{d:02d}"


def team_key(name):
    """'הפועל מבואות חרמון M1' -> 'M1'"""
    m = re.search(r"\b([MWF]\d+|M|W)\s*$", name or "")
    return m.group(1) if m else None


def id_from_href(href, prefix):
    """/t/1568-1151/... -> ('1568','1151');  /p/1439/... -> ('1439', None)"""
    m = re.search(rf"/{prefix}/(\d+)(?:-(\d+))?", href or "")
    return (m.group(1), m.group(2)) if m else (None, None)


def is_ours(name):
    return CLUB_NAME_HINT in (name or "")


# ---------------------------------------------------------------- scraping
def scrape_players():
    """כל השחקנים + דירוג. מחזיר dict tttmId -> player"""
    players = {}
    s = soup(f"/c/{CLUB_ID}-ap/x")
    for tr in s.select("table.presentTurn tr"):
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue
        pid = txt(tds[1])
        if not pid.isdigit():
            continue
        players[pid] = {
            "tttmId": pid,
            "category": txt(tds[2]),
            "name": txt(tds[3]),
            "rank": None,
            "rating": None,
            "rankDelta": None,
        }

    s = soup(f"/c/{CLUB_ID}-p/x")
    for table in s.select("table.rank"):
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < 8:
                continue
            pid = txt(tds[2])
            if not pid.isdigit():
                continue
            p = players.setdefault(pid, {"tttmId": pid, "name": txt(tds[5]), "category": txt(tds[3])})
            delta = txt(tds[0])
            rank = txt(tds[1])
            pts = re.match(r"([\d.]+)", txt(tds[7]))
            p["rank"] = int(rank) if rank.isdigit() else None
            p["rankDelta"] = int(delta) if re.fullmatch(r"[+-]?\d+", delta) else None
            p["rating"] = float(pts.group(1)) if pts else None
            img = tds[4].find("img")
            if img and img.get("src") and "Avatar" not in img["src"]:
                p["photoUrl"] = BASE + img["src"]
    return players


def scrape_teams():
    """הקבוצות של העונה הנוכחית מדף /c/160-c/. מחזיר list of team dicts (עם drawId, eventId)"""
    teams = []
    s = soup(f"/c/{CLUB_ID}-c/x")
    for h1 in s.select("div.tttm_ls_container h1"):
        league_a = h1.find("a")
        league = txt(league_a)
        event_id, _ = id_from_href(league_a.get("href") if league_a else "", "e")
        container = h1.parent
        for tab in container.select("div.tttm_ls_tab"):
            label = tab.find("label")
            draw_a = label.find("a") if label else None
            draw_name = txt(label).strip() if label else ""
            m = re.search(r"/e/(\d+)-(\d+)/", draw_a.get("href", "") if draw_a else "")
            draw_id = m.group(2) if m else None
            for a in tab.select("table.lstTeamGroup a[href^='/t/']"):
                if is_ours(txt(a)):
                    tid, _ = id_from_href(a["href"], "t")
                    teams.append({
                        "teamId": tid,
                        "teamKey": team_key(txt(a)),
                        "name": txt(a),
                        "league": league,
                        "eventId": event_id,
                        "drawId": draw_id,
                        "drawName": draw_name,
                    })
    return teams


def scrape_draw(event_id, draw_id):
    """דף ליגה: טבלה + כל המשחקים בכל המחזורים"""
    s = soup(f"/e/{event_id}-{draw_id}/x/y")
    table = []
    for tr in s.select("div.group table.lstTeamGroup tr"):
        tds = tr.find_all("td")
        if len(tds) < 7:
            continue
        a = tds[1].find("a")
        tid, _ = id_from_href(a.get("href") if a else "", "t")
        nums = [txt(td) for td in tds[2:7]]
        table.append({
            "position": int(txt(tds[0])) if txt(tds[0]).isdigit() else None,
            "teamId": tid,
            "name": txt(a),
            "played": _int(nums[0]), "won": _int(nums[1]), "drawn": _int(nums[2]),
            "lost": _int(nums[3]), "points": _int(nums[4]),
            "ours": is_ours(txt(a)),
        })

    matches = []
    for tbl in s.select("table.presentTurn"):
        round_name = txt(tbl.find("th"))
        current_date = None
        for tr in tbl.find_all("tr"):
            place = tr.find("td", class_="place")
            if place is not None:
                current_date = parse_date(txt(place))
            tds = [td for td in tr.find_all("td") if "place" not in (td.get("class") or [])]
            if len(tds) < 5:
                continue
            time_ = txt(tds[1])
            home_a, away_a = tds[2].find("a"), tds[4].find("a")
            score_a = tds[3].find("a")
            mid = None
            if score_a:
                m = re.search(r"/m/(\d+)/", score_a.get("href", ""))
                mid = m.group(1) if m else None
            if not mid:
                pdf = tds[0].find("a", href=re.compile(r"mid=\d+"))
                m = re.search(r"mid=(\d+)", pdf["href"]) if pdf else None
                mid = m.group(1) if m else None
            if not mid:
                continue
            hs, as_ = _score(txt(score_a))
            hid, _ = id_from_href(home_a.get("href") if home_a else "", "t")
            aid, _ = id_from_href(away_a.get("href") if away_a else "", "t")
            matches.append({
                "matchId": mid,
                "round": round_name,
                "date": current_date,
                "time": time_ if re.fullmatch(r"\d{1,2}:\d{2}", time_) else None,
                "homeId": hid, "homeName": txt(home_a),
                "awayId": aid, "awayName": txt(away_a),
                "homeScore": hs, "awayScore": as_,
                "played": hs is not None and (hs + as_) > 0,
            })
    return table, matches


def scrape_match_details(match_id):
    """/api/matchs/{id} -> {'score': '4 : 2', 'homeName':..., 'games': [...]}"""
    r = get(f"/api/matchs/{match_id}")
    j = r.json().get("resp") or {}
    html = j.get("listMatchs") or ""
    games = []
    if html:
        s = BeautifulSoup(html, "html.parser")
        rows = s.find_all("tr")
        i = 0
        while i < len(rows):
            th = rows[i].find("th")
            tds = rows[i].find_all("td")
            if th and len(tds) >= 3:
                label = txt(th)
                left = [(id_from_href(a["href"], "p")[0], txt(a)) for a in tds[0].find_all("a")]
                right = [(id_from_href(a["href"], "p")[0], txt(a)) for a in tds[2].find_all("a")]
                sets = txt(tds[1])
                points = ""
                if i + 1 < len(rows) and rows[i + 1].find("td", class_="points"):
                    points = txt(rows[i + 1].find("td", class_="points"))
                    i += 1
                ls, rs = _score(sets)
                games.append({
                    "label": label,
                    "doubles": label.lower() == "double",
                    "homePlayers": [{"id": a, "name": b} for a, b in left],
                    "awayPlayers": [{"id": a, "name": b} for a, b in right],
                    "homeSets": ls, "awaySets": rs,
                    "points": points,
                    "played": ls is not None and (ls + rs) > 0,
                })
            i += 1
    return {
        "score": j.get("bigScore"),
        "homeName": j.get("nameClubA"),
        "awayName": j.get("nameClubX"),
        "games": games,
    }


def _int(s):
    return int(s) if s and s.lstrip("-").isdigit() else None


def _score(s):
    m = re.search(r"(\d+)\s*:\s*(\d+)", s or "")
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)



def scrape_tournaments():
    """כל התחרויות שמפורסמות ב-TTTM לעונה הנוכחית (עמוד 'אירועים -> כולם')."""
    out = []
    try:
        s = soup("/?page=eventLst")
    except Exception as e:
        print(f"(tournaments page failed: {e})", file=sys.stderr)
        return out
    for box in s.select("div.lstEvent > div"):
        a = box.select_one("div.titleEvent a")
        if not a:
            continue
        eid, _ = id_from_href(a.get("href", ""), "e")
        if not eid:
            continue
        img = box.find("img")
        t = {
            "eventId": eid,
            "name": txt(a),
            "date": parse_date(txt(box.find("p"))),
            "url": BASE + a["href"],
            "imageUrl": BASE + img["src"].replace(" ", "%20") if img and img.get("src") else "",
            "venue": "",
            "registrationUntil": "",
            "categories": [],
            "info": "",
        }
        try:
            d = soup(f"/e/{eid}/x")
            body = txt(d.select_one("div.content") or d.body)
            m = re.search(r"מקום התחרות:\s*([^\n]+?)(?:\s{2,}|התחרות נערכת|מנהל התחרות|$)", body)
            if m:
                t["venue"] = m.group(1).strip(" .")[:120]
            m = re.search(r"סיום ה?רשמה[^\d]{0,30}(\d{1,2}[./]\d{1,2}[./]\d{2,4})(?:[^\d]{0,15}(\d{1,2}:\d{2}))?", body)
            if m:
                t["registrationUntil"] = m.group(1).replace("/", ".") + (f" {m.group(2)}" if m.group(2) else "")
            cats, seen = [], set()
            for li in d.select("a"):
                name = txt(li)
                if not name.endswith("הרשמה"):
                    continue
                name = re.sub(r"\s*-\s*הרשמה$", "", name).strip()
                if name and name not in seen:
                    seen.add(name)
                    cats.append(name)
            t["categories"] = cats[:20]
            intro = re.split(r"\s*1\.\s*הרשמה", body)[0]
            t["info"] = intro.strip()[:400]
        except Exception as e:
            print(f"(tournament {eid} details failed: {e})", file=sys.stderr)
        out.append(t)
    out.sort(key=lambda x: x.get("date") or "9999")
    return out


# ---------------------------------------------------------------- assembly
def build_snapshot(existing_matches=None):
    existing_matches = existing_matches or {}
    players = scrape_players()
    teams = scrape_teams()
    print(f"players: {len(players)}   teams this season: {[t['teamKey'] for t in teams]}", file=sys.stderr)

    all_matches = {}
    for t in teams:
        if not (t["eventId"] and t["drawId"]):
            continue
        table, matches = scrape_draw(t["eventId"], t["drawId"])
        t["table"] = table
        for row in table:
            if row["teamId"] == t["teamId"]:
                t.update({k: row[k] for k in ("position", "played", "won", "drawn", "lost", "points")})
        ours = [m for m in matches if m["homeId"] == t["teamId"] or m["awayId"] == t["teamId"]]
        for m in ours:
            m.update({
                "eventId": t["eventId"], "drawId": t["drawId"],
                "league": t["league"], "drawName": t["drawName"],
                "ourTeamId": t["teamId"], "ourTeamKey": t["teamKey"],
                "isHome": m["homeId"] == t["teamId"],
            })
            all_matches[m["matchId"]] = m
        today = dt.date.today().isoformat()
        upcoming = sorted([m for m in ours if not m["played"] and m["date"] and m["date"] >= today], key=lambda x: x["date"])
        results = sorted([m for m in ours if m["played"]], key=lambda x: x["date"] or "", reverse=True)
        t["nextMatch"] = _slim(upcoming[0]) if upcoming else None
        t["upcoming"] = [_slim(m) for m in upcoming[:6]]
        t["lastResults"] = [_slim(m) for m in results[:5]]
        time.sleep(0.5)

    # individual results — only for finished matches we haven't parsed yet
    fetched = 0
    for mid, m in all_matches.items():
        prev = existing_matches.get(mid)
        if prev and prev.get("individual") and prev.get("homeScore") == m["homeScore"] and prev.get("awayScore") == m["awayScore"]:
            m["individual"] = prev["individual"]
            continue
        if not m["played"]:
            m["individual"] = []
            continue
        det = scrape_match_details(mid)
        m["individual"] = det["games"]
        fetched += 1
        time.sleep(0.4)
    print(f"matches: {len(all_matches)}  (fetched details for {fetched})", file=sys.stderr)

    # per-player: last matches + team assignment
    per_player = {}
    for m in sorted(all_matches.values(), key=lambda x: x["date"] or ""):
        if not m["played"]:
            continue
        for g in m.get("individual", []):
            if not g.get("played"):
                continue
            our_side = "homePlayers" if m["isHome"] else "awayPlayers"
            opp_side = "awayPlayers" if m["isHome"] else "homePlayers"
            our_sets = g["homeSets"] if m["isHome"] else g["awaySets"]
            opp_sets = g["awaySets"] if m["isHome"] else g["homeSets"]
            for p in g[our_side]:
                if not p["id"]:
                    continue
                rec = per_player.setdefault(p["id"], {"teams": {}, "matches": []})
                rec["teams"][m["ourTeamKey"]] = rec["teams"].get(m["ourTeamKey"], 0) + 1
                rec["matches"].append({
                    "matchId": m["matchId"], "date": m["date"],
                    "teamKey": m["ourTeamKey"],
                    "opponentTeam": m["awayName"] if m["isHome"] else m["homeName"],
                    "opponent": " / ".join(x["name"] for x in g[opp_side]),
                    "doubles": g["doubles"],
                    "won": our_sets > opp_sets,
                    "sets": f"{our_sets}:{opp_sets}",
                    "points": g["points"],
                    "teamScore": f"{m['homeScore']}:{m['awayScore']}" if m["isHome"] else f"{m['awayScore']}:{m['homeScore']}",
                })
    for pid, p in players.items():
        rec = per_player.get(pid)
        if rec:
            p["teamKey"] = max(rec["teams"], key=rec["teams"].get)
            p["lastMatches"] = list(reversed(rec["matches"]))[:LAST_MATCHES_PER_PLAYER]
            p["seasonWins"] = sum(1 for x in rec["matches"] if x["won"])
            p["seasonGames"] = len(rec["matches"])
        else:
            p.setdefault("teamKey", None)
            p.setdefault("lastMatches", [])

    tournaments = scrape_tournaments()
    print(f"tournaments: {len(tournaments)}", file=sys.stderr)
    return {"players": players, "teams": teams, "matches": all_matches, "tournaments": tournaments}


def _slim(m):
    return {k: m.get(k) for k in ("matchId", "date", "time", "round", "homeId", "homeName", "awayId", "awayName",
                                  "homeScore", "awayScore", "played", "isHome", "league", "drawName")}


# ---------------------------------------------------------------- Firestore
def write_firestore(snap):
    from google.cloud import firestore  # lazy import so --dry-run needs no credentials
    db = firestore.Client()
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    written = {"players": 0, "teams": 0, "matches": 0, "tournaments": 0}

    def upsert(coll_ref, doc_id, data, keep_prev_rating=False):
        ref = coll_ref.document(doc_id)
        old = ref.get().to_dict() or {}
        if keep_prev_rating:
            # שמירת הדירוג הקודם כדי להציג חץ למעלה/למטה
            if old.get("rating") is not None and old.get("rating") != data.get("rating"):
                data["ratingPrev"] = old["rating"]
                data["ratingUpdatedAt"] = now
            else:
                data["ratingPrev"] = old.get("ratingPrev", data.get("rating"))
                data["ratingUpdatedAt"] = old.get("ratingUpdatedAt", now)
        if _hash(old) == _hash(data):
            return False
        data["updatedAt"] = now
        ref.set(data)
        return True

    pc = db.collection("tttm").document("players").collection("items")
    for pid, p in snap["players"].items():
        written["players"] += upsert(pc, pid, dict(p), keep_prev_rating=True)
    tc = db.collection("tttm").document("teams").collection("items")
    for t in snap["teams"]:
        written["teams"] += upsert(tc, t["teamId"], dict(t))
    mc = db.collection("tttm").document("matches").collection("items")
    for mid, m in snap["matches"].items():
        written["matches"] += upsert(mc, mid, dict(m))

    wc = db.collection("tttm").document("tournaments").collection("items")
    keep_ids = set()
    for t in snap.get("tournaments", []):
        keep_ids.add(t["eventId"])
        written["tournaments"] += upsert(wc, t["eventId"], dict(t))
    for d in wc.stream():                       # תחרויות שהוסרו מהאתר
        if d.id not in keep_ids:
            wc.document(d.id).delete()

    db.collection("tttm").document("meta").collection("items").document("status").set({
        "lastRun": now,
        "counts": {k: len(v) for k, v in snap.items()},
        "written": written,
    })
    print(f"firestore written: {written}", file=sys.stderr)


def load_existing_matches():
    try:
        from google.cloud import firestore
        db = firestore.Client()
        out = {}
        for d in db.collection("tttm").document("matches").collection("items").stream():
            out[d.id] = d.to_dict()
        return out
    except Exception as e:  # pragma: no cover
        print(f"(no existing matches loaded: {e})", file=sys.stderr)
        return {}


def _hash(d):
    d = {k: v for k, v in (d or {}).items() if k != "updatedAt"}
    return hashlib.sha1(json.dumps(d, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="לא כותב ל-Firestore")
    ap.add_argument("--out", help="שמירת snapshot JSON לקובץ")
    args = ap.parse_args()

    print(f"http engine: {'curl_cffi (chrome impersonation)' if USING_CURL_CFFI else 'requests'}"
          f"{' via proxy' if PROXY_PREFIX else ''}", file=sys.stderr)
    existing = {} if args.dry_run else load_existing_matches()
    snap = build_snapshot(existing)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False, indent=1)
    if args.dry_run:
        summary = {
            "players": {pid: {k: p.get(k) for k in ("name", "category", "rank", "rating", "teamKey")} for pid, p in snap["players"].items()},
            "teams": [{k: t.get(k) for k in ("teamKey", "league", "drawName", "position", "points", "nextMatch")} for t in snap["teams"]],
            "matches": len(snap["matches"]),
            "tournaments": [{k: t.get(k) for k in ("eventId", "name", "date", "venue", "registrationUntil", "categories")} for t in snap.get("tournaments", [])],
        }
        print(json.dumps(summary, ensure_ascii=False, indent=1))
        return
    write_firestore(snap)


if __name__ == "__main__":
    main()
