/**
 * Login Worker — פורטל מועדון טניס שולחן מבואות החרמון
 *
 * POST /login  { phone }   ->  { token, user }
 *
 * זהו "השרת" היחיד במערכת. הוא:
 *   1. מנרמל את מספר הטלפון
 *   2. אוכף הגבלת ניסיונות (5 מספרים שונים מאותו מכשיר ב-10 דקות -> נעילה לשעה)
 *   3. בודק שהמספר קיים ב-/users
 *   4. מנפיק Firebase Custom Token עם claims: role, playerIds, canPublish
 *   5. מעדכן lastLogin / loginCount ומונה כניסות יומי לדשבורד
 *
 * רץ ב-Cloudflare Workers (מכסה חינמית: 100,000 בקשות ביום, בלי כרטיס אשראי).
 * POST /push   { announcementId, title, body, audience, groupId }  (Authorization: Bearer <ID token>)
 *              שולח התראת דחיפה (FCM) לכל המכשירים הרשומים — למנהל / מאמן עם הרשאת פרסום.
 *
 * Secrets:  FIREBASE_SA  (תוכן קובץ ה-service account, JSON)
 * Vars:     ALLOWED_ORIGIN (למשל https://shahar1987.github.io), PORTAL_URL
 */

const IDENTITY_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX_DISTINCT = 5;
const RL_LOCK_MS = 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/login') {
        return json(await login(request, env), 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/push') {
        return json(await push(request, env), 200, cors);
      }
      if (url.pathname === '/health') return json({ ok: true }, 200, cors);
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status, cors);
      console.error(e);
      return json({ error: 'internal' }, 500, cors);
    }
  },
};

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

// ---------- phone normalization (same logic as web/app.js) ----------
export function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('972')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  if (!/^5\d{8}$/.test(d)) return null;   // ישראלי נייד בלבד: 5XXXXXXXX
  return '972' + d;
}

// ---------- main ----------
async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'bad_phone', 'מספר טלפון לא תקין');

  const sa = JSON.parse(env.FIREBASE_SA);
  const fs = await firestore(sa);

  // rate limit per device
  const deviceKey = await sha256(
    (request.headers.get('CF-Connecting-IP') || '') + '|' + (request.headers.get('User-Agent') || '')
  );
  await enforceRateLimit(fs, deviceKey, phone);

  let user = await fs.get(`users/${phone}`);
  // מספר שהוזן זה עתה באפליקציית הנוכחות — בודקים שם בזמן אמת, בלי לחכות לסנכרון היומי
  if (!user) user = await provisionFromAttendance(phone, fs, env);
  if (!user) throw new HttpError(404, 'not_registered', 'המספר לא רשום במערכת');
  if (user.disabled === true) throw new HttpError(403, 'disabled', 'הגישה הושעתה');

  const claims = {
    role: user.role || 'member',
    playerIds: Array.isArray(user.playerIds) ? user.playerIds.slice(0, 10) : [],
    canPublish: user.canPublish === true,
    name: user.name || '',
  };
  const token = await mintCustomToken(sa, phone, claims);

  // bookkeeping (best effort)
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const firstLogin = !user.lastLogin;
  await Promise.all([
    fs.patch(`users/${phone}`, { lastLogin: now.toISOString(), loginCount: (user.loginCount || 0) + 1 }),
    fs.increment(`logins/${today}`, {
      count: 1,
      [`byRole.${claims.role}`]: 1,
      ...(firstLogin ? { firstLogins: 1 } : {}),
    }),
  ]).catch(e => console.error('bookkeeping failed', e));

  return { token, user: { phone, name: user.name || '', role: claims.role, playerIds: claims.playerIds, canPublish: claims.canPublish } };
}

// ---------- הצטרפות מיידית: מספר שהוזן באפליקציית הנוכחות ועדיין לא סונכרן ----------
const ADULT_RE = /מבוגרים|בוגרים|פרקינסון|סגל|ותיקים/;

