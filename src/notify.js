// Customer emails: one when the order is paid, and one when the kitchen marks it ready.
// Sent through Resend (RESEND_API_KEY, EMAIL_FROM, optional EMAIL_REPLY_TO). Without a key nothing is sent,
// so the site works the same. Every attempt is recorded on the order (notify_json) so an email is never sent twice.
const fs = require('node:fs');
const path = require('node:path');
const { db, dataDir } = require('./db');
const { fmtTime } = require('./time');

const env = (k) => (process.env[k] || '').trim();
const emailOn = () => !!(env('RESEND_API_KEY') && env('EMAIL_FROM'));
const PROD = process.env.NODE_ENV === 'production';

let cfg = { restaurant: {}, timezone: 'America/Puerto_Rico' };
let publicUrl = () => '';
function setup(config, baseUrl) { cfg = config; publicUrl = baseUrl; }

// ---------- Delivery ----------
async function sendEmail({ to, subject, html, text }) {
  if (!emailOn()) {
    if (!PROD) { // local testing: keep a copy to look at
      const dir = path.join(dataDir, 'outbox'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}-${subject.replace(/[^\w]+/g, '_').slice(0, 40)}.html`), html);
    }
    return 'off';
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env('EMAIL_FROM'), to: [to], subject, html, text,
      ...(env('EMAIL_REPLY_TO') && { reply_to: env('EMAIL_REPLY_TO') }),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return 'sent';
}

// ---------- Helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (c) => `$${(c / 100).toFixed(2)}`;
const shortLink = (o) => `${publicUrl()}/o/${o.id.replace(/-/g, '').slice(0, 12)}`;
const pickupTime = (o, lang) => (o.pickup_at ? fmtTime(new Date(o.pickup_at), cfg.timezone, lang === 'en' ? 'en-US' : 'es-PR') : '');

const T = {
  es: {
    subjConfirm: (o) => `Recibimos tu orden #${o.number} · Eastern Lake`,
    subjReady: (o) => `Tu orden #${o.number} está lista · Eastern Lake`,
    hi: (n) => `¡Gracias, ${n}!`,
    got: 'Recibimos tu orden y ya está en la cocina.',
    readyHead: '¡Tu orden está lista!',
    readyBody: 'Puedes pasar a recogerla cuando quieras. Te esperamos.',
    order: 'Orden', pickup: 'Recogido aprox.', track: 'Ver el estado de mi orden',
    subtotal: 'Subtotal', total: 'Total pagado', note: 'Nota',
    where: 'Dónde recoger', questions: '¿Preguntas? Llámanos',
  },
  en: {
    subjConfirm: (o) => `We got your order #${o.number} · Eastern Lake`,
    subjReady: (o) => `Your order #${o.number} is ready · Eastern Lake`,
    hi: (n) => `Thank you, ${n}!`,
    got: 'We got your order and it’s in the kitchen.',
    readyHead: 'Your order is ready!',
    readyBody: 'Come pick it up whenever you’re ready. See you soon.',
    order: 'Order', pickup: 'Pickup around', track: 'See my order status',
    subtotal: 'Subtotal', total: 'Total paid', note: 'Note',
    where: 'Pickup at', questions: 'Questions? Call us',
  },
};

// ---------- Email layout (tables + inline styles so it looks right in Gmail, Outlook and Apple Mail) ----------
function emailHtml(o, kind) {
  const lang = o.lang === 'en' ? 'en' : 'es'; const t = T[lang];
  const r = cfg.restaurant; const link = shortLink(o);
  const items = JSON.parse(o.items_json || '[]');
  const ready = kind === 'ready';
  const rows = items.map((l) => `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee6d6;vertical-align:top;width:34px;font:600 15px Arial,sans-serif;color:#0e3b33">${l.qty}×</td>
      <td style="padding:10px 0;border-bottom:1px solid #eee6d6;vertical-align:top;font:15px Arial,sans-serif;color:#17211d">
        <b>#${esc(l.num)} ${esc(l.name)}</b>
        ${l.options?.length ? `<div style="font-size:13px;color:#6a716a;margin-top:2px">${l.options.map((x) => esc(x.label)).join(' · ')}</div>` : ''}
        ${l.note ? `<div style="font-size:13px;color:#6a716a;margin-top:2px">${t.note}: ${esc(l.note)}</div>` : ''}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #eee6d6;vertical-align:top;text-align:right;font:15px Arial,sans-serif;color:#17211d;white-space:nowrap">${money(l.total)}</td></tr>`).join('');
  const body = ready
    ? `<h1 style="margin:0 0 8px;font:700 26px Georgia,serif;color:#0e3b33">${t.readyHead}</h1>
       <p style="margin:0 0 20px;font:16px/1.5 Arial,sans-serif;color:#17211d">${t.readyBody}</p>`
    : `<h1 style="margin:0 0 8px;font:700 26px Georgia,serif;color:#0e3b33">${esc(t.hi(o.customer_name.split(' ')[0]))}</h1>
       <p style="margin:0 0 20px;font:16px/1.5 Arial,sans-serif;color:#17211d">${t.got}</p>`;
  const facts = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f3ea;border-radius:10px;margin:0 0 20px">
      <tr><td style="padding:14px 16px;font:13px Arial,sans-serif;color:#6a716a">${t.order}<div style="font:700 22px 'Courier New',monospace;color:#0e3b33;margin-top:2px">#${esc(o.number)}</div></td>
      ${!ready && o.pickup_at ? `<td style="padding:14px 16px;font:13px Arial,sans-serif;color:#6a716a;text-align:right">${t.pickup}<div style="font:700 22px Arial,sans-serif;color:#17211d;margin-top:2px">${esc(pickupTime(o, lang))}</div></td>` : ''}</tr></table>`;
  const list = ready ? '' : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
      <tr><td></td><td style="padding:10px 0 2px;font:14px Arial,sans-serif;color:#6a716a">${t.subtotal}</td><td style="padding:10px 0 2px;text-align:right;font:14px Arial,sans-serif;color:#6a716a">${money(o.subtotal_cents)}</td></tr>
      <tr><td></td><td style="padding:2px 0;font:14px Arial,sans-serif;color:#6a716a">${esc(cfg.taxLabel || 'IVU')}</td><td style="padding:2px 0;text-align:right;font:14px Arial,sans-serif;color:#6a716a">${money(o.tax_cents)}</td></tr>
      <tr><td></td><td style="padding:6px 0;font:700 16px Arial,sans-serif;color:#17211d">${t.total}</td><td style="padding:6px 0;text-align:right;font:700 16px Arial,sans-serif;color:#17211d">${money(o.total_cents)}</td></tr></table>`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#efe9dc">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe9dc"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf8;border-radius:14px;overflow:hidden">
  <tr><td style="background:#0e3b33;padding:18px 24px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:12px"><img src="${publicUrl()}/assets/logo-icon.png" width="40" height="40" alt="" style="display:block;border:0"></td>
      <td><div style="font:700 20px Georgia,serif;color:#f7f3ea">Eastern Lake</div><div style="font:11px Arial,sans-serif;letter-spacing:3px;color:#b08d57">RESTAURANTE CHINO</div></td>
    </tr></table></td></tr>
  <tr><td style="padding:26px 24px 8px">${body}${facts}${list}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="background:#0e3b33;border-radius:99px">
      <a href="${link}" style="display:inline-block;padding:13px 26px;font:700 14px Arial,sans-serif;letter-spacing:.5px;color:#fffdf8;text-decoration:none">${t.track}</a></td></tr></table>
  </td></tr>
  <tr><td style="padding:18px 24px 24px;font:13px/1.6 Arial,sans-serif;color:#6a716a;border-top:1px solid #eee6d6">
    <b style="color:#17211d">${t.where}</b><br>${esc(r.address || '')}<br>
    ${t.questions}: ${(r.phones || []).map((p) => `<a href="tel:+1${p.replace(/\D/g, '')}" style="color:#0e3b33">${esc(p)}</a>`).join(' · ')}
  </td></tr>
</table></td></tr></table></body></html>`;
}

function emailText(o, kind) {
  const lang = o.lang === 'en' ? 'en' : 'es'; const t = T[lang];
  const items = JSON.parse(o.items_json || '[]');
  const head = kind === 'ready' ? `${t.readyHead}\n${t.readyBody}` : `${t.hi(o.customer_name.split(' ')[0])}\n${t.got}`;
  const lines = kind === 'ready' ? '' : `\n${items.map((l) => `${l.qty}x #${l.num} ${l.name}${l.options?.length ? ` (${l.options.map((x) => x.label).join(', ')})` : ''}  ${money(l.total)}`).join('\n')}\n${t.total}: ${money(o.total_cents)}\n`;
  return `${head}\n\n${t.order} #${o.number}${kind !== 'ready' && o.pickup_at ? ` · ${t.pickup} ${pickupTime(o, lang)}` : ''}\n${lines}\n${t.track}: ${shortLink(o)}\n\n${cfg.restaurant.address || ''}\n${(cfg.restaurant.phones || []).join(' · ')}`;
}

// ---------- Sending with a record on the order ----------
const record = (id) => { try { return JSON.parse(db.prepare('SELECT notify_json FROM orders WHERE id = ?').get(id)?.notify_json || '{}'); } catch { return {}; } };
function save(id, kind, channel, state) {
  const n = record(id); n[kind] = { ...(n[kind] || {}), [channel]: state };
  db.prepare('UPDATE orders SET notify_json = ? WHERE id = ?').run(JSON.stringify(n), id);
}
// Claims an email before sending, so two triggers at once (webhook + status page) can't both send it.
function claim(id, kind, channel) {
  const cur = record(id)[kind]?.[channel];
  if (cur && cur !== 'failed') return false;
  save(id, kind, channel, 'sending');
  return true;
}

async function deliver(o, kind) {
  if (!o) return;
  const lang = o.lang === 'en' ? 'en' : 'es'; const t = T[lang];
  const jobs = [];
  if (o.email && claim(o.id, kind, 'email')) {
    jobs.push(sendEmail({
      to: o.email,
      subject: kind === 'ready' ? t.subjReady(o) : t.subjConfirm(o),
      html: emailHtml(o, kind), text: emailText(o, kind),
    }).then((s) => save(o.id, kind, 'email', s), (e) => { console.error(`Email ${kind} ${o.number} failed:`, e.message); save(o.id, kind, 'email', 'failed'); }));
  }
  await Promise.all(jobs);
}

// Fire and forget: the kitchen and checkout never wait on (or fail because of) an email.
const orderConfirmed = (o) => { deliver(o, 'confirm').catch((e) => console.error('notify', e)); };
const orderReady = (o) => { deliver(o, 'ready').catch((e) => console.error('notify', e)); };

module.exports = { setup, orderConfirmed, orderReady, deliver, emailHtml, emailOn };
