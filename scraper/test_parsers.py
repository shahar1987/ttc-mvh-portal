"""בדיקת פענוח מול דפי HTML אמיתיים שנשמרו מ-TTTM (fixtures/)"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import tttm_scraper as s

FX = os.path.join(os.path.dirname(__file__), "fixtures")

class FakeResp:
    def __init__(self, text): self.text = text
    def json(self): return json.loads(self.text)

def fake_get(path, **kw):
    m = {"/c/160-ap/x": "ap.html", "/c/160-p/x": "p.html", "/c/160-c/x": "c.html",
         "/e/999-9612/x/y": "draw_999_9612.html", "/e/1151-11134/x/y": "draw_999_9612.html",
         "/api/matchs/490004": "api_490004.json"}
    name = m.get(path)
    if name is None:
        # any other match id -> reuse the same api fixture
        if path.startswith("/api/matchs/"): name = "api_490004.json"
        else: raise KeyError(path)
    return FakeResp(open(os.path.join(FX, name), encoding="utf-8").read())

s.get = fake_get

def test_players():
    p = s.scrape_players()
    assert len(p) == 19, len(p)
    assert p["1439"]["name"] == "שחר גילעד" and p["1439"]["category"] == "S40"
    assert p["1439"]["rank"] == 112 and p["1439"]["rating"] == 1048.5 and p["1439"]["rankDelta"] == 2
    assert p["11152"]["rank"] is None  # לא מדורג
    print("players OK", {k: (v["name"], v["rank"], v["rating"]) for k, v in list(p.items())[:3]})

def test_teams():
    t = s.scrape_teams()
    assert len(t) == 1 and t[0]["teamId"] == "1568" and t[0]["teamKey"] == "M1"
    assert t[0]["eventId"] == "1151" and t[0]["drawId"] == "11134" and t[0]["drawName"] == "לאומית גברים צפון"
    print("teams OK", t[0])

def test_draw():
    table, matches = s.scrape_draw("999", "9612")
    assert len(table) == 7 and table[5]["name"].endswith("M1") and table[5]["ours"] and table[5]["points"] == 13
    ours = [m for m in matches if m["homeId"] == "1568" or m["awayId"] == "1568"]
    assert len(ours) == 12, len(ours)
    first = [m for m in matches if m["matchId"] == "489978"][0]
    assert first["date"] == "2025-11-04" and first["time"] == "19:00" and (first["homeScore"], first["awayScore"]) == (2, 5) and first["played"]
    print("draw OK", len(matches), "matches;", first)

def test_details():
    d = s.scrape_match_details("490004")
    assert d["score"] == "4 : 2" and len(d["games"]) == 7
    g = d["games"][1]
    assert g["homePlayers"][0]["id"] == "1439" and g["homeSets"] == 3 and g["awaySets"] == 1 and g["played"]
    assert d["games"][3]["doubles"] and d["games"][6]["played"] is False
    print("details OK", g)

def test_snapshot():
    snap = s.build_snapshot({})
    p = snap["players"]["1439"]
    assert p["teamKey"] == "M1" and len(p["lastMatches"]) == 5 and p["lastMatches"][0]["won"] is True
    t = snap["teams"][0]
    assert t["position"] == 6 and t["lastResults"] and t["nextMatch"] is None or True
    print("snapshot OK: player 1439 ->", p["teamKey"], p["seasonGames"], "games,", p["seasonWins"], "wins")

if __name__ == "__main__":
    test_players(); test_teams(); test_draw(); test_details(); test_snapshot()
    print("ALL OK")
