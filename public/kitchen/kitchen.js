(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const TZ = 'America/Puerto_Rico';

  // Per-tablet preferences (printer, sound, language)
  const prefs = (() => {
    const d = { autoPrint: true, ascii: false, copies: 1, sound: true, lang: 'es' };
    try { return { ...d, ...JSON.parse(localStorage.getItem('el_kitchen_prefs') || '{}') }; } catch { return d; }
  })();
  const savePrefs = () => { try { localStorage.setItem('el_kitchen_prefs', JSON.stringify(prefs)); } catch {} };

  // Language: tr('español', 'English'). Printed tickets always stay in Spanish.
  const tr = (es, en) => (prefs.lang === 'en' ? en : es);
  const L = (o) => (o ? (prefs.lang === 'en' ? o.en || o.es : o.es) : '');
  const hm = (iso) => new Intl.DateTimeFormat(prefs.lang === 'en' ? 'en-US' : 'es-PR', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  function applyLang() {
    document.documentElement.lang = prefs.lang;
    document.querySelectorAll('[data-en]').forEach((el) => {
      if (el.dataset.es === undefined) el.dataset.es = el.textContent;
      el.textContent = prefs.lang === 'en' ? el.dataset.en : el.dataset.es;
    });
    $('#langBtn').textContent = prefs.lang === 'en' ? 'ES' : 'EN';
    $('#langBtn2').textContent = $('#langBtn').textContent;
    $('#menuBtn').setAttribute('aria-label', tr('Ajustes', 'Settings'));
    applyRole();
  }

  let data = { active: [], recent: [], settings: {}, status: {}, today: { n: 0, total: 0 } };
  let role = null;              // 'employee' | 'manager'
  let known = null;             // ids seen so far (null until first load)
  const fresh = new Set();      // ids to flash
  const inflight = new Set();   // printing right now
  const failedAt = new Map();   // id -> time of last failed print
  const acked = new Set();      // alarm acknowledged
  let printError = '';
  let tab = 'live';
  let online = true;
  const isMgr = () => role === 'manager';

  const show = (id) => ['login', 'start', 'board'].forEach((s) => { $(`#${s}`).hidden = s !== id; });

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { stopPolling(); showLogin(); throw new Error('login'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }

  function applyRole() {
    const badge = $('#roleBadge');
    badge.hidden = !role;
    badge.className = `role ${role === 'manager' ? '' : 'emp'}`;
    badge.textContent = role === 'manager' ? tr('Gerente', 'Manager') : tr('Empleado', 'Employee');
    document.querySelectorAll('.tab.mgr').forEach((b) => { b.hidden = !isMgr(); });
    if (!isMgr() && ['menu', 'store', 'sales'].includes(tab)) setTab('live');
  }

  // ---------------- Login ----------------
  let pin = '';
  function showLogin() {
    show('login'); pin = ''; drawPin(); role = null;
    $('#pinpad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].map((k) => `<button type="button" data-k="${k}">${k}</button>`).join('');
  }
  function drawPin() { $('#pinDots').innerHTML = [...pin].map(() => '<span class="on"></span>').join('') || '<span></span>'; }
  $('#pinpad').addEventListener('click', async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k; if (!k) return;
    $('#loginErr').textContent = '';
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (k === 'OK') {
      try {
        const r = await fetch('/api/kitchen/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        role = j.role; applyRole();
        pin = ''; drawPin(); show('start');
      } catch (err) { $('#loginErr').textContent = err.message === 'PIN incorrecto' ? tr('PIN incorrecto', 'Wrong PIN') : (err.message || 'Error'); pin = ''; }
    } else if (pin.length < 12) pin += k;
    drawPin();
  });

  // ---------------- Start of shift ----------------
  let audio; let wakeLock;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); poll(); } });
  $('#startBtn').onclick = async () => {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); } catch {}
    keepAwake();
    try { document.documentElement.requestFullscreen?.(); } catch {}
    show('board');
    await KPrint.reconnect();
    renderChips();
    startPolling();
  };

  function chime() {
    if (!prefs.sound || !audio) return;
    const now = audio.currentTime;
    [[880, 0], [1175, 0.18], [1568, 0.36]].forEach(([f, t]) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + t); g.gain.exponentialRampToValueAtTime(0.6, now + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.5);
      o.connect(g).connect(audio.destination); o.start(now + t); o.stop(now + t + 0.55);
    });
  }

  // ---------------- Polling ----------------
  let pollTimer; let alarmTimer; let clockTimer;
  function startPolling() {
    poll();
    clearInterval(alarmTimer); alarmTimer = setInterval(alarm, 20000);
    clearInterval(clockTimer); clockTimer = setInterval(() => { renderClock(); renderCards(); }, 15000);
    renderClock();
  }
  function stopPolling() { clearTimeout(pollTimer); clearInterval(alarmTimer); clearInterval(clockTimer); }

  async function poll() {
    clearTimeout(pollTimer);
    if ($('#board').hidden) return;
    try {
      data = await api('/api/kitchen/orders');
      online = true;
      if (data.role !== role) { role = data.role; applyRole(); }
      const ids = data.active.map((o) => o.id);
      if (known === null) {
        known = new Set(ids);
        if (data.active.some((o) => !o.printedAt && o.status === 'paid')) chime();
      } else {
        const news = data.active.filter((o) => !known.has(o.id));
        news.forEach((o) => { known.add(o.id); fresh.add(o.id); setTimeout(() => { fresh.delete(o.id); }, 4000); });
        if (news.length) chime();
      }
      autoPrint();
    } catch (e) {
      if (e.message === 'login') return;
      online = false;
    }
    render();
    pollTimer = setTimeout(poll, 4000);
  }

  function unprinted() { return data.active.filter((o) => o.status === 'paid' && !o.printedAt); }
  function alarm() {
    if (unprinted().some((o) => !acked.has(o.id) && !inflight.has(o.id))) chime();
  }

  // ---------------- Printing ----------------
  async function printOrder(o, { reprint = false } = {}) {
    for (let i = 0; i < prefs.copies; i++) {
      const label = prefs.copies > 1 ? `Copia ${i + 1} de ${prefs.copies}` : '';
      await KPrint.print(KPrint.orderTicket(o, { ascii: prefs.ascii, reprint, copyLabel: label, taxLabel: data.taxLabel }));
    }
    if (!o.printedAt) { await api(`/api/kitchen/orders/${o.id}/printed`, {}); o.printedAt = new Date().toISOString(); }
  }
  async function autoPrint() {
    if (!prefs.autoPrint) return;
    for (const o of unprinted()) {
      if (inflight.has(o.id) || Date.now() - (failedAt.get(o.id) || 0) < 15000) continue;
      inflight.add(o.id);
      try { await printOrder(o); printError = ''; failedAt.delete(o.id); }
      catch (e) { printError = e.message; failedAt.set(o.id, Date.now()); }
      finally { inflight.delete(o.id); render(); }
    }
  }

  function browserPrint(o) {
    const out = [];
    const W = 42; const rule = '-'.repeat(W);
    const hmEs = (iso) => new Intl.DateTimeFormat('es-PR', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
    out.push('EASTERN LAKE', 'ORDEN EN LINEA - PARA RECOGER', rule);
    if (o) {
      out.push(`ORDEN ${o.number}`, `RECOGER: ${o.pickupType === 'asap' ? 'LO ANTES POSIBLE ~' : 'PROGRAMADA '}${hmEs(o.pickupAt)}`, `Cliente: ${o.name}`, `Tel: ${o.phone}`, rule);
      for (const l of o.items) {
        out.push(`${l.qty} x ${l.name} (#${l.num})`);
        l.options.forEach((x) => out.push(`   > ${x.label.toUpperCase()}`));
        if (l.note) out.push(`   > NOTA: ${l.note}`);
      }
      if (o.notes) out.push(rule, 'NOTA DE LA ORDEN:', o.notes);
      out.push(rule, `TOTAL ${money(o.total)} - PAGADO`);
    } else out.push('PRUEBA DE IMPRESION');
    $('#printArea').textContent = out.join('\n');
    window.print();
  }

  // ---------------- Rendering: top bar ----------------
  function renderClock() { $('#clock').textContent = hm(new Date().toISOString()); }
  function renderChips() {
    const p = KPrint.status(); const chip = $('#printerChip');
    if (!p.supported) { chip.className = 'tb-chip warn'; chip.textContent = tr('Impresora: usa Chrome', 'Printer: use Chrome'); }
    else if (p.connected) { chip.className = 'tb-chip ok'; chip.textContent = tr('Impresora lista', 'Printer ready'); }
    else { chip.className = prefs.autoPrint ? 'tb-chip bad' : 'tb-chip warn'; chip.textContent = tr('Conectar impresora', 'Connect printer'); }
    const s = data.status || {}; const on = $('#onlineChip');
    if (!online) { on.className = 'tb-chip bad'; on.textContent = tr('Sin conexión', 'Offline'); }
    else if (data.settings?.paused) {
      on.className = 'tb-chip bad';
      on.textContent = data.settings.pausedUntil ? tr(`En línea: PAUSADO hasta ${hm(data.settings.pausedUntil)}`, `Online: PAUSED until ${hm(data.settings.pausedUntil)}`) : tr('En línea: PAUSADO', 'Online: PAUSED');
    } else if (s.canOrder) { on.className = 'tb-chip ok'; on.textContent = tr('En línea: recibiendo', 'Online: open'); }
    else { on.className = 'tb-chip warn'; on.textContent = tr('En línea: fuera de horario', 'Online: closed'); }
  }
  KPrint.onChange(() => {
    if (KPrint.status().connected) { failedAt.clear(); printError = ''; autoPrint(); }
    renderChips(); renderAlert();
  });

  function renderAlert() {
    const up = unprinted(); const el = $('#alert');
    const p = KPrint.status();
    const n = up.length; const pl = n > 1;
    let msg = '';
    if (!online) msg = tr('Sin conexión a internet — las órdenes nuevas no están llegando. Revisa el WiFi.', 'No internet connection — new orders are not coming in. Check the WiFi.');
    else if (n && prefs.autoPrint && (!p.connected || printError)) msg = tr(`${n} orden${pl ? 'es' : ''} sin imprimir — ${printError || 'impresora no conectada'}`, `${n} order${pl ? 's' : ''} not printed — ${printError || 'printer not connected'}`);
    else if (n && !prefs.autoPrint && up.some((o) => !acked.has(o.id))) msg = tr(`${n} orden${pl ? 'es' : ''} nueva${pl ? 's' : ''} sin imprimir`, `${n} new order${pl ? 's' : ''} not printed`);
    el.hidden = !msg;
    if (msg) {
      el.innerHTML = `<span>⚠ ${esc(msg)}</span>${!p.connected && p.supported && online ? `<button type="button" data-act="connect">${tr('Conectar impresora', 'Connect printer')}</button>` : ''}${online ? `<button type="button" data-act="ack">${tr('Visto', 'Got it')}</button>` : ''}`;
    }
  }
  $('#alert').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'ack') { unprinted().forEach((o) => acked.add(o.id)); renderAlert(); }
    if (a === 'connect') connectPrinter();
  });

  function render() {
    renderChips(); renderAlert();
    const n = data.today.n;
    $('#today').textContent = isMgr() && data.today.total !== undefined
      ? tr(`Hoy: ${n} orden${n === 1 ? '' : 'es'} · ${money(data.today.total)}`, `Today: ${n} order${n === 1 ? '' : 's'} · ${money(data.today.total)}`)
      : tr(`Hoy: ${n} orden${n === 1 ? '' : 'es'}`, `Today: ${n} order${n === 1 ? '' : 's'}`);
    renderCards(); if (tab === 'history') renderHistory();
  }

  // ---------------- Orders ----------------
  function card(o) {
    const now = Date.now();
    const mins = Math.max(0, Math.round((now - new Date(o.paidAt)) / 60000));
    const late = o.status === 'paid' && new Date(o.pickupAt) < now;
    const pick = o.pickupType === 'asap'
      ? `<div class="card-pick"><span>${tr('LO ANTES POSIBLE', 'ASAP')}</span><span>~${hm(o.pickupAt)}</span></div>`
      : `<div class="card-pick sched"><span>${tr('PROGRAMADA', 'SCHEDULED')}</span><span>${hm(o.pickupAt)}</span></div>`;
    // One modifier per line: removals in red capitals, extras / "aparte" highlighted, the rest plain.
    const modCls = (x) => (x.group !== 'acomp' && /\b(sin|solo)\b/i.test(x.label) ? 'rm' : /extra|aparte/i.test(x.label) ? 'add' : '');
    const items = o.items.map((l) => `<li><span class="q">${l.qty}×</span><span class="n"><small>#${l.num}</small>${esc(l.name)}</span>
      ${l.options.length ? `<div class="mods">${l.options.map((x) => `<div class="m ${modCls(x)}">${esc(x.label)}</div>`).join('')}</div>` : ''}
      ${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</li>`).join('');
    const printed = o.printedAt ? `<span class="pbadge ok">${tr('Impreso', 'Printed')}</span>` : `<span class="pbadge no">${inflight.has(o.id) ? tr('Imprimiendo…', 'Printing…') : tr('Sin imprimir', 'Not printed')}</span>`;
    const cancel = isMgr() ? `<button class="kbtn ghost danger" data-a="cancel" aria-label="${tr('Cancelar', 'Cancel')}">✕</button>` : '';
    const actions = o.status === 'paid'
      ? `<button class="kbtn ghost" data-a="print">${tr('Imprimir', 'Print')}</button>${cancel}<button class="kbtn big" data-a="ready">${tr('Lista ✓', 'Ready ✓')}</button>`
      : `<button class="kbtn ghost" data-a="back">${tr('Volver', 'Back')}</button>${cancel}<button class="kbtn big brass" data-a="done">${tr('Entregada ✓', 'Picked up ✓')}</button>`;
    const age = mins < 1 ? tr('ahora', 'now') : tr(`hace ${mins} min`, `${mins} min ago`);
    return `<article class="card ${o.status}${fresh.has(o.id) ? ' fresh' : ''}" data-id="${o.id}">
      <div class="card-head"><span class="card-num">${esc(o.number)}</span><span class="card-age${late ? ' late' : ''}">${age}${late ? tr(' · ¡atrasada!', ' · late!') : ''}</span></div>
      ${o.status === 'paid' ? pick : ''}
      <div class="card-who"><b>${esc(o.name)}</b><a href="tel:+1${o.phone.replace(/\D/g, '')}">${esc(o.phone)}</a></div>
      <ul class="card-items">${items}</ul>
      ${o.notes ? `<div class="card-note">📝 ${esc(o.notes)}</div>` : ''}
      <div class="card-meta">${printed}<span>${o.items.reduce((s, l) => s + l.qty, 0)} ${tr('art.', 'items')}</span><span class="tot">${money(o.total)}</span></div>
      <div class="card-actions${isMgr() ? '' : ' two'}">${actions}</div></article>`;
  }

  function renderCards() {
    const paid = data.active.filter((o) => o.status === 'paid').sort((a, b) => new Date(a.pickupAt) - new Date(b.pickupAt));
    const ready = data.active.filter((o) => o.status === 'ready').sort((a, b) => new Date(a.readyAt) - new Date(b.readyAt));
    $('#colNew').innerHTML = paid.map(card).join('') || `<p class="empty">${tr('No hay órdenes pendientes.', 'No pending orders.')}</p>`;
    $('#colReady').innerHTML = ready.map(card).join('') || `<p class="empty">${tr('Nada esperando por recoger.', 'Nothing waiting for pickup.')}</p>`;
    $('#newCount').textContent = paid.length; $('#readyCount').textContent = ready.length;
    $('#liveCount').textContent = data.active.length;
  }

  function renderHistory() {
    const rows = data.recent.map((o) => `<div class="hrow" data-id="${o.id}">
      <span class="mono">${esc(o.number)}</span><span>${esc(o.name)} · ${o.items.reduce((s, l) => s + l.qty, 0)} ${tr('art.', 'items')}</span>
      <span class="mono">${money(o.total)}</span>
      <span class="st ${o.status}">${o.status === 'done' ? `${tr('Entregada', 'Picked up')} ${hm(o.doneAt)}` : `${tr('Cancelada', 'Cancelled')}${o.refunded ? tr(' · reemb.', ' · refunded') : ''}`}</span>
      <button class="kbtn ghost" data-a="reprint-h" style="color:var(--ivory);border-color:rgba(246,241,231,.25)">${tr('Reimprimir', 'Reprint')}</button></div>`).join('');
    $('#history').innerHTML = rows || `<p class="empty">${tr('Todavía no hay órdenes entregadas hoy.', 'No orders picked up yet today.')}</p>`;
  }

  const PANES = { live: '#live', history: '#history', menu: '#menuTab', store: '#storeTab', sales: '#salesTab' };
  function setTab(name) {
    tab = name;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    Object.entries(PANES).forEach(([k, sel]) => { $(sel).hidden = k !== name; });
    if (name === 'history') renderHistory();
    if (name === 'menu') loadMenu();
    if (name === 'store') loadStore();
    if (name === 'sales') loadSales();
  }
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

  // ---------------- Card actions ----------------
  const findOrder = (id) => data.active.find((o) => o.id === id) || data.recent.find((o) => o.id === id);
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-a]'); if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id; const o = findOrder(id); if (!o) return;
    const a = btn.dataset.a;
    acked.add(id);
    try {
      if (a === 'print' || a === 'reprint-h') {
        btn.disabled = true;
        if (!KPrint.status().connected && !(await KPrint.reconnect())) { browserPrint(o); if (!o.printedAt) await api(`/api/kitchen/orders/${id}/printed`, {}); }
        else await printOrder(o, { reprint: !!o.printedAt });
        printError = '';
      } else if (a === 'ready') await api(`/api/kitchen/orders/${id}/status`, { status: 'ready' });
      else if (a === 'done') await api(`/api/kitchen/orders/${id}/status`, { status: 'done' });
      else if (a === 'back') await api(`/api/kitchen/orders/${id}/status`, { status: 'paid' });
      else if (a === 'cancel' && isMgr()) return confirmCancel(o);
    } catch (err) { if (err.message !== 'login') toastModal(tr('No se pudo completar', 'Could not complete'), err.message); }
    finally { btn.disabled = false; }
    poll();
  });

  // ---------------- Modals ----------------
  const modal = $('#modal');
  function toastModal(title, text) {
    $('#modalBody').innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="stack"><button class="kbtn" data-m="close">OK</button></div>`;
    modal.showModal();
  }
  function confirmCancel(o) {
    $('#modalBody').innerHTML = `<h3>${tr('Cancelar orden', 'Cancel order')} ${esc(o.number)}</h3>
      <p>${esc(o.name)} · ${money(o.total)}. ${tr('Si cancelas con reembolso, Stripe le devuelve el dinero a la tarjeta del cliente.', 'If you cancel with a refund, Stripe returns the money to the customer’s card.')}</p>
      <div class="stack">
        <button class="kbtn solid-danger" data-m="refund">${tr('Cancelar y reembolsar', 'Cancel and refund')} ${money(o.total)}</button>
        <button class="kbtn ghost danger" data-m="norefund">${tr('Cancelar sin reembolso', 'Cancel without refund')}</button>
        <button class="kbtn ghost" data-m="close">${tr('Volver', 'Back')}</button>
      </div><div class="err" id="mErr"></div>`;
    modal.dataset.id = o.id; modal.showModal();
  }
  function pinModal(forRole) {
    const who = forRole === 'manager' ? tr('gerente', 'manager') : tr('empleado', 'employee');
    $('#modalBody').innerHTML = `<h3>${tr(`Nuevo PIN de ${who}`, `New ${who} PIN`)}</h3>
      <p>${tr('De 4 a 8 números. Las tabletas que usan el PIN viejo tendrán que entrar otra vez.', '4 to 8 digits. Tablets using the old PIN will need to sign in again.')}</p>
      <div class="stack"><input class="pin-in" id="pin1" inputmode="numeric" type="password" autocomplete="off" placeholder="${tr('Nuevo PIN', 'New PIN')}">
      <input class="pin-in" id="pin2" inputmode="numeric" type="password" autocomplete="off" placeholder="${tr('Repite el PIN', 'Repeat the PIN')}">
      <button class="kbtn" data-m="savepin">${tr('Guardar PIN', 'Save PIN')}</button><button class="kbtn ghost" data-m="close">${tr('Volver', 'Back')}</button></div><div class="err" id="mErr"></div>`;
    modal.dataset.role = forRole; modal.showModal(); setTimeout(() => $('#pin1').focus(), 50);
  }
  modal.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m && e.target === modal) return modal.close();
    if (!m) return;
    if (m === 'close') return modal.close();
    try {
      if (m === 'refund' || m === 'norefund') {
        e.target.disabled = true;
        await api(`/api/kitchen/orders/${modal.dataset.id}/cancel`, { refund: m === 'refund' });
      } else if (m === 'savepin') {
        const a = $('#pin1').value.trim(); const b = $('#pin2').value.trim();
        if (a !== b) throw new Error(tr('Los PIN no son iguales.', 'The PINs don’t match.'));
        store = await api('/api/kitchen/store', { pin: { role: modal.dataset.role, value: a } });
        renderStore(); modal.close(); toastModal(tr('PIN cambiado', 'PIN changed'), tr('Usa el PIN nuevo la próxima vez que entres.', 'Use the new PIN next time you sign in.'));
        return;
      }
      modal.close(); poll();
    } catch (err) { const box = $('#mErr'); if (box) box.textContent = err.message; e.target.disabled = false; }
  });

  // ---------------- Top bar ----------------
  async function connectPrinter() {
    try { await KPrint.choose(); failedAt.clear(); printError = ''; toastModal(tr('Impresora conectada', 'Printer connected'), tr('Imprime una prueba desde Ajustes para confirmar.', 'Print a test from Settings to confirm.')); autoPrint(); }
    catch (err) { if (err.name !== 'NotFoundError') toastModal(tr('No se pudo conectar', 'Could not connect'), err.message); }
    renderChips(); renderAlert(); renderPrinterStatus();
  }
  $('#printerChip').onclick = () => (KPrint.status().connected ? openDrawer() : connectPrinter());
  $('#onlineChip').onclick = () => { if (isMgr()) setTab('store'); };
  $('#menuBtn').onclick = openDrawer;
  $('#langBtn2').onclick = () => { prefs.lang = prefs.lang === 'en' ? 'es' : 'en'; savePrefs(); applyLang(); };
  $('#langBtn').onclick = () => {
    prefs.lang = prefs.lang === 'en' ? 'es' : 'en'; savePrefs(); applyLang(); render(); renderClock();
    if (tab === 'menu') renderMenu(); if (tab === 'store') renderStore(); if (tab === 'sales') renderSales();
  };

  // ---------------- Settings drawer (printer, sound, sign out) ----------------
  const drawer = $('#drawer');
  drawer.addEventListener('click', (e) => { if (e.target === drawer || e.target.closest('[data-close]')) drawer.close(); });
  function renderPrinterStatus() {
    const p = KPrint.status();
    $('#prnStatus').textContent = !p.supported ? tr('Este navegador no permite USB. Abre esta página en Google Chrome en la tableta Android.', 'This browser can’t use USB. Open this page in Google Chrome on the Android tablet.')
      : p.connected ? tr(`Conectada: ${p.name}`, `Connected: ${p.name}`) : tr('No hay impresora conectada. Conecta el cable USB a la tableta y toca “Conectar impresora USB”.', 'No printer connected. Plug the USB cable into the tablet and tap “Connect USB printer”.');
  }
  function openDrawer() {
    renderPrinterStatus();
    $('#autoPrint').checked = prefs.autoPrint; $('#asciiPrint').checked = prefs.ascii; $('#copies').value = String(prefs.copies);
    $('#soundToggle').checked = prefs.sound;
    drawer.showModal();
  }
  $('#prnConnect').onclick = connectPrinter;
  $('#prnTest').onclick = async () => {
    try { await KPrint.print(KPrint.testTicket({ ascii: prefs.ascii })); }
    catch (err) { toastModal(tr('No se pudo imprimir', 'Could not print'), err.message); }
  };
  $('#browserPrintTest').onclick = () => browserPrint(null);
  $('#autoPrint').onchange = (e) => { prefs.autoPrint = e.target.checked; savePrefs(); render(); if (prefs.autoPrint) autoPrint(); };
  $('#asciiPrint').onchange = (e) => { prefs.ascii = e.target.checked; savePrefs(); };
  $('#copies').onchange = (e) => { prefs.copies = Number(e.target.value); savePrefs(); };
  $('#soundToggle').onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); };
  $('#soundTest').onclick = () => { if (!audio) audio = new AudioContext(); audio.resume(); const s = prefs.sound; prefs.sound = true; chime(); prefs.sound = s; };
  $('#logout').onclick = async () => { await fetch('/api/kitchen/logout', { method: 'POST' }); drawer.close(); stopPolling(); known = null; setTab('live'); showLogin(); };

  // Small "saved" flash in the corner
  let flashTimer;
  function flash(text, bad = false) {
    let el = $('#flash');
    if (!el) { el = document.createElement('div'); el.id = 'flash'; document.body.appendChild(el); }
    el.textContent = text; el.className = bad ? 'bad show' : 'show';
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.className = ''; }, 1800);
  }
  const saved = () => flash(tr('Guardado ✓', 'Saved ✓'));
  const failed = (err) => { if (err.message !== 'login') flash(err.message, true); };
  const toCents = (v) => Math.round(parseFloat(String(v).replace(/[^0-9.]/g, '')) * 100);

  // ---------------- Manager: Menu ----------------
  let menu = null; let menuCat = null; let menuSel = null; let menuQ = '';
  async function loadMenu() {
    try { menu = await api('/api/kitchen/menu'); if (!menuCat) menuCat = menu.categories[0].id; renderMenu(); } catch (e) { failed(e); }
  }
  const allItems = () => menu.categories.flatMap((c) => c.items.map((i) => ({ ...i, cat: c.id })));
  function itemSub(it) {
    const bits = [];
    if (it.unavailable) bits.push(tr('No disponible (tachado)', 'Not available (crossed out)'));
    for (const g of it.groups) {
      if (g.type === 'count') continue;
      const off = g.choices.filter((c) => c.off).length;
      if (g.choices.length > 6 || off) bits.push(`${L(g.label)} · ${g.choices.length} ${tr('opciones', 'options')}${off ? ` · ${off} ${tr('apagadas', 'off')}` : ''}`);
    }
    return bits.join(' · ');
  }
  function renderMenu() {
    if (!menu) return;
    const q = menuQ.trim().toLowerCase();
    const list = q ? allItems().filter((i) => i.name.toLowerCase().includes(q) || String(i.num).toLowerCase() === q) : menu.categories.find((c) => c.id === menuCat).items;
    const sel = menuSel && allItems().find((i) => i.id === menuSel);
    $('#menuTab').innerHTML = `<div class="menuwrap">
      <div class="mcats"><input class="search dark" id="mSearch" type="search" placeholder="${tr('Buscar plato o número', 'Search dish or number')}" value="${esc(menuQ)}">
        ${menu.categories.map((c) => `<button type="button" class="mcat${!q && c.id === menuCat ? ' on' : ''}" data-cat="${c.id}">${esc(L(c.name))}</button>`).join('')}</div>
      <div class="mlistwrap"><div class="mhdr"><span>#</span><span>${tr('Plato', 'Dish')}</span><span>${tr('Precio', 'Price')}</span><span title="${tr('Más pedido', 'Popular')}">★</span><span>${tr('Disponible', 'Available')}</span></div>
        <div class="mlist">${list.map((it) => `<div class="mrow${it.id === menuSel ? ' sel' : ''}${it.unavailable ? ' na' : ''}" data-item="${it.id}">
          <span class="n">${esc(it.num)}</span><span class="nm">${esc(it.name)}${itemSub(it) ? `<small>${esc(itemSub(it))}</small>` : ''}</span>
          <input class="price" data-price="${it.id}" inputmode="decimal" value="${(it.price / 100).toFixed(2)}">
          <button type="button" class="star${it.best ? ' on' : ''}" data-best="${it.id}" aria-label="${tr('Más pedido', 'Popular')}">★</button>
          <button type="button" class="sw${it.soldOut ? ' off' : ''}" data-avail="${it.id}"><i></i>${it.soldOut ? tr('Agotado', 'Sold out') : tr('Sí', 'Yes')}</button></div>`).join('') || `<p class="empty dark">${tr('Nada coincide.', 'No matches.')}</p>`}</div>
        <p class="mhelp">${tr('Toca un plato para cambiar su nombre o sus opciones. Los cambios se ven en el sitio al instante y quedan en el historial (Tienda).', 'Tap a dish to change its name or options. Changes show on the website right away and are kept in the change history (Store).')}</p></div>
      <div class="mpanel">${sel ? panelHtml(sel) : `<p class="empty">${tr('Escoge un plato de la lista.', 'Pick a dish from the list.')}</p>`}</div></div>`;
  }
  function panelHtml(it) {
    const groups = it.groups.map((g) => `<div class="grp"><div class="gh">${esc(L(g.label))}${g.shared ? `<span class="shared">${tr('Aplica a todas las combinaciones', 'Applies to all combos')}</span>` : ''}</div>
      ${g.choices.map((c) => `<div class="opt${c.off ? ' off' : ''}"><span>${esc(L(c.label))}</span>
        <label class="xprice">+$<input data-cprice="${esc(c.key)}" inputmode="decimal" value="${(c.price / 100).toFixed(2)}"></label>
        <button type="button" class="mini${c.off ? ' off' : ''}" data-coff="${esc(c.key)}" aria-label="${tr('Encender o apagar', 'Turn on or off')}"></button></div>`).join('')}</div>`).join('');
    return `<h3>${esc(it.name)}</h3><div class="sub">#${esc(it.num)}${it.name !== it.baseName ? ` · ${tr('antes', 'was')}: ${esc(it.baseName)}` : ''}</div>
      <label class="fld">${tr('Nombre', 'Name')}<input id="pName" value="${esc(it.name)}" maxlength="60"></label>
      <label class="fld">${tr('Precio', 'Price')}<input id="pPrice" inputmode="decimal" value="${(it.price / 100).toFixed(2)}"></label>
      <label class="chk"><input type="checkbox" id="pNA" ${it.unavailable ? 'checked' : ''}> ${tr('No disponible — se ve tachado y no se puede ordenar', 'Not available — shown crossed out and can’t be ordered')}</label>
      ${groups || `<p class="sub">${tr('Este plato no tiene opciones.', 'This dish has no options.')}</p>`}
      <p class="sub">${tr('Para añadir opciones o preguntas nuevas, pídeselo a Claude.', 'To add new options or questions, ask Claude.')}</p>`;
  }
  const replaceMenu = (m) => { menu = m; renderMenu(); saved(); };
  $('#menuTab').addEventListener('click', async (e) => {
    const t = e.target;
    const cat = t.closest('[data-cat]')?.dataset.cat;
    if (cat) { menuCat = cat; menuQ = ''; menuSel = null; return renderMenu(); }
    const best = t.closest('[data-best]')?.dataset.best;
    if (best) { const it = allItems().find((i) => i.id === best); try { replaceMenu(await api('/api/kitchen/menu/best', { id: best, on: !it.best })); } catch (err) { failed(err); } return; }
    const av = t.closest('[data-avail]')?.dataset.avail;
    if (av) { const it = allItems().find((i) => i.id === av); try { await api('/api/kitchen/soldout', { itemId: av, soldOut: !it.soldOut }); await loadMenu(); saved(); } catch (err) { failed(err); } return; }
    const off = t.closest('[data-coff]')?.dataset.coff;
    if (off) {
      const c = allItems().flatMap((i) => i.groups.flatMap((g) => g.choices)).find((x) => x.key === off);
      try { replaceMenu(await api('/api/kitchen/menu/choice', { key: off, off: !c.off })); } catch (err) { failed(err); } return;
    }
    if (t.closest('input, button, label')) return;
    const row = t.closest('[data-item]')?.dataset.item;
    if (row) { menuSel = row; renderMenu(); }
  });
  $('#menuTab').addEventListener('input', (e) => { if (e.target.id === 'mSearch') { menuQ = e.target.value; const pos = e.target.selectionStart; renderMenu(); const s = $('#mSearch'); s.focus(); s.setSelectionRange(pos, pos); } });
  $('#menuTab').addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.price) {
        const c = toCents(t.value); if (!Number.isFinite(c)) throw new Error(tr('Precio inválido', 'Invalid price'));
        replaceMenu(await api('/api/kitchen/menu/item', { id: t.dataset.price, price: c }));
      } else if (t.dataset.cprice) {
        const c = toCents(t.value || '0'); if (!Number.isFinite(c)) throw new Error(tr('Precio inválido', 'Invalid price'));
        replaceMenu(await api('/api/kitchen/menu/choice', { key: t.dataset.cprice, price: c }));
      } else if (t.id === 'pName') replaceMenu(await api('/api/kitchen/menu/item', { id: menuSel, name: t.value }));
      else if (t.id === 'pPrice') {
        const c = toCents(t.value); if (!Number.isFinite(c)) throw new Error(tr('Precio inválido', 'Invalid price'));
        replaceMenu(await api('/api/kitchen/menu/item', { id: menuSel, price: c }));
      } else if (t.id === 'pNA') replaceMenu(await api('/api/kitchen/menu/item', { id: menuSel, unavailable: t.checked }));
    } catch (err) { failed(err); loadMenu(); }
  });
  $('#menuTab').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox]):not(#mSearch)')) e.target.blur(); });

  // ---------------- Manager: Store ----------------
  let store = null; let hoursDraft = null;
  const DAYS = () => (prefs.lang === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']);
  async function loadStore() { try { store = await api('/api/kitchen/store'); hoursDraft = null; renderStore(); } catch (e) { failed(e); } }
  const fmtDate = (d) => new Intl.DateTimeFormat(prefs.lang === 'en' ? 'en-US' : 'es-PR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  const logTime = (iso) => {
    const d = new Date(iso); const today = new Date().toDateString() === d.toDateString();
    return today ? hm(iso) : new Intl.DateTimeFormat(prefs.lang === 'en' ? 'en-US' : 'es-PR', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d);
  };
  function renderStore() {
    if (!store) return;
    const s = store.settings; const h = hoursDraft || store.hours;
    const pausedTxt = s.pausedUntil ? tr(`Pausadas · vuelven ${hm(s.pausedUntil)}`, `Paused · back at ${hm(s.pausedUntil)}`) : tr('Pausadas hasta que las reanudes', 'Paused until you resume');
    $('#storeTab').innerHTML = `<div class="grid3">
      <div class="box"><h4>${tr('Órdenes en línea', 'Online orders')}</h4>
        ${s.paused ? `<div class="bigstat warn">${pausedTxt}<button type="button" class="kbtn" data-s="resume">${tr('Reanudar', 'Resume')}</button></div>`
          : `<div class="bigstat">${store.status.canOrder ? tr('Recibiendo órdenes', 'Taking orders') : tr('Fuera de horario', 'Outside hours')}</div>
             <div class="lbl">${tr('Pausar por:', 'Pause for:')}</div><div class="chips">
             ${[[15, '15 min'], [30, '30 min'], [60, tr('1 hora', '1 hour')], ['day', tr('Resto del día', 'Rest of the day')], [0, tr('Hasta reanudar', 'Until resumed')]].map(([m, t]) => `<button type="button" data-pause="${m}">${t}</button>`).join('')}</div>`}
        <h4>${tr('Tiempo de preparación', 'Prep time')}</h4>
        <div class="stepper"><button type="button" data-prep="-5">−</button><span>${s.prepMinutes} min</span><button type="button" data-prep="5">+</button></div>
        <h4>${tr('Aviso en la página de inicio', 'Homepage banner')}</h4>
        <textarea id="bText" maxlength="140" placeholder="${tr('Ej.: Hoy cerramos a las 8:00 PM', 'E.g. Today we close at 8:00 PM')}">${esc(store.banner.text)}</textarea>
        <label class="chk"><input type="checkbox" id="bShow" ${store.banner.show ? 'checked' : ''}> ${tr('Mostrar el aviso a los clientes', 'Show the banner to customers')}</label>
        <button type="button" class="kbtn" data-s="banner">${tr('Guardar aviso', 'Save banner')}</button></div>
      <div class="box"><h4>${tr('Horario', 'Hours')}</h4>
        <div class="hrs">${[1, 2, 3, 4, 5, 6, 0].map((d) => { const v = h[d] || h[String(d)]; return `<div class="hr" data-day="${d}"><span>${DAYS()[d]}</span>
          ${v ? `<input type="time" data-h="0" value="${v[0]}"><span>–</span><input type="time" data-h="1" value="${v[1]}">` : `<em>${tr('Cerrado', 'Closed')}</em>`}
          <label class="chk sm"><input type="checkbox" data-closed ${v ? '' : 'checked'}> ${tr('Cerrado', 'Closed')}</label></div>`; }).join('')}</div>
        <button type="button" class="kbtn" data-s="hours" ${hoursDraft ? '' : 'disabled'}>${tr('Guardar horario', 'Save hours')}</button>
        <h4>${tr('Días cerrados (feriados)', 'Closed days (holidays)')}</h4>
        ${store.closedDays.map((c) => `<div class="hol"><span>${esc(fmtDate(c.date))}${c.label ? ` · ${esc(c.label)}` : ''}</span><button type="button" data-unclose="${c.date}" aria-label="${tr('Quitar', 'Remove')}">✕</button></div>`).join('') || `<p class="lbl">${tr('Ninguno.', 'None.')}</p>`}
        <div class="addclosed"><input type="date" id="cDate"><input id="cLabel" maxlength="40" placeholder="${tr('Motivo (opcional)', 'Reason (optional)')}"><button type="button" class="kbtn" data-s="addclosed">${tr('Añadir', 'Add')}</button></div></div>
      <div class="box"><h4>PINs</h4>
        <div class="pinrow"><span>${tr('Empleado', 'Employee')}</span><button type="button" class="linkbtn" data-pin="employee">${tr('Cambiar', 'Change')}</button></div>
        <div class="pinrow"><span>${tr('Gerente', 'Manager')}</span><button type="button" class="linkbtn" data-pin="manager">${tr('Cambiar', 'Change')}</button></div>
        <h4>${tr('Historial de cambios', 'Change history')}</h4>
        <div class="log">${store.log.map((l) => `<div><span class="mono">${esc(logTime(l.at))}</span><span>${esc(l.msg)}</span></div>`).join('') || `<p class="lbl">${tr('Sin cambios todavía.', 'No changes yet.')}</p>`}</div></div></div>`;
  }
  async function storePost(body) { store = await api('/api/kitchen/store', body); renderStore(); saved(); }
  async function settingsPost(body) {
    const r = await api('/api/kitchen/settings', body);
    data.settings = r.settings; data.status = r.status; renderChips();
    await loadStore(); saved();
  }
  $('#storeTab').addEventListener('click', async (e) => {
    const t = e.target;
    try {
      const p = t.closest('[data-pause]')?.dataset.pause;
      if (p !== undefined) return await settingsPost({ paused: true, minutes: p === 'day' ? 'day' : Number(p) });
      const prep = t.closest('[data-prep]')?.dataset.prep;
      if (prep) return await settingsPost({ prepMinutes: Math.max(5, Math.min(120, store.settings.prepMinutes + Number(prep))) });
      const pinRole = t.closest('[data-pin]')?.dataset.pin;
      if (pinRole) return pinModal(pinRole);
      const un = t.closest('[data-unclose]')?.dataset.unclose;
      if (un) return await storePost({ removeClosed: un });
      const s = t.closest('[data-s]')?.dataset.s;
      if (s === 'resume') await settingsPost({ paused: false });
      else if (s === 'banner') await storePost({ banner: { text: $('#bText').value, show: $('#bShow').checked } });
      else if (s === 'hours') { await storePost({ hours: hoursDraft }); hoursDraft = null; renderStore(); }
      else if (s === 'addclosed') {
        if (!$('#cDate').value) throw new Error(tr('Escoge una fecha.', 'Pick a date.'));
        await storePost({ addClosed: { date: $('#cDate').value, label: $('#cLabel').value } });
      }
    } catch (err) { failed(err); }
  });
  $('#storeTab').addEventListener('change', (e) => {
    const row = e.target.closest('[data-day]'); if (!row) return;
    hoursDraft = hoursDraft || JSON.parse(JSON.stringify(store.hours));
    const d = row.dataset.day;
    if (e.target.dataset.closed !== undefined) hoursDraft[d] = e.target.checked ? null : (store.hours[d] || ['10:30', '21:30']);
    else if (e.target.dataset.h !== undefined) { hoursDraft[d] = [...(hoursDraft[d] || ['10:30', '21:30'])]; hoursDraft[d][Number(e.target.dataset.h)] = e.target.value; }
    renderStore();
  });

  // ---------------- Manager: Sales ----------------
  let sales = null; let salesRange = 'today';
  async function loadSales() { try { sales = await api(`/api/kitchen/sales?range=${salesRange}`); renderSales(); } catch (e) { failed(e); } }
  function renderSales() {
    if (!sales) return;
    const s = sales;
    const delta = (cur, prev) => {
      if (!prev) return `<span class="muted">${tr('sin datos para comparar', 'nothing to compare yet')}</span>`;
      const pct = Math.round(((cur - prev) / prev) * 100);
      return `<span class="${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% ${s.kind === 'today' ? tr('vs. mismo día la semana pasada', 'vs. same day last week') : s.kind === 'week' ? tr('vs. 7 días antes', 'vs. previous 7 days') : tr('vs. mes pasado', 'vs. last month')}</span>`;
    };
    const max = Math.max(1, ...s.buckets.map((b) => b.v));
    const bl = (k) => {
      if (s.bucketType === 'hour') { const h = Number(k); return `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`; }
      return new Intl.DateTimeFormat(prefs.lang === 'en' ? 'en-US' : 'es-PR', { day: 'numeric', timeZone: 'UTC' }).format(new Date(`${k}T12:00:00Z`));
    };
    $('#salesTab').innerHTML = `<div class="vtop"><div class="seg">
        ${[['today', tr('Hoy', 'Today')], ['week', tr('Últimos 7 días', 'Last 7 days')], ['month', tr('Este mes', 'This month')]].map(([k, t]) => `<button type="button" data-range="${k}" class="${k === salesRange ? 'on' : ''}">${t}</button>`).join('')}</div>
        <a class="kbtn brass" href="/api/kitchen/sales.csv?range=${salesRange}" download>${tr('Exportar a Excel (CSV)', 'Export to Excel (CSV)')}</a></div>
      <div class="kpis">
        <div class="kpi"><small>${tr('Ventas', 'Sales')}</small><b>${money(s.total)}</b>${delta(s.total, s.prev.total)}</div>
        <div class="kpi"><small>${tr('Órdenes', 'Orders')}</small><b>${s.orders}</b>${delta(s.orders, s.prev.orders)}</div>
        <div class="kpi"><small>${tr('Promedio por orden', 'Average order')}</small><b>${money(s.avg)}</b><span class="muted">${s.cancelled ? tr(`${s.cancelled} cancelada(s) · ${money(s.refunded)} reembolsado`, `${s.cancelled} cancelled · ${money(s.refunded)} refunded`) : tr('sin cancelaciones', 'no cancellations')}</span></div>
        <div class="kpi"><small>IVU 7%</small><b>${money(s.tax)}</b><span class="muted">${tr('incluido en ventas', 'included in sales')}</span></div></div>
      <div class="two"><div class="box"><h4>${s.bucketType === 'hour' ? tr('Órdenes por hora', 'Orders by hour') : tr('Ventas por día', 'Sales by day')}</h4>
          <div class="bars">${s.buckets.map((b) => `<div class="bar" style="height:${Math.max(2, Math.round((b.v / max) * 100))}%" title="${s.bucketType === 'hour' ? b.v : money(b.v)}"><em>${b.v ? (s.bucketType === 'hour' ? b.v : `$${Math.round(b.v / 100)}`) : ''}</em></div>`).join('')}</div>
          <div class="blab">${s.buckets.map((b) => `<span>${bl(b.k)}</span>`).join('')}</div></div>
        <div class="box"><h4>${tr('Más vendidos', 'Best sellers')}</h4>
          <div class="top">${s.topItems.map((i, n) => `<div><span class="r">${n + 1}</span><span>#${esc(i.num)} ${esc(i.name)}</span><span class="tq">×${i.qty}</span><span class="v">${money(i.total)}</span></div>`).join('') || `<p class="lbl">${tr('Todavía no hay ventas en este período.', 'No sales in this period yet.')}</p>`}</div>
          ${s.topOptions.length ? `<h4>${tr('Opciones más pedidas', 'Most chosen options')}</h4><div class="optlist">${s.topOptions.map((o) => `<span>${esc(o.label)} <b>×${o.n}</b></span>`).join('')}</div>` : ''}</div></div>`;
  }
  $('#salesTab').addEventListener('click', (e) => {
    const r = e.target.closest('[data-range]')?.dataset.range;
    if (r) { salesRange = r; loadSales(); }
  });

  // ---------------- Boot ----------------
  applyLang();
  (async () => {
    try { const me = await api('/api/kitchen/me'); role = me.role; applyRole(); show('start'); }
    catch (e) { if (e.message !== 'login') { show('start'); } }
  })();
})();
