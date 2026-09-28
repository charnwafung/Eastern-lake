require('./src/env').load();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { db, getSetting, setSetting, soldOutIds, setSoldOut } = require('./src/db');
const { storeStatus, partsIn } = require('./src/time');
const O = require('./src/orders');
const A = require('./src/admin');
const N = require('./src/notify');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config.json'), 'utf8'));
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'menu.json'), 'utf8'));
// Items can share option groups through "optionSet" (all the combos use "combo").
// Shared groups are marked so a manager's change to them (e.g. a price) applies to every dish that uses them.
for (const [name, groups] of Object.entries(menu.optionSets || {})) for (const g of groups) g.shared = name;
for (const c of menu.categories) for (const it of c.items) {
  if (it.optionSet) {
    if (!menu.optionSets?.[it.optionSet]) throw new Error(`menu.json: unknown optionSet "${it.optionSet}" on item ${it.id}`);
    it.options = [...(it.optionsBefore || []), ...menu.optionSets[it.optionSet], ...(it.optionsAfter || [])];
    delete it.optionSet; delete it.optionsBefore; delete it.optionsAfter;
  }
}
delete menu.optionSets;
const M = A.makeMenu(menu); // menu.json + changes made by managers on the kitchen screen

const PROD = process.env.NODE_ENV === 'production';
const MOCK = process.env.MOCK_PAYMENTS === '1' && !PROD;
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!stripe && !MOCK) console.warn('⚠  STRIPE_SECRET_KEY is not set — online payment will not work.');
if (MOCK) console.warn('⚠  MOCK_PAYMENTS=1 — orders are marked paid without charging. Never use this in production.');
if (!A.hasPin('employee')) console.warn('⚠  KITCHEN_PIN is not set — employees cannot unlock the kitchen screen.');
if (!A.hasPin('manager')) console.warn('⚠  MANAGER_PIN is not set — nobody can open the manager tabs (Menú, Tienda, Ventas).');
if (!process.env.SESSION_SECRET) console.warn('⚠  SESSION_SECRET not set — kitchen logins reset whenever the server restarts.');

// DEV_NOW lets you preview open/closed behaviour locally (ignored in production).
const clock = () => (!PROD && process.env.DEV_NOW ? new Date(process.env.DEV_NOW) : new Date());
const weekHours = () => ({ ...config.hours, ...getSetting('hours', {}) });
// Closed days (holidays) that are already over are dropped automatically.
const closedDays = () => {
  const today = A.ymd(partsIn(clock(), config.timezone));
  return getSetting('closedDays', []).filter((c) => c.date >= today).sort((a, b) => a.date.localeCompare(b.date));
};
function settings() {
  let paused = getSetting('paused', false);
  const until = getSetting('pausedUntil', null);
  if (paused && until && new Date(until) <= clock()) { setSetting('paused', false); setSetting('pausedUntil', null); paused = false; }
  return {
    paused, pausedUntil: paused ? until : null,
    prepMinutes: getSetting('prepMinutes', config.defaultPrepMinutes),
  };
}
const status = () => {
  const s = settings();
  return storeStatus(config, { paused: s.paused, prepMinutes: s.prepMinutes, now: clock(), hours: weekHours(), closed: closedDays() });
};
const banner = () => { const b = getSetting('banner', { text: '', show: false }); return b.show && b.text ? b.text : ''; };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

N.setup(config, () => (process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/$/, ''));
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// ---------- Stripe webhook (needs the raw body, so it is registered before express.json) ----------
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !WEBHOOK_SECRET) return res.status(400).send('Webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Signature check failed: ${e.message}`);
  }
  const s = event.data.object;
  const orderId = s?.metadata?.order_id;
  try {
    if (orderId && (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded')) {
      if (s.payment_status === 'paid') paid(orderId, s);
    } else if (orderId && event.type === 'checkout.session.expired') {
      db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(orderId);
    }
  } catch (e) {
    console.error('Webhook handling failed', e);
    return res.status(500).send('error');
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '64kb' }));

