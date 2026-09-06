#!/usr/bin/env python3
"""
זריעה ראשונית של פרויקט הפורטל — מריצים פעם אחת אחרי יצירת הפרויקט.

  GOOGLE_APPLICATION_CREDENTIALS=service-account.json python seed/seed.py --admin 0504999149 --name "שחר גילעד"

יוצר (רק אם לא קיים): אולמות, מאמנים, קבוצות (לפי לוח האימונים הידוע), הגדרות המועדון,
ומשתמש מנהל ראשון. את הטלפונים של ההורים מוסיפים אחר כך ממסך הניהול.
"""
import argparse
import datetime as dt
import json
import os
import re

from google.cloud import firestore

HERE = os.path.dirname(os.path.abspath(__file__))
NOW = dt.datetime.now(dt.timezone.utc).isoformat()


def normalize_phone(raw):
    d = re.sub(r"\D", "", str(raw or ""))
    if d.startswith("00"): d = d[2:]
    if d.startswith("972"): d = d[3:]
    d = d.lstrip("0")
    return "972" + d if re.fullmatch(r"5\d{8}", d) else None


VENUES = [
    {"id": "shear-yashuv", "name": "אולם שאר ישוב", "address": "אולם הספורט, שאר ישוב"},
    {"id": "ramat-korazim", "name": "בית ספר רמת כורזים", "address": "בית הספר רמת כורזים"},
    {"id": "dafna", "name": "אולם הספורט קיבוץ דפנה", "address": "אולם הספורט, קיבוץ דפנה"},
]
COACHES = [
    {"id": "shahar", "name": "שחר גילעד", "phone": "0504999149", "venues": ["שאר ישוב"], "photoUrl": "assets/coach-shahar.jpg"},
    {"id": "daniel", "name": "דניאל בן ארי", "phone": "", "venues": ["רמת כורזים"], "photoUrl": "assets/coach-daniel.jpg"},
    {"id": "tao", "name": "טאו מורנו", "phone": "", "venues": ["שאר ישוב"], "photoUrl": "assets/coach-tao.jpg"},
]
# ימים: 0=ראשון … 6=שבת
GROUPS = [
    {"id": "sy-beginners", "name": "מתחילים — שאר ישוב", "venue": "אולם שאר ישוב", "days": [0, 4], "startTime": "16:30", "endTime": "17:30", "coachIds": ["tao"]},
    {"id": "sy-advanced", "name": "מתקדמים — שאר ישוב", "venue": "אולם שאר ישוב", "days": [0, 1, 4], "startTime": "17:30", "endTime": "19:00", "coachIds": ["shahar"]},
    {"id": "sy-squad", "name": "נבחרת תחרותית (סגל) — שאר ישוב", "venue": "אולם שאר ישוב", "days": [0, 4], "startTime": "19:00", "endTime": "21:00", "coachIds": ["shahar"]},
    {"id": "rk-kids", "name": "מתחילים/מתקדמים — רמת כורזים", "venue": "בית ספר רמת כורזים", "days": [1, 3], "startTime": "16:30", "endTime": "18:00", "coachIds": ["daniel"]},
    {"id": "rk-adults", "name": "בוגרים — רמת כורזים", "venue": "בית ספר רמת כורזים", "days": [1, 3], "startTime": "18:00", "endTime": "20:00", "coachIds": ["daniel"]},
    {"id": "dafna-adults", "name": "מבוגרים וסטודנטים — דפנה", "venue": "אולם הספורט קיבוץ דפנה", "days": [1, 4], "startTime": "19:30", "endTime": "21:00", "coachIds": []},
]


def put_if_missing(db, coll, items):
    n = 0
    for it in items:
        ref = db.collection(coll).document(it["id"])
        if not ref.get().exists:
            data = {k: v for k, v in it.items() if k != "id"}
            data["createdAt"] = NOW
            ref.set(data)
            n += 1
    print(f"{coll}: {n} created")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin", required=True, help="מספר הטלפון של המנהל")
    ap.add_argument("--name", default="מנהל המועדון")
    ap.add_argument("--with-players", action="store_true", help="ליצור גם כרטיסי שחקנים מ-tttm_players.json (אם לא משתמשים בסנכרון מאפליקציית הנוכחות)")
    args = ap.parse_args()
    db = firestore.Client()

    put_if_missing(db, "venues", VENUES)
    put_if_missing(db, "coaches", COACHES)
    put_if_missing(db, "groups", GROUPS)
    db.collection("settings").document("club").set({"seededAt": NOW}, merge=True)

    phone = normalize_phone(args.admin)
    assert phone, "מספר מנהל לא תקין"
    ref = db.collection("users").document(phone)
    if not ref.get().exists:
        ref.set({"name": args.name, "role": "admin", "playerIds": [], "canPublish": True, "createdAt": NOW})
        print(f"admin user {phone} created")
    else:
        ref.update({"role": "admin", "canPublish": True})
        print(f"admin user {phone} updated")

    if args.with_players:
        players = json.load(open(os.path.join(HERE, "tttm_players.json"), encoding="utf-8"))
        put_if_missing(db, "players", [{"id": "tttm-" + p["tttmId"], "name": p["name"], "firstName": p["name"].split()[0],
                                        "tttmId": p["tttmId"], "phones": [], "active": True, "groupId": "", "source": "seed"} for p in players])


if __name__ == "__main__":
    main()
