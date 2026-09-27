// Manager tools: PINs and roles, the change log, menu changes made from the kitchen screen, and sales numbers.
const crypto = require('node:crypto');
const { db, getSetting, setSetting, soldOutIds } = require('./db');
const { partsIn, zonedDate } = require('./time');

db.exec(`
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, role TEXT, msg TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
`);

// ---------------- PINs ----------------
// Each role has one shared PIN. It starts from the environment (KITCHEN_PIN / MANAGER_PIN) and can be
// changed from the dashboard; changed PINs are stored hashed. Changing a PIN signs out that role's tablets.
const ROLES = ['employee', 'manager'];
const ENV_PIN = { employee: String(process.env.KITCHEN_PIN || ''), manager: String(process.env.MANAGER_PIN || '') };
const hash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function pinMatches(role, pin) {
  pin = String(pin || '');
  if (!pin) return false;
  const stored = getSetting(`pin_${role}`, null);
  if (stored) return same(hash(pin, stored.salt), stored.hash);
  return !!ENV_PIN[role] && same(pin, ENV_PIN[role]);
}
function roleForPin(pin) {
  if (pinMatches('manager', pin)) return 'manager';
  if (pinMatches('employee', pin)) return 'employee';
  return null;
}
function hasPin(role) { return !!getSetting(`pin_${role}`, null) || !!ENV_PIN[role]; }
function setPin(role, pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting(`pin_${role}`, { salt, hash: hash(pin, salt) });
  setSetting(`pinv_${role}`, pinVersion(role) + 1);
}
const pinVersion = (role) => getSetting(`pinv_${role}`, 1);

// ---------------- Change log ----------------
function log(role, msg) {
  db.prepare('INSERT INTO audit(at, role, msg) VALUES(?, ?, ?)').run(new Date().toISOString(), role || null, msg);
}
function recentLog(limit = 80) {
  return db.prepare('SELECT at, role, msg FROM audit ORDER BY id DESC LIMIT ?').all(limit);
}

// ---------------- Menu changes ----------------
// Stored as small overrides on top of data/menu.json, so later menu.json edits still apply:
//   items:   { [itemId]: { price, name, unavailable } }
//   choices: { [key]: { off, price } }   key = "<itemId>:<groupId>:<choiceId>", or "@<set>:<groupId>:<choiceId>"
//            for groups shared by many dishes (all the combos share "@combo").
const overrides = () => getSetting('menuOv', { items: {}, choices: {} });
const saveOverrides = (ov) => { setSetting('menuOv', ov); version += 1; };
let version = 1;
const choiceKey = (itemId, g, c) => (g.shared ? `@${g.shared}:${g.id}:${c.id}` : `${itemId}:${g.id}:${c.id}`);

