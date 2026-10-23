/* Warehouse Manager — owner/staff stock and bulk sales app (Supabase) */
(() => {
'use strict';

const CFG = window.APP_CONFIG || {};
const CUR = CFG.currency || '₦';
const LOGIN_DOMAIN = 'login.warehouse.invalid'; // must match private.login_email() in supabase-setup.sql
const UNITS = ['carton', 'pack', 'bag', 'crate', 'bundle', 'dozen', 'sack', 'drum', 'piece'];
const METHODS = { cash: 'Cash', transfer: 'Bank transfer', pos: 'POS', credit: 'Credit (pay later)', refund: 'Refund' };
const DAYS = 31; // how far back sales and payments are loaded

/* ---------------- tiny helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const money = v => (n0(v) < 0 ? '-' : '') + CUR + Math.abs(n0(v)).toLocaleString('en-NG', { maximumFractionDigits: 2 });
// Quantities are whole numbers or quarters, shown as 12, ½, 1¼, 2¾.
const QUARTERS = ['', '¼', '½', '¾'];
const qty = v => {
  const n = n0(v), whole = Math.trunc(n), q = Math.round((n - whole) * 4);
  return (whole || !q ? whole.toLocaleString('en-NG') : '') + (QUARTERS[q] || '');
};
// What someone typed: "3", "1,200", "1/2", "1 1/2", "1½" or "1.5". NaN unless it's a whole number or quarters.
function parseQty(text) {
  const t = String(text ?? '').replace(/,/g, '').trim().replace(/[¼½¾]/g, c => ' ' + { '¼': '1/4', '½': '1/2', '¾': '3/4' }[c]).trim();
  const f = t.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  const n = f ? Number(f[1] || 0) + Number(f[2]) / Number(f[3]) : /^(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) && Number.isInteger(n * 4) ? n : NaN;
}
const QTY_HELP = 'Quantities can be whole numbers or quarters, like 2, 1/2 or 1¼.';
const lineTotal = (q, price) => Math.round(q * price * 100) / 100; // to the kobo, as the database does
const toDate = v => { if (!v) return null; if (v instanceof Date) return v; const d = new Date(v); return isNaN(d) ? null : d; };
const fmtDT = v => { const d = toDate(v); return d ? d.toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''; };
const fmtD = v => { const d = toDate(v); return d ? d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
const ago = v => {
  const d = toDate(v); if (!d) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  return fmtDT(d);
};
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysAgo = n => { const d = startOfDay(); d.setDate(d.getDate() - n); return d; };
// 1 carton, ½ carton, 1½ cartons, 0 cartons
const plural = (n, w) => `${qty(n)} ${w}${n0(n) > 0 && n0(n) <= 1 ? '' : (/(s|x|z|ch|sh)$/.test(w) ? 'es' : 's')}`;
const cleanUser = u => String(u || '').trim().toLowerCase();
const toEmail = u => `${cleanUser(u)}@${LOGIN_DOMAIN}`;
const isVoid = s => s.status === 'void';
const tagClass = code => code === 'OWNER' ? 'owner' : 'staff';
// The first 8 characters of an id: printed on receipts made without internet, and searchable.
const shortRef = id => String(id || '').slice(0, 8).toUpperCase();

// Browser storage can be full or switched off; the app keeps working without it.
function readKey(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function writeKey(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

// No internet, or a connection so slow that a request gave up (see NET_TIMEOUT).
const NET_TIMEOUT = 15000;
const isNetworkError = e => /failed to fetch|networkerror|load failed|network request failed|fetch failed|abort|timed? ?out/i
  .test(String((e && (e.message || e.name)) || e || ''));
const timeLimit = () => AbortSignal.timeout(NET_TIMEOUT);

const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  sale: '<path d="M4 4h16v16H4z" fill="none"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  truck: '<path d="M2 6h12v10H2zM14 10h4l4 4v2h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-5.5"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tag: '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="2" y="9" width="20" height="9" rx="2"/><path d="M6 14h12v7H6z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ''}</svg>`;

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6500 : 3200);
}

function friendlyError(e) {
  const msg = String((e && (e.message || e.error_description)) || e || '');
  const code = (e && e.code) || '';
  if (isNetworkError(e)) return 'No internet connection. Check the network and try again.';
  if (code === 'PGRST202' || /could not find the function/i.test(msg)) return 'The database needs updating. In Supabase, open SQL Editor and run the latest supabase-setup.sql (SETUP.md, step 2), then reload this page.';
  if (/invalid api key|no api key/i.test(msg)) return 'The Supabase key in config.js is not right. Copy the Publishable key again (SETUP.md, step 4).';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Wrong username or password.';
  if (code === 'user_banned' || /user is banned/i.test(msg)) return 'This account has been switched off. Ask the owner.';
  if (/jwt expired|invalid jwt|refresh token/i.test(msg)) return 'Your login has expired. Please log in again.';
  if (/permission denied/i.test(msg)) return 'You are not allowed to do that. Ask the owner.';
  if (code === 'over_request_rate_limit' || /rate limit/i.test(msg)) return 'Too many tries. Wait a few minutes and try again.';
  return msg || 'Something went wrong. Try again.';
}

/* ---------------- config check ---------------- */
const app = $('#app');
if (!window.supabase || !window.supabase.createClient) {
  app.innerHTML = `<div class="auth"><div class="auth-card"><h2>Could not start</h2><p>The file <b>vendor/supabase.js</b> is missing. Upload the whole app folder again.</p></div></div>`;
  return;
}
if (!CFG.supabaseUrl || !CFG.supabaseKey || /YOUR-PROJECT|PASTE_/.test(CFG.supabaseUrl + CFG.supabaseKey)) {
  app.innerHTML = `<div class="auth"><div class="auth-card">
    <h2>Almost ready</h2>
    <p>This app is not connected to its database yet. Open <b>config.js</b> and paste in your Supabase project URL and key, as described in <b>SETUP.md</b> step 3.</p>
  </div></div>`;
  return;
}

const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

async function rpc(fn, args = {}) {
  const { data, error, status } = await sb.rpc(fn, args).abortSignal(timeLimit());
  if (error) { error.status = status; throw error; }
  return data;
}

// Worth trying again later rather than giving up: no internet, the database briefly down,
// or the login not renewed yet (Supabase sends such requests as "not logged in").
const canRetry = e => isNetworkError(e) || (e && e.status >= 500)
  || /jwt|permission denied for function|could not find the function/i.test(String((e && e.message) || ''));
async function loggedIn() {
  try { const { data } = await sb.auth.getSession(); return !!data.session; } catch (e) { return false; }
}

/* ---------------- state ---------------- */
const S = {
  user: null, profile: null, gen: 0, channel: null, live: false, liveLost: false, timers: {},
  justLoggedIn: false, loginMsg: '',
  view: 'home',
  // What the screens show: the database's rows (base) plus what's still waiting to be sent (outbox).
  products: [], customers: [], users: [], activity: [], sales: [], debts: [], payments: [], stockins: [],
  base: {}, outbox: [], failed: [], offline: false, savedAt: null,
  loaded: {},
  ui: { salesPeriod: 'today', salesQ: '', prodQ: '', actWho: '', actKind: '', stockQ: '' },
};
const isOwner = () => !!S.profile && S.profile.role === 'owner';
const productById = id => S.products.find(p => p.id === id);

function logEvent(kind, message) {
  return rpc('log_event', { p_kind: kind, p_message: message }).catch(e => console.warn('log failed', e));
}

/* ---------------- data loading ---------------- */
async function fetchAll(make) {
  const size = 1000; let from = 0, out = [];
  for (;;) {
    const { data, error } = await make().range(from, from + size - 1).abortSignal(timeLimit());
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < size) return out;
    from += size;
  }
}
async function fetchSome(q) { const { data, error } = await q.abortSignal(timeLimit()); if (error) throw error; return data || []; }

const LOADERS = {
  products: () => fetchAll(() => sb.from('products').select('*').eq('archived', false).order('name')),
  customers: () => fetchAll(() => sb.from('customers').select('id,name,phone').order('name')),
  users: () => fetchSome(sb.from('profiles').select('*').order('created_at')),
  activity: () => fetchSome(sb.from('activity').select('*').order('id', { ascending: false }).limit(300)),
  sales: () => fetchAll(() => sb.from('sales').select('*').gte('created_at', daysAgo(DAYS).toISOString()).order('created_at', { ascending: false })),
  debts: () => fetchAll(() => sb.from('sales').select('*').eq('status', 'ok').gt('balance', 0).order('created_at', { ascending: false })),
  payments: () => fetchAll(() => sb.from('payments').select('*').gte('created_at', daysAgo(DAYS).toISOString()).order('created_at', { ascending: false })),
  stockins: () => fetchSome(sb.from('stock_ins').select('*').order('created_at', { ascending: false }).limit(300)),
};
const LABEL = { products: 'products', customers: 'customers', users: 'staff', activity: 'activity', sales: 'sales', debts: 'unpaid invoices', payments: 'payments', stockins: 'stock received' };
const keysForRole = () => isOwner()
  ? ['products', 'customers', 'users', 'activity', 'sales', 'debts', 'payments', 'stockins']
  : ['products', 'customers', 'sales', 'debts', 'stockins'];

async function load(key) {
  if (!S.user || !LOADERS[key]) return;
  const gen = S.gen;
  try {
    if (!(await loggedIn())) throw new Error('jwt not renewed yet');
    const rows = await LOADERS[key]();
    if (gen !== S.gen) return;
    S.base[key] = rows; S.loaded[key] = true; S.savedAt = new Date().toISOString();
    saveCacheSoon();
    setOffline(false);
    showChanges();
  } catch (e) {
    if (gen !== S.gen) return;
    // The screens keep what was saved on this device; the bar at the top says so.
    if (canRetry(e)) return setOffline(true);
    console.error(key, e);
    toast(`Could not load ${LABEL[key] || key}. ${friendlyError(e)}`, 'bad');
  }
}
function reloadSoon(...keys) {
  keys.forEach(k => { clearTimeout(S.timers[k]); S.timers[k] = setTimeout(() => load(k), 250); });
}
async function reloadAll() {
  if (!S.user) return;
  if (!isOwner()) {
    // make sure this login is still switched on
    const { data } = await sb.from('profiles').select('active').eq('id', S.user.id).maybeSingle().abortSignal(timeLimit());
    if (data && data.active === false) return forceOut('This account has been switched off. Ask the owner.');
  }
  reloadSoon(...keysForRole());
}

/* ---------------- working without internet ----------------
   Sales, stock received and payments are first written to this device (the outbox),
   then sent in order. Without internet they wait there and go out once it's back.
   Each one carries an id picked here, so if an answer gets lost and it is sent again,
   the database still saves it once. The last data loaded is kept on this device too,
   so the screens open without internet. */
const outboxKey = () => 'outbox:' + S.user.id;
const cacheKey = id => 'cache:' + id;
const RPC_FOR = { sale: 'create_sale', stock: 'receive_stock', payment: 'record_payment' };

function openOutbox() {
  const o = readJSON(outboxKey()) || {};
  S.outbox = o.waiting || []; S.failed = o.failed || [];
}
function storeOutbox() { writeJSON(outboxKey(), { waiting: S.outbox, failed: S.failed }); }
// Another window of the app on this device changed the outbox. Nothing is dropped:
// sending something twice is harmless, losing it is not.
window.addEventListener('storage', e => {
  if (!S.user || e.key !== outboxKey()) return;
  const o = readJSON(e.key) || {};
  const add = (mine, theirs) => mine.concat((theirs || []).filter(t => !mine.some(m => m.id === t.id)));
  S.outbox = add(S.outbox, o.waiting); S.failed = add(S.failed, o.failed);
  showChanges(); syncNow();
});

function writeCache() {
  S.timers.cache = null;
  if (S.user) writeJSON(cacheKey(S.user.id), { profile: S.profile, base: S.base, savedAt: S.savedAt });
}
// Several loads usually finish together, so the copy is written once they're done...
function saveCacheSoon() {
  clearTimeout(S.timers.cache);
  S.timers.cache = setTimeout(writeCache, 500);
}
// ...or straight away if the app is closed or reloaded before that.
window.addEventListener('pagehide', () => { if (S.timers.cache) { clearTimeout(S.timers.cache); writeCache(); } });

// Saves a sale, stock received or a payment. Resolves with { data } once the database has it,
// or { waiting: true } when it's kept on this device for later. Throws when the database
// refused it (e.g. not enough stock), so the form can say why.
async function save(kind, args, view) {
  const id = crypto.randomUUID(), madeAt = new Date().toISOString();
  const tryNow = !S.offline && navigator.onLine !== false;
  // offline: sent later as "made offline", so the database accepts what already happened (see create_sale)
  const item = { id, kind, args, madeAt, offline: !tryNow, view: { ...view, id, created_at: madeAt, pending: true } };
  S.outbox.push(item); storeOutbox(); showChanges();
  if (tryNow) {
    await syncNow();
    // A send that was just finishing when this was added doesn't pick it up; start another.
    if (S.outbox.includes(item) && !S.offline) await syncNow();
  } else syncNow();
  const refused = S.failed.find(f => f.id === id);
  if (refused) {
    S.failed = S.failed.filter(f => f !== refused); storeOutbox(); showChanges();
    throw new Error(refused.error);
  }
  if (!S.outbox.includes(item)) return { data: item.result, id };
  item.offline = true; storeOutbox(); showChanges();
  return { waiting: true, id };
}

let syncing = null;
function syncNow() {
  if (!syncing) syncing = sendWaiting().finally(() => { syncing = null; });
  return syncing;
}
async function sendWaiting() {
  const gen = S.gen;
  let answered = 0; // saved or refused: either way the database has moved on, so reload after
  while (S.user && S.outbox.length && gen === S.gen) {
    const item = S.outbox[0];
    try {
      if (!(await loggedIn())) throw new Error('jwt not renewed yet');
      item.result = await rpc(RPC_FOR[item.kind], { ...item.args, p_client_id: item.id, ...(item.offline ? { p_made_at: item.madeAt } : {}) });
    } catch (e) {
      if (gen !== S.gen) return;
      if (canRetry(e)) {
        S.dbOutdated = /could not find the function/i.test(String(e.message || ''));
        item.offline = true; storeOutbox(); setOffline(!S.dbOutdated);
        break;
      }
      S.failed.push({ ...item, error: friendlyError(e) });
    }
    answered++;
    S.outbox = S.outbox.filter(i => i !== item); storeOutbox();
    S.dbOutdated = false;
    setOffline(false);
    showChanges();
  }
  if (answered) reloadSoon(...keysForRole());
}

function setOffline(v) {
  if (S.offline === v) return;
  S.offline = v;
  updateSyncBar();
  if (!v && S.outbox.length) syncNow();
}
window.addEventListener('online', () => { if (S.user) { reloadAll(); syncNow(); } });
window.addEventListener('offline', () => { if (S.user) setOffline(true); });
// Keep checking whether the internet is back.
setInterval(() => {
  if (!S.user) return;
  if (S.offline) reloadAll();
  if (S.outbox.length) syncNow();
}, 20000);

const waiting = kind => S.outbox.filter(i => i.kind === kind).map(i => i.view);
function withWaitingPayments(s) {
  const extra = sum(waiting('payment').filter(p => p.sale_id === s.id), p => p.amount);
  return extra ? { ...s, amount_paid: n0(s.amount_paid) + extra, balance: Math.max(0, n0(s.balance) - extra) } : s;
}
// The screens show the database's rows plus what's still waiting, so a sale made offline is
// already in the lists and its goods are already out of the stock count.
function recompute() {
  const b = k => S.base[k] || [];
  // Sent already but still listed here (the answer got lost): the database's row wins.
  const savedSales = new Set(b('sales').map(r => r.id)), savedStock = new Set(b('stockins').map(r => r.id));
  const sales = waiting('sale').filter(s => !savedSales.has(s.id)).reverse();
  const stock = waiting('stock').filter(r => !savedStock.has(r.id)).reverse();
  const change = new Map();
  const add = (id, n) => change.set(id, (change.get(id) || 0) + n);
  sales.forEach(s => s.items.forEach(l => add(l.product_id, -l.qty)));
  stock.forEach(r => add(r.product_id, r.qty));
  S.products = b('products').map(p => change.has(p.id) ? { ...p, qty: Math.max(0, n0(p.qty) + change.get(p.id)) } : p);
  S.sales = [...sales, ...b('sales')].map(withWaitingPayments);
  S.debts = [...sales, ...b('debts')].map(withWaitingPayments).filter(s => n0(s.balance) > 0);
  S.stockins = [...stock, ...b('stockins')];
  const firstPays = sales.filter(s => n0(s.amount_paid) > 0)
    .map(s => ({ id: s.id, sale_id: s.id, amount: s.amount_paid, method: s.method === 'credit' ? 'cash' : s.method, created_at: s.created_at, pending: true }));
  S.payments = [...waiting('payment').reverse(), ...firstPays, ...b('payments')];
  S.customers = b('customers'); S.users = b('users'); S.activity = b('activity');
}
function showChanges() { recompute(); refresh(); updateSyncBar(); }

function updateSyncBar() {
  const bar = $('#syncbar'); if (!bar) return;
  const n = S.outbox.filter(i => i.offline).length, f = S.failed.length;
  let html = '';
  if (f) html = `<span>${plural(f, 'change')} could not be saved.</span><button class="btn" data-do="failed">See what happened</button>`;
  else if (S.dbOutdated) html = `<span>${plural(n, 'change')} waiting. The database needs updating first: in Supabase, run the latest supabase-setup.sql (SETUP.md, step 2).</span>`;
  else if (n && S.offline) html = `<span>No internet. ${plural(n, 'change')} saved on this device will be sent when the internet is back.</span>`;
  else if (n) html = `<span>Sending ${plural(n, 'change')}…</span>`;
  else if (S.offline) html = `<span>No internet. Showing what was saved ${S.savedAt ? 'at ' + esc(fmtDT(S.savedAt)) : 'earlier'}.</span>`;
  bar.hidden = !html;
  bar.classList.toggle('bad', !!f);
  bar.innerHTML = html;
  bind(bar);
}

function failedModal() {
  if (!S.failed.length) return closeModal();
  const what = i => i.kind === 'sale' ? `Sale to ${i.view.customer_name || 'a walk-in customer'} for ${money(i.view.total)} (receipt ${shortRef(i.id)})`
    : i.kind === 'stock' ? `${plural(i.view.qty, i.view.unit)} of ${i.view.product_name} received`
    : `${money(i.view.amount)} paid on ${i.view.invoice_no || 'receipt ' + shortRef(i.view.sale_id)}`;
  const m = openModal(`${mHead('Not saved')}
  <div class="modal-b">
    <p style="margin:0">These were made without internet, but the database did not take them when they were sent, so they are <b>not in the records</b>. Tell the owner. Then try again, or remove them from this list.</p>
    <ul class="lowlist">${S.failed.map(i => `<li><div><b>${esc(what(i))}</b><div class="small muted">${esc(fmtDT(i.madeAt))} · ${esc(i.error)}</div></div>
      <div class="row" style="gap:8px;flex-wrap:nowrap"><button class="btn" data-again="${i.id}">Try again</button><button class="btn danger" data-drop="${i.id}">Remove</button></div></li>`).join('')}</ul>
  </div>
  <div class="modal-f"><button class="btn primary" data-close>Done</button></div>`);
  $$('[data-again]', m).forEach(b => b.addEventListener('click', () => {
    const i = S.failed.find(x => x.id === b.dataset.again);
    S.failed = S.failed.filter(x => x !== i);
    S.outbox.push({ ...i, error: undefined, offline: true }); storeOutbox();
    showChanges(); syncNow(); failedModal();
  }));
  $$('[data-drop]', m).forEach(b => b.addEventListener('click', () => {
    S.failed = S.failed.filter(x => x.id !== b.dataset.drop); storeOutbox();
    showChanges(); failedModal();
  }));
}

function subscribe() {
  const ch = sb.channel('warehouse-' + S.user.id);
  const watch = (table, keys, extra) => ch.on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
    if (keys.length) reloadSoon(...keys);
    if (extra) extra(payload);
  });
  watch('products', ['products']);
  watch('customers', ['customers']);
  watch('sales', ['sales', 'debts']);
  watch('stock_ins', ['stockins']);
  if (isOwner()) {
    watch('payments', ['payments']);
    watch('activity', ['activity']);
    watch('profiles', ['users']);
  } else {
    watch('profiles', [], p => { if (p.new && p.new.id === S.user.id && p.new.active === false) forceOut('This account has been switched off. Ask the owner.'); });
  }
  ch.subscribe(status => {
    const wasLive = S.live;
    S.live = status === 'SUBSCRIBED';
    if (S.live) S.everLive = true;
    if (S.live && S.liveLost) { S.liveLost = false; reloadAll(); }
    if (!S.live && wasLive) S.liveLost = true;
    updateLive();
  });
  S.channel = ch;
}
function updateLive() {
  $$('.live').forEach(el => { el.classList.toggle('off', !S.live); el.textContent = S.live ? 'Live' : S.everLive ? 'Reconnecting…' : 'Connecting…'; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.user) reloadAll(); });