async function provisionFromAttendance(phone, fsPortal, env) {
  if (!env.ATTENDANCE_SA) return null;                 // לא הוגדר — מתנהג כמו קודם
  try {
    const saAtt = JSON.parse(env.ATTENDANCE_SA);
    const fsAtt = await firestore(saAtt);
    const [players, groups] = await Promise.all([fsAtt.list('players'), fsAtt.list('groups')]);
    const gById = Object.fromEntries(groups.map(g => [g.id, g]));

    const mine = players.filter(p =>
      p.active !== false && [p.parentPhone, p.phone, p.playerPhone].some(v => normalizePhone(v) === phone));
    if (!mine.length) return null;

    const isAdult = g => (g && (g.isAdultGroup === true || ADULT_RE.test(g.name || ''))) || false;
    const first = mine[0];
    const adult = isAdult(gById[first.groupId]);
    const name = adult
      ? (first.name || '').trim()
      : ((first.parentName || '').trim() || `הורה של ${(first.firstName || (first.name || '').split(' ')[0] || '').trim()}`);

    const doc = {
      name: name || '',
      role: adult ? 'player' : 'parent',
      playerIds: mine.map(p => p.id).slice(0, 10),
      canPublish: false,
      source: 'attendance-app',
      createdAt: new Date().toISOString(),
    };
    await fsPortal.set(`users/${phone}`, doc);
    // מוסיפים את המספר גם לכרטיס השחקן בפורטל, כדי שהנוכחות תיפתח לו מיד
    await Promise.all(mine.map(async p => {
      const cur = await fsPortal.get(`players/${p.id}`);
      const phones = Array.from(new Set([...(cur && cur.phones ? cur.phones : []), phone]));
      if (cur) return fsPortal.patch(`players/${p.id}`, { phones });
      // שחקן חדש שנוסף זה עתה בנוכחות — כרטיס בסיסי עד הסנכרון הבא
      return fsPortal.set(`players/${p.id}`, {
        name: (p.name || '').trim(),
        firstName: (p.firstName || (p.name || '').split(' ')[0] || '').trim(),
        groupId: p.groupId || '', active: true, phones, source: 'attendance-app',
      });
    })).catch(e => console.error('link players failed', e));
    return doc;
  } catch (e) {
    console.error('provisionFromAttendance failed', e);
    return null;
  }
}

async function enforceRateLimit(fs, key, phone) {
  const path = `ratelimit/${key}`;
  const now = Date.now();
  const rec = (await fs.get(path)) || {};
  if (rec.lockedUntil && rec.lockedUntil > now) {
    throw new HttpError(429, 'locked', 'יותר מדי ניסיונות. נסה שוב בעוד שעה');
  }
  let phones = Array.isArray(rec.phones) ? rec.phones : [];
  let windowStart = rec.windowStart || now;
  if (now - windowStart > RL_WINDOW_MS) { phones = []; windowStart = now; }
  if (!phones.includes(phone)) phones.push(phone);
  const update = { phones, windowStart };
  if (phones.length > RL_MAX_DISTINCT) {
    update.lockedUntil = now + RL_LOCK_MS;
    await fs.set(path, update);
    throw new HttpError(429, 'locked', 'יותר מדי ניסיונות. נסה שוב בעוד שעה');
  }
  await fs.set(path, update);
}

// ---------- push (FCM HTTP v1) ----------
// POST /push  Authorization: Bearer <Firebase ID token של מנהל/מאמן-מפרסם>
//             { announcementId, title, body, audience: all|group|players|coaches, groupId }
async function push(request, env) {
  const sa = JSON.parse(env.FIREBASE_SA);
  const authz = request.headers.get('Authorization') || '';
  const claims = await verifyIdToken(authz.replace(/^Bearer\s+/i, ''), sa.project_id);
  if (!claims) throw new HttpError(401, 'unauthorized');
  if (claims.role !== 'admin' && claims.canPublish !== true) throw new HttpError(403, 'forbidden');
  const body = await request.json().catch(() => ({}));
  if (!body.title) throw new HttpError(400, 'bad_request');
  if (claims.role !== 'admin' && body.audience !== 'group') throw new HttpError(403, 'coach_group_only');

  const fs = await firestore(sa);
  const tokens = await fs.list('pushTokens');
  const wanted = tokens.filter(t => {
    if (body.audience === 'group') return (t.groupIds || []).includes(body.groupId);
    if (body.audience === 'players') return ['player', 'parent'].includes(t.role);
    if (body.audience === 'coaches') return ['coach', 'admin'].includes(t.role);
    return true;
  });
  const accessToken = await getAccessToken(sa, 'https://www.googleapis.com/auth/firebase.messaging');
  let sent = 0, removed = 0;
  await Promise.all(wanted.map(async t => {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token: t.id,
        notification: { title: body.title, body: (body.body || '').slice(0, 200) },
        webpush: { notification: { icon: 'assets/icon-192.png', dir: 'rtl', lang: 'he' }, fcm_options: { link: env.PORTAL_URL || '' } },
        data: { announcementId: String(body.announcementId || '') },
      } }),
    });
    if (r.ok) sent++;
    else if (r.status === 404 || r.status === 400) { removed++; await fs.del(`pushTokens/${t.id}`).catch(() => {}); }
    else console.warn('fcm', r.status, await r.text());
  }));
  if (body.announcementId) await fs.patch(`announcements/${body.announcementId}`, { pushSent: true, pushCount: sent }).catch(() => {});
  return { sent, removed, targeted: wanted.length };
}

