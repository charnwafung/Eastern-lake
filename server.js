require('./src/env').load();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { db, getSetting, setSetting, soldOutIds, setSoldOut } = require('./src/db');
const { storeStatus } = require('./src/time');
const O = require('./src/orders');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config.json'), 'utf8'));
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'menu.json'), 'utf8'));
// Items can share option groups through "optionSet" (all the combos use "combo").
for (const c of menu.categories) for (const it of c.items) {
  if (it.optionSet) {
    if (!menu.optionSets?.[it.optionSet]) throw new Error(`menu.json: unknown optionSet "${it.optionSet}" on item ${it.id}`);
    it.options = menu.optionSets[it.optionSet];
    delete it.optionSet;
  }
}
delete menu.optionSets;
const menuIndex = O.indexMenu(menu);

const PROD = process.env.NODE_ENV === 'production';
const MOCK = process.env.MOCK_PAYMENTS === '1' && !PROD;
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const KITCHEN_PIN = String(process.env.KITCHEN_PIN || '');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!stripe && !MOCK) console.warn('⚠  STRIPE_SECRET_KEY is not set — online payment will not work.');
if (MOCK) console.warn('⚠  MOCK_PAYMENTS=1 — orders are marked paid without charging. Never use this in production.');
if (!KITCHEN_PIN) console.warn('⚠  KITCHEN_PIN is not set — the kitchen screen cannot be unlocked.');
if (!process.env.SESSION_SECRET) console.warn('⚠  SESSION_SECRET not set — kitchen logins reset whenever the server restarts.');

const settings = () => ({
  paused: getSetting('paused', false),
  prepMinutes: getSetting('prepMinutes', config.defaultPrepMinutes),
});
// DEV_NOW lets you preview open/closed behaviour locally (ignored in production).
const clock = () => (!PROD && process.env.DEV_NOW ? new Date(process.env.DEV_NOW) : new Date());
const status = () => storeStatus(config, { ...settings(), now: clock() });

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
  }
  return o;
}

// ---------- Public API ----------
app.get('/api/menu', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    restaurant: config.restaurant, taxRate: config.taxRate, taxLabel: config.taxLabel,
    maxQty: config.maxQuantityPerLine, timezone: config.timezone,
    categories: menu.categories, soldOut: soldOutIds(), status: status(),
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
    const priced = O.priceCart(req.body?.items, menuIndex, config);
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
      payment_intent_data: { metadata: { order_id: id }, description: `Eastern Lake — ${customer.name}` },
      success_url: `${base}/pedido.html?o=${id}`,
      cancel_url: `${base}/?pago=cancelado`,
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
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function makeToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days on the tablet
  return `${exp}.${sign(`kitchen.${exp}`)}`;
}
function validToken(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(`kitchen.${exp}`);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const cookie = (req, name) => (req.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
function kitchenOnly(req, res, next) {
  if (validToken(decodeURIComponent(cookie(req, 'el_kitchen') || ''))) return next();
  res.status(401).json({ error: 'login' });
}

const attempts = new Map();
app.post('/api/kitchen/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
  const pin = String(req.body?.pin || '');
  const ok = KITCHEN_PIN && pin.length === KITCHEN_PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(KITCHEN_PIN));
  if (!ok) {
    a.n += 1; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
    attempts.set(ip, a);
    return res.status(401).json({ error: 'PIN incorrecto' });
  }
  attempts.delete(ip);
  res.set('Set-Cookie', `el_kitchen=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/kitchen/logout', (req, res) => {
  res.set('Set-Cookie', 'el_kitchen=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

// ---------- Kitchen API ----------
app.get('/api/kitchen/orders', kitchenOnly, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const active = db.prepare("SELECT * FROM orders WHERE status IN ('paid','ready') ORDER BY paid_at ASC").all();
  const since = new Date(Date.now() - 16 * 3600 * 1000).toISOString();
  const recent = db.prepare("SELECT * FROM orders WHERE status IN ('done','cancelled') AND paid_at > ? ORDER BY paid_at DESC LIMIT 40").all(since);
  const today = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS total FROM orders WHERE status IN ('paid','ready','done') AND paid_at > ?").get(since);
  res.json({
    active: active.map(O.kitchenOrder), recent: recent.map(O.kitchenOrder),
    settings: settings(), status: status(), today, taxLabel: config.taxLabel, serverTime: new Date().toISOString(),
  });
});

app.post('/api/kitchen/orders/:id/printed', kitchenOnly, (req, res) => {
  db.prepare('UPDATE orders SET printed_at = COALESCE(printed_at, ?) WHERE id = ?').run(new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post('/api/kitchen/orders/:id/status', kitchenOnly, (req, res) => {
  const to = req.body?.status;
  const o = O.getOrder(req.params.id);
  if (!o || !['paid', 'ready', 'done'].includes(o.status)) return res.status(404).json({ error: 'Orden no encontrada' });
  const now = new Date().toISOString();
  if (to === 'ready') db.prepare("UPDATE orders SET status = 'ready', ready_at = ? WHERE id = ?").run(now, o.id);
  else if (to === 'done') db.prepare("UPDATE orders SET status = 'done', done_at = ? WHERE id = ?").run(now, o.id);
  else if (to === 'paid') db.prepare("UPDATE orders SET status = 'paid', ready_at = NULL, done_at = NULL WHERE id = ?").run(o.id);
  else return res.status(400).json({ error: 'Estado inválido' });
  res.json({ order: O.kitchenOrder(O.getOrder(o.id)) });
});

app.post('/api/kitchen/orders/:id/cancel', kitchenOnly, async (req, res) => {
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
  res.json({ order: O.kitchenOrder(O.getOrder(o.id)) });
});

app.post('/api/kitchen/settings', kitchenOnly, (req, res) => {
  if (typeof req.body?.paused === 'boolean') setSetting('paused', req.body.paused);
  const p = Number(req.body?.prepMinutes);
  if (Number.isFinite(p) && p >= 5 && p <= 120) setSetting('prepMinutes', Math.round(p));
  res.json({ settings: settings(), status: status() });
});

app.get('/api/kitchen/menu', kitchenOnly, (req, res) => {
  res.json({ categories: menu.categories, soldOut: soldOutIds() });
});
app.post('/api/kitchen/soldout', kitchenOnly, (req, res) => {
  const id = String(req.body?.itemId || '');
  if (!menuIndex.has(id)) return res.status(404).json({ error: 'Artículo no encontrado' });
  setSoldOut(id, !!req.body?.soldOut);
  res.json({ soldOut: soldOutIds() });
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
