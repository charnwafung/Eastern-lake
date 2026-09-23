const crypto = require('node:crypto');
const { db, tx, soldOutIds } = require('./db');
const { dayKey } = require('./time');
const Opt = require('../public/options.js');

class OrderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function indexMenu(menu) {
  const byId = new Map();
  for (const c of menu.categories) for (const it of c.items) byId.set(it.id, { ...it, category: c.id });
  return byId;
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Validate the cart against the server's menu. Prices always come from the server, never the browser.
 */
function priceCart(rawItems, menuIndex, config) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new OrderError('empty', 'La orden está vacía.');
  if (rawItems.length > 60) throw new OrderError('too_many', 'Demasiadas líneas en la orden.');
  const soldOut = new Set(soldOutIds());
  const lines = [];
  for (const raw of rawItems) {
    const item = menuIndex.get(String(raw?.id));
    if (!item) throw new OrderError('unknown_item', 'Un artículo ya no está en el menú. Actualiza la página.');
    if (soldOut.has(item.id)) throw new OrderError('sold_out', `${item.name} está agotado hoy.`);
    const qty = Math.floor(Number(raw.qty));
    if (!(qty >= 1 && qty <= config.maxQuantityPerLine)) throw new OrderError('bad_qty', 'Cantidad inválida.');
    let sel;
    try { sel = Opt.normalize(item, raw.options); }
    catch (e) { if (e instanceof Opt.OptionError) throw new OrderError('bad_option', `${item.name}: ${e.message}`); throw e; }
    const unit = Opt.unitPrice(item, sel);
    const chosen = Opt.chosen(item, sel).filter(({ choice }) => choice.summary !== null).map(({ group, choice }) => ({
      group, id: choice.id, label: (choice.summary || choice.label).es, price: choice.price || 0,
    }));
    lines.push({
      id: item.id, num: item.num, name: item.name, qty, unit, total: unit * qty,
      options: chosen, note: clean(raw.note, 140),
    });
  }
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const tax = Math.round(subtotal * config.taxRate);
  return { lines, subtotal, tax, total: subtotal + tax };
}

function validateCustomer(body) {
  const name = clean(body?.name, 60);
  const phoneDigits = String(body?.phone ?? '').replace(/\D/g, '');
  if (name.length < 2) throw new OrderError('name', 'Escribe tu nombre.');
  if (phoneDigits.length < 10 || phoneDigits.length > 11) throw new OrderError('phone', 'Escribe un teléfono de 10 dígitos.');
  const d = phoneDigits.slice(-10);
  const phone = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return { name, phone, notes: clean(body?.notes, 240) };
}

function createPendingOrder({ customer, priced, pickup }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO orders (id, status, customer_name, phone, notes, pickup_type, pickup_at, items_json,
      subtotal_cents, tax_cents, total_cents, created_at)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, customer.name, customer.phone, customer.notes || null, pickup.type, pickup.at || null,
      JSON.stringify(priced.lines), priced.subtotal, priced.tax, priced.total, new Date().toISOString());
  return id;
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

/**
 * Mark an order paid and give it its MMDDYY-XX number. Safe to call more than once
 * (the webhook and the customer's success page may both report the same payment).
 */
function markPaid(orderId, { email, paymentIntent, prepMinutes, tz, now = new Date() }) {
  return tx(() => {
    const o = getOrder(orderId);
    if (!o) return null;
    if (o.status !== 'pending' && o.status !== 'expired') return o;
    const day = dayKey(now, tz);
    const { seq } = db.prepare('SELECT COALESCE(MAX(day_seq), 0) + 1 AS seq FROM orders WHERE day = ?').get(day);
    const number = `${day}-${String(seq).padStart(2, '0')}`;
    const pickupAt = o.pickup_type === 'asap' ? new Date(now.getTime() + prepMinutes * 60000).toISOString() : o.pickup_at;
    db.prepare(`UPDATE orders SET status = 'paid', number = ?, day = ?, day_seq = ?, paid_at = ?, email = COALESCE(?, email),
        payment_intent = COALESCE(?, payment_intent), pickup_at = ? WHERE id = ?`)
      .run(number, day, seq, now.toISOString(), email || null, paymentIntent || null, pickupAt, orderId);
    return getOrder(orderId);
  });
}

function publicOrder(o) {
  if (!o) return null;
  return {
    id: o.id, number: o.number, status: o.status, name: o.customer_name, pickupType: o.pickup_type,
    pickupAt: o.pickup_at, items: JSON.parse(o.items_json), subtotal: o.subtotal_cents, tax: o.tax_cents,
    total: o.total_cents, notes: o.notes, createdAt: o.created_at, paidAt: o.paid_at, readyAt: o.ready_at,
    refunded: !!o.refunded,
  };
}

function kitchenOrder(o) {
  return { ...publicOrder(o), phone: o.phone, email: o.email, printedAt: o.printed_at, doneAt: o.done_at, cancelledAt: o.cancelled_at };
}

module.exports = { OrderError, indexMenu, priceCart, validateCustomer, createPendingOrder, getOrder, markPaid, publicOrder, kitchenOrder };