/* ---------------- auth flow ---------------- */
sb.auth.onAuthStateChange((event, session) => {
  // run outside the auth callback (recommended by Supabase to avoid lockups)
  setTimeout(() => handleAuth(event, session), 0);
});

async function handleAuth(event, session) {
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
  if (!session) {
    // Opened without internet after the login expired. Supabase keeps the login saved and
    // renews it once the internet is back, so carry on with what's saved on this device.
    const saved = event === 'INITIAL_SESSION' && readJSON(sb.auth.storageKey);
    const cached = saved && saved.user && readJSON(cacheKey(saved.user.id));
    if (cached) { teardown(); return start(saved.user, cached.profile, cached); }
    teardown(); S.user = null; S.profile = null;
    const msg = S.loginMsg; S.loginMsg = '';
    return showLogin(msg);
  }
  if (S.user && S.user.id === session.user.id) return; // already inside
  teardown();
  await enter(session.user);
}

async function enter(user) {
  const gen = S.gen;
  const cached = readJSON(cacheKey(user.id));
  // With a copy saved on this device, open straight away (a bad connection can take a while
  // to fail) and check the account in the background.
  if (cached) start(user, cached.profile, cached);
  const { data: prof, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle().abortSignal(timeLimit());
  // Supabase can report the same login twice at start-up; the newer one carries on.
  if (gen !== S.gen) return;
  if (error && canRetry(error)) {
    if (cached) return;
    app.innerHTML = `<div class="auth"><div class="auth-card"><h2>No internet</h2><p>Could not reach the database. Check the connection.</p><button class="btn primary big block" id="retry">Try again</button></div></div>`;
    $('#retry').addEventListener('click', () => enter(user));
    return;
  }
  if (!prof) return forceOut('This login has no account in the warehouse. Ask the owner.');
  if (!prof.active) return forceOut('This account has been switched off. Ask the owner.');
  if (S.justLoggedIn) { S.justLoggedIn = false; logEvent('login', 'Logged in'); }
  if (!cached) return start(user, prof, null);
  if (JSON.stringify(prof) !== JSON.stringify(S.profile)) { S.profile = prof; saveCacheSoon(); renderShell(); }
}

function start(user, prof, cached) {
  S.user = user;
  S.profile = prof;
  S.view = isOwner() ? 'home' : 'sales';
  openOutbox();
  // Show what was saved on this device straight away; fresh rows replace it as they arrive.
  if (cached && cached.base) {
    S.base = cached.base; S.savedAt = cached.savedAt;
    Object.keys(cached.base).forEach(k => { S.loaded[k] = true; });
  }
  recompute();
  renderShell();
  subscribe();
  keysForRole().forEach(k => load(k));
  syncNow();
}

function teardown() {
  S.gen++;
  if (S.channel) { try { sb.removeChannel(S.channel); } catch (e) {} S.channel = null; }
  Object.values(S.timers).forEach(clearTimeout); S.timers = {};
  S.loaded = {}; S.live = false; S.everLive = false; S.liveLost = false;
  ['products', 'customers', 'users', 'activity', 'sales', 'debts', 'payments', 'stockins'].forEach(k => S[k] = []);
  S.base = {}; S.outbox = []; S.failed = []; S.offline = false; S.dbOutdated = false; S.savedAt = null;
  closeModal();
}

function forceOut(msg) {
  S.loginMsg = msg;
  S.user = null;
  return sb.auth.signOut({ scope: 'local' }).catch(() => { teardown(); showLogin(msg); });
}

function logout() {
  // What's waiting is sent with this login, so it has to stay logged in until then.
  if (S.outbox.length) return toast(`${plural(S.outbox.length, 'change')} not sent yet. Stay logged in until the internet is back and they have been sent.`, 'bad');
  if (S.failed.length) return toast('Some changes were not saved. Tap “See what happened” at the top first.', 'bad');
  if (!S.offline) return signOut();
  const m = openModal(`${mHead('Log out?')}
  <div class="modal-b"><p style="margin:0">There is no internet. After logging out, nobody can log in on this device until the internet is back.</p></div>
  <div class="modal-f"><button class="btn" data-close>Stay logged in</button><button class="btn primary" id="lo-yes">Log out</button></div>`);
  $('#lo-yes', m).addEventListener('click', () => { closeModal(); signOut(); });
}
async function signOut() {
  const uid = S.user.id;
  if (!S.offline) await logEvent('logout', 'Logged out');
  clearTimeout(S.timers.cache); S.timers.cache = null;
  writeKey(cacheKey(uid), '');   // this device may be shared; don't leave the records on it
  await sb.auth.signOut({ scope: 'local' });
}

async function showLogin(message = '') {
  app.innerHTML = '<div class="boot">Loading…</div>';
  let ownerExists = true;
  try { ownerExists = await rpc('owner_exists'); }
  catch (e) {
    const why = friendlyError(e);
    const notSetUp = /needs updating|key in config\.js/.test(why);
    app.innerHTML = `<div class="auth"><div class="auth-card"><h2>${notSetUp ? 'One setup step left' : 'Cannot reach the database'}</h2>
      <p>${esc(why)}</p>${notSetUp ? '' : '<p class="muted small">If this keeps happening, the Supabase project may be paused. See SETUP.md, “If the app stops loading”.</p>'}
      <button class="btn primary big block" id="retry">Try again</button></div></div>`;
    $('#retry').addEventListener('click', () => showLogin(message));
    return;
  }
  const brand = `<div class="auth-brand"><img src="icon.svg" alt=""><div class="name">${esc(CFG.businessName || 'Warehouse')}</div><div class="sub">Warehouse Manager</div></div>`;

  if (!ownerExists) {
    app.innerHTML = `<div class="auth"><div style="width:100%;max-width:420px">${brand}
      <form class="auth-card" id="setupForm" autocomplete="off">
        <div><h2>Create the owner account</h2><p class="muted small">Do this once. This account controls prices, stock and staff.</p></div>
        <label class="field"><span>Owner's full name</span><input id="su-name" required placeholder="e.g. Mrs. Adebayo"></label>
        <label class="field"><span>Username</span><input id="su-user" required placeholder="e.g. mummy" autocapitalize="none"><small>Letters and numbers only. Used to log in.</small></label>
        <label class="field"><span>Password</span><input id="su-pw" type="password" required minlength="6"></label>
        <label class="field"><span>Type password again</span><input id="su-pw2" type="password" required minlength="6"></label>
        <div class="err" id="su-err"></div>
        <button class="btn primary big block" type="submit">Create owner account</button>
      </form></div></div>`;
    $('#setupForm').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#su-err'), btn = e.submitter;
      const name = $('#su-name').value.trim(), username = cleanUser($('#su-user').value), pw = $('#su-pw').value;
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return err.textContent = 'Username must be 3 to 30 letters or numbers, with no spaces.';
      if (pw !== $('#su-pw2').value) return err.textContent = 'The two passwords are different.';
      btn.disabled = true; err.textContent = '';
      try {
        await rpc('setup_owner', { p_name: name, p_username: username, p_password: pw });
        const { error } = await sb.auth.signInWithPassword({ email: toEmail(username), password: pw });
        if (error) throw error;
        toast('Owner account created. Welcome!', 'good');
      } catch (ex) {
        const nice = friendlyError(ex), raw = String((ex && ex.message) || '');
        err.textContent = raw && raw !== nice ? `${nice} (Database said: ${raw})` : nice;
        btn.disabled = false;
      }
    });
    return;
  }

  app.innerHTML = `<div class="auth"><div style="width:100%;max-width:420px">${brand}
    <form class="auth-card" id="loginForm">
      <h2>Log in</h2>
      <label class="field"><span>Username</span><input id="li-user" required autocapitalize="none" autocomplete="username"></label>
      <label class="field"><span>Password</span><input id="li-pw" type="password" required autocomplete="current-password"></label>
      <div class="err" id="li-err">${esc(message)}</div>
      <button class="btn primary big block" type="submit">Log in</button>
      <p class="muted small" style="margin:0">Forgot your password? Ask the owner to set a new one for you.</p>
    </form></div></div>`;
  $('#li-user').focus();
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; $('#li-err').textContent = '';
    S.justLoggedIn = true;
    const { error } = await sb.auth.signInWithPassword({ email: toEmail($('#li-user').value), password: $('#li-pw').value });
    if (error) { S.justLoggedIn = false; $('#li-err').textContent = friendlyError(error); btn.disabled = false; }
  });
}

