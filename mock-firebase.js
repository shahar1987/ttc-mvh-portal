/* מדמה את Firebase compat SDK לבדיקות UI מקומיות (ללא רשת). נטען במקום סקריפטי gstatic. */
(() => {
  const DB = window.MOCK_DB || {};
  const listeners = [];
  let currentUser = null;
  const claims = window.MOCK_CLAIMS || { role: 'parent', playerIds: ['p1', 'p2'], canPublish: false, name: 'רונית כהן' };
  const getPath = p => DB[p];
  const snap = (id, data) => ({ id, exists: data !== undefined, data: () => data });
  const colDocs = path => Object.entries(DB).filter(([k]) => k.startsWith(path + '/') && k.slice(path.length + 1).indexOf('/') < 0);
  function query(path, filters = [], order = null, lim = null) {
    return {
      where: (f, op, v) => query(path, [...filters, [f, op, v]], order, lim),
      orderBy: (f, d) => query(path, filters, [f, d], lim),
      limit: n => query(path, filters, order, n),
      async get() {
        let docs = colDocs(path).map(([k, v]) => snap(k.split('/').pop(), v));
        for (const [f, op, v] of filters) docs = docs.filter(d => { const x = f === '__id__' ? d.id : d.data()[f]; return op === '<=' ? x <= v : op === '>=' ? x >= v : op === '==' ? x === v : true; });
        if (order) docs.sort((a, b) => (a.data()[order[0]] > b.data()[order[0]] ? 1 : -1) * (order[1] === 'desc' ? -1 : 1));
        if (lim) docs = docs.slice(0, lim);
        return { docs };
      },
      async add(data) { const id = 'new' + Math.random().toString(36).slice(2, 6); DB[path + '/' + id] = data; return { id }; },
      doc: id => docRef(path + '/' + id),
    };
  }
  const docRef = path => ({
    async get() { return snap(path.split('/').pop(), getPath(path)); },
    async set(d, o) { DB[path] = o?.merge ? { ...(DB[path] || {}), ...d } : d; },
    async update(d) { DB[path] = { ...(DB[path] || {}), ...d }; },
    async delete() { delete DB[path]; },
    collection: sub => query(path + '/' + sub),
  });
  window.firebase = {
    initializeApp() {},
    auth: () => ({
      onAuthStateChanged(cb) { listeners.push(cb); setTimeout(() => cb(currentUser), 10); },
      async signInWithCustomToken() { currentUser = { uid: '972501234567', getIdTokenResult: async () => ({ claims }), getIdToken: async () => 'x' }; listeners.forEach(cb => cb(currentUser)); },
      async signOut() { currentUser = null; listeners.forEach(cb => cb(null)); },
    }),
    firestore: Object.assign(() => ({ doc: docRef, collection: p => query(p) }), {
      FieldValue: { arrayUnion: (...v) => v, arrayRemove: () => [] },
      FieldPath: { documentId: () => '__id__' },
    }),
    messaging: Object.assign(() => ({}), { isSupported: () => false }),
  };
  if (window.MOCK_AUTO_LOGIN) setTimeout(() => window.firebase.auth().signInWithCustomToken(), 20);
  // mock login endpoint
  const of = window.fetch;
  window.fetch = async (u, o) => u.includes('/login') ? new Response(JSON.stringify({ token: 't' }), { status: 200 }) : of(u, o);
})();
