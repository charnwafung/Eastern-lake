// ESC/POS ticket builder + USB printer connection (WebUSB, works in Chrome on Android).
// Layout target: 80 mm thermal printers (48 characters per line, Font A) such as the PBM P-822D.
window.KPrint = (() => {
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  const COLS = 48;

  // Code page PC437 (ESC t 0) is the default on nearly every ESC/POS printer and has the Spanish lowercase letters.
  const CP437 = { 'á': 0xa0, 'é': 0x82, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ü': 0x81, 'Ü': 0x9a, 'É': 0x90, '¿': 0xa8, '¡': 0xad, '°': 0xf8 };
  function encode(str, ascii) {
    const out = [];
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) { out.push(c); continue; }
      if (ch === '\u00a0' || ch === '\u202f') { out.push(0x20); continue; }
      if (!ascii && CP437[ch] !== undefined) { out.push(CP437[ch]); continue; }
      const plain = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '');
      if (plain && plain.codePointAt(0) < 0x80) out.push(...[...plain].map((x) => x.charCodeAt(0)));
      else if (ch === '—' || ch === '–') out.push(0x2d);
      else if (ch === '“' || ch === '”') out.push(0x22);
      else if (ch === '’' || ch === '‘') out.push(0x27);
      else if (ch === '·') out.push(0x2d);
      else out.push(0x3f);
    }
    return out;
  }

  class Ticket {
    constructor({ ascii = false } = {}) { this.b = [ESC, 0x40, ESC, 0x74, 0x00]; this.ascii = ascii; }
    raw(...bytes) { this.b.push(...bytes); return this; }
    text(s) { this.b.push(...encode(s, this.ascii)); return this; }
    line(s = '') { return this.text(s).raw(LF); }
    align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); }
    bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
    size(w = 1, h = 1) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }
    invert(on) { return this.raw(GS, 0x42, on ? 1 : 0); }
    rule(ch = '-') { return this.line(ch.repeat(COLS)); }
    feed(n = 1) { return this.raw(ESC, 0x64, n); }
    cut() { return this.feed(4).raw(GS, 0x56, 0x42, 0x00); }
    pair(l, r, width = COLS) {
      const space = Math.max(1, width - l.length - r.length);
      return this.line(l + ' '.repeat(space) + r);
    }
    wrap(s, width = COLS, indent = '') {
      const str = String(s); const lead = str.match(/^\s*/)[0];
      const words = str.trim().split(/\s+/); let cur = lead;
      for (const w of words) {
        const sep = cur.trim() ? ' ' : '';
        if ((cur + sep + w).length > width && cur.trim()) { this.line(cur); cur = indent + w; }
        else cur += sep + w;
      }
      if (cur.trim()) this.line(cur);
      return this;
    }
    bytes() { return new Uint8Array(this.b); }
  }

  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const TZ = 'America/Puerto_Rico';
  const hm = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  const dt = (iso) => `${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(iso))} ${hm(iso)}`;

  function orderTicket(o, { ascii = false, reprint = false, copyLabel = '', taxLabel = 'IVU' } = {}) {
    const t = new Ticket({ ascii });
    t.align('center').bold(true).size(2, 1).line('EASTERN LAKE').size(1, 1).bold(false);
    t.line('ORDEN EN LINEA - PARA RECOGER');
    if (reprint) t.bold(true).line('*** REIMPRESION ***').bold(false);
    if (copyLabel) t.line(copyLabel);
    t.rule('=');
    t.bold(true).size(3, 3).line(o.number).size(1, 1);
    t.feed(1);
    const pick = o.pickupType === 'asap' ? `LO ANTES POSIBLE ~${hm(o.pickupAt)}` : `PROGRAMADA ${hm(o.pickupAt)}`;
    t.invert(true).size(1, 2).line(` RECOGER: ${pick} `).size(1, 1).invert(false).bold(false);
    t.feed(1).align('left');
    t.bold(true).size(1, 2).line(`Cliente: ${o.name}`).size(1, 1).bold(false);
    t.line(`Tel: ${o.phone}`);
    t.line(`Pagado: ${dt(o.paidAt)}`);
    t.rule('=');

    let count = 0;
    for (const l of o.items) {
      count += l.qty;
      t.bold(true).size(1, 2);
      t.wrap(`${l.qty} x ${l.name}  (#${l.num})`, COLS, '    ');
      t.size(1, 1).bold(false);
      for (const op of l.options) t.bold(true).line(`    > ${op.label.toUpperCase()}`).bold(false);
      if (l.note) { t.bold(true); t.wrap(`    > NOTA: ${l.note}`, COLS, '      '); t.bold(false); }
      t.line();
    }
    if (o.notes) {
      t.rule('-').bold(true).line('NOTA DE LA ORDEN:').bold(false);
      t.wrap(o.notes, COLS).line();
    }
    t.rule('-');
    t.pair('Subtotal', money(o.subtotal));
    t.pair(taxLabel, money(o.tax));
    t.bold(true).size(1, 2).pair('TOTAL', money(o.total)).size(1, 1).bold(false);
    t.feed(1).align('center').bold(true).line('*** PAGADO CON TARJETA (STRIPE) ***').bold(false);
    t.line(`${count} articulo${count === 1 ? '' : 's'}`);
    return t.cut().bytes();
  }

  function testTicket({ ascii = false } = {}) {
    const t = new Ticket({ ascii });
    t.align('center').bold(true).size(2, 2).line('PRUEBA').size(1, 1).bold(false);
    t.line('Eastern Lake - impresora de cocina');
    t.line(new Date().toLocaleString('es-PR', { timeZone: TZ }));
    t.rule();
    t.align('left').line('Acentos: á é í ó ú ñ Ñ ¿? ¡!');
    t.line('Si ves signos raros arriba, activa "Sin acentos"');
    t.line('en Ajustes de la pantalla de cocina.');
    t.rule();
    t.line('123456789012345678901234567890123456789012345678');
    t.align('center').line('La linea de arriba debe caber completa.');
    return t.cut().bytes();
  }

  // ---------------- WebUSB printer ----------------
  const USB_KEY = 'el_printer_usb';
  const state = { device: null, endpoint: null, iface: null, busy: Promise.resolve() };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(status()));
  const supported = () => 'usb' in navigator;
  const status = () => ({ supported: supported(), connected: !!state.device?.opened, name: state.device ? (state.device.productName || 'Impresora USB') : null });

  async function open(device) {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    let pick = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const ep = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (!ep) continue;
        const score = alt.interfaceClass === 7 ? 2 : alt.interfaceClass === 0xff ? 1 : 0;
        if (!pick || score > pick.score) pick = { iface, alt, ep, score };
      }
    }
    if (!pick) { await device.close(); throw new Error('Este aparato USB no parece una impresora.'); }
    await device.claimInterface(pick.iface.interfaceNumber);
    if (pick.alt.alternateSetting) await device.selectAlternateInterface(pick.iface.interfaceNumber, pick.alt.alternateSetting);
    state.device = device; state.endpoint = pick.ep.endpointNumber; state.iface = pick.iface.interfaceNumber;
    try { localStorage.setItem(USB_KEY, JSON.stringify({ v: device.vendorId, p: device.productId })); } catch {}
    emit();
  }

  async function reconnect() {
    if (!supported() || state.device?.opened) return status().connected;
    let want = null; try { want = JSON.parse(localStorage.getItem(USB_KEY)); } catch {}
    const devs = await navigator.usb.getDevices();
    const dev = devs.find((d) => want && d.vendorId === want.v && d.productId === want.p) || (devs.length === 1 ? devs[0] : null);
    if (!dev) return false;
    try { await open(dev); return true; } catch (e) { console.warn('Printer reconnect failed', e); return false; }
  }

  async function choose() {
    if (!supported()) throw new Error('Este navegador no puede usar USB. Usa Google Chrome en la tableta.');
    const dev = await navigator.usb.requestDevice({ filters: [] });
    if (state.device && state.device !== dev) { try { await state.device.close(); } catch {} }
    await open(dev);
  }

  function print(bytes) {
    // Serialise jobs so two tickets never interleave.
    const job = state.busy.then(async () => {
      if (!state.device?.opened) { const ok = await reconnect(); if (!ok) throw new Error('Impresora no conectada'); }
      for (let i = 0; i < bytes.length; i += 4096) {
        const r = await state.device.transferOut(state.endpoint, bytes.slice(i, i + 4096));
        if (r.status !== 'ok') throw new Error(`USB: ${r.status}`);
      }
    });
    state.busy = job.catch(() => {});
    return job;
  }

  if (supported()) {
    navigator.usb.addEventListener('disconnect', (e) => { if (e.device === state.device) { state.device = null; emit(); } });
    navigator.usb.addEventListener('connect', () => { reconnect(); });
  }

  return { orderTicket, testTicket, print, choose, reconnect, status, onChange: (f) => listeners.add(f), supported };
})();