/* ---------------- shell & navigation ---------------- */
function navItems() {
  return isOwner()
    ? [['home', 'Home', 'home'], ['sales', 'Sales', 'sale'], ['products', 'Products & prices', 'tag'], ['stock', 'Stock received', 'truck'], ['staff', 'Staff', 'users'], ['activity', 'Activity', 'pulse']]
    : [['sales', 'My sales', 'sale'], ['products', 'Products & prices', 'tag'], ['stock', 'Stock received', 'truck']];
}
function tabItems() {
  return isOwner()
    ? [['home', 'Home', 'home'], ['sales', 'Sales', 'sale'], ['products', 'Prices', 'tag'], ['stock', 'Stock', 'truck'], ['more', 'More', 'more']]
    : [['sales', 'Sales', 'sale'], ['products', 'Prices', 'tag'], ['stock', 'Stock', 'truck'], ['more', 'Me', 'person']];
}

function renderShell() {
  const p = S.profile;
  app.innerHTML = `
  <div class="shell">
    <aside class="rail">
      <div class="brand"><img src="icon.svg" alt=""><b>${esc(CFG.businessName || 'Warehouse')}</b></div>
      ${navItems().map(([v, l, i]) => `<button class="navbtn" data-nav="${v}">${icon(i)}<span>${l}</span></button>`).join('')}
      <div class="spacer"></div>
      <div class="who">
        <div class="nm">${esc(p.name)}</div>
        <div class="row" style="gap:6px"><span class="tag ${tagClass(p.staff_code)}">${esc(p.staff_code)}</span><span class="small" style="opacity:.75">@${esc(p.username)}</span></div>
        <div class="acts">${canPrint() ? '<button data-act="printer">Receipt printer</button>' : ''}<button data-act="pw">Change password</button><button data-act="logout">Log out</button></div>
      </div>
    </aside>
    <header class="topbar">
      <div class="brand"><img src="icon.svg" alt=""><span>${esc(CFG.businessName || 'Warehouse')}</span></div>
      <span class="tag" style="color:#fff;border-color:rgba(255,255,255,.5)">${esc(p.staff_code)}</span>
    </header>
    <main class="main"><div id="syncbar" class="syncbar" role="status" hidden></div><div class="main-in" id="main"></div></main>
    <nav class="tabbar">${tabItems().map(([v, l, i]) => `<button data-nav="${v}">${icon(i)}<span>${l}</span></button>`).join('')}</nav>
  </div>`;
  $$('[data-nav]').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));
  $$('[data-act="logout"]').forEach(b => b.addEventListener('click', logout));
  $$('[data-act="pw"]').forEach(b => b.addEventListener('click', changePasswordModal));
  $$('[data-act="printer"]').forEach(b => b.addEventListener('click', () => printerModal()));
  go(S.view);
  updateSyncBar();
}

function go(view) {
  if (['home', 'staff', 'activity'].includes(view) && !isOwner()) view = 'sales';
  S.view = view;
  $$('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === view));
  render();
  window.scrollTo(0, 0);
}

function refresh() { if ($('#main')) render(true); }

function render(keepFocus = false) {
  const main = $('#main'); if (!main) return;
  const active = keepFocus ? document.activeElement : null;
  const aid = active && main.contains(active) ? active.id : null;
  let caret = null;
  try { caret = aid && active.selectionStart != null ? active.selectionStart : null; } catch (e) {}
  const views = { home: viewHome, sales: viewSales, products: viewProducts, stock: viewStock, staff: viewStaff, activity: viewActivity, more: viewMore };
  main.innerHTML = (views[S.view] || viewSales)();
  bind(main);
  updateLive();
  if (aid) { const el = document.getElementById(aid); if (el) { el.focus(); if (caret != null) try { el.setSelectionRange(caret, caret); } catch (e) {} } }
}

const loading = keys => keys.some(k => !S.loaded[k]);
const loadingBox = '<div class="panel"><div class="empty">Loading…</div></div>';

function bind(root) {
  $$('[data-do]', root).forEach(el => el.addEventListener('click', e => { e.stopPropagation(); actions[el.dataset.do](el.dataset.id, el); }));
  $$('[data-set]', root).forEach(el => {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { S.ui[el.dataset.set] = el.value; render(true); });
  });
}

const actions = {
  newSale: () => saleModal(),
  receive: id => stockModal(id),
  addProduct: () => productModal(),
  editProduct: id => productModal(id),
  editPrice: id => priceModal(id),
  openSale: id => invoiceModal(id),
  addStaff: () => staffModal(),
  toggleStaff: id => toggleStaff(id),
  resetPw: id => resetPasswordModal(id),
  period: v => { S.ui.salesPeriod = v; render(); },
  go: v => go(v),
  pw: () => changePasswordModal(),
  printer: () => printerModal(),
  logout: () => logout(),
  failed: () => failedModal(),
};

/* ---------------- numbers ---------------- */
const sum = (arr, f) => arr.reduce((a, x) => a + n0(f(x)), 0);
const salesSince = d => S.sales.filter(s => (toDate(s.created_at) || 0) >= d);
const okSales = arr => arr.filter(s => !isVoid(s));
const receivedSince = d => sum(S.payments.filter(p => (toDate(p.created_at) || 0) >= d), p => p.amount);
// "Running low" is worked out from sales: a product is low when what's left would
// last less than a week at the pace of the last 7 days. Only the owner sees all sales.
function stockOutlook() {
  const sold = new Map();
  okSales(salesSince(daysAgo(6))).forEach(s => (s.items || []).forEach(i => sold.set(i.product_id, (sold.get(i.product_id) || 0) + n0(i.qty))));
  return new Map(S.products.map(p => {
    const week = sold.get(p.id) || 0;
    const daysLeft = n0(p.qty) <= 0 ? 0 : week > 0 ? n0(p.qty) / (week / 7) : Infinity;
    return [p.id, { p, daysLeft, low: isOwner() && daysLeft < 7 }];
  }));
}
const lowStock = () => [...stockOutlook().values()].filter(o => o.low).sort((a, b) => a.daysLeft - b.daysLeft);
const daysText = d => d < 1 ? 'less than a day' : `about ${plural(Math.round(d), 'day')}`;

/* ---------------- views ---------------- */
function pageHead(title, sub, buttons = '') {
  return `<div class="head"><div><h1>${title}</h1>${sub ? `<div class="muted">${sub}</div>` : ''}</div><div class="row">${buttons}</div></div>`;
}
const btnNewSale = `<button class="btn primary big" data-do="newSale">${icon('plus')}New sale</button>`;
const btnReceive = `<button class="btn big" data-do="receive">${icon('truck')}Receive stock</button>`;

