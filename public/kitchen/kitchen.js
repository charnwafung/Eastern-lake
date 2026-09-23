(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const TZ = 'America/Puerto_Rico';
  const hm = (iso) => new Intl.DateTimeFormat('es-PR', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));

  // Per-tablet preferences
  const prefs = (() => {
    const d = { autoPrint: true, ascii: false, copies: 1, sound: true };
    try { return { ...d, ...JSON.parse(localStorage.getItem('el_kitchen_prefs') || '{}') }; } catch { return d; }
  })();
  const savePrefs = () => { try { localStorage.setItem('el_kitchen_prefs', JSON.stringify(prefs)); } catch {} };

  let data = { active: [], recent: [], settings: {}, status: {}, today: { n: 0, total: 0 } };
  let known = null;             // ids seen so far (null until first load)
  const fresh = new Set();      // ids to flash
  const inflight = new Set();   // printing right now
  const failedAt = new Map();   // id -> time of last failed print
  const acked = new Set();      // alarm acknowledged
  let printError = '';
  let tab = 'live';
  let online = true;

  const show = (id) => ['login', 'start', 'board'].forEach((s) => { $(`#${s}`).hidden = s !== id; });

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { stopPolling(); showLogin(); throw new Error('login'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }

  // ---------------- Login ----------------
  let pin = '';
  function showLogin() {
    show('login'); pin = ''; drawPin();
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
        pin = ''; drawPin(); show('start');
      } catch (err) { $('#loginErr').textContent = err.message || 'Error'; pin = ''; }
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
    const L = [];
    const W = 42; const rule = '-'.repeat(W);
    L.push('EASTERN LAKE', 'ORDEN EN LINEA - PARA RECOGER', rule);
    if (o) {
      L.push(`ORDEN ${o.number}`, `RECOGER: ${o.pickupType === 'asap' ? 'LO ANTES POSIBLE ~' : 'PROGRAMADA '}${hm(o.pickupAt)}`, `Cliente: ${o.name}`, `Tel: ${o.phone}`, rule);
      for (const l of o.items) {
        L.push(`${l.qty} x ${l.name} (#${l.num})`);
        l.options.forEach((x) => L.push(`   > ${x.label.toUpperCase()}`));
        if (l.note) L.push(`   > NOTA: ${l.note}`);
      }
      if (o.notes) L.push(rule, 'NOTA DE LA ORDEN:', o.notes);
      L.push(rule, `TOTAL ${money(o.total)} - PAGADO`);
    } else L.push('PRUEBA DE IMPRESION');
    $('#printArea').textContent = L.join('\n');
    window.print();
  }

  // ---------------- Rendering ----------------
  function renderClock() {
    $('#clock').textContent = hm(new Date().toISOString());
  }
  function renderChips() {
    const p = KPrint.status(); const chip = $('#printerChip');
    if (!p.supported) { chip.className = 'tb-chip warn'; chip.textContent = 'Impresora: usa Chrome'; }
    else if (p.connected) { chip.className = 'tb-chip ok'; chip.textContent = 'Impresora lista'; }
    else { chip.className = prefs.autoPrint ? 'tb-chip bad' : 'tb-chip warn'; chip.textContent = 'Conectar impresora'; }
    const s = data.status || {}; const on = $('#onlineChip');
    if (!online) { on.className = 'tb-chip bad'; on.textContent = 'Sin conexión'; }
    else if (data.settings?.paused) { on.className = 'tb-chip bad'; on.textContent = 'En línea: PAUSADO'; }
    else if (s.canOrder) { on.className = 'tb-chip ok'; on.textContent = 'En línea: recibiendo'; }
    else { on.className = 'tb-chip warn'; on.textContent = 'En línea: fuera de horario'; }
  }
  KPrint.onChange(() => {
    if (KPrint.status().connected) { failedAt.clear(); printError = ''; autoPrint(); }
    renderChips(); renderAlert();
  });

  function renderAlert() {
    const up = unprinted(); const el = $('#alert');
    const p = KPrint.status();
    let msg = '';
    if (!online) msg = 'Sin conexión a internet — las órdenes nuevas no están llegando. Revisa el WiFi.';
    else if (up.length && prefs.autoPrint && (!p.connected || printError)) msg = `${up.length} orden${up.length > 1 ? 'es' : ''} sin imprimir — ${printError || 'impresora no conectada'}`;
    else if (up.length && !prefs.autoPrint && up.some((o) => !acked.has(o.id))) msg = `${up.length} orden${up.length > 1 ? 'es' : ''} nueva${up.length > 1 ? 's' : ''} sin imprimir`;
    el.hidden = !msg;
    if (msg) {
      el.innerHTML = `<span>⚠ ${esc(msg)}</span>${!p.connected && p.supported && online ? '<button type="button" data-act="connect">Conectar impresora</button>' : ''}${online ? '<button type="button" data-act="ack">Visto</button>' : ''}`;
    }
  }
  $('#alert').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'ack') { unprinted().forEach((o) => acked.add(o.id)); renderAlert(); }
    if (a === 'connect') connectPrinter();
  });

  function render() {
    renderChips(); renderAlert();
    $('#today').textContent = `Hoy: ${data.today.n} orden${data.today.n === 1 ? '' : 'es'} · ${money(data.today.total)}`;
    renderCards(); if (tab === 'history') renderHistory();
  }

  function card(o) {
    const now = Date.now();
    const mins = Math.max(0, Math.round((now - new Date(o.paidAt)) / 60000));
    const late = o.status === 'paid' && new Date(o.pickupAt) < now;
    const pick = o.pickupType === 'asap'
      ? `<div class="card-pick"><span>LO ANTES POSIBLE</span><span>~${hm(o.pickupAt)}</span></div>`
      : `<div class="card-pick sched"><span>PROGRAMADA</span><span>${hm(o.pickupAt)}</span></div>`;
    const items = o.items.map((l) => `<li><span class="q">${l.qty}×</span><span class="n">${esc(l.name)}<small>#${l.num}</small></span>
      ${l.options.length ? `<span class="mods">${esc(l.options.map((x) => x.label).join(' · '))}</span>` : ''}
      ${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</li>`).join('');
    const printed = o.printedAt ? '<span class="pbadge ok">Impreso</span>' : `<span class="pbadge no">${inflight.has(o.id) ? 'Imprimiendo…' : 'Sin imprimir'}</span>`;
    const actions = o.status === 'paid'
      ? `<button class="kbtn ghost" data-a="print">Imprimir</button><button class="kbtn ghost danger" data-a="cancel" aria-label="Cancelar">✕</button><button class="kbtn big" data-a="ready">Lista ✓</button>`
      : `<button class="kbtn ghost" data-a="back">Volver</button><button class="kbtn ghost danger" data-a="cancel" aria-label="Cancelar">✕</button><button class="kbtn big brass" data-a="done">Entregada ✓</button>`;
    return `<article class="card ${o.status}${fresh.has(o.id) ? ' fresh' : ''}" data-id="${o.id}">
      <div class="card-head"><span class="card-num">${esc(o.number)}</span><span class="card-age${late ? ' late' : ''}">${mins < 1 ? 'ahora' : `hace ${mins} min`}${late ? ' · ¡atrasada!' : ''}</span></div>
      ${o.status === 'paid' ? pick : ''}
      <div class="card-who"><b>${esc(o.name)}</b><a href="tel:+1${o.phone.replace(/\D/g, '')}">${esc(o.phone)}</a></div>
      <ul class="card-items">${items}</ul>
      ${o.notes ? `<div class="card-note">📝 ${esc(o.notes)}</div>` : ''}
      <div class="card-meta">${printed}<span>${o.items.reduce((s, l) => s + l.qty, 0)} art.</span><span class="tot">${money(o.total)}</span></div>
      <div class="card-actions">${actions}</div></article>`;
  }

  function renderCards() {
    const paid = data.active.filter((o) => o.status === 'paid').sort((a, b) => new Date(a.pickupAt) - new Date(b.pickupAt));
    const ready = data.active.filter((o) => o.status === 'ready').sort((a, b) => new Date(a.readyAt) - new Date(b.readyAt));
    $('#colNew').innerHTML = paid.map(card).join('') || '<p class="empty">No hay órdenes pendientes.</p>';
    $('#colReady').innerHTML = ready.map(card).join('') || '<p class="empty">Nada esperando por recoger.</p>';
    $('#newCount').textContent = paid.length; $('#readyCount').textContent = ready.length;
    $('#liveCount').textContent = data.active.length;
  }

  function renderHistory() {
    const rows = data.recent.map((o) => `<div class="hrow" data-id="${o.id}">
      <span class="mono">${esc(o.number)}</span><span>${esc(o.name)} · ${o.items.reduce((s, l) => s + l.qty, 0)} art.</span>
      <span class="mono">${money(o.total)}</span>
      <span class="st ${o.status}">${o.status === 'done' ? `Entregada ${hm(o.doneAt)}` : `Cancelada${o.refunded ? ' · reemb.' : ''}`}</span>
      <button class="kbtn ghost" data-a="reprint-h" style="color:var(--ivory);border-color:rgba(246,241,231,.25)">Reimprimir</button></div>`).join('');
    $('#history').innerHTML = rows || '<p class="empty">Todavía no hay órdenes entregadas hoy.</p>';
  }

  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    $('#live').hidden = tab !== 'live'; $('#history').hidden = tab !== 'history';
    if (tab === 'history') renderHistory();
  });

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
      else if (a === 'cancel') return confirmCancel(o);
    } catch (err) { if (err.message !== 'login') toastModal('No se pudo completar', err.message); }
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
    $('#modalBody').innerHTML = `<h3>Cancelar orden ${esc(o.number)}</h3>
      <p>${esc(o.name)} · ${money(o.total)}. Si cancelas con reembolso, Stripe le devuelve el dinero a la tarjeta del cliente.</p>
      <div class="stack">
        <button class="kbtn solid-danger" data-m="refund">Cancelar y reembolsar ${money(o.total)}</button>
        <button class="kbtn ghost danger" data-m="norefund">Cancelar sin reembolso</button>
        <button class="kbtn ghost" data-m="close">Volver</button>
      </div><div class="err" id="mErr"></div>`;
    modal.dataset.id = o.id; modal.showModal();
  }
  function confirmPause(paused) {
    $('#modalBody').innerHTML = paused
      ? `<h3>¿Pausar órdenes en línea?</h3><p>Los clientes verán que no estamos aceptando órdenes en línea. Las órdenes ya pagadas no se afectan.</p>
         <div class="stack"><button class="kbtn solid-danger" data-m="pause">Pausar</button><button class="kbtn ghost" data-m="close">Volver</button></div>`
      : `<h3>¿Reanudar órdenes en línea?</h3><p>Los clientes podrán ordenar otra vez (dentro del horario).</p>
         <div class="stack"><button class="kbtn" data-m="resume">Reanudar</button><button class="kbtn ghost" data-m="close">Volver</button></div>`;
    modal.showModal();
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
      } else if (m === 'pause' || m === 'resume') {
        await api('/api/kitchen/settings', { paused: m === 'pause' });
        $('#pausedToggle').checked = m === 'pause';
      }
      modal.close(); poll();
    } catch (err) { const box = $('#mErr'); if (box) box.textContent = err.message; e.target.disabled = false; }
  });

  // ---------------- Top bar ----------------
  async function connectPrinter() {
    try { await KPrint.choose(); failedAt.clear(); printError = ''; toastModal('Impresora conectada', 'Imprime una prueba desde Ajustes para confirmar.'); autoPrint(); }
    catch (err) { if (err.name !== 'NotFoundError') toastModal('No se pudo conectar', err.message); }
    renderChips(); renderAlert(); renderPrinterStatus();
  }
  $('#printerChip').onclick = () => (KPrint.status().connected ? openDrawer() : connectPrinter());
  $('#onlineChip').onclick = () => confirmPause(!data.settings?.paused);
  $('#menuBtn').onclick = openDrawer;

  // ---------------- Settings drawer ----------------
  const drawer = $('#drawer');
  drawer.addEventListener('click', (e) => { if (e.target === drawer || e.target.closest('[data-close]')) drawer.close(); });
  function renderPrinterStatus() {
    const p = KPrint.status();
    $('#prnStatus').textContent = !p.supported ? 'Este navegador no permite USB. Abre esta página en Google Chrome en la tableta Android.'
      : p.connected ? `Conectada: ${p.name}` : 'No hay impresora conectada. Conecta el cable USB a la tableta y toca “Conectar impresora USB”.';
  }
  async function openDrawer() {
    renderPrinterStatus();
    $('#autoPrint').checked = prefs.autoPrint; $('#asciiPrint').checked = prefs.ascii; $('#copies').value = String(prefs.copies);
    $('#soundToggle').checked = prefs.sound;
    $('#pausedToggle').checked = !!data.settings?.paused;
    $('#prepSel').innerHTML = [10, 15, 20, 25, 30, 35, 40, 45, 50, 60].map((m) => `<option value="${m}" ${m === data.settings?.prepMinutes ? 'selected' : ''}>${m} min</option>`).join('');
    drawer.showModal();
    loadSoldOut();
  }
  $('#prnConnect').onclick = connectPrinter;
  $('#prnTest').onclick = async () => {
    try { await KPrint.print(KPrint.testTicket({ ascii: prefs.ascii })); }
    catch (err) { toastModal('No se pudo imprimir', err.message); }
  };
  $('#browserPrintTest').onclick = () => browserPrint(null);
  $('#autoPrint').onchange = (e) => { prefs.autoPrint = e.target.checked; savePrefs(); render(); if (prefs.autoPrint) autoPrint(); };
  $('#asciiPrint').onchange = (e) => { prefs.ascii = e.target.checked; savePrefs(); };
  $('#copies').onchange = (e) => { prefs.copies = Number(e.target.value); savePrefs(); };
  $('#soundToggle').onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); };
  $('#soundTest').onclick = () => { if (!audio) audio = new AudioContext(); audio.resume(); const s = prefs.sound; prefs.sound = true; chime(); prefs.sound = s; };
  $('#pausedToggle').onchange = async (e) => {
    try { data = { ...data, ...(await api('/api/kitchen/settings', { paused: e.target.checked })) }; render(); } catch (err) { e.target.checked = !e.target.checked; }
  };
  $('#prepSel').onchange = async (e) => { try { const r = await api('/api/kitchen/settings', { prepMinutes: Number(e.target.value) }); data.settings = r.settings; } catch {} };
  $('#logout').onclick = async () => { await fetch('/api/kitchen/logout', { method: 'POST' }); drawer.close(); stopPolling(); known = null; showLogin(); };

  let soMenu = null;
  async function loadSoldOut() {
    try { soMenu = await api('/api/kitchen/menu'); renderSoldOut(); } catch {}
  }
  function renderSoldOut() {
    if (!soMenu) return;
    const q = $('#soSearch').value.trim().toLowerCase();
    const so = new Set(soMenu.soldOut);
    let html = '';
    for (const c of soMenu.categories) {
      const list = c.items.filter((i) => !q || i.name.toLowerCase().includes(q) || String(i.num) === q);
      if (!list.length) continue;
      html += `<h4>${esc(c.name.es)}</h4>` + list.map((i) => `<label class="${so.has(i.id) ? 'on' : ''}"><input type="checkbox" data-so="${i.id}" ${so.has(i.id) ? 'checked' : ''}><span class="num">${i.num}</span>${esc(i.name)}${so.has(i.id) ? ' — AGOTADO' : ''}</label>`).join('');
    }
    $('#soList').innerHTML = html || '<p class="set-status" style="padding:12px">Nada coincide.</p>';
  }
  $('#soSearch').oninput = renderSoldOut;
  $('#soList').addEventListener('change', async (e) => {
    const id = e.target.dataset.so; if (!id) return;
    try { const r = await api('/api/kitchen/soldout', { itemId: id, soldOut: e.target.checked }); soMenu.soldOut = r.soldOut; } catch {}
    renderSoldOut();
  });

  // ---------------- Boot ----------------
  (async () => {
    try { await api('/api/kitchen/orders'); show('start'); }
    catch (e) { if (e.message !== 'login') { show('start'); } }
  })();
})();
