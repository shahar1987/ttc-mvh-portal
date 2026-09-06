# פורטל מועדון טניס שולחן מבואות החרמון

אתר אחד שנפתח בטלפון, כניסה עם מספר טלפון בלבד, אפס עלות.
מימוש של האפיון (גרסה 1.0, ספטמבר 2026).

```
ttc-mvh-portal/
├── web/                 האתר עצמו (GitHub Pages) — HTML/CSS/JS ללא build
│   ├── config.js        ← הקובץ היחיד שצריך למלא
│   ├── app.js           כל המסכים: כניסה, בית, אזור אישי, ליגה, אימונים, הודעות, ניהול, דשבורד
│   ├── firebase-messaging-sw.js   התראות דחיפה
│   └── assets/          לוגואים ותמונות (ראה assets/README.md)
├── worker/              Cloudflare Worker — "השרת": כניסה לפי טלפון + שליחת התראות
├── scraper/             סקרייפר TTTM (Python) + בדיקות מול דפים אמיתיים
├── sync/                סנכרון נוכחות מאפליקציית הנוכחות (ttcmh-2a752) לפורטל
├── reminders/           תזכורות למשחקים במייל (Gmail)
├── seed/                זריעה ראשונית: אולמות, מאמנים, קבוצות, מנהל + מיפוי שחקנים ל-TTTM
├── firestore.rules      חוקי האבטחה
└── .github/workflows/   פריסה ל-Pages, סקרייפר, סנכרון, תזכורות
```

## איך זה עובד (בקצרה)

| רכיב | שירות | עלות |
|---|---|---|
| האתר | GitHub Pages | חינם |
| נתונים | Firebase Firestore (Spark) | חינם — ~1% מהמכסה |
| זיהוי | Firebase Auth עם Custom Token (בלי SMS) | חינם |
| "שרת" הכניסה + התראות | Cloudflare Worker | חינם (100K בקשות/יום, בלי כרטיס אשראי) |
| התראות דחיפה | Firebase Cloud Messaging | חינם |
| סקרייפר / סנכרון / מיילים | GitHub Actions | חינם |
| מיילים | Gmail (סיסמת אפליקציה) | חינם (500/יום) |

**למה יש Worker?** כדי שחוקי האבטחה של Firestore יוכלו להבטיח שכל אחד רואה *רק* את המסמך שלו, צריך זהות
מאומתת. ה-Worker מקבל מספר טלפון, בודק שהוא ברשימת המורשים (`/users`), ומנפיק טוקן חתום עם
התפקיד והשחקנים המקושרים. מרגע זה Firestore אוכף הכל בעצמו — הדפדפן לא יכול לבקש נתונים של מישהו אחר.
Cloud Functions היו דורשות Blaze; Worker לא.

---

## התקנה — צעד אחר צעד (כ-45 דקות)

### 1. Firebase (פרויקט חדש ונפרד)

1. https://console.firebase.google.com → **Add project** → שם: `ttc-mvh-portal` (בלי Analytics).
2. **Build → Firestore Database → Create database** → Production mode → אזור `europe-west1`.
3. **Build → Authentication → Get started** (לא צריך להפעיל שום ספק — משתמשים ב-Custom Token).
4. **Project settings → General → Your apps → `</>` Web** → שם `portal` → העתק את `firebaseConfig` אל `web/config.js`.
5. **Project settings → Cloud Messaging → Web Push certificates → Generate key pair** → העתק ל-`vapidKey` ב-`config.js`.
6. **Project settings → Service accounts → Generate new private key** → נשמר קובץ JSON. **זה המפתח של כל המערכת — לא להעלות ל-GitHub.**
7. חוקי אבטחה: **Firestore → Rules** → הדבק את תוכן `firestore.rules` → Publish.
   (או: `npm i -g firebase-tools && firebase login && firebase deploy --only firestore:rules`)

### 2. Cloudflare Worker (הכניסה)

```bash
cd worker
npx wrangler login                 # חשבון Cloudflare חינמי
npx wrangler secret put FIREBASE_SA   # הדבק את כל תוכן קובץ ה-JSON מסעיף 1.6, Enter, Ctrl+D
npx wrangler deploy
```
תקבל כתובת כמו `https://ttc-mvh-login.<שם>.workers.dev` → הדבק ב-`loginUrl` ב-`web/config.js`.
בדיקה: `curl https://ttc-mvh-login.<שם>.workers.dev/health` → `{"ok":true}`.

### 3. זריעה ראשונית + המנהל הראשון

```bash
pip install google-cloud-firestore
GOOGLE_APPLICATION_CREDENTIALS=service-account.json python seed/seed.py --admin 0504999149 --name "שחר גילעד"
```
יוצר אולמות, 3 מאמנים, 6 קבוצות לפי לוח האימונים, ואת המנהל. להוסיף מספר לבדיקה של דניאל:
ממסך הניהול בפורטל, או שוב `seed.py --admin <טלפון> --name <שם>` (יהפוך אותו למנהל — לבדיקות בלבד).

### 4. GitHub

1. צור מאגר **public** `ttc-mvh-portal` (public = GitHub Actions ללא הגבלה) והעלה את כל הקבצים.
2. **Settings → Pages → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions**:

