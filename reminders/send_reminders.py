#!/usr/bin/env python3
"""
תזכורות למשחקים במייל — רץ כל בוקר ב-07:00 מ-GitHub Actions, שולח דרך Gmail (סיסמת אפליקציה).

/reminders/{id}
    email, scope: "match" | "team", matchId | teamId, timing: ["week","sameDay"],
    sentFor: ["<matchId>:<week|sameDay>"], unsubscribeToken, ownerUid, createdAt

לכל תזכורת: מוצא את המשחקים הרלוונטיים מ-tttm/matches, ואם היום = תאריך-7 (week)
או היום = תאריך (sameDay) ועדיין לא נשלח -> שולח ומסמן.
משחק שנדחה ב-TTTM מקבל תאריך חדש, ולכן התזכורת "נדלקת" שוב אוטומטית.
"""
import datetime as dt
import os
import smtplib
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from google.cloud import firestore

GMAIL_USER = os.environ["GMAIL_USER"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]
PORTAL_URL = os.environ.get("PORTAL_URL", "https://shahar1987.github.io/ttc-mvh-portal/")
CLUB = "מועדון טניס שולחן מבואות החרמון"
HEB_DAYS = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]


def heb_date(iso):
    d = dt.date.fromisoformat(iso)
    return f"יום {HEB_DAYS[d.weekday()]}, {d.day}.{d.month}.{d.year}"


def build_email(m, team, timing, unsub):
    ours_home = m.get("isHome")
    opp = m["awayName"] if ours_home else m["homeName"]
    where = "משחק בית — אולם הספורט בבית הספר רמת כורזים" if ours_home else f"משחק חוץ — אצל {opp}"
    nav = "https://waze.com/ul?q=%D7%91%D7%99%D7%AA%20%D7%A1%D7%A4%D7%A8%20%D7%A8%D7%9E%D7%AA%20%D7%9B%D7%95%D7%A8%D7%96%D7%99%D7%9D" if ours_home else ""
    when = "השבוע הבא" if timing == "week" else "היום"
    pos = f"מקום {team['position']} בטבלה, {team.get('points', 0)} נקודות" if team and team.get("position") else ""
    subj = f"🏓 {when}: {m['homeName']} נגד {m['awayName']} — {heb_date(m['date'])}"
    html = f"""
<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.6;color:#111;max-width:560px">
  <h2 style="color:#0b5ed7;margin:0 0 12px">{CLUB}</h2>
  <p style="font-size:22px;font-weight:bold;margin:0 0 8px">{m['homeName']}<br>נגד<br>{m['awayName']}</p>
  <p style="margin:0 0 8px">📅 {heb_date(m['date'])}{(' בשעה ' + m['time']) if m.get('time') else ''}</p>
  <p style="margin:0 0 8px">📍 {where}</p>
  {'<p style="margin:0 0 8px"><a href="' + nav + '">ניווט לאולם</a></p>' if nav else ''}
  {'<p style="margin:0 0 8px">📊 ' + m.get('league', '') + ' · ' + m.get('drawName', '') + ' · ' + pos + '</p>' if pos else ''}
  <p style="margin:16px 0"><a href="{PORTAL_URL}" style="background:#0b5ed7;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">לפורטל המועדון</a></p>
  <p style="font-size:13px;color:#666;margin-top:32px"><a href="{unsub}" style="color:#666">הסר אותי מהתזכורות</a></p>
</div>"""
    return subj, html


def send(to, subj, html):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subj
    msg["From"] = f"{CLUB} <{GMAIL_USER}>"
    msg["To"] = to
    msg.attach(MIMEText(html, "html", "utf-8"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        s.sendmail(GMAIL_USER, [to], msg.as_string())


def main():
    db = firestore.Client()
    today = dt.date.today()
    matches = {d.id: d.to_dict() for d in db.collection("tttm").document("matches").collection("items").stream()}
    teams = {d.id: d.to_dict() for d in db.collection("tttm").document("teams").collection("items").stream()}
    sent = 0
    for r in db.collection("reminders").stream():
        rem = r.to_dict()
        if rem.get("unsubscribed"):
            continue
        if rem.get("scope") == "match":
            cand = [matches[rem["matchId"]]] if rem.get("matchId") in matches else []
        else:
            cand = [m for m in matches.values() if m.get("ourTeamId") == rem.get("teamId")]
        already = set(rem.get("sentFor") or [])
        unsub = f"{PORTAL_URL}#unsubscribe={r.id}:{rem.get('unsubscribeToken', '')}"
        for m in cand:
            if not m.get("date") or m.get("played"):
                continue
            mdate = dt.date.fromisoformat(m["date"])
            for timing in rem.get("timing") or []:
                due = (timing == "week" and mdate - today == dt.timedelta(days=7)) or (timing == "sameDay" and mdate == today)
                key = f"{m['matchId']}:{timing}"
                if not due or key in already:
                    continue
                subj, html = build_email(m, teams.get(m.get("ourTeamId")), timing, unsub)
                try:
                    send(rem["email"], subj, html)
                    already.add(key)
                    sent += 1
                    print(f"sent {timing} -> {rem['email']} for {key}", file=sys.stderr)
                except Exception as e:  # pragma: no cover
                    print(f"FAILED {rem['email']} {key}: {e}", file=sys.stderr)
        if already != set(rem.get("sentFor") or []):
            r.reference.update({"sentFor": sorted(already), "lastSentAt": dt.datetime.now(dt.timezone.utc).isoformat()})
    print(f"total sent: {sent}", file=sys.stderr)


if __name__ == "__main__":
    main()
