#!/usr/bin/env python3
"""
סנכרון מאפליקציית הנוכחות (פרויקט ttcmh-2a752) -> פרויקט הפורטל

למה צריך את זה: הפורטל יושב בפרויקט Firebase נפרד. במקום שהפורטל יקרא ישירות
מהפרויקט של אפליקציית הנוכחות (שם ההרשאות בנויות למאמנים בלבד), סקריפט זה רץ
פעם ביום ב-GitHub Actions ומעתיק רק את מה שהפורטל צריך, בצורה מסוכמת:

  groups/{id}                 שם, ימים, שעות, מאמנים, מקום
  players/{id}                שם, קבוצה, active, phones[] (מיזוג — לא מוחק מספרים שהוספת ידנית)
  attendance/{playerId}       datesPresent[] (העונה), heldDates[] (אימונים שהתקיימו לקבוצה שלו),
                              streak, updatedAt   -> מסמך אחד לשחקן = קריאה אחת בפורטל

הגדרות (משתני סביבה):
  PORTAL_SA        נתיב ל-service account של פרויקט הפורטל
  ATTENDANCE_SA    נתיב ל-service account של פרויקט הנוכחות
  SEASON_START     ברירת מחדל: 1 בספטמבר האחרון (YYYY-MM-DD)
  AUTO_ADD_PHONES  "1" = להוסיף אוטומטית את טלפון ההורה/שחקן מהאפליקציה ל-phones ול-/users
                   (ברירת מחדל: "0" — אתה מוסיף מספרים ידנית ממסך הניהול)
"""
import datetime as dt
import os
import re
import sys

from google.cloud import firestore
from google.oauth2 import service_account


def client(path):
    creds = service_account.Credentials.from_service_account_file(path)
    return firestore.Client(credentials=creds, project=creds.project_id)


def normalize_phone(raw):
    if not raw:
        return None
    d = re.sub(r"\D", "", str(raw))
    if d.startswith("00"):
        d = d[2:]
    if d.startswith("972"):
        d = d[3:]
    d = d.lstrip("0")
    return "972" + d if re.fullmatch(r"5\d{8}", d) else None


# אותה לוגיקה כמו באפליקציית הנוכחות: קבוצת מבוגרים לפי דגל מפורש, אחרת לפי שם הקבוצה
ADULT_RE = re.compile(r"מבוגרים|בוגרים|פרקינסון|סגל|ותיקים")


def is_adult_group(g):
    if not g:
        return False
    if isinstance(g.get("isAdultGroup"), bool):
        return g["isAdultGroup"]
    return bool(ADULT_RE.search(g.get("name") or ""))


def _norm_name(n):
    return re.sub(r"[\s'\u05f3\u2019\-]+", "", (n or "")).strip()


def season_start():
    env = os.environ.get("SEASON_START")
    if env:
        return env
    today = dt.date.today()
    y = today.year if today.month >= 9 else today.year - 1
    return f"{y}-09-01"


