/* ===== פורטל מועדון טניס שולחן מבואות החרמון — app.js ===== */
(() => {
  'use strict';
  const CFG = window.PORTAL_CONFIG;
  const CLUB = CFG.club;
  firebase.initializeApp(CFG.firebase);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FieldValue = firebase.firestore.FieldValue;

  // ---------------------------------------------------------------- helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const HEB_DAYS_SHORT = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const todayISO = () => localISO(new Date());
  function localISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function fmtDate(iso, withDay = true) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    const s = `${d.getDate()}.${d.getMonth() + 1}.${String(d.getFullYear()).slice(2)}`;
    return withDay ? `יום ${HEB_DAYS[d.getDay()]}, ${s}` : s;
  }
  function relDay(iso) {
    const t = new Date(todayISO() + 'T00:00:00'), d = new Date(iso + 'T00:00:00');
    const diff = Math.round((d - t) / 864e5);
    if (diff === 0) return 'היום'; if (diff === 1) return 'מחר'; if (diff === -1) return 'אתמול';
    if (diff > 1 && diff < 7) return `בעוד ${diff} ימים`;
    return fmtDate(iso, false);
  }
  function normalizePhone(raw) {
    if (!raw) return null;
    let d = String(raw).replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('972')) d = d.slice(3);
    d = d.replace(/^0+/, '');
    return /^5\d{8}$/.test(d) ? '972' + d : null;
  }
  const fmtPhone = p => p ? '0' + String(p).replace(/^972/, '').replace(/(\d{2})(\d{3})(\d{4})/, '$1-$2-$3') : '';
  const telHref = p => `tel:+${normalizePhone(p) || p}`;
  const waHref = (p, text = '') => `https://wa.me/${normalizePhone(p) || p}${text ? '?text=' + encodeURIComponent(text) : ''}`;
  const firstName = n => (n || '').trim().split(/\s+/)[0];
  const toast = (msg, ms = 2600) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms); };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // ---------------------------------------------------------------- state
  const S = { user: null, claims: null, players: [], activePlayer: 0, cache: new Map(), history: [] };
  const roleLabel = r => ({ admin: 'מנהל', coach: 'מאמן', player: 'שחקן', parent: 'הורה', member: 'חבר מועדון' }[r] || r);
  const isAdmin = () => S.claims?.role === 'admin';
  const isCoach = () => S.claims?.role === 'coach' || isAdmin();
  const canPublish = () => isAdmin() || S.claims?.canPublish === true;
  const hasPersonal = () => (S.claims?.playerIds || []).length > 0;
  // אילו קבוצות ליגה רלוונטיות למשתמש: מאמן/מנהל רואה הכל; שחקן/הורה רק את הקבוצה שהוא משחק בה
  async function myTeams() {
    const teams = await D.teams();
    if (isCoach()) return teams;
    if (!hasPersonal()) return [];
    const keys = new Set();
    for (const p of S.players) {
      (p.leagueTeams || []).forEach(k => keys.add(k));           // שיוך ידני ממסך הניהול
      const tp = await D.tttmPlayer(p.tttmId);                   // או שיוך אוטומטי לפי משחקים ב-TTTM
      if (tp && tp.teamKey) keys.add(tp.teamKey);
    }
    return teams.filter(t => keys.has(t.teamKey));
  }

  // ---------------------------------------------------------------- data layer (with small cache to save reads)
  async function cached(key, ttlMs, fn) {
    const c = S.cache.get(key);
    if (c && Date.now() - c.t < ttlMs) return c.v;
    const v = await fn();
    S.cache.set(key, { t: Date.now(), v });
    return v;
  }
  const invalidate = prefix => [...S.cache.keys()].forEach(k => k.startsWith(prefix) && S.cache.delete(k));
  const docData = snap => snap.exists ? { id: snap.id, ...snap.data() } : null;
  const colData = qs => qs.docs.map(d => ({ id: d.id, ...d.data() }));
  const D = {
    settings: () => cached('settings', 6e5, async () => docData(await db.doc('settings/club').get()) || {}),
    groups: () => cached('groups', 6e5, async () => colData(await db.collection('groups').get())),
    coaches: () => cached('coaches', 6e5, async () => colData(await db.collection('coaches').get())),
    venues: () => cached('venues', 6e5, async () => colData(await db.collection('venues').get())),
    teams: () => cached('teams', 3e5, async () => colData(await db.collection('tttm/teams/items').get())),
    announcements: (n = 30) => cached('ann' + n, 12e4, async () =>
      colData(await db.collection('announcements').where('publishAt', '<=', new Date().toISOString()).orderBy('publishAt', 'desc').limit(n).get())),
    player: id => cached('player:' + id, 3e5, async () => docData(await db.doc('players/' + id).get())),
    attendance: id => cached('att:' + id, 3e5, async () => docData(await db.doc('attendance/' + id).get())),
    tournaments: () => cached('tournaments', 6e5, async () => colData(await db.collection('tttm/tournaments/items').get())),
    tttmPlayer: tid => cached('tp:' + tid, 3e5, async () => tid ? docData(await db.doc('tttm/players/items/' + tid).get()) : null),
  };
  function visibleAnnouncements(list) {
    const r = S.claims?.role, myGroups = new Set(S.players.map(p => p.groupId).filter(Boolean));
    return list.filter(a => {
      if (a.audience === 'all' || !a.audience) return true;
      if (a.audience === 'coaches') return isCoach();
      if (a.audience === 'players') return hasPersonal() || isCoach();
      if (a.audience === 'group') return isAdmin() || myGroups.has(a.groupId) || (isCoach() && true);
      return true;
    });
  }

  // ---------------------------------------------------------------- auth
  const loginScreen = $('#screen-login'), app = $('#app'), loading = $('#loading');
  $('#login-club-name').textContent = CLUB.fullName;

  auth.onAuthStateChanged(async user => {
    if (!user) { S.user = null; showLogin(); return; }
    try {
      const t = await user.getIdTokenResult();
      S.user = user; S.claims = { role: t.claims.role || 'member', playerIds: t.claims.playerIds || [], canPublish: !!t.claims.canPublish, name: t.claims.name || '' };
      // הטוקן נוצר בכניסה — אם שויכו לך שחקנים מאז, נמשוך אותם מהמסמך החי כדי שלא תצטרך להתנתק
      try {
        const live = docData(await db.doc('users/' + user.uid).get());
        if (live) {
          if (Array.isArray(live.playerIds) && live.playerIds.length) S.claims.playerIds = live.playerIds;
          if (live.name) S.claims.name = live.name;
          if (live.canPublish === true) S.claims.canPublish = true;
        }
      } catch (e) { console.warn('live user doc unavailable', e); }
      S.players = (await Promise.all(S.claims.playerIds.map(D.player))).filter(Boolean);
      S.leagueTeams = await myTeams().catch(() => []);
      showApp();
      route();
      setupPush();
      handleUnsubscribeLink();
    } catch (e) { console.error(e); showLogin('אירעה שגיאה, נסה שוב'); }
  });

  function showLogin(msg = '') {
    loading.classList.add('hidden'); app.classList.add('hidden'); loginScreen.classList.remove('hidden');
    $('#login-msg').textContent = msg; setTimeout(() => $('#phone').focus(), 50);
  }
  function showApp() {
    loading.classList.add('hidden'); loginScreen.classList.add('hidden'); app.classList.remove('hidden');
    $('#drawer-name').textContent = S.claims.name || fmtPhone(S.user.uid);
    $('#drawer-role').textContent = roleLabel(S.claims.role);
    $('#sidebar-name').textContent = S.claims.name || fmtPhone(S.user.uid);
    $('#sidebar-role').textContent = roleLabel(S.claims.role);
    $$('.only-personal').forEach(el => el.classList.toggle('hidden', !hasPersonal()));
    $$('.only-league').forEach(el => el.classList.toggle('hidden', !(S.leagueTeams || []).length));
    $$('.only-admin').forEach(el => el.classList.toggle('hidden', !isAdmin()));
    $$('.only-publisher').forEach(el => el.classList.toggle('hidden', !canPublish()));
    $('#nav-me').classList.toggle('hidden', !hasPersonal());
  }

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#login-btn'), msg = $('#login-msg'), phone = normalizePhone($('#phone').value);
    msg.className = 'msg';
    if (!phone) { msg.textContent = 'נא להזין מספר נייד ישראלי תקין (10 ספרות)'; return; }
    btn.disabled = true; btn.textContent = 'רגע…';
    try {
      const r = await fetch(CFG.loginUrl.replace(/\/$/, '') + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404) { msg.innerHTML = `המספר לא רשום במערכת.<br>פנה למאמן: ${esc(CLUB.contactName)} <a href="${telHref(CLUB.contactPhone)}">${esc(fmtPhone(normalizePhone(CLUB.contactPhone)))}</a>`; }
      else if (r.status === 429) msg.textContent = 'יותר מדי ניסיונות. נסה שוב בעוד שעה.';
      else if (!r.ok) msg.textContent = j.message || 'שגיאה בכניסה, נסה שוב';
      else { msg.className = 'msg ok'; msg.textContent = 'ברוך הבא!'; await auth.signInWithCustomToken(j.token); }
    } catch (err) { console.error(err); msg.textContent = 'אין חיבור לשרת. בדוק את האינטרנט ונסה שוב.'; }
    btn.disabled = false; btn.textContent = 'כניסה';
  });
  $('#btn-logout').addEventListener('click', async () => { closeDrawer(); await auth.signOut(); S.cache.clear(); location.hash = ''; });

  // ---------------------------------------------------------------- router
  const TITLES = { home: 'בית', me: 'האזור האישי', schedule: 'לוח אימונים', league: 'טבלאות ליגה', tournaments: 'תחרויות', news: 'הודעות ואירועים', coaches: 'המאמנים שלנו', contact: 'צור קשר', social: 'עקבו אחרינו', partners: 'שותפים', more: 'עוד', publish: 'הודעה חדשה', admin: 'ניהול', dashboard: 'דשבורד' };
  const SCREENS = {};
  function navDepth() { return (history.state && history.state.idx) || 0; }
  function go(name, param) {
    const h = '#/' + name + (param ? '/' + param : '');
    const fromDrawer = history.state && history.state.drawer;
    hideDrawer();
    if (location.hash === h) { if (fromDrawer) history.back(); return; }
    // ניווט מתוך התפריט מחליף את רשומת התפריט, כדי ש"חזרה" תחזור למסך ולא תפתח אותו שוב
    if (fromDrawer) history.replaceState({ idx: navDepth() }, '', h);
    else history.pushState({ idx: navDepth() + 1 }, '', h);
    route();
  }
  async function route() {
    if (!S.user) return;
    const m = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/);
    let name = m ? m[1] : 'home', param = m ? m[2] : null;
    if (!SCREENS[name]) name = 'home';
    if (name === 'me' && !hasPersonal()) name = 'home';
    if ((name === 'admin' || name === 'dashboard') && !isAdmin()) name = 'home';
    if (name === 'publish' && !canPublish()) name = 'home';
    if (name === 'league' && !(S.leagueTeams || []).length) name = 'home';
    $('#topbar-title').textContent = TITLES[name] || '';
    const mainFour = ['home', 'me', 'schedule', 'league'];
    $$('.bottomnav button').forEach(b => b.classList.toggle('active', b.dataset.nav === name || (b.dataset.nav === 'more' && !mainFour.includes(name))));
    $$('.sidebar-nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
    $('#btn-back').hidden = ['home'].includes(name);
    const main = $('#main');
    main.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>';
    try { main.innerHTML = await SCREENS[name](param); }
    catch (e) { console.error(e); main.innerHTML = `<div class="card"><b>שגיאה בטעינה</b><p class="muted small">${esc(e.message)}</p><button class="btn btn-secondary" onclick="location.reload()">רענן</button></div>`; }
    bindMain(main);
    window.scrollTo(0, 0); main.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);
  $$('[data-nav]').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));
  $('#btn-back').addEventListener('click', goBack);
  $('#btn-menu').addEventListener('click', openDrawer);
  $('#btn-close-drawer').addEventListener('click', () => closeDrawer());
  $('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });

  // ---- כפתור החזרה של אנדרואיד: סוגר קודם תפריט/חלונית, ורק אז חוזר מסך אחורה
  function drawerOpen() { return !$('#drawer').classList.contains('hidden'); }
  function openDrawer() {
    $('#drawer').classList.remove('hidden');
    history.pushState({ drawer: true, idx: navDepth() }, '', location.href);  // "חזרה" תסגור את התפריט
  }
  function hideDrawer() { $('#drawer').classList.add('hidden'); }
  function closeDrawer() {
    if (!drawerOpen()) return;
    hideDrawer();
    if (history.state && history.state.drawer) history.back();
  }
  window.addEventListener('popstate', () => {
    if (drawerOpen()) { $('#drawer').classList.add('hidden'); return; }   // "חזרה" ראשונה סוגרת תפריט
    const modal = $('#modal');
    if (modal) { modal.remove(); return; }                                // ואחריו חלונית פתוחה
    route();
  });
  function pushModalState() { history.pushState({ modal: true, idx: navDepth() }, '', location.href); }
  function closeModal() {
    const modal = $('#modal'); if (!modal) return;
    modal.remove();
    if (history.state && history.state.modal) history.back();
  }
  function goBack() { if (navDepth() > 0) history.back(); else go('home'); }

  // delegated actions inside main
  function bindMain(main) {
    $$('[data-go]', main).forEach(el => el.addEventListener('click', () => go(el.dataset.go, el.dataset.param)));
    $$('[data-remind]', main).forEach(el => el.addEventListener('click', () => openReminder(el.dataset.remind, el.dataset.label)));
    $$('[data-player-idx]', main).forEach(el => el.addEventListener('click', () => { S.activePlayer = +el.dataset.playerIdx; route(); }));
    $$('[data-seg]', main).forEach(el => el.addEventListener('click', () => {
      $$('[data-seg]', el.parentElement).forEach(b => b.classList.toggle('active', b === el));
      $$('[data-pane]', main).forEach(p => p.classList.toggle('hidden', p.dataset.pane !== el.dataset.seg));
    }));
    $$('[data-action]', main).forEach(el => el.addEventListener('click', e => ACTIONS[el.dataset.action]?.(el, e)));
    $$('[data-filter]', main).forEach(el => el.addEventListener('input', () => { const q = el.value.trim(), np = normalizePhone(q) || '§'; $$(el.dataset.filter + ' li').forEach(li => li.classList.toggle('hidden', !!q && !li.dataset.search.includes(q) && !li.dataset.search.includes(np))); }));
    $$('form[data-form]', main).forEach(f => f.addEventListener('submit', e => { e.preventDefault(); FORMS[f.dataset.form]?.(f); }));
  }
  const ACTIONS = {}, FORMS = {};

  // ---------------------------------------------------------------- components
  function matchCard(m, opts = {}) {
    if (!m) return '';
    const ours = m.isHome ? 'home' : 'away';
    const played = m.played;
    let cls = '';
    if (played) { const our = m.isHome ? m.homeScore : m.awayScore, opp = m.isHome ? m.awayScore : m.homeScore; cls = our > opp ? 'win' : our < opp ? 'loss' : ''; }
    const score = played ? `${m.homeScore}:${m.awayScore}` : (m.time || '—');
    return `
      <div class="match">
        <div class="team ${ours === 'home' ? 'ours' : ''}">${esc(m.homeName)}</div>
        <div class="score ${cls}">${score}</div>
        <div class="team ${ours === 'away' ? 'ours' : ''}">${esc(m.awayName)}</div>
      </div>
      <div class="match-meta">${played ? fmtDate(m.date) : (m.date ? relDay(m.date) + ' · ' + fmtDate(m.date) : 'תאריך טרם נקבע')}
        ${m.isHome ? '· <b>בית</b>' : '· חוץ'}${m.drawName ? ' · ' + esc(m.drawName) : ''}</div>
      ${!played && opts.remind !== false ? `<button class="btn btn-secondary btn-sm" style="margin:8px auto 0;display:flex" data-remind="match:${esc(m.matchId)}" data-label="${esc(m.homeName)} נגד ${esc(m.awayName)}"><svg class="ic" aria-hidden="true"><use href="#ic-bell"/></svg> הזכר לי</button>` : ''}`;
  }
  const empty = (ico, text) => `<div class="empty"><div class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-${ico}"/></svg></div>${esc(text)}</div>`;
  const dayList = days => (days || []).map(d => typeof d === 'number' ? HEB_DAYS[d] : d).join(', ');

  // ---------------------------------------------------------------- screens
  SCREENS.home = async () => {
    const [anns, teams, groups, coaches] = await Promise.all([D.announcements(), D.teams(), D.groups(), D.coaches()]);
    const vis = visibleAnnouncements(anns);
    const urgent = vis.find(a => a.urgent && (!a.expiresAt || a.expiresAt > new Date().toISOString()) && a.publishAt > new Date(Date.now() - 3 * 864e5).toISOString());
    let html = '';
    if (urgent) html += `<div class="alert" data-go="news" role="alert"><div class="ttl"><svg class="ic" aria-hidden="true"><use href="#ic-megaphone"/></svg> הודעה דחופה</div>${esc(urgent.title)}${urgent.body ? '<div style="font-weight:400;margin-top:4px">' + esc(urgent.body).slice(0, 160) + '</div>' : ''}</div>`;

    // next training
    const next = nextTraining(groups, coaches, S.players[S.activePlayer]?.groupId);
    if (next) html += `<div class="card tap" data-go="schedule"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-ball"/></svg></span>${hasPersonal() ? 'האימון הבא שלי' : 'האימון הקרוב במועדון'}</div>
      <div class="big-number" style="font-size:1.5rem">${next.when}</div><div>${esc(next.venue)}${next.coach ? ' · מאמן ' + esc(next.coach) : ''}</div><div class="muted small">${esc(next.groupName)}</div></div>`;

    // personal preview
    if (hasPersonal()) {
      const p = S.players[S.activePlayer];
      const [att, tp] = await Promise.all([D.attendance(p.id), D.tttmPlayer(p.tttmId)]);
      const st = attStats(att);
      html += `<div class="card tap" data-go="me"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-user"/></svg></span>האזור האישי של ${esc(firstName(p.name))}</div>
        <div class="row" style="gap:16px"><div><span class="big-number">${st.month}</span><div class="small muted">אימונים החודש</div></div>
        ${tp?.rating != null ? `<div><span class="big-number">${Math.round(tp.rating)}</span><div class="small muted">דירוג TTTM</div></div>` : ''}
        ${st.streak ? `<div><span class="big-number">${st.streak}</span><div class="small muted">ברצף</div></div>` : ''}</div>
        <a class="card-more">לכל הפרטים ←</a></div>`;
    }

    // announcements
    html += `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-megaphone"/></svg></span>הודעות מהמועדון</div>`;
    html += vis.length ? `<ul class="list">${vis.slice(0, 3).map(a => `<li><div style="font-weight:700">${esc(a.title)}</div><div class="small muted">${fmtDate(a.publishAt.slice(0, 10), false)}${a.authorName ? ' · ' + esc(a.authorName) : ''}</div></li>`).join('')}</ul><a class="card-more" data-go="news">כל ההודעות ←</a>` : '<p class="muted">אין הודעות חדשות</p>';
    html += '</div>';

    // next match — רק לשחקנים שמשחקים באותה ליגה (ולמאמנים/מנהלים)
    const mine = await myTeams();
    const nm = mine.map(t => t.nextMatch && { ...t.nextMatch, teamKey: t.teamKey }).filter(Boolean).sort((a, b) => (a.date || '').localeCompare(b.date || ''))[0];
    if (nm) html += `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-trophy"/></svg></span>המשחק הבא — ${esc(nm.teamKey)}</div>${matchCard(nm)}<a class="card-more" data-go="league">טבלאות ליגה ←</a></div>`;

    // next tournament — פתוח לכולם, גם למי שאינו רשום לליגה
    const tours = (await D.tournaments()).filter(t => t.date && t.date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date));
    if (tours.length) html += `<div class="card tap" data-go="tournaments"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-medal"/></svg></span>התחרות הקרובה</div>
      <div class="big-number" style="font-size:1.35rem">${esc(tours[0].name)}</div>
      <div>${fmtDate(tours[0].date, true)}${tours[0].venue ? ' · ' + esc(tours[0].venue) : ''}</div>
      ${tours[0].registrationUntil ? `<div class="muted small">הרשמה עד ${esc(tours[0].registrationUntil)}</div>` : ''}
      <a class="card-more">כל התחרויות ←</a></div>`;

    // shortcuts
    html += `<div class="shortcuts">
      <button data-go="schedule"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-calendar"/></svg></span>לוח אימונים</button>
      ${mine.length ? '<button data-go="league"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-trophy"/></svg></span>טבלאות ליגה</button>' : ''}
      <button data-go="tournaments"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-medal"/></svg></span>תחרויות</button>
      <button data-go="coaches"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-whistle"/></svg></span>מאמנים</button>
      <button data-go="contact"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-phone"/></svg></span>צור קשר</button>
      <a href="${esc(CLUB.facebook)}" target="_blank" rel="noopener"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-facebook"/></svg></span>פייסבוק</a>
      <a href="${esc(CLUB.instagram)}" target="_blank" rel="noopener"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-instagram"/></svg></span>אינסטגרם</a>
    </div>`;
    html += pushCard();
    return html;
  };

  function nextTraining(groups, coaches, groupId) {
    const coachName = id => coaches.find(c => c.id === id)?.name || '';
    const cand = groups.filter(g => !groupId || g.id === groupId);
    const now = new Date(); let best = null;
    for (const g of cand) {
      for (const d of (g.days || [])) {
        const dow = typeof d === 'number' ? d : HEB_DAYS.indexOf(d);
        if (dow < 0) continue;
        for (let k = 0; k < 8; k++) {
          const dt = new Date(now); dt.setDate(now.getDate() + k); dt.setHours(0, 0, 0, 0);
          if (dt.getDay() !== dow) continue;
          const [hh, mm] = (g.startTime || '00:00').split(':').map(Number); dt.setHours(hh, mm);
          if (dt < now) continue;
          if (!best || dt < best.dt) best = { dt, g };
          break;
        }
      }
    }
    if (!best) return null;
    const { dt, g } = best; const iso = localISO(dt);
    return { when: `${esc(relDay(iso))}, ${HEB_DAYS[dt.getDay()]} ${timeRange(g)}`, venue: g.venue || '', coach: (g.coachIds || []).map(coachName).filter(Boolean).join(', '), groupName: g.name || '' };
  }

  function attStats(att) {
    const dates = att?.datesPresent || [], held = att?.heldDates || [];
    const t = todayISO(), month = t.slice(0, 7);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); const ws = localISO(weekStart);
    const inWeek = d => d >= ws && d <= t, inMonth = d => d.startsWith(month);
    const heldMonth = held.filter(d => inMonth(d) && d <= t).length;
    return {
      week: dates.filter(inWeek).length, month: dates.filter(inMonth).length, season: dates.length,
      heldWeek: held.filter(inWeek).length, heldMonth, heldSeason: held.filter(d => d <= t).length,
      pct: held.length ? Math.round(100 * dates.length / held.filter(d => d <= t).length) : null,
      streak: att?.streak || 0,
    };
  }

  SCREENS.me = async () => {
    const p = S.players[S.activePlayer];
    if (!p) return empty('user', 'לא נמצא כרטיס שחקן');
    let html = '';
    if (S.players.length > 1) html += `<div class="player-switch">${S.players.map((pl, i) => `<button class="${i === S.activePlayer ? 'active' : ''}" data-player-idx="${i}">${esc(firstName(pl.name))}</button>`).join('')}</div>`;
    const [att, tp, groups, coaches, teams] = await Promise.all([D.attendance(p.id), D.tttmPlayer(p.tttmId), D.groups(), D.coaches(), D.teams()]);
    const st = attStats(att);
    html += `<h1>${esc(p.name)}</h1>`;
    // attendance
    html += `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-check"/></svg></span>נוכחות באימונים</div>
      <div class="stat-grid"><div><div class="big-number">${st.week}</div><div class="lbl">השבוע</div></div><div><div class="big-number">${st.month}</div><div class="lbl">החודש</div></div><div><div class="big-number">${st.season}</div><div class="lbl">העונה</div></div></div>
      <div class="row" style="justify-content:center;margin-top:12px">${st.pct != null ? `<span class="chip ${st.pct >= 75 ? 'green' : st.pct >= 50 ? 'orange' : 'red'}">${st.pct}% הגעה</span>` : ''}${st.streak ? `<span class="chip green">🔥 ${st.streak} אימונים ברצף</span>` : ''}</div>
      ${calendar(att)}
      ${!att ? '<p class="muted small center" style="margin-top:8px">נתוני הנוכחות יופיעו לאחר הסנכרון הראשון</p>' : ''}</div>`;
    // TTTM
    if (tp) {
      const delta = tp.ratingPrev != null && tp.rating != null ? Math.round(tp.rating - tp.ratingPrev) : null;
      const team = teams.find(t => t.teamKey === tp.teamKey);
      html += `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-trend"/></svg></span>הישגים ב-TTTM</div>
        <div class="row" style="gap:20px;align-items:flex-start">
          <div><div class="big-number">${tp.rating != null ? Math.round(tp.rating) : '—'} ${delta ? `<span style="font-size:1rem;color:${delta > 0 ? 'var(--green)' : 'var(--red)'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}</span>` : ''}</div><div class="small muted">נקודות דירוג</div></div>
          ${tp.rank ? `<div><div class="big-number">#${tp.rank}</div><div class="small muted">דירוג ארצי${tp.rankDelta ? ` (${tp.rankDelta > 0 ? '+' : ''}${tp.rankDelta})` : ''}</div></div>` : ''}
        </div>
        <div class="row" style="margin-top:8px"><span class="chip gray">מס' שחקן ${esc(tp.tttmId)}</span><span class="chip">${esc(tp.category)}</span>${tp.teamKey ? `<span class="chip orange">קבוצה ${esc(tp.teamKey)}${team?.position ? ' · מקום ' + team.position : ''}</span>` : ''}${tp.seasonGames ? `<span class="chip green">${tp.seasonWins}/${tp.seasonGames} ניצחונות העונה</span>` : ''}</div>
        ${(tp.lastMatches || []).length ? `<h3 style="margin-top:14px">המשחקים האחרונים</h3><ul class="list">${tp.lastMatches.map(m => `<li class="row spread"><div><b>${m.won ? '✅' : '❌'} ${esc(m.opponent)}</b>${m.doubles ? ' <span class="chip gray">זוגות</span>' : ''}<div class="small muted">${fmtDate(m.date, false)} · נגד ${esc(m.opponentTeam)}</div></div><div class="big-number" style="font-size:1.3rem">${esc(m.sets)}</div></li>`).join('')}</ul>` : ''}
        ${team?.nextMatch ? `<h3 style="margin-top:14px">המשחק הבא של ${esc(tp.teamKey)}</h3>${matchCard(team.nextMatch)}` : ''}
        <a class="small" href="${esc(CLUB.tttmClubUrl)}" target="_blank" rel="noopener">לדף המועדון ב-TTTM ↗</a></div>`;
    } else if (p.tttmId) html += `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-trend"/></svg></span>הישגים ב-TTTM</div><p class="muted">הנתונים יופיעו לאחר ריצת הסקרייפר הראשונה</p></div>`;
    // group
    const g = groups.find(x => x.id === p.groupId);
    if (g) {
      const mates = await groupMates(g.id, p.id);
      html += `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-users"/></svg></span>הקבוצה שלי — ${esc(g.name)}</div>
        <p>${esc(dayList(g.days))} ${timeRange(g)}<br>${esc(g.venue || '')}</p>
        <p class="muted small">מאמן: ${esc((g.coachIds || []).map(id => coaches.find(c => c.id === id)?.name).filter(Boolean).join(', ') || '—')}</p>
        ${mates.length ? `<div class="row">${mates.map(n => `<span class="chip gray">${esc(n)}</span>`).join('')}</div>` : ''}</div>`;
    }
    return html;
  };
  async function groupMates(groupId, selfId) {
    // מוצג בשם פרטי בלבד. הרשימה נשמרת במסמך הקבוצה ע"י הסנכרון/מנהל כדי לחסוך קריאות ולא לחשוף מסמכי שחקנים אחרים.
    const g = (await D.groups()).find(x => x.id === groupId);
    return (g?.memberNames || []).filter(n => n.id !== selfId).map(n => typeof n === 'string' ? n : n.firstName);
  }
  function calendar(att) {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
    const present = new Set(att?.datesPresent || []), held = new Set(att?.heldDates || []);
    let cells = HEB_DAYS_SHORT.map(d => `<div class="dow">${d}</div>`).join('');
    for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
    for (let d = 1; d <= days; d++) {
      const iso = localISO(new Date(y, m, d));
      const cls = present.has(iso) ? 'present' : held.has(iso) && iso < todayISO() ? 'absent' : held.has(iso) ? 'held' : '';
      cells += `<div class="day ${cls} ${iso === todayISO() ? 'today' : ''}">${d}</div>`;
    }
    return `<div class="small muted" style="margin:12px 0 6px;text-align:center">${['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'][m]} ${y}</div><div class="cal">${cells}</div>`;
  }

  SCREENS.schedule = async () => {
    const [groups, coaches, venues] = await Promise.all([D.groups(), D.coaches(), D.venues()]);
    if (!groups.length) return empty('calendar', 'לוח האימונים עדיין לא הוזן');
    const byVenue = {};
    groups.forEach(g => (byVenue[g.venue || 'אחר'] ||= []).push(g));
    const cname = ids => (ids || []).map(id => coaches.find(c => c.id === id)?.name).filter(Boolean).join(', ');
    const dayOrder = g => Math.min(...(g.days || []).map(d => typeof d === 'number' ? d : HEB_DAYS.indexOf(d)), 9);
    return Object.entries(byVenue).map(([v, gs]) => {
      const ven = venues.find(x => x.name === v);
      return `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-pin"/></svg></span>${esc(v)}</div>
      ${ven?.address ? `<p class="small muted">${esc(ven.address)} · <a href="https://waze.com/ul?q=${encodeURIComponent(ven.address)}&navigate=yes">ניווט</a></p>` : ''}
      <ul class="list">${gs.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || '')).map(g => `<li>
        <div class="row spread"><b style="font-size:1.05rem">${esc(g.name)}</b>${g.startTime ? `<span class="chip">${timeRange(g)}</span>` : ''}</div>
        <div>${esc(dayList(g.days)) || '<span class="muted">ימים טרם נקבעו</span>'}</div>
        ${cname(g.coachIds) ? `<div class="small muted">מאמן: ${esc(cname(g.coachIds))}</div>` : ''}</li>`).join('')}</ul></div>`;
    }).join('');
  };
  const timeRange = g => `<span dir="ltr">${esc(g.startTime || '')}${g.endTime ? '–' + esc(g.endTime) : ''}</span>`;

  SCREENS.league = async () => {
    const teams = (await myTeams()).sort((a, b) => (a.teamKey || '').localeCompare(b.teamKey || ''));
    if (!teams.length) return empty('trophy', (await D.teams()).length
      ? 'אין לך קבוצת ליגה. הטבלאות מוצגות רק לשחקנים שרשומים לליגה.'
      : 'טבלאות הליגה יופיעו לאחר ריצת הסקרייפר הראשונה');
    const seg = `<div class="seg">${teams.map((t, i) => `<button data-seg="${esc(t.teamKey)}" class="${i === 0 ? 'active' : ''}">${esc(t.teamKey)}</button>`).join('')}</div>`;
    return seg + teams.map((t, i) => `<div data-pane="${esc(t.teamKey)}" class="${i ? 'hidden' : ''}">
      <div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-trophy"/></svg></span>${esc(t.league)}</div><p class="muted small">${esc(t.drawName)}</p>
        <button class="btn btn-secondary" data-remind="team:${esc(t.teamId)}" data-label="כל משחקי ${esc(t.teamKey)} העונה"><svg class="ic" aria-hidden="true"><use href="#ic-bell"/></svg> שלח לי תזכורת לכל משחקי ${esc(t.teamKey)} העונה</button></div>
      <div class="card"><div class="card-title">טבלה</div><div class="table-wrap"><table class="tbl"><tr><th class="num">#</th><th>קבוצה</th><th class="num">מש'</th><th class="num">נצ'</th><th class="num">הפ'</th><th class="num">נק'</th></tr>
        ${(t.table || []).map(r => `<tr class="${r.ours ? 'ours' : ''}"><td class="num">${r.position ?? ''}</td><td>${esc(r.name)}</td><td class="num">${r.played ?? ''}</td><td class="num">${r.won ?? ''}</td><td class="num">${r.lost ?? ''}</td><td class="num"><b>${r.points ?? ''}</b></td></tr>`).join('')}</table></div></div>
      ${(t.upcoming || []).length ? `<div class="card"><div class="card-title">משחקים קרובים</div><ul class="list">${t.upcoming.map(m => `<li>${matchCard(m)}</li>`).join('')}</ul></div>` : ''}
      ${(t.lastResults || []).length ? `<div class="card"><div class="card-title">תוצאות אחרונות</div><ul class="list">${t.lastResults.map(m => `<li>${matchCard(m)}</li>`).join('')}</ul></div>` : ''}
    </div>`).join('');
  };

  SCREENS.tournaments = async () => {
    const list = (await D.tournaments()).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    if (!list.length) return empty('medal', 'התחרויות יתעדכנו מאתר TTTM');
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = list.filter(t => !t.date || t.date >= today);
    const past = list.filter(t => t.date && t.date < today).reverse();
    const card = t => `<div class="card">
      <div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-medal"/></svg></span>${esc(t.name)}</div>
      <div class="row" style="margin-bottom:6px">${t.date ? `<span class="chip orange">${fmtDate(t.date, true)}</span>` : ''}${t.registrationUntil ? `<span class="chip">הרשמה עד ${esc(t.registrationUntil)}</span>` : ''}</div>
      ${t.venue ? `<p class="small">📍 ${esc(t.venue)}</p>` : ''}
      ${(t.categories || []).length ? `<div class="row">${t.categories.map(c => `<span class="chip gray">${esc(c)}</span>`).join('')}</div>` : ''}
      ${t.info ? `<p class="small muted" style="margin-top:8px">${esc(t.info)}</p>` : ''}
      <a class="btn btn-secondary btn-sm" style="margin-top:10px" href="${esc(t.url)}" target="_blank" rel="noopener">פרטים והרשמה ב-TTTM ↗</a></div>`;
    return `${upcoming.length ? `<h2>תחרויות קרובות</h2>${upcoming.map(card).join('')}` : '<p class="muted">אין תחרויות קרובות שפורסמו</p>'}
      ${past.length ? `<h2 style="margin-top:18px">תחרויות שהיו</h2>${past.map(card).join('')}` : ''}`;
  };

  SCREENS.news = async () => {
    const list = visibleAnnouncements(await D.announcements(50));
    if (!list.length) return empty('megaphone', 'אין הודעות עדיין');
    return list.map(a => `<div class="card ${a.urgent ? 'alert' : ''}" style="font-weight:400">
      ${a.urgent ? '<div class="ttl">דחוף</div>' : ''}<h2 style="font-size:1.15rem">${esc(a.title)}</h2>
      ${a.imageUrl ? `<img src="${esc(a.imageUrl)}" alt="" style="width:100%;border-radius:12px;margin:6px 0">` : ''}
      <p style="white-space:pre-wrap">${linkify(esc(a.body || ''))}</p>
      <div class="small muted">${fmtDate(a.publishAt.slice(0, 10))}${a.authorName ? ' · ' + esc(a.authorName) : ''}${a.audience === 'group' && a.groupName ? ' · ' + esc(a.groupName) : ''}</div>
      ${isAdmin() || (canPublish() && a.authorId === S.user.uid) ? `<div class="row" style="margin-top:8px"><button class="btn btn-secondary btn-sm" data-action="editAnn" data-id="${a.id}">עריכה</button><button class="btn btn-danger btn-sm" data-action="delAnn" data-id="${a.id}">מחיקה</button></div>` : ''}
    </div>`).join('');
  };
  const linkify = s => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  SCREENS.coaches = async () => {
    const coaches = await D.coaches();
    if (!coaches.length) return empty('whistle', 'פרטי המאמנים יוזנו בקרוב');
    return coaches.map(c => `<div class="card"><div class="person">${c.photoUrl ? `<img src="${esc(c.photoUrl)}" alt="">` : '<div class="avatar">' + '<svg class="ic" aria-hidden="true"><use href="#ic-user"/></svg>' + '</div>'}
      <div><div class="name">${esc(c.name)}</div><div class="muted small">${esc((c.venues || []).join(' · '))}</div>${(c.groupNames || []).length ? `<div class="muted small">מאמן/ת: ${esc(c.groupNames.join(' · '))}</div>` : ''}${c.bio ? `<div class="small">${esc(c.bio)}</div>` : ''}</div></div>
      ${c.phone ? `<div class="row" style="margin-top:12px"><a class="btn btn-primary btn-sm" href="${telHref(c.phone)}"><svg class="ic" aria-hidden="true"><use href="#ic-phone"/></svg> ${esc(fmtPhone(normalizePhone(c.phone)))}</a><a class="btn btn-secondary btn-sm" href="${waHref(c.phone)}" target="_blank" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#ic-whatsapp"/></svg> וואטסאפ</a></div>` : ''}</div>`).join('');
  };

  SCREENS.contact = async () => {
    const [venues, settings] = await Promise.all([D.venues(), D.settings()]);
    const c = { ...CLUB, ...(settings.contact || {}) };
    return `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-phone"/></svg></span>טלפונים</div>
      <div class="row"><a class="btn btn-primary" href="${telHref(c.contactPhone)}"><svg class="ic" aria-hidden="true"><use href="#ic-phone"/></svg> ${esc(c.contactName)} · ${esc(fmtPhone(normalizePhone(c.contactPhone)))}</a></div>
      <div class="row" style="margin-top:8px"><a class="btn btn-secondary" href="${waHref(c.contactPhone, 'שלום, אני פונה מפורטל המועדון')}" target="_blank" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#ic-whatsapp"/></svg> וואטסאפ</a></div>
      ${c.email ? `<p style="margin-top:10px"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}</div>
      ${venues.length ? `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-pin"/></svg></span>האולמות</div><ul class="list">${venues.map(v => `<li><b>${esc(v.name)}</b><div class="small muted">${esc(v.address || '')}</div>${v.address ? `<div class="row" style="margin-top:6px"><a class="btn btn-secondary btn-sm" href="https://waze.com/ul?q=${encodeURIComponent(v.address)}&navigate=yes"><svg class="ic" aria-hidden="true"><use href="#ic-navigate"/></svg> Waze</a><a class="btn btn-secondary btn-sm" href="https://maps.google.com/?q=${encodeURIComponent(v.address)}"><svg class="ic" aria-hidden="true"><use href="#ic-map"/></svg> מפות</a></div>` : ''}</li>`).join('')}</ul></div>` : ''}`;
  };

  SCREENS.social = async () => `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-share"/></svg></span>עקבו אחרינו</div>
    <a class="btn btn-primary" style="margin-bottom:10px" href="${esc(CLUB.facebook)}" target="_blank" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#ic-facebook"/></svg> הדף שלנו בפייסבוק</a>
    <a class="btn btn-orange" href="${esc(CLUB.instagram)}" target="_blank" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#ic-instagram"/></svg> האינסטגרם שלנו</a></div>
    <div class="card"><div class="card-title">הפוסטים האחרונים</div>
    <iframe src="https://www.facebook.com/plugins/page.php?href=${encodeURIComponent(CLUB.facebook)}&tabs=timeline&width=340&height=600&small_header=true&adapt_container_width=true&hide_cover=false&show_facepile=false" width="100%" height="600" style="border:none;overflow:hidden;border-radius:12px" scrolling="no" frameborder="0" allow="encrypted-media" title="פייסבוק"></iframe></div>`;

  SCREENS.partners = async () => `<div class="card center"><div class="card-title" style="justify-content:center"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-handshake"/></svg></span>השותפים שלנו</div>
    <p>המועדון פועל בשיתוף:</p>
    <img src="assets/logo-matnas.png" alt="מתנ״ס אזורי מבואות החרמון" style="max-width:70%;max-height:150px;margin:12px auto;display:block" onerror="this.style.display='none'"><p><b>מתנ״ס אזורי מבואות החרמון</b></p>
    <img src="assets/logo-moatza.png" alt="מועצה אזורית מבואות החרמון" style="max-width:70%;max-height:150px;margin:12px auto;display:block" onerror="this.style.display='none'"><p><b>מועצה אזורית מבואות החרמון</b></p>
    <img src="assets/logo-club.png" alt="" style="max-width:60%;max-height:170px;margin:18px auto 6px;display:block" onerror="this.style.display='none'"><p class="muted">${esc(CLUB.fullName)}</p></div>`;

  SCREENS.more = async () => `<div class="card" style="padding:6px">
    ${[['tournaments', 'medal', 'תחרויות'], ['news', 'megaphone', 'הודעות ואירועים'], ['coaches', 'whistle', 'המאמנים שלנו'], ['contact', 'phone', 'צור קשר'], ['social', 'share', 'עקבו אחרינו'], ['partners', 'handshake', 'שותפים'],
      ...(canPublish() ? [['publish', 'edit', 'הודעה חדשה']] : []), ...(isAdmin() ? [['admin', 'settings', 'ניהול'], ['dashboard', 'chart', 'דשבורד']] : [])]
      .map(([k, i, t]) => `<button class="btn" style="justify-content:flex-start;font-size:1.1rem;border-bottom:1px solid var(--line);border-radius:0" data-go="${k}"><svg class="ic" aria-hidden="true"><use href="#ic-${i}"/></svg>${t}</button>`).join('')}
    <button class="btn" style="justify-content:flex-start;font-size:1.05rem;color:var(--red)" id="btn-logout-2"><svg class="ic" aria-hidden="true"><use href="#ic-logout"/></svg>יציאה</button></div>
    <p class="center small muted">מחובר: ${esc(S.claims.name || '')} · ${roleLabel(S.claims.role)} · ${esc(fmtPhone(S.user.uid))}</p>`;
  document.addEventListener('click', e => { if (e.target.id === 'btn-logout-2' || e.target.id === 'btn-logout-3') $('#btn-logout').click(); });

  // ---------------------------------------------------------------- reminders
  async function openReminder(target, label) {
    const [scope, id] = target.split(':');
    const html = `<div class="modal" id="modal"><div class="modal-panel"><h2><svg class="ic" aria-hidden="true"><use href="#ic-bell"/></svg> הזכר לי</h2><p class="muted">${esc(label)}</p>
      <form data-form="reminder"><label for="rem-email">כתובת המייל שלך</label><input id="rem-email" name="email" type="email" inputmode="email" autocomplete="email" required placeholder="name@example.com" value="${esc(localStorage.getItem('remEmail') || '')}">
      <label>מתי להזכיר?</label>
      <label class="check"><input type="checkbox" name="week" checked> שבוע לפני המשחק</label>
      <label class="check"><input type="checkbox" name="sameDay" checked> בבוקר המשחק</label>
      <input type="hidden" name="scope" value="${esc(scope)}"><input type="hidden" name="id" value="${esc(id)}">
      <button class="btn btn-primary" type="submit">שמור תזכורת</button><button class="btn btn-secondary" type="button" data-close style="margin-top:8px">ביטול</button></form></div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const modal = $('#modal'); pushModalState();
    modal.addEventListener('click', e => { if (e.target === modal || e.target.dataset.close != null) closeModal(); });
    $('form', modal).addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, email = f.email.value.trim(), timing = [f.week.checked && 'week', f.sameDay.checked && 'sameDay'].filter(Boolean);
      if (!timing.length) return toast('בחר לפחות מועד אחד');
      try {
        await db.collection('reminders').add({ email, scope, [scope === 'match' ? 'matchId' : 'teamId']: id, timing, sentFor: [], unsubscribeToken: uid(), ownerUid: S.user.uid, createdAt: new Date().toISOString() });
        localStorage.setItem('remEmail', email); closeModal(); toast('✅ התזכורת נשמרה');
      } catch (err) { console.error(err); toast('שגיאה בשמירה'); }
    });
    setTimeout(() => $('#rem-email').focus(), 50);
  }
  async function handleUnsubscribeLink() {
    const m = location.hash.match(/#unsubscribe=([^:]+):(.+)/);
    if (!m) return;
    try { await db.doc('reminders/' + m[1]).update({ unsubscribed: true }); toast('הוסרת מהתזכורות'); } catch { toast('לא הצלחנו להסיר — פנה למנהל'); }
    location.hash = '';
  }

  // ---------------------------------------------------------------- push notifications (FCM)
  let messaging = null;
  function pushSupported() { return 'Notification' in window && 'serviceWorker' in navigator && firebase.messaging?.isSupported?.() && CFG.vapidKey && !CFG.vapidKey.startsWith('PASTE'); }
  function pushCard() {
    if (!pushSupported() || Notification.permission === 'granted' || localStorage.getItem('pushDismissed')) return '';
    return `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-bell"/></svg></span>התראות על הודעות דחופות</div><p class="small muted">כדי לקבל הודעה לטלפון כשאימון מתבטל — גם כשהפורטל סגור.</p>
      <div class="row"><button class="btn btn-primary" data-action="enablePush">הפעל התראות</button><button class="btn btn-secondary btn-sm" data-action="dismissPush">לא עכשיו</button></div></div>`;
  }
  ACTIONS.dismissPush = () => { localStorage.setItem('pushDismissed', '1'); route(); };
  ACTIONS.enablePush = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('ההתראות לא הופעלו');
      await setupPush(true); toast('✅ ההתראות הופעלו'); route();
    } catch (e) { console.error(e); toast('לא הצלחנו להפעיל התראות במכשיר זה'); }
  };
  async function setupPush(force = false) {
    if (!pushSupported() || (Notification.permission !== 'granted' && !force)) return;
    try {
      const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
      messaging = messaging || firebase.messaging();
      const token = await messaging.getToken({ vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
      if (token && localStorage.getItem('pushToken') !== token) {
        await db.doc('pushTokens/' + token).set({ uid: S.user.uid, role: S.claims.role, groupIds: S.players.map(p => p.groupId).filter(Boolean), updatedAt: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });
        localStorage.setItem('pushToken', token);
      }
      messaging.onMessage(p => { toast('📢 ' + (p.notification?.title || 'הודעה חדשה'), 5000); invalidate('ann'); });
    } catch (e) { console.warn('push setup', e); }
  }

  // ---------------------------------------------------------------- publish announcement
  SCREENS.publish = async (editId) => {
    const groups = await D.groups();
    const myGroups = groups;
    let a = null;
    if (editId) a = docData(await db.doc('announcements/' + editId).get());
    const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return `<div class="card"><form data-form="announcement" class="form-grid">
      <input type="hidden" name="id" value="${esc(editId || '')}">
      <label for="a-title">כותרת</label><input id="a-title" name="title" required maxlength="120" value="${esc(a?.title || '')}">
      <label for="a-body">תוכן ההודעה</label><textarea id="a-body" name="body" maxlength="2000">${esc(a?.body || '')}</textarea>
      <label for="a-img">קישור לתמונה (אופציונלי)</label><input id="a-img" name="imageUrl" type="url" placeholder="https://…" value="${esc(a?.imageUrl || '')}">
      <label for="a-aud">למי</label><select id="a-aud" name="audience" ${isAdmin() ? '' : ''}>
        ${isAdmin() ? `<option value="all" ${!a || a.audience === 'all' ? 'selected' : ''}>לכולם</option><option value="players" ${a?.audience === 'players' ? 'selected' : ''}>שחקנים והורים בלבד</option><option value="coaches" ${a?.audience === 'coaches' ? 'selected' : ''}>מאמנים בלבד</option>` : ''}
        <option value="group" ${a?.audience === 'group' || !isAdmin() ? 'selected' : ''}>הורי קבוצה מסוימת</option></select>
      <div id="grp-wrap" class="${(a?.audience === 'group' || !isAdmin()) ? '' : 'hidden'}"><label for="a-grp">קבוצה</label><select id="a-grp" name="groupId">${myGroups.map(g => `<option value="${g.id}" ${a?.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" name="urgent" ${a?.urgent ? 'checked' : ''}> דחוף — פס בראש מסך הבית + התראה לטלפון</label>
      <label for="a-when">תזמון פרסום</label><input id="a-when" name="publishAt" type="datetime-local" value="${esc(a?.publishAt ? a.publishAt.slice(0, 16) : now.toISOString().slice(0, 16))}">
      <button class="btn btn-primary btn-xl" type="submit" style="margin-top:14px">${editId ? 'שמור שינויים' : 'פרסם'}</button>
      ${!isAdmin() ? '<p class="small muted">כמאמן, ההודעה נשלחת להורי הקבוצות שלך בלבד.</p>' : ''}
    </form></div>`;
  };
  document.addEventListener('change', e => { if (e.target.id === 'a-aud') $('#grp-wrap').classList.toggle('hidden', e.target.value !== 'group'); });
  FORMS.announcement = async f => {
    const groups = await D.groups();
    const data = {
      title: f.title.value.trim(), body: f.body.value.trim(), imageUrl: f.imageUrl.value.trim() || null,
      audience: f.audience.value, groupId: f.audience.value === 'group' ? f.groupId.value : null,
      groupName: f.audience.value === 'group' ? groups.find(g => g.id === f.groupId.value)?.name || null : null,
      urgent: f.urgent.checked, publishAt: new Date(f.publishAt.value || Date.now()).toISOString(),
      authorId: S.user.uid, authorName: S.claims.name || fmtPhone(S.user.uid), updatedAt: new Date().toISOString(),
    };
    if (!data.title) return toast('חסרה כותרת');
    try {
      const id = f.id.value;
      if (id) await db.doc('announcements/' + id).update(data);
      else { data.createdAt = data.updatedAt; data.pushSent = false; const ref = await db.collection('announcements').add(data); if (data.urgent && data.publishAt <= new Date().toISOString()) sendPush(ref.id, data); }
      invalidate('ann'); toast('✅ ההודעה פורסמה'); go('news');
    } catch (e) { console.error(e); toast('שגיאה בפרסום: ' + e.message); }
  };
  async function sendPush(id, data) {
    try {
      const idToken = await S.user.getIdToken();
      const r = await fetch(CFG.loginUrl.replace(/\/$/, '') + '/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken }, body: JSON.stringify({ announcementId: id, title: data.title, body: data.body, audience: data.audience, groupId: data.groupId }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) toast(`📲 נשלחה התראה ל-${j.sent ?? 0} מכשירים`, 4000);
    } catch (e) { console.warn('push send', e); }
  }
  ACTIONS.editAnn = el => go('publish', el.dataset.id);
  ACTIONS.delAnn = async el => { if (!confirm('למחוק את ההודעה?')) return; await db.doc('announcements/' + el.dataset.id).delete(); invalidate('ann'); toast('נמחק'); route(); };

  // ---------------------------------------------------------------- admin
  SCREENS.admin = async (tab = 'access') => {
    const seg = `<div class="seg">${[['access', 'גישות'], ['players', 'שחקנים'], ['groups', 'קבוצות'], ['coaches', 'מאמנים'], ['venues', 'אולמות']].map(([k, t]) => `<button data-seg="${k}" class="${k === tab ? 'active' : ''}">${t}</button>`).join('')}</div>`;
    const [users, players, groups, coaches, venues] = await Promise.all([colData(await db.collection('users').get()), colData(await db.collection('players').get()), D.groups(), D.coaches(), D.venues()]);
    S.cache.set('adminUsers', { t: Date.now(), v: users }); S.cache.set('adminPlayers', { t: Date.now(), v: players });
    const pname = id => players.find(p => p.id === id)?.name || id;
    const playerOpts = sel => `<option value="">— חבר מועדון (ללא שחקן) —</option>` + players.sort((a, b) => a.name.localeCompare(b.name, 'he')).map(p => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const panes = {
      access: `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-edit"/></svg></span>הוספת מספר</div><form data-form="addUser" class="form-grid">
          <label>מספר טלפון</label><input name="phone" type="tel" inputmode="tel" required placeholder="050-1234567" style="direction:ltr">
          <label>שם</label><input name="name" required placeholder="שם מלא">
          <label>קישור לשחקן</label><select name="playerId">${playerOpts()}</select>
          <label>סוג</label><select name="role"><option value="parent">הורה / בן משפחה</option><option value="player">השחקן עצמו</option><option value="member">חבר מועדון</option><option value="coach">מאמן</option><option value="admin">מנהל</option></select>
          <button class="btn btn-primary" type="submit">הוסף</button></form>
          <details style="margin-top:14px"><summary style="font-weight:700;cursor:pointer">📥 ייבוא רשימה (הדבקה)</summary>
          <p class="small muted">שורה לכל אדם: <code>טלפון, שם, מזהה-שחקן-או-ריק, סוג</code>. לדוגמה:<br><code>0501234567, רונית כהן, ${players[0]?.id || 'abc123'}, parent</code></p>
          <form data-form="importUsers"><textarea name="csv" placeholder="0501234567, שם, מזהה שחקן, parent"></textarea><button class="btn btn-secondary" type="submit">ייבא</button></form></details></div>
        <div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-users"/></svg></span>מורשי כניסה (${users.length})</div><input type="search" placeholder="חיפוש לפי שם או טלפון" data-filter="#users-list" style="margin-bottom:10px">
          <ul class="list" id="users-list">${users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he')).map(u => `<li class="user-row" data-search="${esc((u.name || '') + ' ' + u.id)}"><div class="info"><div class="n">${esc(u.name || '—')} <span class="chip ${u.role === 'admin' ? 'orange' : u.role === 'coach' ? 'green' : ''}">${roleLabel(u.role)}</span>${u.canPublish ? '<span class="chip green">מפרסם</span>' : ''}</div>
            <div class="p">${esc(fmtPhone(u.id))}</div><div class="small muted">${(u.playerIds || []).map(pname).map(esc).join(', ')}${u.lastLogin ? ' · כניסה אחרונה ' + fmtDate(u.lastLogin.slice(0, 10), false) : ' · <b>לא נכנס מעולם</b>'}</div></div>
            ${u.role === 'coach' ? `<button class="btn btn-sm ${u.canPublish ? 'btn-secondary' : 'btn-primary'}" data-action="togglePublish" data-id="${u.id}" data-val="${u.canPublish ? '0' : '1'}" title="רשאי לפרסם הודעות">${u.canPublish ? '🔕' : '✍️'}</button>` : ''}
            ${u.id !== S.user.uid ? `<button class="btn btn-danger btn-sm" data-action="removeUser" data-id="${u.id}">הסר</button>` : ''}</li>`).join('')}</ul></div>`,
      players: `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-ball"/></svg></span>שחקנים (${players.length})</div><p class="small muted">השחקנים מגיעים אוטומטית מאפליקציית הנוכחות (סנכרון יומי). כאן מקשרים מספר TTTM ומוסיפים טלפונים.</p>
        <form data-form="addPlayer" class="row" style="margin-bottom:10px"><input name="name" placeholder="שם שחקן חדש" required><button class="btn btn-secondary btn-sm" type="submit">הוסף</button></form>
        <ul class="list">${players.map(p => `<li><div class="row spread"><div><b>${esc(p.name)}</b> <span class="chip gray">${esc(groups.find(g => g.id === p.groupId)?.name || 'ללא קבוצה')}</span>${p.tttmId ? `<span class="chip">TTTM ${esc(p.tttmId)}</span>` : ''}${(p.leagueTeams || []).map(k => `<span class="chip orange">${esc(k)}</span>`).join('')}</div>
          <button class="btn btn-secondary btn-sm" data-action="editPlayer" data-id="${p.id}">עריכה</button></div>
          <div class="small muted">${(p.phones || []).map(fmtPhone).map(esc).join(' · ') || 'אין מספרים מקושרים'}</div>
          <div class="row" style="margin-top:6px"><form data-form="addPhoneToPlayer" class="row" style="flex:1"><input type="hidden" name="playerId" value="${p.id}"><input name="phone" type="tel" placeholder="הוסף מספר של הורה" style="direction:ltr;min-height:48px"><input name="name" placeholder="שם ההורה" style="min-height:48px"><button class="btn btn-primary btn-sm" type="submit">+</button></form></div></li>`).join('')}</ul></div>`,
      groups: `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-calendar"/></svg></span>קבוצות ולוח אימונים</div><p class="small muted">הקבוצות מסונכרנות מאפליקציית הנוכחות. אפשר לערוך כאן מקום ומאמנים.</p>
        ${groups.map(g => `<form data-form="saveGroup" class="form-grid" style="border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:12px"><input type="hidden" name="id" value="${g.id}">
          <div class="row"><input name="name" value="${esc(g.name || '')}" placeholder="שם הקבוצה" required><select name="venue">${['', ...venues.map(v => v.name)].map(v => `<option ${g.venue === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          <div class="row">${HEB_DAYS.map((d, i) => `<label class="check" style="margin:4px 0"><input type="checkbox" name="day${i}" ${(g.days || []).some(x => x === i || x === d) ? 'checked' : ''}>${d.slice(0, 1)}׳</label>`).join('')}</div>
          <div class="row"><input name="startTime" type="time" value="${esc(g.startTime || '')}"><input name="endTime" type="time" value="${esc(g.endTime || '')}"></div>
          <label>מאמנים</label><div class="row">${coaches.map(c => `<label class="check" style="margin:4px 0"><input type="checkbox" name="coach_${c.id}" ${(g.coachIds || []).includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('') || '<span class="muted small">הוסף מאמנים בלשונית מאמנים</span>'}</div>
          <button class="btn btn-secondary btn-sm" type="submit">שמור</button></form>`).join('')}
        <form data-form="saveGroup" class="row"><input type="hidden" name="id" value=""><input name="name" placeholder="קבוצה חדשה" required><button class="btn btn-primary btn-sm" type="submit">הוסף</button></form></div>`,
      coaches: `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-whistle"/></svg></span>מאמנים</div>
        ${coaches.map(c => `<form data-form="saveCoach" class="form-grid" style="border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:12px"><input type="hidden" name="id" value="${c.id}">
          <div class="row"><input name="name" value="${esc(c.name || '')}" placeholder="שם" required><input name="phone" value="${esc(c.phone || '')}" placeholder="טלפון" style="direction:ltr"></div>
          <input name="photoUrl" value="${esc(c.photoUrl || '')}" placeholder="קישור לתמונה (assets/coach-x.jpg)">
          <input name="venues" value="${esc((c.venues || []).join(', '))}" placeholder="איפה מאמן (מופרד בפסיק)"><input name="bio" value="${esc(c.bio || '')}" placeholder="משפט עליו (אופציונלי)">
          <div class="row"><button class="btn btn-secondary btn-sm" type="submit">שמור</button><button class="btn btn-danger btn-sm" type="button" data-action="delCoach" data-id="${c.id}">מחק</button></div></form>`).join('')}
        <form data-form="saveCoach" class="row"><input type="hidden" name="id" value=""><input name="name" placeholder="מאמן חדש" required><button class="btn btn-primary btn-sm" type="submit">הוסף</button></form></div>`,
      venues: `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-pin"/></svg></span>אולמות</div>
        ${venues.map(v => `<form data-form="saveVenue" class="row" style="margin-bottom:10px"><input type="hidden" name="id" value="${v.id}"><input name="name" value="${esc(v.name)}" required><input name="address" value="${esc(v.address || '')}" placeholder="כתובת לניווט"><button class="btn btn-secondary btn-sm" type="submit">שמור</button><button class="btn btn-danger btn-sm" type="button" data-action="delVenue" data-id="${v.id}">מחק</button></form>`).join('')}
        <form data-form="saveVenue" class="row"><input type="hidden" name="id" value=""><input name="name" placeholder="שם האולם" required><input name="address" placeholder="כתובת"><button class="btn btn-primary btn-sm" type="submit">הוסף</button></form>
        <p class="small muted" style="margin-top:10px">שינוי הרשאות (מאמן→מפרסם, הוספת מנהל) נכנס לתוקף בכניסה הבאה של אותו משתמש.</p></div>`,
    };
    return seg + Object.entries(panes).map(([k, h]) => `<div data-pane="${k}" class="${k === tab ? '' : 'hidden'}">${h}</div>`).join('');
  };
  async function upsertUser(phone, name, role, playerId) {
    const ref = db.doc('users/' + phone), snap = await ref.get();
    const data = { name, role: role || (playerId ? 'parent' : 'member'), updatedAt: new Date().toISOString() };
    if (!snap.exists) { data.createdAt = data.updatedAt; data.playerIds = playerId ? [playerId] : []; data.canPublish = false; await ref.set(data); }
    else await ref.update({ ...data, ...(playerId ? { playerIds: FieldValue.arrayUnion(playerId) } : {}) });
    if (playerId) await db.doc('players/' + playerId).update({ phones: FieldValue.arrayUnion(phone) });
  }
  FORMS.addUser = async f => {
    const phone = normalizePhone(f.phone.value); if (!phone) return toast('מספר לא תקין');
    await upsertUser(phone, f.name.value.trim(), f.role.value, f.playerId.value || null);
    invalidate('player:'); toast('✅ נוסף'); route();
  };
  FORMS.importUsers = async f => {
    const lines = f.csv.value.split('\n').map(l => l.trim()).filter(Boolean); let ok = 0, bad = [];
    for (const l of lines) {
      const [ph, name, pid, role] = l.split(/[,\t;]/).map(s => (s || '').trim());
      const phone = normalizePhone(ph); if (!phone || !name) { bad.push(l); continue; }
      await upsertUser(phone, name, role || (pid ? 'parent' : 'member'), pid || null); ok++;
    }
    toast(`יובאו ${ok}${bad.length ? `, נכשלו ${bad.length}` : ''}`, 4000); if (bad.length) alert('שורות שלא יובאו:\n' + bad.join('\n')); route();
  };
  ACTIONS.removeUser = async el => {
    if (!confirm('להסיר את הגישה של ' + fmtPhone(el.dataset.id) + '?')) return;
    const u = docData(await db.doc('users/' + el.dataset.id).get());
    for (const pid of (u?.playerIds || [])) await db.doc('players/' + pid).update({ phones: FieldValue.arrayRemove(el.dataset.id) }).catch(() => {});
    await db.doc('users/' + el.dataset.id).delete(); toast('הוסר'); route();
  };
  ACTIONS.togglePublish = async el => { await db.doc('users/' + el.dataset.id).update({ canPublish: el.dataset.val === '1' }); toast(el.dataset.val === '1' ? 'המאמן רשאי לפרסם (מהכניסה הבאה שלו)' : 'הרשאת הפרסום בוטלה'); route(); };
  FORMS.addPlayer = async f => { await db.collection('players').add({ name: f.name.value.trim(), firstName: firstName(f.name.value), phones: [], active: true, groupId: '', createdAt: new Date().toISOString(), source: 'portal' }); toast('נוסף'); route(); };
  FORMS.addPhoneToPlayer = async f => {
    const phone = normalizePhone(f.phone.value); if (!phone) return toast('מספר לא תקין');
    const p = docData(await db.doc('players/' + f.playerId.value).get());
    await upsertUser(phone, f.name.value.trim() || ('הורה של ' + firstName(p.name)), 'parent', p.id); invalidate('player:'); toast('✅ המספר קושר'); route();
  };
  ACTIONS.editPlayer = async el => {
    const p = docData(await db.doc('players/' + el.dataset.id).get()), groups = await D.groups(), allTeams = await D.teams();
    const inTeam = k => (p.leagueTeams || []).includes(k);
    const html = `<div class="modal" id="modal"><div class="modal-panel"><h2>${esc(p.name)}</h2><form data-form="savePlayer" class="form-grid"><input type="hidden" name="id" value="${p.id}">
      <label>שם מלא</label><input name="name" value="${esc(p.name)}" required><label>מספר שחקן ב-TTTM</label><input name="tttmId" value="${esc(p.tttmId || '')}" inputmode="numeric" placeholder="למשל 1439">
      <label>קבוצה</label><select name="groupId"><option value="">ללא</option>${groups.map(g => `<option value="${g.id}" ${p.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
      ${allTeams.length ? `<label>סגל ליגה (מי שלא מסומן — לא רואה טבלאות ליגה)</label>
      ${allTeams.map(t => `<label class="check"><input type="checkbox" name="team_${esc(t.teamKey)}" ${inTeam(t.teamKey) ? 'checked' : ''}> ${esc(t.teamKey)} — ${esc(t.league || '')}</label>`).join('')}` : ''}
      <label class="check"><input type="checkbox" name="active" ${p.active !== false ? 'checked' : ''}> פעיל</label>
      <button class="btn btn-primary" type="submit">שמור</button><button class="btn btn-secondary" type="button" data-close style="margin-top:8px">סגור</button></form></div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const modal = $('#modal'); pushModalState();
    modal.addEventListener('click', e => { if (e.target === modal || e.target.dataset.close != null) closeModal(); });
    $('form', modal).addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      const leagueTeams = allTeams.map(t => t.teamKey).filter(k => f['team_' + k] && f['team_' + k].checked);
      await db.doc('players/' + f.id.value).update({ name: f.name.value.trim(), firstName: firstName(f.name.value), tttmId: f.tttmId.value.trim() || null, groupId: f.groupId.value, leagueTeams, active: f.active.checked, updatedAt: new Date().toISOString() });
      invalidate('player:'); closeModal(); toast('נשמר'); route();
    });
  };
  FORMS.saveGroup = async f => {
    const data = { name: f.name.value.trim(), updatedAt: new Date().toISOString() };
    if (f.venue) data.venue = f.venue.value;
    if (f.startTime) { data.startTime = f.startTime.value; data.endTime = f.endTime.value; data.days = HEB_DAYS.map((_, i) => f['day' + i]?.checked ? i : null).filter(v => v !== null); data.coachIds = [...f.elements].filter(el => el.name?.startsWith('coach_') && el.checked).map(el => el.name.slice(6)); }
    if (f.id.value) await db.doc('groups/' + f.id.value).update(data); else await db.collection('groups').add({ ...data, days: [], coachIds: [], createdAt: data.updatedAt });
    invalidate('groups'); toast('נשמר'); route();
  };
  FORMS.saveCoach = async f => {
    const data = { name: f.name.value.trim(), updatedAt: new Date().toISOString() };
    if (f.phone) Object.assign(data, { phone: f.phone.value.trim(), photoUrl: f.photoUrl.value.trim(), venues: f.venues.value.split(',').map(s => s.trim()).filter(Boolean), bio: f.bio.value.trim() });
    if (f.id.value) await db.doc('coaches/' + f.id.value).update(data); else await db.collection('coaches').add({ ...data, venues: [], createdAt: data.updatedAt });
    invalidate('coaches'); toast('נשמר'); route();
  };
  ACTIONS.delCoach = async el => { if (confirm('למחוק?')) { await db.doc('coaches/' + el.dataset.id).delete(); invalidate('coaches'); route(); } };
  FORMS.saveVenue = async f => {
    const data = { name: f.name.value.trim(), address: f.address.value.trim(), updatedAt: new Date().toISOString() };
    if (f.id.value) await db.doc('venues/' + f.id.value).update(data); else await db.collection('venues').add(data);
    invalidate('venues'); toast('נשמר'); route();
  };
  ACTIONS.delVenue = async el => { if (confirm('למחוק?')) { await db.doc('venues/' + el.dataset.id).delete(); invalidate('venues'); route(); } };

  // ---------------------------------------------------------------- dashboard
  SCREENS.dashboard = async () => {
    const since = new Date(Date.now() - 30 * 864e5); const sinceISO = localISO(since);
    const [logins, users] = await Promise.all([colData(await db.collection('logins').where(firebase.firestore.FieldPath.documentId(), '>=', sinceISO).get()), colData(await db.collection('users').get())]);
    const byDay = Object.fromEntries(logins.map(l => [l.id, l.count || 0]));
    const days = []; for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(localISO(d)); }
    const sum = arr => arr.reduce((a, b) => a + (byDay[b] || 0), 0);
    const max = Math.max(1, ...days.map(d => byDay[d] || 0));
    const t = todayISO(), monthAgo = localISO(new Date(Date.now() - 30 * 864e5));
    const never = users.filter(u => !u.lastLogin), stale = users.filter(u => u.lastLogin && u.lastLogin.slice(0, 10) < monthAgo), recent = users.filter(u => u.lastLogin).sort((a, b) => b.lastLogin.localeCompare(a.lastLogin)).slice(0, 15);
    const byRole = {}; users.forEach(u => byRole[u.role] = (byRole[u.role] || 0) + 1);
    const userLi = (u, extra = '') => `<li class="user-row"><div class="info"><div class="n">${esc(u.name || '—')} <span class="chip gray">${roleLabel(u.role)}</span></div><div class="p">${esc(fmtPhone(u.id))}${extra}</div></div><a class="btn btn-secondary btn-sm" href="${waHref(u.id, `היי ${esc(firstName(u.name))}, הצטרפ/י לפורטל המועדון: ${location.origin + location.pathname}`)}" target="_blank" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#ic-whatsapp"/></svg></a></li>`;
    return `<div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-chart"/></svg></span>כניסות לפורטל</div>
      <div class="stat-grid"><div><div class="big-number">${byDay[t] || 0}</div><div class="lbl">היום</div></div><div><div class="big-number">${sum(days.slice(-7))}</div><div class="lbl">השבוע</div></div><div><div class="big-number">${sum(days)}</div><div class="lbl">30 יום</div></div></div>
      <div class="bar-chart" style="margin-top:14px">${days.map(d => `<div class="bar" style="height:${Math.round(100 * (byDay[d] || 0) / max)}%" title="${d}: ${byDay[d] || 0}"></div>`).join('')}</div><div class="small muted center">30 הימים האחרונים</div>
      <div class="row" style="margin-top:10px">${Object.entries(byRole).map(([r, n]) => `<span class="chip">${roleLabel(r)}: ${n}</span>`).join('')}<span class="chip gray">סה"כ ${users.length}</span></div></div>
      <div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-megaphone"/></svg></span>לא נכנסו מעולם (${never.length})</div><p class="small muted">אלה שהוספת ועדיין לא הגיעו — שלח להם תזכורת בוואטסאפ.</p><ul class="list">${never.map(u => userLi(u)).join('') || '<li class="muted">כולם נכנסו 🎉</li>'}</ul></div>
      <div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-calendar"/></svg></span>לא נכנסו מעל חודש (${stale.length})</div><ul class="list">${stale.map(u => userLi(u, ' · ' + fmtDate(u.lastLogin.slice(0, 10), false))).join('') || '<li class="muted">אין</li>'}</ul></div>
      <div class="card"><div class="card-title"><span class="ico"><svg class="ic" aria-hidden="true"><use href="#ic-calendar"/></svg></span>נכנסו לאחרונה</div><ul class="list">${recent.map(u => `<li><b>${esc(u.name || '')}</b> <span class="small muted">${fmtDate(u.lastLogin.slice(0, 10), false)} · ${u.loginCount || 0} כניסות</span></li>`).join('') || '<li class="muted">אין עדיין</li>'}</ul></div>`;
  };

  // ---------------------------------------------------------------- boot
  if (CFG.firebase.apiKey.startsWith('PASTE')) { loading.innerHTML = '<div class="card" style="max-width:420px"><h2>עוד לא הוגדר</h2><p>יש למלא את הפרטים בקובץ <code>config.js</code> (ראה README).</p></div>'; }
})();
