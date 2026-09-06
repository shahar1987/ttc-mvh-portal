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

# מסמכים שנוצרו ב-seed הראשוני ומוחלפים ע"י הנתונים האמיתיים מאפליקציית הנוכחות
SEED_IDS = {
    "groups": ["sy-beginners", "sy-advanced", "sy-squad", "rk-kids", "rk-adults", "dafna-adults"],
    "coaches": ["shahar", "daniel", "tao"],
    "venues": ["shear-yashuv", "ramat-korazim", "dafna"],
}


def slugify(name):
    return re.sub(r"[^\w\u0590-\u05ff]+", "-", (name or "").strip()).strip("-")[:60] or "venue"


def drop_seed_docs(dst, coll):
    """מוחק את מסמכי ה-seed הכפולים, רק אחרי שהגיעו נתונים אמיתיים."""
    n = 0
    for doc_id in SEED_IDS.get(coll, []):
        ref = dst.collection(coll).document(doc_id)
        snap = ref.get()
        if snap.exists and (snap.to_dict() or {}).get("source") != "attendance-app":
            ref.delete()
            n += 1
    return n


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
    def write_groups(coach_doc_id):
      for gid, g in groups.items():
        members = [{"id": pid, "firstName": (p.get("firstName") or (p.get("name") or "").split(" ")[0])}
                   for pid, p in players.items() if p.get("groupId") == gid and p.get("active", True) is not False]
        dst.collection("groups").document(gid).set({
            "name": g.get("name", ""),
            "venue": g.get("venue") or g.get("location") or "",
            "days": g.get("days") or g.get("groupDays") or [],
            "startTime": g.get("startTime", ""),
            "endTime": g.get("endTime", ""),
            "coachIds": sorted({coach_doc_id[c] for c in (g.get("coachIds") or []) if c in coach_doc_id}),
            "memberNames": sorted(members, key=lambda m: m["firstName"]),
            "isAdultGroup": is_adult_group(g),
            "source": "attendance-app",
            "updatedAt": now,
        }, merge=True)

    write_groups({})                 # כתיבה ראשונה כדי שהמאמנים ייגזרו מהקבוצות
    print(f"groups: {len(groups)}", file=sys.stderr)

    # ---- מאמנים: מאוחדים לפי אדם (באפליקציית הנוכחות יש כמה חשבונות לאותו מאמן)
    src_users = {d.id: d.to_dict() for d in src.collection("users").stream()}

    def display_name(u):
        n = (u.get("name") or "").strip()
        return "" if "@" in n else n          # שם שהוא כתובת מייל אינו שם תצוגה

    people = {}          # key -> {name, phone, venues:set, groups:set, ids:set}
    coach_key = {}       # attendance user id -> key
    for gid, g in groups.items():
        venue = (g.get("venue") or g.get("location") or "").strip()
        gname = (g.get("name") or "").strip()
        for cid in (g.get("coachIds") or []):
            u = src_users.get(cid)
            if not u:
                continue
            nm, ph = display_name(u), normalize_phone(u.get("phone"))
            key = ph or _norm_name(nm)        # אותו טלפון = אותו אדם
            if not key:
                continue
            e = people.setdefault(key, {"name": "", "phone": ph or "", "venues": set(),
                                        "groups": set(), "ids": set()})
            if nm and (not e["name"] or len(nm) > len(e["name"])):
                e["name"] = nm
            if venue:
                e["venues"].add(venue)
            if gname:
                e["groups"].add(gname)        # מאמן אחד יכול לאמן כמה קבוצות
            e["ids"].add(cid)
            coach_key[cid] = key

    # מסמכי מאמנים קיימים בפורטל (כולל כאלה שנוצרו ידנית או בזריעה) — לפי אותו מפתח אדם
    existing = {d.id: (d.to_dict() or {}) for d in dst.collection("coaches").stream()}
    by_key = {}
    for did, data in existing.items():
        k = normalize_phone(data.get("phone")) or _norm_name(data.get("name") or "")
        if k:
            by_key.setdefault(k, []).append(did)

    coach_doc_id = {}
    for key, e in people.items():
        if not e["name"]:
            continue                          # בלי שם אין מה להציג
        doc_id = slugify(e["name"])
        for cid in e["ids"]:
            coach_doc_id[cid] = doc_id
        # תמונה ותיאור מוזנים ידנית בפורטל — שומרים אותם גם ממסמך ישן של אותו אדם
        prev = dict(existing.get(doc_id) or {})
        for did in by_key.get(key, []) + by_key.get(_norm_name(e["name"]), []):
            old = existing.get(did) or {}
            for f in ("photoUrl", "bio"):
                if not prev.get(f) and old.get(f):
                    prev[f] = old[f]
        dst.collection("coaches").document(doc_id).set({
            "name": e["name"],
            "phone": e["phone"] or prev.get("phone", ""),
            "venues": sorted(e["venues"]),
            "groupNames": sorted(e["groups"]),
            "photoUrl": prev.get("photoUrl", ""),
            "bio": prev.get("bio", ""),
            "source": "attendance-app",
            "updatedAt": now,
        }, merge=True)

    keep = set(coach_doc_id.values())
    # כפילויות: כל מסמך ישן של אדם שכבר נכתב מחדש (לפי טלפון או שם) — נמחק
    merged_keys = {k for k, e in people.items() if e["name"]}
    merged_keys |= {_norm_name(e["name"]) for e in people.values() if e["name"]}
    stale = 0
    for did, data in existing.items():
        if did in keep:
            continue
        k_phone = normalize_phone(data.get("phone"))
        k_name = _norm_name(data.get("name") or "")
        if data.get("source") == "attendance-app" or k_phone in merged_keys or (k_name and k_name in merged_keys):
            dst.collection("coaches").document(did).delete()
            stale += 1
    print(f"coaches: {len(keep)} (merged from {len(coach_key)} accounts, removed {stale} stale)", file=sys.stderr)

    write_groups(coach_doc_id)       # כתיבה חוזרת עם מזהי המאמנים המאוחדים

    # ---- אולמות: מסמך לכל שם אולם שמופיע בקבוצות (בשביל כתובת וניווט)
    venue_names = sorted({(g.get("venue") or g.get("location") or "").strip()
                          for g in groups.values()} - {""})
    for vname in venue_names:
        vid = slugify(vname)
        ref = dst.collection("venues").document(vid)
        prev = ref.get().to_dict() or {}
        ref.set({
            "name": vname,
            "address": prev.get("address") or vname,   # ניתן לעריכה במסך הניהול
            "source": "attendance-app",
            "updatedAt": now,
        }, merge=True)
    print(f"venues: {len(venue_names)}", file=sys.stderr)

    # ---- ניקוי הכפילויות מהזריעה הראשונית
    if groups:
        removed = {c: drop_seed_docs(dst, c) for c in ("groups", "coaches", "venues")}
        if any(removed.values()):
            print(f"seed duplicates removed: {removed}", file=sys.stderr)

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