def main():
    src = client(os.environ["ATTENDANCE_SA"])
    dst = client(os.environ["PORTAL_SA"])
    auto_phones = os.environ.get("AUTO_ADD_PHONES", "0") == "1"
    since = season_start()
    now = dt.datetime.now(dt.timezone.utc).isoformat()

    # ---- groups (כולל שמות פרטיים של חברי הקבוצה — לתצוגת "הקבוצה שלי" בלי לחשוף מסמכי שחקנים)
    groups = {d.id: d.to_dict() for d in src.collection("groups").stream()}
    players = {d.id: d.to_dict() for d in src.collection("players").stream()}
    for gid, g in groups.items():
        members = [{"id": pid, "firstName": (p.get("firstName") or (p.get("name") or "").split(" ")[0])}
                   for pid, p in players.items() if p.get("groupId") == gid and p.get("active", True) is not False]
        dst.collection("groups").document(gid).set({
            "name": g.get("name", ""),
            "venue": g.get("venue") or g.get("location") or "",
            "days": g.get("days") or g.get("groupDays") or [],
            "startTime": g.get("startTime", ""),
            "endTime": g.get("endTime", ""),
            "coachIds": g.get("coachIds") or [],
            "memberNames": sorted(members, key=lambda m: m["firstName"]),
            "isAdultGroup": is_adult_group(g),
            "source": "attendance-app",
            "updatedAt": now,
        }, merge=True)
    print(f"groups: {len(groups)}", file=sys.stderr)

    # ---- players
    existing = {d.id: d.to_dict() for d in dst.collection("players").stream()}
    created, linked = [], []
    # מיפוי שם -> מספר TTTM (seed/tttm_players.json); שחקן שהשם שלו תואם מקבל tttmId אוטומטית
    tttm_map = {}
    try:
        import json
        here = os.path.dirname(os.path.abspath(__file__))
        for p in json.load(open(os.path.join(here, "..", "seed", "tttm_players.json"), encoding="utf-8")):
            tttm_map[_norm_name(p["name"])] = p["tttmId"]
    except Exception as e:  # pragma: no cover
        print(f"(tttm map not loaded: {e})", file=sys.stderr)
    for pid, p in players.items():
        name = p.get("name") or f"{p.get('firstName', '')} {p.get('lastName', '')}".strip()
        doc = {
            "name": name,
            "firstName": p.get("firstName") or name.split(" ")[0],
            "groupId": p.get("groupId", ""),
            "active": p.get("active", True) is not False,
            "source": "attendance-app",
            "updatedAt": now,
        }
        if not (existing.get(pid) or {}).get("tttmId") and _norm_name(name) in tttm_map:
            doc["tttmId"] = tttm_map[_norm_name(name)]
        adult = is_adult_group(groups.get(p.get("groupId", "")))
        doc["isAdult"] = adult
        phones = set((existing.get(pid) or {}).get("phones") or [])
        if auto_phones:
            first = (doc["firstName"] or name).strip()
            for raw in (p.get("parentPhone"), p.get("phone"), p.get("parentPhone2")):
                n = normalize_phone(raw)
                if not n or n in phones:
                    if n:
                        phones.add(n)
                    continue
                phones.add(n)
                # בקבוצת מבוגרים הטלפון הוא של השחקן עצמו; בקבוצת נוער — של ההורה
                if adult:
                    label, role = name, "player"
                else:
                    label, role = (p.get("parentName") or "").strip() or f"הורה של {first}", "parent"
                uref = dst.collection("users").document(n)
                snap = uref.get()
                if not snap.exists:
                    uref.set({"name": label, "role": role, "playerIds": [pid],
                              "canPublish": False, "createdAt": now, "createdBy": "sync"})
                    created.append((n, label, role))
                else:
                    # לא משנים תפקיד של מנהל/מאמן שכבר קיים — רק מקשרים אליו את השחקן
                    upd = {"playerIds": firestore.ArrayUnion([pid])}
                    if not (snap.to_dict() or {}).get("name"):
                        upd["name"] = label
                    uref.update(upd)
                    linked.append((n, label))
        doc["phones"] = sorted(phones)
        dst.collection("players").document(pid).set(doc, merge=True)
    print(f"players: {len(players)}", file=sys.stderr)
    if auto_phones:
        print(f"users created: {len(created)}  |  existing users linked: {len(linked)}", file=sys.stderr)
        for n, label, role in created:
            print(f"   + 0{n[3:]}  {label}  ({role})", file=sys.stderr)
    else:
        print("AUTO_ADD_PHONES=0 — לא נוצרו משתמשים. הפעל את הדגל כדי לייבא טלפונים.", file=sys.stderr)

    # ---- attendance
    present = {}      # playerId -> set(dates)
    held = {}         # groupId  -> set(dates)
    q = src.collection("attendance").where("date", ">=", since)
    n = 0
    for d in q.stream():
        a = d.to_dict()
        n += 1
        date, gid, pid = a.get("date"), a.get("groupId"), a.get("playerId")
        if not (date and gid and pid):
            continue
        held.setdefault(gid, set()).add(date)
        if a.get("status") == "Present":
            present.setdefault(pid, set()).add(date)
    print(f"attendance records since {since}: {n}", file=sys.stderr)

    batch = dst.batch()
    count = 0
    for pid, p in players.items():
        gid = p.get("groupId", "")
        dates = sorted(present.get(pid, set()))
        held_dates = sorted(held.get(gid, set()))
        # רצף: כמה אימונים אחרונים של הקבוצה הגיע ברצף
        streak = 0
        for d in reversed(held_dates):
            if d in present.get(pid, set()):
                streak += 1
            else:
                break
        batch.set(dst.collection("attendance").document(pid), {
            "playerId": pid,
            "groupId": gid,
            "seasonStart": since,
            "datesPresent": dates,
            "heldDates": held_dates,
            "streak": streak,
            "updatedAt": now,
        })
        count += 1
        if count % 400 == 0:
            batch.commit()
            batch = dst.batch()
    batch.commit()
    print(f"attendance summaries written: {count}", file=sys.stderr)


if __name__ == "__main__":
    main()