function viewHome() {
  if (loading(['products', 'sales', 'activity', 'debts', 'payments'])) return pageHead('Today', '') + loadingBox;
  const today = startOfDay();
  const tSales = okSales(salesSince(today));
  const owed = sum(S.debts, s => s.balance);
  const stockValue = sum(S.products, p => n0(p.qty) * n0(p.price));
  const low = lowStock();
  const dateStr = new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' });

  const byStaff = new Map();
  tSales.forEach(s => {
    const r = byStaff.get(s.sold_by) || { name: s.sold_by_name, code: s.sold_by_code, n: 0, total: 0 };
    r.n++; r.total += n0(s.total); byStaff.set(s.sold_by, r);
  });

  const best = new Map();
  okSales(salesSince(daysAgo(6))).forEach(s => (s.items || []).forEach(i => {
    const r = best.get(i.product_id) || { name: i.name, unit: i.unit, qty: 0, total: 0 };
    r.qty += n0(i.qty); r.total += n0(i.total); best.set(i.product_id, r);
  }));
  const bestArr = [...best.values()].sort((a, b) => b.total - a.total).slice(0, 5);
  const bestMax = bestArr.length ? bestArr[0].total || 1 : 1;

  return `
  ${pageHead('Today', esc(dateStr), btnNewSale + btnReceive)}
  <div class="tiles">
    <div class="tile hero"><div class="lbl">Sales today</div><div class="val">${money(sum(tSales, s => s.total))}</div><div class="sub">${plural(tSales.length, 'sale')}</div></div>
    <div class="tile"><div class="lbl">Money received today</div><div class="val">${money(receivedSince(today))}</div><div class="sub">Cash, transfer and POS</div></div>
    <div class="tile"><div class="lbl">Customers owe</div><div class="val" style="color:${owed > 0 ? 'var(--warn)' : 'inherit'}">${money(owed)}</div><div class="sub">${plural(S.debts.length, 'unpaid invoice')}</div></div>
    <div class="tile"><div class="lbl">Stock value</div><div class="val">${money(stockValue)}</div><div class="sub">At current selling prices</div></div>
  </div>
  <div class="cols">
    <div class="stack">
      <div class="panel">
        <div class="panel-h"><h3>Running low</h3><span class="pill ${low.length ? 'bad' : 'good'}">${low.length ? low.length + ' to restock' : 'All stocked'}</span></div>
        ${low.length ? `<ul class="lowlist">${low.map(({ p, daysLeft }) => `<li><div><b>${esc(p.name)}</b><div class="small ${n0(p.qty) <= 0 ? 'bad' : 'muted'}">${n0(p.qty) <= 0 ? 'Out of stock' : `<span class="num">${plural(p.qty, p.unit)}</span> left · ${daysText(daysLeft)}`}</div></div><button class="btn" data-do="receive" data-id="${p.id}">Add stock</button></li>`).join('')}</ul>`
          : '<div class="empty">Nothing is running low.</div>'}
        <div class="small muted" style="padding:0 16px 12px">Worked out from the last 7 days of sales.</div>
      </div>
      <div class="panel">
        <div class="panel-h"><h3>Sales by staff today</h3></div>
        ${byStaff.size ? `<div class="tbl-wrap"><table><thead><tr><th>Staff</th><th class="r">Sales</th><th class="r">Amount</th></tr></thead><tbody>
          ${[...byStaff.values()].sort((a, b) => b.total - a.total).map(r => `<tr><td>${esc(r.name)} <span class="tag ${tagClass(r.code)}">${esc(r.code)}</span></td><td class="r num">${r.n}</td><td class="r num">${money(r.total)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No sales yet today.</div>'}
      </div>
      <div class="panel">
        <div class="panel-h"><h3>Best sellers · last 7 days</h3></div>
        ${bestArr.length ? `<div style="padding:12px 16px;display:grid;gap:12px">${bestArr.map(b => `
          <div style="display:grid;gap:5px">
            <div class="row" style="justify-content:space-between"><span><b>${esc(b.name)}</b> <span class="muted small">${plural(b.qty, b.unit || 'unit')}</span></span><span class="num">${money(b.total)}</span></div>
            <div style="height:8px;background:var(--surface-2);border-radius:4px"><div style="height:100%;width:${Math.max(3, b.total / bestMax * 100)}%;background:var(--accent);border-radius:4px"></div></div>
          </div>`).join('')}</div>` : '<div class="empty">No sales in the last 7 days.</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>What's happening</h3><span class="live">Live</span></div>
      ${feed(S.activity.slice(0, 20))}
      <div style="padding:10px 16px"><button class="btn block" data-do="go" data-id="activity">See all activity</button></div>
    </div>
  </div>`;
}

function feedIcon(kind) {
  if (kind === 'sale' || kind === 'payment') return ['sale', 'cash'];
  if (kind === 'stock' || kind === 'adjust') return ['stock', 'truck'];
  if (kind === 'price' || kind === 'product') return ['price', 'tag'];
  if (kind === 'staff') return ['alert', 'users'];
  return ['', 'person'];
}
function feed(rows) {
  if (!rows.length) return '<div class="empty">No activity yet.</div>';
  return `<ul class="feed">${rows.map(a => {
    const [cls, ic] = feedIcon(a.kind);
    return `<li><div class="ic ${cls}">${icon(ic)}</div>
      <div class="t"><div><b>${esc(a.user_name)}</b> <span class="tag ${tagClass(a.user_code)}">${esc(a.user_code)}</span></div><div class="d">${esc(a.message)}</div></div>
      <time title="${esc(fmtDT(a.created_at))}">${esc(ago(a.created_at))}</time></li>`;
  }).join('')}</ul>`;
}

const PERIODS = [['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['owing', 'Owing']];
const periodStart = p => ({ today: startOfDay(), week: daysAgo(6), month: daysAgo(29) }[p] || startOfDay());

function viewSales() {
  if (loading(['sales', 'debts'])) return pageHead(isOwner() ? 'Sales' : 'My sales', '', btnNewSale) + loadingBox;
  const p = S.ui.salesPeriod;
  const q = S.ui.salesQ.trim().toLowerCase();
  let rows = p === 'owing' ? S.debts : salesSince(periodStart(p));
  if (q) rows = rows.filter(s => [s.invoice_no, shortRef(s.id), s.customer_name, s.customer_phone, s.sold_by_name, s.sold_by_code, ...(s.items || []).map(i => i.name)].join(' ').toLowerCase().includes(q));
  const valid = okSales(rows);
  return `
  ${pageHead(isOwner() ? 'Sales' : 'My sales', isOwner() ? 'Every sale by everyone' : 'Sales you recorded', btnNewSale)}
  <div class="filters">
    <div class="seg">${PERIODS.map(([v, l]) => `<button class="${p === v ? 'on' : ''}" data-do="period" data-id="${v}">${l}</button>`).join('')}</div>
    <input type="search" id="salesQ" data-set="salesQ" placeholder="Search invoice, customer, product…" value="${esc(S.ui.salesQ)}">
  </div>
  <div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
    <div class="tile"><div class="lbl">Invoices</div><div class="val">${valid.length}</div></div>
    <div class="tile"><div class="lbl">Total sold</div><div class="val">${money(sum(valid, s => s.total))}</div></div>
    <div class="tile"><div class="lbl">Paid</div><div class="val">${money(sum(valid, s => s.amount_paid))}</div></div>
    <div class="tile"><div class="lbl">Still owed</div><div class="val">${money(sum(valid, s => s.balance))}</div></div>
  </div>
  <div class="panel">
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th class="hide-sm">Items</th>${isOwner() ? '<th class="hide-sm">By</th>' : ''}<th class="r">Total</th><th class="hide-sm">Status</th></tr></thead><tbody>
    ${rows.map(s => `<tr class="click ${isVoid(s) ? 'void' : ''}" data-do="openSale" data-id="${s.id}">
      <td style="white-space:nowrap"><b class="num">${esc(s.invoice_no || shortRef(s.id))}</b><div class="small muted">${esc(fmtDT(s.created_at))}</div></td>
      <td>${esc(s.customer_name || 'Walk-in')}${isOwner() ? `<div class="show-sm"><span class="tag ${tagClass(s.sold_by_code)}">${esc(s.sold_by_code)}</span></div>` : ''}</td>
      <td class="small hide-sm">${(s.items || []).map(i => `${qty(i.qty)} × ${esc(i.name)}`).join(', ')}</td>
      ${isOwner() ? `<td class="hide-sm"><span class="tag ${tagClass(s.sold_by_code)}">${esc(s.sold_by_code)}</span></td>` : ''}
      <td class="r"><b class="num money">${money(s.total)}</b><div class="show-sm">${statusPill(s)}</div></td>
      <td class="hide-sm">${statusPill(s)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">${p === 'owing' ? 'Nobody owes money. ' : 'No sales in this period. '}${q ? 'Try a different search.' : ''}</div>`}
  </div>`;
}
const notSentPill = '<span class="pill info">Not sent yet</span>';
function statusPill(s) {
  if (s.pending) return notSentPill;
  if (isVoid(s)) return '<span class="pill muted">Cancelled</span>';
  if (n0(s.balance) <= 0) return '<span class="pill good">Paid</span>';
  return `<span class="pill ${n0(s.amount_paid) > 0 ? 'warn' : 'bad'}">Owes ${money(s.balance)}</span>`;
}

function viewProducts() {
  if (loading(['products'])) return pageHead('Products & prices', '') + loadingBox;
  const q = S.ui.prodQ.trim().toLowerCase();
  const rows = S.products.filter(p => !q || (p.name + ' ' + p.unit).toLowerCase().includes(q));
  const owner = isOwner();
  return `
  ${pageHead('Products & prices', owner ? 'Tap “Change price” to update a price. Staff see it straight away.' : 'Current prices, set by the owner',
    owner ? `<button class="btn primary big" data-do="addProduct">${icon('plus')}Add product</button>` : '')}
  ${S.products.length > 6 ? `<div class="filters"><input type="search" id="prodQ" data-set="prodQ" placeholder="Search products…" value="${esc(S.ui.prodQ)}"></div>` : ''}
  ${rows.length ? `<div class="plist">${(outlook => rows.map(p => {
    const o = outlook.get(p.id);
    const status = n0(p.qty) <= 0 ? '<span class="pill bad">Out of stock</span>' : o && o.low ? '<span class="pill warn">Running low</span>' : '<span class="pill good">In stock</span>';
    return `<div class="pcard">
      <div class="top"><div class="nm">${esc(p.name)}</div>${status}</div>
      <div class="price">${money(p.price)} <small>per ${esc(p.unit)}</small></div>
      <div class="stockline"><span><b class="num">${qty(p.qty)}</b> ${esc(plural(p.qty, p.unit).replace(/^\S+ /, ''))} in stock</span>${owner ? `<button class="linkbtn" data-do="editProduct" data-id="${p.id}">Edit</button>` : ''}</div>
      ${owner ? `<div class="acts"><button class="btn primary" data-do="editPrice" data-id="${p.id}">Change price</button><button class="btn" data-do="receive" data-id="${p.id}">Add stock</button></div>`
              : `<div class="acts"><button class="btn" data-do="receive" data-id="${p.id}">${icon('truck')}Add stock</button></div>`}
    </div>`;
  }).join(''))(stockOutlook())}</div>` : `<div class="panel"><div class="empty">${S.products.length ? 'No product matches your search.' : owner ? 'No products yet. Tap “Add product” to add your first one, for example “Table water 75cl”.' : 'The owner has not added any products yet.'}</div></div>`}`;
}

function viewStock() {
  if (loading(['stockins', 'products'])) return pageHead('Stock received', '', btnReceive) + loadingBox;
  const q = S.ui.stockQ.trim().toLowerCase();
  const rows = S.stockins.filter(r => !q || [r.product_name, r.supplier, r.received_by_name, r.note].join(' ').toLowerCase().includes(q));
  return `
  ${pageHead('Stock received', isOwner() ? 'Every delivery, recorded by anyone' : 'Deliveries you recorded', btnReceive)}
  ${S.stockins.length > 6 ? `<div class="filters"><input type="search" id="stockQ" data-set="stockQ" placeholder="Search product, supplier…" value="${esc(S.ui.stockQ)}"></div>` : ''}
  <div class="panel">
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="r">Quantity</th><th class="hide-sm">Supplier</th>${isOwner() ? '<th class="r hide-sm">Cost</th><th>By</th>' : ''}<th class="hide-sm">Note</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><b>${esc(r.product_name)}</b>${r.pending ? ' ' + notSentPill : ''}<div class="small muted">${esc(fmtDT(r.created_at))}${r.supplier ? `<span class="show-sm"> · ${esc(r.supplier)}</span>` : ''}</div></td>
      <td class="r num" style="white-space:nowrap">${plural(r.qty, r.unit)}</td><td class="hide-sm">${esc(r.supplier || '—')}</td>
      ${isOwner() ? `<td class="r num hide-sm">${r.cost_per_unit != null ? money(n0(r.cost_per_unit) * n0(r.qty)) : '—'}</td><td><span class="tag ${tagClass(r.received_by_code)}">${esc(r.received_by_code)}</span></td>` : ''}
      <td class="small muted hide-sm">${esc(r.note || '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No stock received yet. Tap “Receive stock” when a delivery arrives.</div>'}
  </div>`;
}

function viewStaff() {
  if (loading(['users', 'sales', 'activity'])) return pageHead('Staff', '') + loadingBox;
  const list = [...S.users].sort((a, b) => a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : String(a.staff_code).localeCompare(String(b.staff_code)));
  const today = startOfDay();
  return `
  ${pageHead('Staff', 'Each staff member gets their own login. Switch a login off when someone leaves.', `<button class="btn primary big" data-do="addStaff">${icon('plus')}Add staff</button>`)}
  <div class="plist">${list.map(u => {
    const tSales = okSales(S.sales.filter(s => s.sold_by === u.id && (toDate(s.created_at) || 0) >= today));
    const last = S.activity.find(a => a.user_id === u.id);
    const staff = u.role !== 'owner';
    return `<div class="pcard">
      <div class="top"><div><div class="nm">${esc(u.name)}</div><div class="unit">@${esc(u.username)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></div>
        <span class="tag ${tagClass(u.staff_code)}">${esc(u.staff_code)}</span></div>
      <div class="facts"><div>Sales today<b>${money(sum(tSales, s => s.total))}</b></div><div>Last active<b style="font-size:14px">${last ? esc(ago(last.created_at)) : '—'}</b></div></div>
      <div class="row" style="justify-content:space-between">
        ${!staff ? '<span class="pill warn">Owner</span>' : u.active ? '<span class="pill good">Can log in</span>' : '<span class="pill bad">Switched off</span>'}
      </div>
      ${staff ? `<div class="acts"><button class="btn" data-do="resetPw" data-id="${u.id}">${icon('key')}New password</button><button class="btn ${u.active ? 'danger' : ''}" data-do="toggleStaff" data-id="${u.id}">${u.active ? 'Switch off' : 'Switch on'}</button></div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function viewActivity() {
  if (loading(['activity', 'users'])) return pageHead('Activity', '') + loadingBox;
  const who = S.ui.actWho, kind = S.ui.actKind;
  const groups = { sale: ['sale', 'payment'], stock: ['stock', 'adjust'], price: ['price', 'product'], staff: ['staff'], login: ['login'] };
  const rows = S.activity.filter(a => (!who || a.user_id === who) && (!kind || (groups[kind] || []).includes(a.kind)));
  return `
  ${pageHead('Activity', 'Everything everyone does, as it happens', '<span class="live">Live</span>')}
  <div class="filters">
    <select id="actWho" data-set="actWho"><option value="">Everyone</option>${S.users.map(u => `<option value="${u.id}" ${who === u.id ? 'selected' : ''}>${esc(u.name)} (${esc(u.staff_code)})</option>`).join('')}</select>
    <select id="actKind" data-set="actKind">${[['', 'All actions'], ['sale', 'Sales & payments'], ['stock', 'Stock'], ['price', 'Prices & products'], ['staff', 'Staff changes'], ['login', 'Logins']].map(([v, l]) => `<option value="${v}" ${kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  </div>
  <div class="panel">${feed(rows)}</div>`;
}

function viewMore() {
  const p = S.profile;
  const item = (act, id, ic, label, sub) => `<button class="btn block" style="justify-content:flex-start;min-height:62px;text-align:left" data-do="${act}" data-id="${id}">${icon(ic)}<span style="display:grid"><span>${label}</span>${sub ? `<span class="small muted" style="font-weight:500">${sub}</span>` : ''}</span></button>`;
  return `
  ${pageHead(esc(p.name), `<span class="tag ${tagClass(p.staff_code)}">${esc(p.staff_code)}</span> @${esc(p.username)}`)}
  <div class="stack" style="max-width:520px">
    ${isOwner() ? item('go', 'staff', 'users', 'Staff', 'Add staff, new passwords, switch logins on or off') + item('go', 'activity', 'pulse', 'Activity', 'Everything staff are doing') : ''}
    ${canPrint() ? item('printer', '', 'print', 'Receipt printer', 'Print receipts on a receipt printer') : ''}
    ${item('pw', '', 'key', 'Change my password')}
    ${item('logout', '', 'out', 'Log out')}
  </div>`;
}

/* ---------------- modals ---------------- */
function openModal(html, { wide = false, focus = null } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const m = $('.modal', root);
  $$('[data-close]', m).forEach(b => b.addEventListener('click', closeModal));
  const first = (focus && $(focus, m)) || $('input:not([readonly]),select,textarea', m);
  if (first) { first.focus(); if (focus && first.select) try { first.select(); } catch (e) {} }
  return m;
}
function closeModal() { const r = $('#modal-root'); if (r) r.innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
const mHead = t => `<div class="modal-h"><h2>${t}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>`;
const busy = (btn, on, text) => { if (!btn) return; btn.disabled = on; if (text) btn.textContent = text; };

/* ----- Product (owner) ----- */
function productModal(id) {
  const p = id ? productById(id) : null;
  const m = openModal(`${mHead(p ? 'Edit product' : 'Add product')}
  <form id="pf"><div class="modal-b">
    <label class="field"><span>Product name</span><input id="pf-name" required value="${esc(p?.name)}" placeholder="e.g. Table water 75cl"></label>
    <div class="grid2">
      <label class="field"><span>Sold per</span><input id="pf-unit" required list="units" value="${esc(p?.unit || 'carton')}"><datalist id="units">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist></label>
      <label class="field"><span id="pf-pl">Price (${CUR})</span><input id="pf-price" type="number" min="0" step="any" inputmode="decimal" required value="${p ? n0(p.price) : ''}"></label>
    </div>
    ${p ? `<label class="field"><span>Stock count</span><input id="pf-qty" type="text" inputmode="decimal" autocomplete="off" required value="${esc(qty(p.qty))}"><small>Only change this to fix a wrong count. For new goods, use “Add stock”.</small></label>
    <label class="field" id="pf-why-w" hidden><span>Why did the count change?</span><input id="pf-why" placeholder="e.g. 3 cartons damaged"></label>` : ''}
    <div class="err" id="pf-err"></div>
  </div>
  <div class="modal-f">${p ? '<button type="button" class="btn danger" id="pf-del" style="margin-right:auto">Remove product</button>' : ''}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${p ? 'Save changes' : 'Add product'}</button></div></form>`);

  const unitEl = $('#pf-unit', m);
  const setPriceLabel = () => { $('#pf-pl', m).textContent = `Price per ${unitEl.value.trim().toLowerCase() || 'unit'} (${CUR})`; };
  unitEl.addEventListener('input', setPriceLabel); setPriceLabel();
  const startQty = p ? n0(p.qty) : 0;
  if (p) $('#pf-qty', m).addEventListener('input', e => { $('#pf-why-w', m).hidden = parseQty(e.target.value) === startQty; });

  $('#pf', m).addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter, err = $('#pf-err', m);
    const name = $('#pf-name', m).value.trim();
    const args = { p_id: p ? p.id : null, p_name: name, p_unit: unitEl.value, p_price: n0($('#pf-price', m).value) };
    if (p) {
      const newQty = parseQty($('#pf-qty', m).value);
      if (!(newQty >= 0)) return err.textContent = `Check the stock count. ${QTY_HELP}`;
      if (newQty !== startQty) { args.p_qty = newQty; args.p_reason = $('#pf-why', m).value || null; }
    }
    busy(btn, true); err.textContent = '';
    try {
      await rpc('save_product', args);
      reloadSoon('products', 'activity');
      closeModal(); toast(p ? 'Saved' : `${name} added. Tap “Add stock” when the goods arrive.`, 'good');
    } catch (ex) { err.textContent = friendlyError(ex); busy(btn, false); }
  });

  if (p) $('#pf-del', m).addEventListener('click', () => {
    const f = $('.modal-f', m);
    f.innerHTML = `<span style="margin-right:auto;font-weight:600">Remove ${esc(p.name)} from the list? Past sales stay on record.</span><button type="button" class="btn" id="pf-no">Keep it</button><button type="button" class="btn primary" style="background:var(--bad);border-color:var(--bad)" id="pf-yes">Yes, remove</button>`;
    $('#pf-no', m).addEventListener('click', () => productModal(id));
    $('#pf-yes', m).addEventListener('click', async ev => {
      busy(ev.currentTarget, true);
      try { await rpc('archive_product', { p_id: p.id }); reloadSoon('products', 'activity'); closeModal(); toast('Product removed'); }
      catch (ex) { toast(friendlyError(ex), 'bad'); busy(ev.currentTarget, false); }
    });
  });
}

/* ----- Quick price change (owner) ----- */
function priceModal(id) {
  const p = productById(id); if (!p) return;
  const m = openModal(`${mHead('Change price')}
  <form id="prf"><div class="modal-b">
    <div><div style="font-weight:700;font-size:20px">${esc(p.name)}</div><div class="muted">Current price: <span class="num">${money(p.price)}</span> per ${esc(p.unit)}</div></div>
    <label class="field"><span>New price per ${esc(p.unit)} (${CUR})</span><input id="prf-price" type="number" min="0" step="any" inputmode="decimal" required value="${n0(p.price)}" style="font-size:26px;min-height:62px" class="num"></label>
    <div class="err" id="prf-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary big" type="submit">Save new price</button></div></form>`, { focus: '#prf-price' });
  const inp = $('#prf-price', m);
  $('#prf', m).addEventListener('submit', async e => {
    e.preventDefault();
    const price = n0(inp.value);
    if (price === n0(p.price)) return closeModal();
    busy(e.submitter, true);
    try {
      await rpc('set_price', { p_id: p.id, p_price: price });
      reloadSoon('products', 'activity');
      closeModal(); toast(`${p.name} is now ${money(price)} per ${p.unit}`, 'good');
    } catch (ex) { $('#prf-err', m).textContent = friendlyError(ex); busy(e.submitter, false); }
  });
}

/* ----- Receive stock ----- */
function stockModal(presetId) {
  if (!S.products.length) return toast(isOwner() ? 'Add a product first.' : 'The owner has not added any products yet.', 'bad');
  const m = openModal(`${mHead('Receive stock')}
  <form id="sf"><div class="modal-b">
    <label class="field"><span>Product</span><select id="sf-p" required>${S.products.map(p => `<option value="${p.id}" ${p.id === presetId ? 'selected' : ''}>${esc(p.name)} (${qty(p.qty)} in stock)</option>`).join('')}</select></label>
    <div class="grid2">
      <label class="field"><span id="sf-ql">Quantity received</span><input id="sf-q" type="text" inputmode="decimal" autocomplete="off" required placeholder="e.g. 20 or 2 1/2"></label>
      <label class="field"><span>Cost per unit (${CUR}) · optional</span><input id="sf-c" type="number" min="0" step="any" inputmode="decimal"></label>
    </div>
    <label class="field"><span>Supplier · optional</span><input id="sf-s" placeholder="e.g. Eva Water depot"></label>
    <label class="field"><span>Note · optional</span><input id="sf-n" placeholder="e.g. Waybill no. 2231"></label>
    <div class="err" id="sf-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary big" type="submit">Add to stock</button></div></form>`, { focus: presetId ? '#sf-q' : null });
  const sel = $('#sf-p', m);
  const setLabel = () => { const p = productById(sel.value); $('#sf-ql', m).textContent = `Quantity received (${p ? plural(2, p.unit).replace(/^2 /, '') : 'units'})`; };
  sel.addEventListener('change', setLabel); setLabel();

  $('#sf', m).addEventListener('submit', async e => {
    e.preventDefault();
    const p = productById(sel.value), q = parseQty($('#sf-q', m).value);
    if (!p || !(q > 0)) return $('#sf-err', m).textContent = `Enter how many came in. ${QTY_HELP}`;
    const costRaw = $('#sf-c', m).value.trim();
    const args = { p_product: p.id, p_qty: q, p_cost: costRaw === '' ? null : n0(costRaw), p_supplier: $('#sf-s', m).value.trim() || null, p_note: $('#sf-n', m).value.trim() || null };
    const view = { product_id: p.id, product_name: p.name, unit: p.unit, qty: q, cost_per_unit: args.p_cost, supplier: args.p_supplier, note: args.p_note,
      received_by: S.user.id, received_by_name: S.profile.name, received_by_code: S.profile.staff_code };
    busy(e.submitter, true);
    try {
      const res = await save('stock', args, view);
      closeModal();
      if (res.waiting) return toast(`No internet. ${plural(q, p.unit)} of ${p.name} saved on this device. It will be sent when the internet is back.`);
      reloadSoon('products', 'stockins', 'activity');
      toast(`Added ${plural(q, p.unit)} of ${p.name}`, 'good');
    } catch (ex) { $('#sf-err', m).textContent = friendlyError(ex); busy(e.submitter, false); }
  });
}

/* ----- New sale ----- */
function saleModal() {
  const avail = S.products.filter(p => n0(p.qty) > 0);
  if (!avail.length) return toast(S.products.length ? 'Everything is out of stock. Receive stock first.' : 'No products yet.', 'bad');
  const m = openModal(`${mHead('New sale')}
  <form id="nf" autocomplete="off"><div class="modal-b">
    <div class="grid2">
      <label class="field"><span>Customer name</span><input id="nf-c" list="custlist" placeholder="e.g. Iya Bose Stores"><datalist id="custlist">${S.customers.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
      <label class="field"><span>Phone · optional</span><input id="nf-ph" type="tel" inputmode="tel" placeholder="0803 000 0000"></label>
    </div>
    <div class="field"><span>Items</span><div class="lines" id="nf-lines"></div>
      <button type="button" class="btn" id="nf-add" style="justify-self:start">${icon('plus')}Add another item</button></div>
    <div class="grid2">
      <label class="field"><span>Payment</span><select id="nf-m">${['cash', 'transfer', 'pos', 'credit'].map(k => `<option value="${k}">${METHODS[k]}</option>`).join('')}</select></label>
      <label class="field"><span>Amount paid now (${CUR})</span><input id="nf-paid" type="number" min="0" step="any" inputmode="decimal" class="num"></label>
    </div>
    <label class="field"><span>Note · optional</span><input id="nf-note" placeholder="e.g. Deliver to Ikeja tomorrow"></label>
    <div class="summary"><div><span>Total</span><span class="num tot" id="nf-tot">${money(0)}</span></div><div><span>Paid now</span><span class="num" id="nf-pd">${money(0)}</span></div><div><span>Balance owed</span><span class="num" id="nf-bal">${money(0)}</span></div></div>
    <div class="err" id="nf-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary big" type="submit" id="nf-save">Save sale</button></div></form>`, { wide: true });

  const linesEl = $('#nf-lines', m);
  let paidTouched = false;
  const opts = sel => avail.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} · ${money(p.price)}/${esc(p.unit)}</option>`).join('');

  // fill in a saved customer's phone
  $('#nf-c', m).addEventListener('change', e => {
    const c = S.customers.find(x => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
    if (c && c.phone && !$('#nf-ph', m).value) $('#nf-ph', m).value = c.phone;
  });

  function addLine() {
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = `
      <label class="field pcol"><span>Product</span><select class="l-p">${opts(avail[0].id)}</select></label>
      <label class="field"><span class="l-ql">Quantity</span><input class="l-q num" type="text" inputmode="decimal" autocomplete="off" placeholder="e.g. 2 or 1/2"></label>
      <label class="field"><span>Price each (${CUR})</span><input class="l-pr num" type="number" min="0" step="any" inputmode="decimal"></label>
      <button type="button" class="btn ghost rm" aria-label="Remove item">${icon('x')}</button>
      <div class="info"></div>`;
    linesEl.appendChild(div);
    const sel = $('.l-p', div);
    const setProduct = () => {
      const p = productById(sel.value);
      $('.l-pr', div).value = n0(p.price);
      $('.l-q', div).value = '';
      $('.l-ql', div).textContent = `Quantity (${plural(2, p.unit).replace(/^2 /, '')})`;
      update();
    };
    sel.addEventListener('change', setProduct);
    $('.l-q', div).addEventListener('input', update);
    $('.l-pr', div).addEventListener('input', update);
    $('.rm', div).addEventListener('click', () => { if (linesEl.children.length > 1) { div.remove(); update(); } });
    setProduct();
  }

  const readLines = () => $$('.line', linesEl).map(div => {
    const p = productById($('.l-p', div).value);
    const typed = $('.l-q', div).value.trim(), q = parseQty(typed);
    const price = n0($('.l-pr', div).value);
    const ok = q > 0;
    return { div, p, qty: ok ? q : 0, bad: typed !== '' && !ok, price, total: ok ? lineTotal(q, price) : 0 };
  });

  function update() {
    const lines = readLines();
    const want = new Map();
    lines.forEach(l => want.set(l.p.id, (want.get(l.p.id) || 0) + l.qty));
    lines.forEach(l => {
      const msgs = [];
      if (l.bad) msgs.push(`<span class="bad">Use a whole number or quarters, like 2, 1/2 or 1¼</span>`);
      if (want.get(l.p.id) > n0(l.p.qty)) msgs.push(`<span class="bad">Not enough stock</span>`);
      msgs.push(`<span>In stock: ${qty(l.p.qty)}</span>`, `<span>Line total: <b class="num">${money(l.total)}</b></span>`);
      if (l.price !== n0(l.p.price)) msgs.push(`<span class="pill warn">Special price (list ${money(l.p.price)})</span>`);
      $('.info', l.div).innerHTML = msgs.join('');
    });
    const total = lines.reduce((a, l) => a + l.total, 0);
    const paidEl = $('#nf-paid', m);
    if (!paidTouched) paidEl.value = $('#nf-m', m).value === 'credit' ? 0 : total;
    const paid = Math.min(Math.max(0, n0(paidEl.value)), total);
    $('#nf-tot', m).textContent = money(total);
    $('#nf-pd', m).textContent = money(paid);
    $('#nf-bal', m).textContent = money(total - paid);
  }

  $('#nf-add', m).addEventListener('click', addLine);
  $('#nf-m', m).addEventListener('change', () => { paidTouched = false; update(); });
  $('#nf-paid', m).addEventListener('input', () => { paidTouched = true; update(); });
  addLine();

  $('#nf', m).addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#nf-err', m); err.textContent = '';
    const lines = readLines();
    if (lines.some(l => l.bad)) return err.textContent = QTY_HELP;
    const raw = lines.filter(l => l.qty > 0);
    if (!raw.length) return err.textContent = 'Add at least one item with a quantity.';
    const merged = [];
    raw.forEach(l => {
      const ex = merged.find(x => x.p.id === l.p.id && x.price === l.price);
      if (ex) ex.qty += l.qty; else merged.push({ p: l.p, qty: l.qty, price: l.price });
    });
    const total = merged.reduce((a, l) => a + lineTotal(l.qty, l.price), 0);
    const paid = Math.min(Math.max(0, n0($('#nf-paid', m).value)), total);
    const name = $('#nf-c', m).value.trim();
    if (paid < total && !name) return err.textContent = 'This customer still owes money. Enter their name so you can follow up.';
    // Checked here too, because a sale made without internet can't be checked by the database first.
    const want = new Map();
    merged.forEach(l => want.set(l.p.id, (want.get(l.p.id) || 0) + l.qty));
    const short = merged.find(l => want.get(l.p.id) > n0(l.p.qty));
    if (short) return err.textContent = `Only ${plural(short.p.qty, short.p.unit)} of ${short.p.name} left in stock.`;

    const phone = $('#nf-ph', m).value.trim() || null, note = $('#nf-note', m).value.trim() || null, method = $('#nf-m', m).value;
    // Owner and staff can both change an item's price; the database notes it for the owner.
    const args = { p_items: merged.map(l => ({ product_id: l.p.id, qty: l.qty, price: l.price })), p_method: method, p_amount_paid: paid,
      p_customer_name: name || null, p_customer_phone: phone, p_note: note };
    const view = {
      invoice_no: null, customer_name: name || null, customer_phone: phone, method, note, status: 'ok',
      items: merged.map(l => ({ product_id: l.p.id, name: l.p.name, unit: l.p.unit, qty: l.qty, price: l.price, list_price: n0(l.p.price), total: lineTotal(l.qty, l.price) })),
      total, amount_paid: paid, balance: total - paid, sold_by: S.user.id, sold_by_name: S.profile.name, sold_by_code: S.profile.staff_code,
    };

    const btn = $('#nf-save', m); busy(btn, true, 'Saving…');
    try {
      const res = await save('sale', args, view);
      if (res.waiting) {
        toast('No internet. The sale is saved on this device and will be sent when the internet is back.');
        return invoiceModal(res.id);
      }
      reloadSoon('products', 'sales', 'debts', 'payments', 'activity', 'customers');
      toast(`Sale saved · ${res.data.invoice_no}`, 'good');
      invoiceModal(res.data.id);
    } catch (ex) { err.textContent = friendlyError(ex); busy(btn, false, 'Save sale'); }
  });
}

/* ----- Invoice / receipt ----- */
function waPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 11) d = '234' + d.slice(1);
  return d.length >= 10 ? d : '';
}
function invoiceText(s) {
  const lines = [
    `*${CFG.businessName || 'Warehouse'}*`,
    `${s.invoice_no ? 'Invoice ' + s.invoice_no : 'Receipt ' + shortRef(s.id)} · ${fmtD(s.created_at)}`,
    `Customer: ${s.customer_name || 'Walk-in customer'}`, '',
    ...(s.items || []).map(i => `${plural(i.qty, i.unit)} ${i.name} × ${money(i.price)} = ${money(i.total)}`), '',
    `Total: ${money(s.total)}`, `Paid: ${money(s.amount_paid)}`,
  ];
  if (isVoid(s)) lines.push('THIS SALE WAS CANCELLED');
  else if (n0(s.balance) > 0) lines.push(`Balance: ${money(s.balance)}`);
  lines.push('', 'Thank you for your business.');
  return lines.join('\n');
}

async function invoiceModal(id) {
  // What's on this device first; a fresh copy from the database when there's internet.
  let s = S.sales.find(x => x.id === id) || S.debts.find(x => x.id === id);
  let pays = S.payments.filter(p => p.sale_id === id);
  if (!s || !s.pending) {
    const r = await sb.from('sales').select('*').eq('id', id).maybeSingle().abortSignal(timeLimit());
    if (r.error && !canRetry(r.error)) return toast(friendlyError(r.error), 'bad');
    if (r.data) {
      s = withWaitingPayments(r.data);
      if (isOwner()) {
        const p = await sb.from('payments').select('*').eq('sale_id', id).order('created_at').abortSignal(timeLimit());
        if (!p.error) pays = [...(p.data || []), ...waiting('payment').filter(x => x.sale_id === id)];
      }
    }
  }
  if (!s) return toast('Could not open that sale. No internet connection.', 'bad');
  if (!isOwner()) pays = [];
  const ref = s.invoice_no || 'Receipt ' + shortRef(s.id);
  const wa = `https://wa.me/${waPhone(s.customer_phone)}?text=${encodeURIComponent(invoiceText(s))}`;
  const canChange = isOwner() && !isVoid(s);
  const m = openModal(`${mHead((s.invoice_no ? 'Invoice ' : '') + esc(ref))}
  <div class="modal-b">
    ${isVoid(s) ? `<div class="pill bad" style="justify-self:start;font-size:14px">Cancelled: ${esc(s.void_reason || '')}</div>` : ''}
    ${s.pending ? '<p class="muted" style="margin:0">Saved on this device. It will be sent when the internet is back, and then gets its invoice number.</p>' : ''}
    <div class="invoice">
      <div class="ih">
        <div><div class="biz">${esc(CFG.businessName || 'Warehouse')}</div><div class="small">${esc(CFG.businessAddress || '')}${CFG.businessPhone ? '<br>' + esc(CFG.businessPhone) : ''}</div></div>
        <div class="meta"><div class="no">${esc(ref)}</div><div>${esc(fmtDT(s.created_at))}</div><div>Served by ${esc(s.sold_by_name)} (${esc(s.sold_by_code)})</div></div>
      </div>
      <div><div class="small" style="color:#555;text-transform:uppercase;letter-spacing:.06em;font-weight:700">Bill to</div><div style="font-weight:700">${esc(s.customer_name || 'Walk-in customer')}</div>${s.customer_phone ? `<div>${esc(s.customer_phone)}</div>` : ''}</div>
      <div class="tbl-wrap"><table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>
        ${(s.items || []).map(i => `<tr><td>${esc(i.name)}</td><td class="r num">${plural(i.qty, i.unit)}</td><td class="r num">${money(i.price)}</td><td class="r num">${money(i.total)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="tots">
        <div class="g"><span>Total</span><span class="num">${money(s.total)}</span></div>
        <div><span>Paid</span><span class="num">${money(s.amount_paid)}</span></div>
        <div style="font-weight:700"><span>Balance</span><span class="num">${money(s.balance)}</span></div>
      </div>
      ${pays.length ? `<div class="foot"><b>Payments:</b> ${pays.map(p => `${money(p.amount)} ${esc(METHODS[p.method] || p.method)} on ${esc(fmtD(p.created_at))}`).join(' · ')}</div>` : ''}
      ${s.note ? `<div class="foot"><b>Note:</b> ${esc(s.note)}</div>` : ''}
      <div class="foot">Thank you for your business.</div>
    </div>
  </div>
  <div class="modal-f">
    ${canChange && !s.pending ? `<button class="btn danger" id="iv-void" style="margin-right:auto">Cancel sale</button>` : ''}
    ${canChange && n0(s.balance) > 0 ? `<button class="btn" id="iv-pay">${icon('cash')}Record payment</button>` : ''}
    <a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">${icon('chat')}WhatsApp</a>
    <button class="btn" id="iv-print">${icon('print')}Print receipt</button>
    <button class="btn primary" data-close>Done</button>
  </div>`, { wide: true });
  $('#iv-print', m).addEventListener('click', e => usesPrinter() ? printReceipt(saleReceipt(s, pays), e.currentTarget) : printInBrowser(saleReceipt(s, pays)));
  const pay = $('#iv-pay', m); if (pay) pay.addEventListener('click', () => paymentModal(s));
  const vd = $('#iv-void', m); if (vd) vd.addEventListener('click', () => voidModal(s));
}

/* ----- Receipt printer (XP-Q200 or another ESC/POS printer) ----- */
// In the Windows app (desktop/) receipts go through the Windows print queue, so the printer
// keeps its normal driver. In Chrome or Edge they go straight to the printer over WebUSB,
// which on Windows only works once the driver has been swapped for WinUSB (SETUP.md, step 9).
// Either way the receipt is sent as a picture, because the printer's built-in fonts have no ₦ sign.
const desktop = window.desktop || null; // added by desktop/preload.js
const PRINTER_NAME_KEY = 'receiptPrinterName'; // Windows app: the Windows printer to use
const PRINTER_KEY = 'receiptPrinter'; // browser: '1' once a USB printer is connected on this computer
const PAPER_DOTS = 576; // printable width of 80mm paper at 203 dpi
const USB_PRINTER_CLASS = 7;
const hasUsb = () => !!navigator.usb;
const canPrint = () => !!desktop || hasUsb();
const printerName = () => readKey(PRINTER_NAME_KEY);
function usesPrinter() { return desktop ? !!printerName() : hasUsb() && readKey(PRINTER_KEY) === '1'; }

const isPrinter = d => d.configurations.some(c => c.interfaces.some(i => i.alternates.some(a => a.interfaceClass === USB_PRINTER_CLASS)));
// getDevices() only lists printers this site was allowed to use that are plugged in right now
async function findPrinter() { return (await navigator.usb.getDevices()).find(isPrinter) || null; }

// The Windows app's errors arrive wrapped, e.g. "Error invoking remote method 'print': Error: printer-missing".
function printerError(e) {
  const msg = String((e && e.message) || e || '');
  if (desktop && /printer-missing/.test(msg)) return 'The receipt printer is not installed on this computer any more. Open Receipt printer and pick it again.';
  if (/printer-missing/.test(msg) || (e && e.name === 'NotFoundError')) return 'The receipt printer is not connected. Check it is switched on and its USB cable is plugged in.';
  if (/printer-refused/.test(msg)) return 'Windows would not take the receipt. Open Receipt printer and check the right printer is picked.';
  if ((e && e.name === 'SecurityError') || /access denied/i.test(msg)) return "Windows is still using the printer's own driver, so the app can't reach the printer. Do the one-time printer setup in SETUP.md (step 9), then try again.";
  if (/claim/i.test(msg)) return 'The printer is busy. Close any other window that has this app open, then try again.';
  if (/printer-stuck/.test(msg)) return 'The printer is not taking the receipt. Check it has paper and the lid is shut, then try again.';
  return 'Could not print. Switch the printer off and on again, then try again.';
}

// One job at a time, so two quick taps can't mix two receipts together.
let printQueue = Promise.resolve();
function sendToPrinter(bytes) {
  const job = printQueue.then(() => writeToPrinter(bytes));
  printQueue = job.catch(() => {});
  return job;
}
async function writeToPrinter(bytes) {
  if (desktop) return desktop.print(printerName(), bytes);
  const dev = await findPrinter();
  if (!dev) throw new Error('printer-missing');
  await dev.open();
  try {
    if (!dev.configuration) await dev.selectConfiguration(1);
    const { iface, ep } = bulkOut(dev);
    await dev.claimInterface(iface);
    for (let i = 0; i < bytes.length; i += 16384) {
      // A printer out of paper stops accepting data and the transfer never finishes on its own.
      const res = await withinTime(dev.transferOut(ep, bytes.subarray(i, i + 16384)), 15000);
      if (res.status !== 'ok') throw new Error('printer-stuck');
    }
  } finally {
    // close() also cancels a stuck transfer and frees the printer for other windows
    await dev.close().catch(() => {});
  }
}
function bulkOut(dev) {
  for (const i of dev.configuration.interfaces) for (const a of i.alternates) {
    const ep = a.interfaceClass === USB_PRINTER_CLASS && a.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
    if (ep) return { iface: i.interfaceNumber, ep: ep.endpointNumber };
  }
  throw new Error('printer-unknown');
}
function withinTime(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error('printer-stuck')), ms); })]).finally(() => clearTimeout(timer));
}

// A receipt is a list of lines: 'rule' or { text, right, size, bold, align, invert }.
function saleReceipt(s, pays) {
  const when = toDate(s.created_at);
  const r = [
    { text: CFG.businessName || 'Warehouse', size: 40, bold: true, align: 'center' },
    CFG.businessAddress && { text: CFG.businessAddress, align: 'center' },
    CFG.businessPhone && { text: CFG.businessPhone, align: 'center' },
    'rule',
    { text: s.invoice_no || 'Receipt ' + shortRef(s.id), size: 30, bold: true },
    when && { text: when.toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) },
    { text: `Served by ${s.sold_by_name} (${s.sold_by_code})` },
    { text: `Customer: ${s.customer_name || 'Walk-in customer'}` },
    s.customer_phone && { text: s.customer_phone },
    'rule',
    ...(s.items || []).flatMap(i => [{ text: i.name, bold: true }, { text: `${plural(i.qty, i.unit)} × ${money(i.price)}`, right: money(i.total) }]),
    'rule',
    { text: 'Total', right: money(s.total), size: 32, bold: true },
    { text: 'Paid', right: money(s.amount_paid) },
    { text: 'Balance', right: money(s.balance), bold: true },
  ];
  if (isVoid(s)) r.push('rule', { text: 'CANCELLED', size: 32, bold: true, align: 'center', invert: true }, s.void_reason && { text: s.void_reason, align: 'center' });
  if (pays.length) r.push('rule', { text: 'Payments', bold: true }, ...pays.map(p => ({ text: `${fmtD(p.created_at)} · ${METHODS[p.method] || p.method}`, right: money(p.amount) })));
  if (s.note) r.push('rule', { text: `Note: ${s.note}` });
  r.push('rule', { text: 'Thank you for your business.', align: 'center' });
  return r.filter(Boolean);
}
const testReceipt = () => [
  { text: CFG.businessName || 'Warehouse', size: 40, bold: true, align: 'center' },
  'rule',
  { text: 'Test print', size: 30, bold: true, align: 'center' },
  { text: 'The receipt printer is working.', align: 'center' },
  { text: new Date().toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }), align: 'center' },
];

const receiptFont = (size, bold) => `${bold ? 700 : 600} ${size}px Barlow, Arial, sans-serif`;
function wrapText(ctx, text, max) {
  const rows = []; let row = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = row ? row + ' ' + word : word;
    if (!row || ctx.measureText(next).width <= max) row = next; else { rows.push(row); row = word; }
  }
  return rows.concat(row);
}
// Draws the receipt and returns its height. Run once on a 1px canvas to measure, then again to draw.
function drawReceipt(ctx, lines) {
  const W = PAPER_DOTS, PAD = 8;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, ctx.canvas.height);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
  let y = 4;
  for (const l of lines) {
    if (l === 'rule') { y += 6; ctx.fillRect(PAD, y, W - PAD * 2, 2); y += 14; continue; }
    const size = l.size || 24, lh = Math.round(size * 1.3), top = Math.round((lh - size) / 2);
    ctx.font = receiptFont(size, l.bold);
    const rightW = l.right ? ctx.measureText(l.right).width + 16 : 0;
    const max = W - PAD * 2 - rightW;
    const rows = wrapText(ctx, String(l.text), max);
    if (l.invert) { ctx.fillRect(PAD, y, W - PAD * 2, rows.length * lh + 8); ctx.fillStyle = '#fff'; y += 4; }
    rows.forEach((row, n) => {
      ctx.textAlign = l.align || 'left';
      ctx.fillText(row, l.align === 'center' ? W / 2 : PAD, y + top, max);
      if (l.right && n === 0) { ctx.textAlign = 'right'; ctx.fillText(l.right, W - PAD, y + top); }
      y += lh;
    });
    if (l.invert) { ctx.fillStyle = '#000'; y += 4; }
  }
  return y + 24;
}
// The receipt as a black-and-white picture, PAPER_DOTS wide (8 dots per mm).
async function receiptCanvas(lines) {
  await Promise.all([document.fonts.load(receiptFont(24, false)), document.fonts.load(receiptFont(24, true))]);
  const canvas = document.createElement('canvas');
  canvas.width = PAPER_DOTS; canvas.height = 1;
  canvas.height = drawReceipt(canvas.getContext('2d'), lines);
  const ctx = canvas.getContext('2d');
  drawReceipt(ctx, lines);
  // Thermal paper has no grey. Slightly darker than half-grey becomes black, so the edges of letters print solid.
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data;
  for (let i = 0; i < px.length; i += 4) { px[i] = px[i + 1] = px[i + 2] = px[i] + px[i + 1] + px[i + 2] < 480 ? 0 : 255; px[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
async function receiptBytes(lines) {
  const canvas = await receiptCanvas(lines);
  const w = canvas.width, h = canvas.height, rowBytes = w / 8, BAND = 255;
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new Uint8Array(2 + Math.ceil(h / BAND) * 8 + rowBytes * h + 4);
  let o = 0;
  out.set([0x1b, 0x40], o); o += 2; // ESC @: reset the printer
  // GS v 0 sends the picture one band at a time; small printers choke on one huge image.
  for (let top = 0; top < h; top += BAND) {
    const rows = Math.min(BAND, h - top);
    out.set([0x1d, 0x76, 0x30, 0, rowBytes & 255, rowBytes >> 8, rows & 255, rows >> 8], o); o += 8;
    for (let y = top; y < top + rows; y++, o += rowBytes) {
      for (let x = 0; x < w; x++) if (px[(y * w + x) * 4] === 0) out[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  out.set([0x1d, 0x56, 0x42, 0], o); // GS V B: feed up to the cutter, then cut
  return out;
}

// No receipt printer connected: print the same picture through the print window, on one
// 80mm page exactly as long as the receipt, with nothing else from the screen on it.
async function printInBrowser(lines) {
  const canvas = await receiptCanvas(lines);
  const img = new Image();
  img.alt = '';
  img.src = canvas.toDataURL('image/png');
  await img.decode();
  const box = document.createElement('div');
  box.id = 'print-receipt';
  box.append(img);
  const page = document.createElement('style');
  page.textContent = `@page { size: 80mm ${Math.ceil(canvas.height / 8)}mm; margin: 0; }`;
  document.head.append(page);
  document.body.append(box);
  document.body.classList.add('printing-receipt');
  window.addEventListener('afterprint', () => { box.remove(); page.remove(); document.body.classList.remove('printing-receipt'); }, { once: true });
  window.print();
}

async function printReceipt(lines, btn) {
  const label = btn.innerHTML;
  busy(btn, true, 'Printing…');
  try {
    await sendToPrinter(await receiptBytes(lines));
    toast('Receipt sent to the printer', 'good');
  } catch (e) { toast(printerError(e), 'bad'); }
  btn.innerHTML = label; busy(btn, false);
}

function printerModal() { return desktop ? windowsPrinterModal() : usbPrinterModal(); }

// Windows app: pick one of the printers installed on this computer.
async function windowsPrinterModal() {
  const list = await desktop.printers();
  const chosen = printerName();
  const ready = list.some(p => p.name === chosen);
  // The likely receipt printer goes first, so it is already picked. ("XP-" but not "XPS Document Writer".)
  const likely = p => /xprinter|xp-|receipt|thermal|pos-?\d|80mm/i.test(p.name);
  const options = [...list].sort((a, b) => likely(b) - likely(a));
  const m = openModal(`${mHead('Receipt printer')}
  <div class="modal-b" id="pr-b">
    ${ready ? `<div class="row" style="gap:10px"><span class="pill good">Ready</span><b>${esc(chosen)}</b></div>
      <p class="muted" style="margin:0">Tap <b>Print receipt</b> on any sale to print it here.</p>`
    : `${chosen ? `<p style="margin:0"><b>${esc(chosen)}</b> is not on this computer any more. Pick the receipt printer again.</p>` : ''}
      ${options.length ? `<label class="field"><span>Printer</span><select id="pr-pick">${options.map(p => `<option>${esc(p.name)}</option>`).join('')}</select></label>
      <p class="muted small" style="margin:0">Not in the list? Install the driver that came with the printer, then open this again.</p>`
      : '<p style="margin:0">No printers are installed on this computer. Install the driver that came with the receipt printer, then open this again.</p>'}`}
    <div class="err" id="pr-err"></div>
  </div>
  <div class="modal-f">
    ${chosen ? '<button class="btn danger" id="pr-off" style="margin-right:auto">Stop using it</button>' : ''}
    ${ready ? `<button class="btn" id="pr-test">${icon('print')}Print test</button>` : options.length ? '<button class="btn primary" id="pr-use">Use this printer</button>' : ''}
    <button class="btn ${ready ? 'primary' : ''}" data-close>Done</button>
  </div>`);
  const use = $('#pr-use', m); if (use) use.addEventListener('click', () => {
    writeKey(PRINTER_NAME_KEY, $('#pr-pick', m).value);
    toast('Receipt printer set', 'good');
    printerModal();
  });
  const test = $('#pr-test', m); if (test) test.addEventListener('click', () => printReceipt(testReceipt(), test));
  const off = $('#pr-off', m); if (off) off.addEventListener('click', () => {
    writeKey(PRINTER_NAME_KEY, '');
    toast('This computer no longer uses the receipt printer.');
    printerModal();
  });
}

// Chrome or Edge: the printer is reached over WebUSB.
async function usbPrinterModal() {
  const on = usesPrinter();
  const dev = on ? await findPrinter() : null;
  const m = openModal(`${mHead('Receipt printer')}
  <div class="modal-b" id="pr-b">
    ${dev ? `<div class="row" style="gap:10px"><span class="pill good">Ready</span><b>${esc(dev.productName || 'USB printer')}</b></div>
      <p class="muted" style="margin:0">Tap <b>Print receipt</b> on any sale to print it here.</p>`
    : `${on ? '<span class="pill warn" style="justify-self:start">Not connected</span>' : ''}
      <p style="margin:0">Plug the receipt printer's USB cable into this computer and switch the printer on. Then tap <b>Connect printer</b> and pick it from the list.</p>`}
    <div class="err" id="pr-err"></div>
  </div>
  <div class="modal-f">
    ${on ? '<button class="btn danger" id="pr-off" style="margin-right:auto">Stop using it</button>' : ''}
    ${dev ? `<button class="btn" id="pr-test">${icon('print')}Print test</button>` : '<button class="btn primary" id="pr-add">Connect printer</button>'}
    <button class="btn ${dev ? 'primary' : ''}" data-close>Done</button>
  </div>`);
  const add = $('#pr-add', m); if (add) add.addEventListener('click', () => connectPrinter(m));
  const test = $('#pr-test', m); if (test) test.addEventListener('click', () => printReceipt(testReceipt(), test));
  const off = $('#pr-off', m); if (off) off.addEventListener('click', async () => {
    const d = await findPrinter();
    if (d && d.forget) await d.forget().catch(() => {});
    writeKey(PRINTER_KEY, '');
    toast('This computer no longer uses the receipt printer.');
    printerModal();
  });
}
async function connectPrinter(m) {
  const err = $('#pr-err', m); err.textContent = '';
  let dev;
  try { dev = await navigator.usb.requestDevice({ filters: [{ classCode: USB_PRINTER_CLASS }] }); }
  catch (e) { err.textContent = 'No printer was picked. If it is not in the list, check it is switched on and plugged in.'; return; }
  try {
    // Open it once now, so a Windows driver problem shows up here and not in the middle of a sale.
    await dev.open();
    await dev.close();
    writeKey(PRINTER_KEY, '1');
    toast('Receipt printer connected', 'good');
    printerModal();
  } catch (e) { err.textContent = printerError(e); }
}
if (hasUsb() && !desktop) ['connect', 'disconnect'].forEach(ev => navigator.usb.addEventListener(ev, () => { if ($('#pr-b')) printerModal(); }));

function paymentModal(s) {
  const m = openModal(`${mHead('Record payment')}
  <form id="pm"><div class="modal-b">
    <div><b>${esc(s.customer_name || 'Customer')}</b> owes <b class="num">${money(s.balance)}</b> on ${esc(s.invoice_no)}.</div>
    <div class="grid2">
      <label class="field"><span>Amount received (${CUR})</span><input id="pm-a" type="number" min="1" step="any" inputmode="decimal" required value="${n0(s.balance)}" class="num"></label>
      <label class="field"><span>Paid by</span><select id="pm-m">${['cash', 'transfer', 'pos'].map(k => `<option value="${k}">${METHODS[k]}</option>`).join('')}</select></label>
    </div>
    <div class="err" id="pm-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary big" type="submit">Save payment</button></div></form>`);
  $('#pm', m).addEventListener('submit', async e => {
    e.preventDefault();
    const amount = Math.min(n0($('#pm-a', m).value), n0(s.balance)), method = $('#pm-m', m).value;
    if (amount <= 0) return $('#pm-err', m).textContent = 'Enter the amount received.';
    const view = { sale_id: s.id, invoice_no: s.invoice_no, amount, method, received_by: S.user.id, received_by_name: S.profile.name };
    busy(e.submitter, true);
    try {
      const res = await save('payment', { p_sale: s.id, p_amount: amount, p_method: method }, view);
      if (res.waiting) toast('No internet. The payment is saved on this device and will be sent when the internet is back.');
      else { reloadSoon('sales', 'debts', 'payments', 'activity'); toast('Payment saved', 'good'); }
      invoiceModal(s.id);
    } catch (ex) { $('#pm-err', m).textContent = friendlyError(ex); busy(e.submitter, false); }
  });
}

function voidModal(s) {
  const m = openModal(`${mHead('Cancel sale ' + esc(s.invoice_no))}
  <form id="vm"><div class="modal-b">
    <p style="margin:0">The items go back into stock${n0(s.amount_paid) > 0 ? ` and a refund of <b class="num">${money(s.amount_paid)}</b> is recorded` : ''}. The sale stays on record, marked as cancelled.</p>
    <label class="field"><span>Why are you cancelling it?</span><input id="vm-r" required placeholder="e.g. Customer returned the goods, wrong quantity entered"></label>
    <div class="err" id="vm-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" id="vm-back">Go back</button><button class="btn primary" style="background:var(--bad);border-color:var(--bad)" type="submit">Cancel this sale</button></div></form>`);
  $('#vm-back', m).addEventListener('click', () => invoiceModal(s.id));
  $('#vm', m).addEventListener('submit', async e => {
    e.preventDefault();
    busy(e.submitter, true);
    try {
      await rpc('void_sale', { p_sale: s.id, p_reason: $('#vm-r', m).value });
      reloadSoon('products', 'sales', 'debts', 'payments', 'activity');
      toast(`${s.invoice_no} cancelled. Stock returned.`, 'good');
      invoiceModal(s.id);
    } catch (ex) { $('#vm-err', m).textContent = friendlyError(ex); busy(e.submitter, false); }
  });
}

/* ----- Staff (owner) ----- */
function credentialsCard(m, title, name, code, username, pw) {
  $('.modal-b', m).innerHTML = `<div class="stack"><span class="pill good" style="justify-self:start">${title}</span>
    <div style="font-size:18px">Give these to <b>${esc(name)}</b>:</div>
    <div class="summary">${code ? `<div><span>Staff ID</span><b class="num">${esc(code)}</b></div>` : ''}<div><span>Username</span><b class="num">${esc(username)}</b></div><div><span>Password</span><b class="num">${esc(pw)}</b></div></div>
    <div class="muted small">They can change the password after logging in.</div></div>`;
  $('.modal-f', m).innerHTML = '<button type="button" class="btn primary big" data-close>Done</button>';
  $$('[data-close]', m).forEach(b => b.addEventListener('click', closeModal));
}

function staffModal() {
  const m = openModal(`${mHead('Add staff')}
  <form id="stf" autocomplete="off"><div class="modal-b">
    <p class="muted" style="margin:0">They log in with this username and password. A staff ID like STF-001 is given automatically.</p>
    <label class="field"><span>Full name</span><input id="stf-n" required placeholder="e.g. Tunde Okafor"></label>
    <div class="grid2">
      <label class="field"><span>Username</span><input id="stf-u" required autocapitalize="none" placeholder="e.g. tunde"></label>
      <label class="field"><span>Phone · optional</span><input id="stf-ph" type="tel" inputmode="tel"></label>
    </div>
    <label class="field"><span>Password</span><input id="stf-p" required minlength="6" autocomplete="new-password"><small>At least 6 characters. You will see it again on the next screen.</small></label>
    <div class="err" id="stf-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary big" type="submit">Create login</button></div></form>`);
  $('#stf', m).addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#stf-err', m);
    const name = $('#stf-n', m).value.trim(), username = cleanUser($('#stf-u', m).value), pw = $('#stf-p', m).value;
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return err.textContent = 'Username must be 3 to 30 letters or numbers, with no spaces.';
    busy(e.submitter, true); err.textContent = '';
    try {
      const code = await rpc('create_staff', { p_name: name, p_username: username, p_password: pw, p_phone: $('#stf-ph', m).value || null });
      reloadSoon('users', 'activity');
      credentialsCard(m, 'Login created', name, code, username, pw);
    } catch (ex) { err.textContent = friendlyError(ex); busy(e.submitter, false); }
  });
}

function resetPasswordModal(id) {
  const u = S.users.find(x => x.id === id); if (!u) return;
  const m = openModal(`${mHead('New password')}
  <form id="rp" autocomplete="off"><div class="modal-b">
    <div>Set a new password for <b>${esc(u.name)}</b> <span class="tag staff">${esc(u.staff_code)}</span>. Their old password stops working.</div>
    <label class="field"><span>New password</span><input id="rp-p" required minlength="6" autocomplete="new-password"></label>
    <div class="err" id="rp-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary big" type="submit">Set password</button></div></form>`);
  $('#rp', m).addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('#rp-p', m).value;
    busy(e.submitter, true);
    try {
      await rpc('reset_staff_password', { p_user: u.id, p_password: pw });
      reloadSoon('activity');
      credentialsCard(m, 'Password changed', u.name, '', u.username, pw);
    } catch (ex) { $('#rp-err', m).textContent = friendlyError(ex); busy(e.submitter, false); }
  });
}

async function toggleStaff(id) {
  const u = S.users.find(x => x.id === id); if (!u || u.role === 'owner') return;
  try {
    await rpc('set_staff_active', { p_user: id, p_active: !u.active });
    reloadSoon('users', 'activity');
    toast(u.active ? `${u.name} can no longer log in` : `${u.name} can log in again`, 'good');
  } catch (ex) { toast(friendlyError(ex), 'bad'); }
}

/* ----- Change own password ----- */
function changePasswordModal() {
  const m = openModal(`${mHead('Change my password')}
  <form id="cp"><div class="modal-b">
    <label class="field"><span>Current password</span><input id="cp-o" type="password" required autocomplete="current-password"></label>
    <label class="field"><span>New password</span><input id="cp-n" type="password" required minlength="6" autocomplete="new-password"></label>
    <label class="field"><span>Type new password again</span><input id="cp-n2" type="password" required minlength="6" autocomplete="new-password"></label>
    <div class="err" id="cp-err"></div>
  </div>
  <div class="modal-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Change password</button></div></form>`);
  $('#cp', m).addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#cp-err', m);
    if ($('#cp-n', m).value !== $('#cp-n2', m).value) return err.textContent = 'The new passwords are different.';
    busy(e.submitter, true); err.textContent = '';
    try {
      const check = await sb.auth.signInWithPassword({ email: toEmail(S.profile.username), password: $('#cp-o', m).value });
      if (check.error) throw (check.error.code === 'invalid_credentials' ? new Error('Your current password is wrong.') : check.error);
      const { error } = await sb.auth.updateUser({ password: $('#cp-n', m).value });
      if (error) throw error;
      logEvent('password', 'Changed their password');
      closeModal(); toast('Password changed', 'good');
    } catch (ex) { err.textContent = friendlyError(ex); busy(e.submitter, false); }
  });
}

/* keep "x min ago" fresh */
setInterval(() => { if (['home', 'activity', 'staff'].includes(S.view) && S.user) refresh(); }, 60000);

})();