| Secret | ערך |
|---|---|
| `FIREBASE_SA` | תוכן קובץ ה-JSON של פרויקט הפורטל (סעיף 1.6) |
| `ATTENDANCE_SA` | Service account של פרויקט אפליקציית הנוכחות `ttcmh-2a752` (אותו תהליך בסעיף 1.6, בפרויקט ההוא) |
| `GMAIL_USER` | הכתובת שממנה יוצאות התזכורות |
| `GMAIL_APP_PASSWORD` | סיסמת אפליקציה: Google Account → Security → 2-Step Verification → App passwords |

   ו-**Variables**: `PORTAL_URL` = `https://shahar1987.github.io/ttc-mvh-portal/`

4. **Actions → TTTM scraper → Run workflow** (אפשר עם `dry_run` קודם). אחרי ריצה: טבלאות, משחקים ודירוגים בפורטל.
5. **Actions → Sync attendance → Run workflow** → שחקנים, קבוצות ונוכחות מאפליקציית הנוכחות.

הפריסה של האתר קורית אוטומטית בכל push לתיקיית `web/`.

### 5. לוגואים

החלף את הקבצים ב-`web/assets/` (ראה שם README). כל תמונה מתחת ל-100KB.

### 6. בדיקה

פתח `https://shahar1987.github.io/ttc-mvh-portal/` בטלפון, הזן את המספר שלך → אתה בפנים.
"הוסף למסך הבית" בדפדפן → זה מתנהג כמו אפליקציה.

---

## תפעול יומיומי

**הוספת הורה** — ניהול → גישות → מספר, שם, בחירת השחקן → הוסף. או מלשונית *שחקנים*, בשורה של הילד: "הוסף מספר של הורה".
**ייבוא רשימה** — ניהול → גישות → "ייבוא רשימה": שורה לכל אדם `טלפון, שם, מזהה-שחקן, סוג`.
**הסרה** — כפתור "הסר". הכניסה הבאה שלו תיכשל.
**הודעה** — תפריט → "הודעה חדשה". "דחוף" = פס כתום בראש מסך הבית + התראה לטלפונים שאישרו.
**מאמן שרשאי לפרסם** — ניהול → גישות → ליד המאמן כפתור ✍️. נכנס לתוקף בכניסה הבאה שלו. מאמן יכול לפרסם רק להורי קבוצה.
**דשבורד** — תפריט → דשבורד: כניסות, מי לא נכנס מעולם (עם כפתור וואטסאפ להזמנה), מי נעלם.
**מספר TTTM לשחקן** — הסנכרון מקשר אוטומטית לפי שם (מ-`seed/tttm_players.json`). אם שם שונה — ניהול → שחקנים → עריכה.

### שיוך הקבוצות (התשובה לשאלה הפתוחה מס' 4)
נסרקו כל 40 משחקי עונת 2025-26. לפי מי ששיחק בפועל:
- **M1:** שחר גילעד, איתמר יוסף לב (+ איתן דולדנר 8992, לא ברשימת המועדון)
- **M2:** עדי לוי, יבגני ג'וטובסקי, אלעד מרנבך, ליאוניד ג'מפלסון, אלעזר שנקר, דניאל בן אהרון
- **M4:** יותם ירושלמי, ישראל בן ארוש, ויאצ'סלב סנדקוב, טל כהן, אורי מוסנזון, דור נברו, אוהד בן ארוש, צור כהן
- ללא קבוצה: רוני גלבוע, נועם יעקובוביץ', טאו מורנו

הסקרייפר מחשב את זה מחדש כל ריצה לפי העונה הנוכחית.

---

## חיבור לאפליקציית הנוכחות

הפורטל בפרויקט Firebase נפרד (כפי שביקשת), ולכן:

1. **נוכחות** — `sync/sync_attendance.py` רץ כל לילה ב-23:30 ומעתיק סיכום נוכחות לכל שחקן
   (`attendance/{playerId}` — מסמך אחד = קריאה אחת). הוא גם מסנכרן שחקנים וקבוצות, ומכניס לכל קבוצה
   את השמות הפרטיים של חבריה (לתצוגת "הקבוצה שלי" בלי לחשוף כרטיסי שחקנים).
   דגל `AUTO_ADD_PHONES=1` ב-workflow יוסיף אוטומטית את טלפון ההורה מאפליקציית הנוכחות כמשתמש — כבוי כברירת מחדל.
2. **פרסום הודעות ודשבורד מתוך אפליקציית הנוכחות** — הדרך הפשוטה: כפתור באפליקציית הנוכחות שפותח
   `https://shahar1987.github.io/ttc-mvh-portal/#/publish` (ו-`#/dashboard`). המכשיר שלך כבר מחובר לפורטל,
   אז זו לחיצה אחת. הטמעה מלאה בתוך האפליקציה (SDK שני + טוקן) אפשרית בשלב הבא אם תרצה.

## פיתוח מקומי / בדיקות

```bash
cd scraper && pip install -r requirements.txt && python test_parsers.py     # פענוח מול דפי TTTM שמורים
python scraper/tttm_scraper.py --dry-run                                     # ריצה אמיתית מול TTTM, בלי Firestore
cd web && python -m http.server 8080  →  http://localhost:8080/test/         # UI עם Firebase מדומה (בלי רשת)
```

## שאלות פתוחות שנותרו (מהאפיון, סעיף 10)
1. **דומיין** — כרגע `shahar1987.github.io/ttc-mvh-portal`. דומיין משלך: Settings → Pages → Custom domain (חינם, צריך רק את הדומיין).
2. **שמות** — ✅ שם פרטי בלבד.
3. **הורים גרושים** — כרגע כל מספר שמקושר לילד רואה אותו דבר, ואף אחד לא רואה את המספרים של האחרים. אם צריך הפרדה מלאה — נוסיף.
4. **שיוך קבוצות** — ✅ נסגר (למעלה).