// אימות Firebase ID token מול המפתחות הציבוריים של Google (JWK)
let jwkCache = { t: 0, keys: [] };
async function verifyIdToken(token, projectId) {
  try {
    const [h, p, sig] = token.split('.');
    if (!sig) return null;
    const header = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || payload.exp < now) return null;
    if (Date.now() - jwkCache.t > 3600e3) {
      const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
      jwkCache = { t: Date.now(), keys: (await r.json()).keys || [] };
    }
    const jwk = jwkCache.keys.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)), new TextEncoder().encode(`${h}.${p}`));
    return ok ? payload : null;
  } catch { return null; }
}

// ---------- Firebase custom token ----------
async function mintCustomToken(sa, uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email, sub: sa.client_email, aud: IDENTITY_AUD,
    iat: now, exp: now + 3600, uid, claims,
  };
  return signJwt(sa, payload);
}

// ---------- Google OAuth + Firestore REST ----------
async function firestore(sa) {
  const accessToken = await getAccessToken(sa);
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  return {
    async get(path) {
      const r = await fetch(`${base}/${path}`, { headers: h });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`firestore get ${path}: ${r.status} ${await r.text()}`);
      return fromFields((await r.json()).fields || {});
    },
    async set(path, obj) {
      const r = await fetch(`${base}/${path}`, { method: 'PATCH', headers: h, body: JSON.stringify({ fields: toFields(obj) }) });
      if (!r.ok) throw new Error(`firestore set ${path}: ${r.status} ${await r.text()}`);
    },
    async patch(path, obj) {
      const mask = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      const r = await fetch(`${base}/${path}?${mask}`, { method: 'PATCH', headers: h, body: JSON.stringify({ fields: toFields(obj) }) });
      if (!r.ok) throw new Error(`firestore patch ${path}: ${r.status} ${await r.text()}`);
    },
    async list(collection) {
      const out = []; let pageToken = '';
      do {
        const r = await fetch(`${base}/${collection}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: h });
        if (!r.ok) throw new Error(`firestore list ${collection}: ${r.status}`);
        const j = await r.json();
        for (const d of j.documents || []) out.push({ id: d.name.split('/').pop(), ...fromFields(d.fields || {}) });
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    async del(path) {
      const r = await fetch(`${base}/${path}`, { method: 'DELETE', headers: h });
      if (!r.ok && r.status !== 404) throw new Error(`firestore delete ${path}: ${r.status}`);
    },
    // atomic increments via commit/transform
    async increment(path, incs) {
      const doc = `projects/${sa.project_id}/databases/(default)/documents/${path}`;
      const fieldTransforms = Object.entries(incs).map(([fieldPath, n]) => ({ fieldPath, increment: { integerValue: String(n) } }));
      const body = { writes: [{ transform: { document: doc, fieldTransforms } }] };
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`, { method: 'POST', headers: h, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`firestore increment ${path}: ${r.status} ${await r.text()}`);
    },
  };
}

const cachedTokens = {};
async function getAccessToken(sa, scope = 'https://www.googleapis.com/auth/datastore') {
  const ck = `${sa.client_email}|${scope}`;          // מפתח נפרד לכל service account
  const cachedToken = cachedTokens[ck];
  if (cachedToken && cachedToken.exp > Date.now() / 1000 + 60) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(sa, {
    iss: sa.client_email, scope,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`,
  });
  if (!r.ok) throw new Error(`oauth: ${r.status} ${await r.text()}`);
  const j = await r.json();
  cachedTokens[ck] = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cachedTokens[ck].token;
}

// ---------- JWT RS256 with WebCrypto ----------
const cachedKeys = {};
async function importKey(pem, id) {
  if (cachedKeys[id]) return cachedKeys[id];
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  cachedKeys[id] = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return cachedKeys[id];
}
async function signJwt(sa, payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = await importKey(sa.private_key, sa.private_key_id || sa.client_email);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}
function b64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ---------- Firestore value <-> JS ----------
function toFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toValue(v);
  return out;
}
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
  return out;
}
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