function paid(orderId, session) {
  const before = O.getOrder(orderId);
  const o = O.markPaid(orderId, {
    email: session?.customer_details?.email,
    paymentIntent: typeof session?.payment_intent === 'string' ? session.payment_intent : session?.payment_intent?.id,
    prepMinutes: settings().prepMinutes,
    tz: config.timezone,
    now: clock(),
  });
  if (o && before?.status !== 'paid' && o.status === 'paid') {
    console.log(`✓ Order ${o.number} paid — ${o.customer_name} $${(o.total_cents / 100).toFixed(2)}`);
    if (stripe && o.payment_intent) {
      stripe.paymentIntents.update(o.payment_intent, { description: `Eastern Lake pedido ${o.number} — ${o.customer_name}` })
        .catch(() => {});
    }
    N.orderConfirmed(o); // email: "we got your order"
  }
  return o;
}

// ---------- Public API ----------
app.get('/api/menu', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    restaurant: config.restaurant, taxRate: config.taxRate, taxLabel: config.taxLabel,
    maxQty: config.maxQuantityPerLine, timezone: config.timezone,
    categories: M.effective().menu.categories, bestSellers: M.effective().menu.bestSellers, soldOut: soldOutIds(), status: status(),
    hours: weekHours(), banner: banner(),
  });
});

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: status(), soldOut: soldOutIds() });
});

app.post('/api/checkout', async (req, res) => {
  let pendingId = null;
  try {
    const st = status();
    if (!st.canOrder) throw new O.OrderError('closed', st.paused
      ? 'No estamos aceptando órdenes en línea en este momento. Llámanos al 787-292-0920.'
      : 'Estamos cerrados ahora mismo.');
    const pickupReq = req.body?.pickup || {};
    let pickup;
    if (pickupReq.type === 'scheduled') {
      if (!st.slots.includes(pickupReq.at)) throw new O.OrderError('slot', 'Esa hora de recogido ya no está disponible. Escoge otra.');
      pickup = { type: 'scheduled', at: pickupReq.at };
    } else {
      if (!st.asap) throw new O.OrderError('slot', 'Escoge una hora de recogido.');
      pickup = { type: 'asap' };
    }
    const customer = O.validateCustomer(req.body);
    const priced = O.priceCart(req.body?.items, M.effective().index, config);
    if (priced.total < 50) throw new O.OrderError('min', 'El total mínimo es $0.50.');
    const id = O.createPendingOrder({ customer, priced, pickup });
    const base = baseUrl(req);

    if (MOCK) {
      paid(id, { customer_details: { email: 'prueba@example.com' } });
      return res.json({ url: `${base}/pedido.html?o=${id}` });
    }
    if (!stripe) throw new O.OrderError('payments_off', 'Los pagos en línea no están configurados todavía.');
    pendingId = id;

    const lang = req.body?.lang === 'en' ? 'en' : 'es';
    const line_items = priced.lines.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: config.currency, unit_amount: l.unit,
        product_data: {
          name: `#${l.num} ${l.name}`,
          ...((l.options.length || l.note) && {
            description: [...l.options.map((o) => o.label), l.note && `Nota: ${l.note}`].filter(Boolean).join(' · '),
          }),
        },
      },
    }));
    if (priced.tax > 0) {
      line_items.push({ quantity: 1, price_data: { currency: config.currency, unit_amount: priced.tax, product_data: { name: config.taxLabel } } });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      locale: lang,
      client_reference_id: id,
      metadata: { order_id: id },
      customer_email: customer.email,
      payment_intent_data: { metadata: { order_id: id }, description: `Eastern Lake — ${customer.name}` },
      success_url: `${base}/pedido.html?o=${id}`,
      cancel_url: `${base}/ordenar?pago=cancelado`,
      expires_at: Math.floor(Date.now() / 1000) + 35 * 60, // Stripe's minimum is 30 min
    });
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, id);
    res.json({ url: session.url });
  } catch (e) {
    if (pendingId) db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(pendingId);
    if (e instanceof O.OrderError) return res.status(400).json({ error: e.message, code: e.code });
    console.error('Checkout failed', e);
    res.status(500).json({ error: 'No pudimos iniciar el pago. Intenta otra vez o llámanos.' });
  }
});