function makeMenu(base) {
  let cache = null; let cachedAt = 0;
  // What customers see: overrides applied, switched-off choices removed.
  function effective() {
    if (cache && cachedAt === version) return cache;
    const ov = overrides();
    const m = structuredClone(base);
    for (const c of m.categories) for (const it of c.items) {
      const io = ov.items[it.id];
      if (io) {
        if (Number.isInteger(io.price)) it.price = io.price;
        if (io.name) { it.name = io.name; if (it.short) it.short = io.name; }
        if (typeof io.unavailable === 'boolean') { if (io.unavailable) it.unavailable = true; else delete it.unavailable; }
      }
      for (const g of it.options || []) {
        g.choices = g.choices.map((ch) => {
          const co = ov.choices[choiceKey(it.id, g, ch)];
          if (co && Number.isInteger(co.price)) ch.price = co.price;
          return co?.off ? null : ch;
        }).filter(Boolean);
        if (g.default != null && typeof g.default !== 'object' && !g.choices.some((ch) => ch.id === g.default)) delete g.default;
        delete g.shared;
      }
    }
    m.bestSellers = getSetting('bestSellers', base.bestSellers || []);
    const index = new Map();
    for (const c of m.categories) for (const it of c.items) index.set(it.id, { ...it, category: c.id });
    cache = { menu: m, index }; cachedAt = version;
    return cache;
  }
  // What the manager edits: every choice (including switched-off ones) with its key and state.
  function forEditor() {
    const ov = overrides(); const eff = effective().index; const so = new Set(soldOutIds());
    const best = new Set(getSetting('bestSellers', base.bestSellers || []));
    return {
      categories: base.categories.map((c) => ({
        id: c.id, name: c.name,
        items: c.items.map((it) => {
          const e = eff.get(it.id);
          return {
            id: it.id, num: it.num, name: e.name, baseName: it.name, price: e.price, basePrice: it.price,
            unavailable: !!e.unavailable, soldOut: so.has(it.id), best: best.has(it.id),
            groups: (it.options || []).map((g) => ({
              id: g.id, label: g.label, type: g.type, shared: g.shared || null,
              choices: g.choices.map((ch) => {
                const key = choiceKey(it.id, g, ch); const co = ov.choices[key] || {};
                return { key, id: ch.id, label: ch.label, price: Number.isInteger(co.price) ? co.price : ch.price || 0, basePrice: ch.price || 0, off: !!co.off };
              }),
            })),
          };
        }),
      })),
    };
  }
  function findItem(id) { for (const c of base.categories) { const it = c.items.find((x) => x.id === id); if (it) return it; } return null; }
  function findChoice(key) {
    for (const c of base.categories) for (const it of c.items) for (const g of it.options || []) for (const ch of g.choices) {
      if (choiceKey(it.id, g, ch) === key) return { item: it, group: g, choice: ch };
    }
    return null;
  }
  function setItem(id, patch) {
    const ov = overrides(); const cur = ov.items[id] || {};
    Object.assign(cur, patch);
    const it = findItem(id);
    if (cur.price === it.price) delete cur.price;
    if (cur.name === it.name || cur.name === '') delete cur.name;
    if (cur.unavailable === !!it.unavailable) delete cur.unavailable;
    if (Object.keys(cur).length) ov.items[id] = cur; else delete ov.items[id];
    saveOverrides(ov);
  }
  function setChoice(key, patch) {
    const ov = overrides(); const cur = ov.choices[key] || {};
    Object.assign(cur, patch);
    const f = findChoice(key);
    if (cur.price === (f.choice.price || 0)) delete cur.price;
    if (!cur.off) delete cur.off;
    if (Object.keys(cur).length) ov.choices[key] = cur; else delete ov.choices[key];
    saveOverrides(ov);
  }
  function setBest(id, on) {
    const list = getSetting('bestSellers', base.bestSellers || []).filter((x) => x !== id);
    if (on) list.push(id);
    setSetting('bestSellers', list); version += 1;
  }
  return { effective, forEditor, findItem, findChoice, setItem, setChoice, setBest };
}

// ---------------- Sales ----------------
const ymd = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
function startOfDay(date, tz, addDays = 0) {
  const p = partsIn(new Date(date.getTime() + addDays * 86400000), tz);
  return zonedDate(p.y, p.m, p.d, 0, 0, tz);
}
// "today" | "week" (last 7 days) | "month" (this month) -> [from, to) plus the period before it for comparison
function range(kind, now, tz) {
  now = new Date(now.getTime() + 60000); // include orders from this very minute
  const today = startOfDay(now, tz);
  if (kind === 'week') {
    const from = startOfDay(now, tz, -6);
    return { from, to: now, prevFrom: startOfDay(now, tz, -13), prevTo: from, buckets: 'day' };
  }
  if (kind === 'month') {
    const p = partsIn(now, tz);
    const from = zonedDate(p.y, p.m, 1, 0, 0, tz);
    const pm = p.m === 1 ? 12 : p.m - 1; const py = p.m === 1 ? p.y - 1 : p.y;
    const prevFrom = zonedDate(py, pm, 1, 0, 0, tz);
    return { from, to: now, prevFrom, prevTo: new Date(prevFrom.getTime() + (now - from)), buckets: 'day' };
  }
  // today, compared with the same weekday last week up to the same time
  return { from: today, to: now, prevFrom: new Date(today - 7 * 86400000), prevTo: new Date(now - 7 * 86400000), buckets: 'hour' };
}
const SOLD = "status IN ('paid','ready','done')";
function ordersBetween(from, to) {
  return db.prepare(`SELECT * FROM orders WHERE ${SOLD} AND paid_at >= ? AND paid_at < ? ORDER BY paid_at`).all(from.toISOString(), to.toISOString());
}
function sales(kind, now, tz) {
  const r = range(kind, now, tz);
  const rows = ordersBetween(r.from, r.to);
  const prev = ordersBetween(r.prevFrom, r.prevTo);
  const sum = (list, f) => list.reduce((s, o) => s + o[f], 0);
  const buckets = new Map();
  if (r.buckets === 'hour') for (let h = 10; h <= 21; h++) buckets.set(String(h), 0);
  else for (let t = r.from.getTime(); t < r.to.getTime(); t += 86400000) buckets.set(ymd(partsIn(new Date(t + 3600000), tz)), 0);
  const items = new Map(); const opts = new Map();
  for (const o of rows) {
    const p = partsIn(new Date(o.paid_at), tz);
    const k = r.buckets === 'hour' ? String(p.H) : ymd(p);
    buckets.set(k, (buckets.get(k) || 0) + (r.buckets === 'hour' ? 1 : o.total_cents));
    for (const l of JSON.parse(o.items_json)) {
      const cur = items.get(l.id) || { id: l.id, num: l.num, name: l.name, qty: 0, total: 0 };
      cur.qty += l.qty; cur.total += l.total; items.set(l.id, cur);
      for (const x of l.options || []) opts.set(x.label, (opts.get(x.label) || 0) + l.qty);
    }
  }
  const cancelled = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN refunded = 1 THEN total_cents ELSE 0 END), 0) AS refunded FROM orders WHERE status = 'cancelled' AND paid_at >= ? AND paid_at < ?")
    .get(r.from.toISOString(), r.to.toISOString());
  const lineCount = [...items.values()].reduce((s, i) => s + i.qty, 0) || 1;
  return {
    kind, from: r.from.toISOString(), to: r.to.toISOString(), bucketType: r.buckets,
    total: sum(rows, 'total_cents'), subtotal: sum(rows, 'subtotal_cents'), tax: sum(rows, 'tax_cents'), orders: rows.length,
    avg: rows.length ? Math.round(sum(rows, 'total_cents') / rows.length) : 0,
    prev: { total: sum(prev, 'total_cents'), orders: prev.length },
    buckets: [...buckets.entries()].map(([k, v]) => ({ k, v })),
    topItems: [...items.values()].sort((a, b) => b.qty - a.qty || b.total - a.total).slice(0, 10),
    topOptions: [...opts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, n]) => ({ label, n, pct: Math.round((n / lineCount) * 100) })),
    cancelled: cancelled.n, refunded: cancelled.refunded,
  };
}
function salesCsv(kind, now, tz) {
  const r = range(kind, now, tz);
  const rows = db.prepare(`SELECT * FROM orders WHERE status IN ('paid','ready','done','cancelled') AND paid_at >= ? AND paid_at < ? ORDER BY paid_at`)
    .all(r.from.toISOString(), r.to.toISOString());
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = [['Orden', 'Fecha y hora', 'Cliente', 'Teléfono', 'Artículos', 'Subtotal', 'IVU', 'Total', 'Estado', 'Reembolsado'].map(q).join(',')];
  for (const o of rows) {
    const items = JSON.parse(o.items_json).map((l) => `${l.qty}x ${l.name}${l.options?.length ? ` (${l.options.map((x) => x.label).join(', ')})` : ''}`).join(' | ');
    lines.push([o.number, fmt.format(new Date(o.paid_at)), o.customer_name, o.phone, items, (o.subtotal_cents / 100).toFixed(2),
      (o.tax_cents / 100).toFixed(2), (o.total_cents / 100).toFixed(2), { paid: 'Pagada', ready: 'Lista', done: 'Entregada', cancelled: 'Cancelada' }[o.status] || o.status, o.refunded ? 'sí' : ''].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

module.exports = { ROLES, roleForPin, hasPin, setPin, pinVersion, log, recentLog, makeMenu, sales, salesCsv, ymd };