// Short link used in texts and emails: /o/<first 12 characters of the order id>
app.get('/o/:code', (req, res) => {
  const code = String(req.params.code).toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(code)) return res.redirect('/ordenar');
  const like = `${code.slice(0, 8)}-${code.slice(8, 12)}%`;
  const row = db.prepare('SELECT id FROM orders WHERE id LIKE ? LIMIT 1').get(like);
  res.redirect(row ? `/pedido.html?o=${row.id}` : '/ordenar');
});

const lastCheck = new Map();
app.get('/api/order/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let o = O.getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  // If the webhook hasn't arrived yet, ask Stripe directly (at most every 3 s per order).
  if (o.status === 'pending' && o.stripe_session_id && stripe && Date.now() - (lastCheck.get(o.id) || 0) > 3000) {
    lastCheck.set(o.id, Date.now());
    try {
      const s = await stripe.checkout.sessions.retrieve(o.stripe_session_id);
      if (s.payment_status === 'paid') o = paid(o.id, s);
    } catch (e) { console.error('Stripe lookup failed', e.message); }
  }
  res.json({ order: O.publicOrder(o), restaurant: config.restaurant, timezone: config.timezone });
});

// ---------- Kitchen auth ----------
// Two shared PINs: employee (orders only) and manager (everything). The role is signed into the cookie,
// together with the PIN "version", so changing a PIN signs out every tablet using the old one.
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function makeToken(role) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days on the tablet
  const v = A.pinVersion(role);
  return `${role}.${v}.${exp}.${sign(`kitchen.${role}.${v}.${exp}`)}`;
}
function roleFromToken(t) {
  const [role, v, exp, sig] = String(t || '').split('.');
  if (!A.ROLES.includes(role) || !sig || Number(exp) < Date.now() || Number(v) !== A.pinVersion(role)) return null;
  const good = sign(`kitchen.${role}.${v}.${exp}`);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? role : null;
}
const cookie = (req, name) => (req.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
function staff(req, res, next) {
  req.role = roleFromToken(decodeURIComponent(cookie(req, 'el_kitchen') || ''));
  if (req.role) return next();
  res.status(401).json({ error: 'login' });
}
function manager(req, res, next) {
  staff(req, res, () => (req.role === 'manager' ? next() : res.status(403).json({ error: 'Solo un gerente puede hacer esto.' })));
}
const roleName = (r) => (r === 'manager' ? 'Gerente' : 'Empleado');

const attempts = new Map();
app.post('/api/kitchen/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
  const role = A.roleForPin(req.body?.pin);
  if (!role) {
    a.n += 1; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
    attempts.set(ip, a);
    return res.status(401).json({ error: 'PIN incorrecto' });
  }
  attempts.delete(ip);
  res.set('Set-Cookie', `el_kitchen=${encodeURIComponent(makeToken(role))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${PROD ? '; Secure' : ''}`);
  res.json({ ok: true, role });
});
app.post('/api/kitchen/logout', (req, res) => {
  res.set('Set-Cookie', 'el_kitchen=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/kitchen/me', staff, (req, res) => res.json({ role: req.role }));

// ---------- Kitchen API: orders (employees and managers) ----------
app.get('/api/kitchen/orders', staff, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const active = db.prepare("SELECT * FROM orders WHERE status IN ('paid','ready') ORDER BY paid_at ASC").all();
  const since = new Date(Date.now() - 16 * 3600 * 1000).toISOString();
  const recent = db.prepare("SELECT * FROM orders WHERE status IN ('done','cancelled') AND paid_at > ? ORDER BY paid_at DESC LIMIT 40").all(since);
  const today = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS total FROM orders WHERE status IN ('paid','ready','done') AND paid_at > ?").get(since);
  res.json({
    role: req.role, active: active.map(O.kitchenOrder), recent: recent.map(O.kitchenOrder),
    settings: settings(), status: status(), today: req.role === 'manager' ? today : { n: today.n }, taxLabel: config.taxLabel, serverTime: new Date().toISOString(),
  });
});

app.post('/api/kitchen/orders/:id/printed', staff, (req, res) => {
  db.prepare('UPDATE orders SET printed_at = COALESCE(printed_at, ?) WHERE id = ?').run(new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post('/api/kitchen/orders/:id/status', staff, (req, res) => {
  const to = req.body?.status;
  const o = O.getOrder(req.params.id);
  if (!o || !['paid', 'ready', 'done'].includes(o.status)) return res.status(404).json({ error: 'Orden no encontrada' });
  const now = new Date().toISOString();
  if (to === 'ready') {
    db.prepare("UPDATE orders SET status = 'ready', ready_at = ? WHERE id = ?").run(now, o.id);
    if (o.status === 'paid') N.orderReady(O.getOrder(o.id)); // email: "your order is ready" (sent once)
  }
  else if (to === 'done') db.prepare("UPDATE orders SET status = 'done', done_at = ? WHERE id = ?").run(now, o.id);
  else if (to === 'paid') db.prepare("UPDATE orders SET status = 'paid', ready_at = NULL, done_at = NULL WHERE id = ?").run(o.id);
  else return res.status(400).json({ error: 'Estado inválido' });
  res.json({ order: O.kitchenOrder(O.getOrder(o.id)) });
});

// ---------- Kitchen API: manager only ----------
const $c = (c) => `$${(c / 100).toFixed(2)}`;
app.post('/api/kitchen/orders/:id/cancel', manager, async (req, res) => {
  const o = O.getOrder(req.params.id);
  if (!o || !['paid', 'ready'].includes(o.status)) return res.status(404).json({ error: 'Orden no encontrada' });
  let refunded = 0;
  if (req.body?.refund) {
    if (MOCK) refunded = 1;
    else if (stripe && o.payment_intent) {
      try { await stripe.refunds.create({ payment_intent: o.payment_intent }); refunded = 1; }
      catch (e) { return res.status(502).json({ error: `Stripe no pudo hacer el reembolso: ${e.message}` }); }
    } else return res.status(400).json({ error: 'No se encontró el pago en Stripe. Reembolsa desde el panel de Stripe.' });
  }
  db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ?, refunded = ? WHERE id = ?").run(new Date().toISOString(), refunded, o.id);
  A.log(req.role, refunded ? `Canceló y reembolsó la orden ${o.number} (${$c(o.total_cents)})` : `Canceló la orden ${o.number} sin reembolso`);
  res.json({ order: O.kitchenOrder(O.getOrder(o.id)) });
});

// Pause (optionally for N minutes or until closing) and prep time
app.post('/api/kitchen/settings', manager, (req, res) => {
  const b = req.body || {};
  if (typeof b.paused === 'boolean') {
    let until = null;
    if (b.paused && Number(b.minutes) > 0) until = new Date(clock().getTime() + Math.min(Number(b.minutes), 24 * 60) * 60000).toISOString();
    if (b.paused && b.minutes === 'day') until = status().closeAt || null;
    setSetting('paused', b.paused); setSetting('pausedUntil', b.paused ? until : null);
    A.log(req.role, b.paused ? `Pausó las órdenes en línea${b.minutes === 'day' ? ' por el resto del día' : until ? ` por ${b.minutes} min` : ''}` : 'Reanudó las órdenes en línea');
  }
  const p = Number(b.prepMinutes);
  if (Number.isFinite(p) && p >= 5 && p <= 120) {
    setSetting('prepMinutes', Math.round(p));
    A.log(req.role, `Cambió el tiempo de preparación a ${Math.round(p)} min`);
  }
  res.json({ settings: settings(), status: status() });
});

// Menu: availability, prices, names, choices, "Más pedido"
app.get('/api/kitchen/menu', manager, (req, res) => { res.set('Cache-Control', 'no-store'); res.json(M.forEditor()); });
app.post('/api/kitchen/soldout', manager, (req, res) => {
  const id = String(req.body?.itemId || '');
  const it = M.findItem(id);
  if (!it) return res.status(404).json({ error: 'Artículo no encontrado' });
  setSoldOut(id, !!req.body?.soldOut);
  A.log(req.role, `${req.body?.soldOut ? 'Marcó agotado' : 'Marcó disponible'}: #${it.num} ${it.name}`);
  res.json({ soldOut: soldOutIds() });
});
app.post('/api/kitchen/menu/item', manager, (req, res) => {
  const b = req.body || {}; const it = M.findItem(String(b.id || ''));
  if (!it) return res.status(404).json({ error: 'Artículo no encontrado' });
  const eff = M.effective().index.get(it.id); const patch = {}; const msgs = [];
  if (b.price !== undefined) {
    const c = Math.round(Number(b.price));
    if (!Number.isInteger(c) || c < 0 || c > 100000) return res.status(400).json({ error: 'Precio inválido' });
    if (c !== eff.price) { patch.price = c; msgs.push(`precio ${$c(eff.price)} → ${$c(c)}`); }
  }
  if (b.name !== undefined) {
    const n = String(b.name).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (n.length < 2) return res.status(400).json({ error: 'Nombre muy corto' });
    if (n !== eff.name) { patch.name = n; msgs.push(`nombre “${eff.name}” → “${n}”`); }
  }
  if (typeof b.unavailable === 'boolean' && b.unavailable !== !!eff.unavailable) {
    patch.unavailable = b.unavailable; msgs.push(b.unavailable ? 'marcado No disponible (tachado)' : 'quitado de No disponible');
  }
  if (msgs.length) { M.setItem(it.id, patch); A.log(req.role, `#${it.num} ${it.name}: ${msgs.join(', ')}`); }
  res.json(M.forEditor());
});
app.post('/api/kitchen/menu/choice', manager, (req, res) => {
  const b = req.body || {}; const f = M.findChoice(String(b.key || ''));
  if (!f) return res.status(404).json({ error: 'Opción no encontrada' });
  const where = f.group.shared ? `todas las combinaciones` : `#${f.item.num} ${f.item.name}`;
  const label = `${f.group.label.es} → ${f.choice.label.es}`;
  const patch = {}; const msgs = [];
  if (typeof b.off === 'boolean') { patch.off = b.off; msgs.push(b.off ? 'apagada' : 'encendida'); }
  if (b.price !== undefined) {
    const c = Math.round(Number(b.price));
    if (!Number.isInteger(c) || c < 0 || c > 100000) return res.status(400).json({ error: 'Precio inválido' });
    patch.price = c; msgs.push(`precio extra ${$c(c)}`);
  }
  if (msgs.length) { M.setChoice(b.key, patch); A.log(req.role, `${where}: ${label} ${msgs.join(', ')}`); }
  res.json(M.forEditor());
});
app.post('/api/kitchen/menu/best', manager, (req, res) => {
  const it = M.findItem(String(req.body?.id || ''));
  if (!it) return res.status(404).json({ error: 'Artículo no encontrado' });
  M.setBest(it.id, !!req.body?.on);
  A.log(req.role, `${req.body?.on ? 'Añadió a' : 'Quitó de'} “Más pedido”: #${it.num} ${it.name}`);
  res.json(M.forEditor());
});

// Store: hours, closed days, homepage banner, PINs, change log
const storeInfo = () => ({ hours: weekHours(), closedDays: closedDays(), banner: getSetting('banner', { text: '', show: false }), settings: settings(), status: status(), log: A.recentLog() });
app.get('/api/kitchen/store', manager, (req, res) => { res.set('Cache-Control', 'no-store'); res.json(storeInfo()); });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
app.post('/api/kitchen/store', manager, (req, res) => {
  const b = req.body || {};
  if (b.hours) {
    const h = {}; const before = weekHours(); const changed = [];
    for (let d = 0; d < 7; d++) {
      const v = b.hours[String(d)];
      if (v === null) h[d] = null;
      else if (Array.isArray(v) && HHMM.test(v[0]) && HHMM.test(v[1]) && v[0] < v[1]) h[d] = [v[0], v[1]];
      else return res.status(400).json({ error: `Horario inválido para el ${DAYS[d]}` });
      if (JSON.stringify(h[d]) !== JSON.stringify(before[d])) changed.push(DAYS[d]);
    }
    setSetting('hours', h);
    if (changed.length) A.log(req.role, `Cambió el horario (${changed.join(', ')})`);
  }
  if (b.addClosed) {
    const d = String(b.addClosed.date || ''); const label = String(b.addClosed.label || '').trim().slice(0, 40);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Fecha inválida' });
    const list = getSetting('closedDays', []).filter((c) => c.date !== d); list.push({ date: d, label });
    setSetting('closedDays', list); A.log(req.role, `Añadió día cerrado ${d}${label ? ` (${label})` : ''}`);
  }
  if (b.removeClosed) {
    setSetting('closedDays', getSetting('closedDays', []).filter((c) => c.date !== b.removeClosed));
    A.log(req.role, `Quitó el día cerrado ${b.removeClosed}`);
  }
  if (b.banner) {
    const text = String(b.banner.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    setSetting('banner', { text, show: !!b.banner.show && !!text });
    A.log(req.role, b.banner.show && text ? `Aviso en la página: “${text}”` : 'Quitó el aviso de la página');
  }
  if (b.pin) {
    const role = b.pin.role; const pin = String(b.pin.value || '');
    if (!A.ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'El PIN debe tener de 4 a 8 números.' });
    const other = role === 'manager' ? 'employee' : 'manager';
    if (A.roleForPin(pin) === other) return res.status(400).json({ error: 'Ese PIN ya lo usa el otro rol. Escoge uno diferente.' });
    A.setPin(role, pin); A.log(req.role, `Cambió el PIN de ${roleName(role).toLowerCase()}`);
    if (role === 'manager') res.set('Set-Cookie', `el_kitchen=${encodeURIComponent(makeToken('manager'))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${PROD ? '; Secure' : ''}`);
  }
  res.json(storeInfo());
});

// Sales
app.get('/api/kitchen/sales', manager, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const kind = ['today', 'week', 'month'].includes(req.query.range) ? req.query.range : 'today';
  res.json(A.sales(kind, clock(), config.timezone));
});
app.get('/api/kitchen/sales.csv', manager, (req, res) => {
  const kind = ['today', 'week', 'month'].includes(req.query.range) ? req.query.range : 'today';
  const day = A.ymd(partsIn(clock(), config.timezone));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="eastern-lake-ventas-${kind}-${day}.csv"`, 'Cache-Control': 'no-store' });
  res.send(A.salesCsv(kind, clock(), config.timezone));
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- Static pages ----------
app.get('/cocina', (req, res) => res.redirect('/kitchen/'));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, file) => {
    if (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.css')) res.set('Cache-Control', 'no-cache');
  },
}));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Eastern Lake running on http://localhost:${port}  (kitchen: /kitchen/)`));
