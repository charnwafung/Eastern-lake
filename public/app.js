(() => {
  const { t, money, time, sameDay, esc, store, toast } = EL;
  const $ = (s, r = document) => r.querySelector(s);
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  let data = null;          // /api/menu payload
  let items = new Map();    // id -> item (+category)
  let soldOut = new Set();
  let cart = store.get('el_cart_v1', []);
  const saved = store.get('el_customer', {});
  let pickup = { type: 'asap', at: null };
  let editingKey = null;    // cart line being edited in the item sheet

  // ---------------- Load ----------------
  async function load() {
    try {
      const r = await fetch('/api/menu');
      data = await r.json();
    } catch {
      $('#menu').innerHTML = `<p class="empty-search">${esc(t('network'))}</p>`;
      return;
    }
    items = new Map();
    for (const c of data.categories) for (const it of c.items) items.set(it.id, { ...it, cat: c });
    soldOut = new Set(data.soldOut);
    // Drop saved cart lines whose options no longer exist on the menu (e.g. after a menu change).
    const stillValid = (l) => {
      const it = items.get(l.id); if (!it || it.unavailable) return false;
      const groups = it.options || [];
      for (const [gid, v] of Object.entries(l.options || {})) {
        const g = groups.find((x) => x.id === gid); if (!g) return false;
        if (g.type !== 'count' && (Array.isArray(v) ? v : [v]).some((id) => id !== '' && id != null && !g.choices.some((c) => c.id === id))) return false;
      }
      try { ELOptions.normalize(it, l.options); return true; } catch { return false; }
    };
    cart = cart.filter(stillValid); saveCart();
    renderAll();
    if (new URLSearchParams(location.search).get('pago') === 'cancelado') {
      if (!cart.length) { cart = store.get('el_last_order_cart', []).filter(stillValid); saveCart(); renderMenu(); renderCartBar(); }
      toast(t('cancelled'));
      history.replaceState(null, '', '/ordenar');
      if (cart.length) openCart();
    }
    setInterval(refreshStatus, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
  }

  async function refreshStatus() {
    try {
      const r = await fetch('/api/status'); const j = await r.json();
      data.status = j.status; soldOut = new Set(j.soldOut);
      dropSoldOut(); renderStatus(); renderMenu(); renderCartBar();
      if ($('#cartSheet').open) renderCart();
    } catch {}
  }

  function dropSoldOut() {
    const gone = cart.filter((l) => soldOut.has(l.id));
    if (!gone.length) return;
    cart = cart.filter((l) => !soldOut.has(l.id)); saveCart();
    toast(t('soldOutRemoved', { n: items.get(gone[0].id).name }));
  }

  function renderAll() {
    $('#langBtn').textContent = EL.lang === 'es' ? 'EN' : 'ES';
    $('#search').placeholder = t('search');
    $('#pickupOnly').textContent = t('pickupOnly');
    $('#viewOrderLbl').textContent = t('viewOrder');
    $('#secureLbl').textContent = t('secure');
    $('#footer').innerHTML = `${esc(data.restaurant.address)}<br>${data.restaurant.phones.map((p) => `<a href="tel:+1${p.replace(/\D/g, '')}">${p}</a>`).join(' · ')}`;
    renderStatus(); renderChips(); renderMenu(); renderCartBar();
  }

  // ---------------- Status ----------------
  function renderStatus() {
    const s = data.status; const pill = $('#statusPill'); const n = $('#notice');
    const now = new Date(s.now);
    const opensLbl = (iso) => (sameDay(new Date(iso), now) ? t('opensAt', { t: time(iso) }) : t('opensTomorrow', { t: time(iso) }));
    pill.className = 'pill'; n.innerHTML = '';
    if (s.paused) {
      pill.classList.add('closed'); pill.textContent = t('paused');
      n.innerHTML = `<div class="notice warn">${esc(t('pausedNotice', { p: data.restaurant.phones[0] }))}</div>`;
    } else if (s.asap) {
      pill.textContent = `${t('open')} · ${t('closesAt', { t: time(s.closeAt) })}`;
    } else if (s.canOrder) {
      pill.classList.add('later'); pill.textContent = `${t('closed')} · ${opensLbl(s.openAt)}`;
      n.innerHTML = `<div class="notice">${esc(t('preorder', { t: time(s.openAt) }))}</div>`;
    } else {
      pill.classList.add('closed');
      pill.textContent = s.nextOpen ? `${t('closed')} · ${opensLbl(s.nextOpen)}` : t('closed');
      if (s.nextOpen) n.innerHTML = `<div class="notice warn">${esc(t('closedNotice', { t: t(sameDay(new Date(s.nextOpen), now) ? 'whenToday' : 'whenTomorrow', { t: time(s.nextOpen) }) }))}</div>`;
    }
    if (!s.asap && pickup.type === 'asap') pickup = { type: 'scheduled', at: s.slots[0] || null };
    if (pickup.type === 'scheduled' && !s.slots.includes(pickup.at)) pickup.at = s.slots[0] || null;
    if (s.asap && pickup.type === 'scheduled' && !pickup.at) pickup = { type: 'asap', at: null };
  }

  // ---------------- Menu ----------------
  function renderChips() {
    const wrap = $('#chips');
    wrap.querySelectorAll('.chip').forEach((c) => c.remove());
    for (const c of data.categories) {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.dataset.cat = c.id; b.textContent = c.name[EL.lang] || c.name.es;
      b.onclick = () => { clearSearch(); jumpTo(c.id); };
      wrap.append(b);
    }
  }

  const qtyInCart = (id) => cart.filter((l) => l.id === id).reduce((s, l) => s + l.qty, 0);

  function renderMenu() {
    const q = $('#search').value.trim().toLowerCase();
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const nq = norm(q);
    let html = ''; let shown = 0;
    for (const c of data.categories) {
      const list = c.items.filter((it) => !nq || norm(it.name).includes(nq) || String(it.num) === nq);
      if (!list.length) continue;
      shown += list.length;
      html += `<section class="cat" id="cat-${c.id}"><h2>${esc(c.name[EL.lang] || c.name.es)}</h2>`;
      html += '<ul class="items">';
      for (const it of list) {
        const na = !!it.unavailable; const so = na || soldOut.has(it.id); const q2 = qtyInCart(it.id);
        html += `<li class="item${so ? ' soldout' : ''}${na ? ' unavailable' : ''}${q2 ? ' in-cart' : ''}">
          <button class="item-main" type="button" data-open="${it.id}" ${so ? 'disabled' : ''}>
            <span class="num">${it.num}</span>
            <span><div class="item-name">${esc(it.short || it.name)}</div>${so ? `<div class="tag-soldout">${t(na ? 'notAvailable' : 'soldOut')}</div>` : ''}</span>
            <span class="item-price">${money(it.price)}</span>
          </button>
          <button class="add" type="button" data-add="${it.id}" aria-label="${esc(t('add'))} ${esc(it.name)}">${PLUS}${q2 ? `<span class="qty-badge">${q2}</span>` : ''}</button>
        </li>`;
      }
      html += '</ul></section>';
    }
    if (!shown) html = `<p class="empty-search">${esc(t('noResults', { q }))}</p>`;
    $('#menu').innerHTML = html;
    observeSections();
  }

  // Highlight the section chip and slide the chip row sideways only.
  // (scrollIntoView here would also cancel the page's own scrolling, which made scrolling jumpy.)
  function setActiveChip(id) {
    const row = $('#chips');
    row.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset.cat === id;
      c.classList.toggle('active', on);
      if (on) {
        const left = c.offsetLeft - (row.clientWidth - c.offsetWidth) / 2;
        row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
      }
    });
  }
  let jumping = false; let jumpTimer;
  function jumpTo(id) {
    const sec = document.getElementById(`cat-${id}`); if (!sec) return;
    const navH = $('.catnav').offsetHeight;
    const top = sec.getBoundingClientRect().top + window.scrollY - navH - 8;
    jumping = true; setActiveChip(id);
    window.scrollTo({ top, behavior: 'smooth' });
    const done = () => { jumping = false; clearTimeout(jumpTimer); window.removeEventListener('scrollend', done); };
    window.addEventListener('scrollend', done, { once: true });
    clearTimeout(jumpTimer); jumpTimer = setTimeout(done, 1500); // browsers without scrollend
  }
  let io;
  function observeSections() {
    io?.disconnect();
    io = new IntersectionObserver((entries) => {
      if (jumping) return;
      for (const e of entries) if (e.isIntersecting) setActiveChip(e.target.id.slice(4));
    }, { rootMargin: '-80px 0px -70% 0px' });
    document.querySelectorAll('.cat').forEach((s) => io.observe(s));
  }

  $('#menu').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'); const open = e.target.closest('[data-open]');
    const id = add?.dataset.add || open?.dataset.open;
    if (!id || soldOut.has(id) || items.get(id)?.unavailable) return;
    const it = items.get(id);
    if (add && !it.options?.length) { addToCart({ id, qty: 1, options: {}, note: '' }); toast(t('added', { n: it.name })); return; }
    openItem(id);
  });

  $('#searchToggle').onclick = () => {
    const bar = $('#searchbar'); bar.classList.toggle('show');
    if (bar.classList.contains('show')) $('#search').focus(); else clearSearch();
  };
  $('#search').addEventListener('input', () => {
    renderMenu();
    const navTop = $('.catnav').offsetTop;
    if (window.scrollY > navTop) window.scrollTo({ top: navTop });
  });
  function clearSearch() { if ($('#search').value) { $('#search').value = ''; renderMenu(); } }

  $('#langBtn').onclick = () => { EL.setLang(EL.lang === 'es' ? 'en' : 'es'); renderAll(); if ($('#cartSheet').open) renderCart(); };

  // ---------------- Item sheet ----------------
  const itemSheet = $('#itemSheet');
  let sheetQty = 1;
  function openItem(id, line) {
    const it = items.get(id); editingKey = line?.key || null;
    itemSheet.dataset.id = id;
    sheetQty = line?.qty || 1;
    $('#itemTitle').textContent = it.name;
    $('#itemSub').innerHTML = `<span class="mono num">#${it.num}</span><span class="mono price">${money(it.price)}</span>`;
    const L = (o) => (o ? o[EL.lang] || o.es : '');
    let html = '';
    for (const opt of it.options || []) {
      const multi = opt.type === 'multi';
      const prev = line?.options?.[opt.id];
      html += `<fieldset data-opt="${opt.id}" class="optgroup${multi ? ' multi' : ''}"><legend>${esc(L(opt.label))} ${opt.required ? `<span class="req">${t('required')}</span>` : ''}</legend>`;
      if (opt.hint) html += `<p class="opt-hint">${esc(L(opt.hint))}</p>`;
      if (opt.type === 'count') {
        const counts = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : opt.default || {};
        html += '<div class="choices counts">';
        for (const ch of opt.choices) {
          const n = Number(counts[ch.id] || 0);
          html += `<div class="count-row${n ? ' on' : ''}" data-choice="${ch.id}"><span class="cn">${esc(L(ch.label))}</span>${ch.price ? `<span class="extra">+${money(ch.price)} ${esc(t('each'))}</span>` : ''}
            <div class="stepper sm"><button type="button" data-cnt="-1" aria-label="Menos ${esc(L(ch.label))}">−</button><output>${n}</output><button type="button" data-cnt="1" aria-label="Más ${esc(L(ch.label))}">+</button></div></div>`;
        }
        html += `</div><div class="formerr" data-err>${t('errOption')}</div></fieldset>`;
        continue;
      }
      html += `<div class="choices${multi ? ' grid2' : ''}">`;
      for (const ch of opt.choices) {
        if (ch.sepBefore) html += '<div class="choice-sep" role="separator"></div>';
        const checked = multi ? (prev || []).includes(ch.id) : prev ? prev === ch.id : opt.default === ch.id;
        html += `<label class="choice" data-cid="${ch.id}"><input type="${multi ? 'checkbox' : 'radio'}" name="opt-${opt.id}" value="${ch.id}" ${checked ? 'checked' : ''}>
          <span>${esc(L(ch.label))}${ch.sub ? `<small class="choice-sub">${esc(L(ch.sub))}</small>` : ''}</span>${ch.price ? `<span class="extra">+${money(ch.price)}</span>` : ''}</label>`;
      }
      html += `</div><div class="formerr" data-err>${t('errOption')}</div></fieldset>`;
    }
    $('#itemBody').innerHTML = html;
    for (const g of it.options || []) if (g.type === 'count') paintCounts(itemSheet.querySelector(`fieldset[data-opt="${g.id}"]`), g);
    $('#itemBody').scrollTop = 0;
    syncGroups(false);
    updateItemFoot();
    itemSheet.showModal();
  }
  // Answers exactly as ticked in the sheet (hidden groups included; ELOptions.normalize drops them).
  function readRaw(it) {
    const raw = {};
    for (const o of it.options || []) {
      if (o.type === 'count') {
        const fs = itemSheet.querySelector(`fieldset[data-opt="${o.id}"]`); const counts = {};
        fs?.querySelectorAll('.count-row').forEach((r) => { counts[r.dataset.choice] = Number(r.querySelector('output').textContent); });
        raw[o.id] = counts; continue;
      }
      const boxes = [...itemSheet.querySelectorAll(`input[name="opt-${o.id}"]:checked`)].map((x) => x.value);
      if (boxes.length) raw[o.id] = o.type === 'multi' ? boxes : boxes[0];
    }
    return raw;
  }
  // Only what applies (for price and the cart), never throws.
  function readItemOptions(it) {
    const raw = readRaw(it); const groups = it.options || []; const sel = {};
    for (const g of groups) {
      if (!ELOptions.isVisible(groups, g, sel)) continue;
      const v = raw[g.id] ?? (g.type === 'multi' ? undefined : g.default);
      if (v != null) sel[g.id] = v;
    }
    return sel;
  }
  function unitPrice(it, options) {
    try { return ELOptions.unitPrice(it, ELOptions.normalize(it, options)); } catch { return ELOptions.unitPrice(it, options); }
  }
  // Show the follow-up questions that apply to the current answers, and bring a newly revealed one into view.
  function syncGroups(scroll = true) {
    const it = currentItem(); const groups = it.options || []; const sel = readItemOptions(it);
    let revealed = null; let pending = false; // step by step: wait until earlier required questions are answered
    for (const g of groups) {
      const fs = itemSheet.querySelector(`fieldset[data-opt="${g.id}"]`);
      const vis = !pending && ELOptions.isVisible(groups, g, sel);
      if (vis && g.required && sel[g.id] == null) pending = true;
      if (vis && fs.hidden && !revealed) revealed = fs;
      fs.hidden = !vis;
      for (const c of g.choices || []) { // choices that only apply to some answers (e.g. "Papas aparte" needs papas)
        if (!c.showIf) continue;
        const lab = fs.querySelector(`label[data-cid="${c.id}"]`); if (!lab) continue;
        const on = ELOptions.choiceShown(c, sel); lab.hidden = !on;
        if (!on) lab.querySelector('input').checked = false;
      }
    }
    if (revealed && scroll) setTimeout(() => {
      const body = $('#itemBody');
      const y = revealed.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12;
      body.scrollTo({ top: y, behavior: 'smooth' });
    }, 60);
  }
  // Keep any note an old cart line already had when it's edited; new items have none.
  function line0Note() { return editingKey ? (cart.find((l) => l.key === editingKey)?.note || '') : ''; }
  function currentItem() { return items.get(itemSheet.dataset.id); }
  function updateItemFoot() {
    const it = currentItem();
    const q = $('#itemQty'); q.querySelector('output').textContent = sheetQty;
    q.querySelector('[data-d="-1"]').disabled = sheetQty <= 1;
    q.querySelector('[data-d="1"]').disabled = sheetQty >= data.maxQty;
    const unit = unitPrice(it, readItemOptions(it));
    const total = unit * sheetQty;
    const extra = unit - it.price;
    // Spell out paid extras above the button so the higher price is never a surprise.
    const ex = $('#itemExtras'); ex.hidden = extra <= 0;
    if (extra > 0) ex.innerHTML = `<span>${esc(t('basePrice'))} ${money(it.price)}</span><span class="plus">+ ${esc(t('extrasCost'))} ${money(extra)}</span>${sheetQty > 1 ? `<span class="x">× ${sheetQty}</span>` : ''}`;
    const btn = $('#itemSubmit');
    const prev = Number(btn.dataset.total || 0);
    btn.innerHTML = `${editingKey ? t('update') : t('addToOrder')} <span class="amt">${money(total)}</span>`;
    if (prev && total > prev && btn.dataset.id === it.id) { btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump'); }
    btn.dataset.total = total; btn.dataset.id = it.id;
  }
  $('#itemQty').addEventListener('click', (e) => {
    const d = Number(e.target.closest('[data-d]')?.dataset.d); if (!d) return;
    sheetQty = Math.max(1, Math.min(data.maxQty, sheetQty + d)); updateItemFoot();
  });
  // Piece counts (e.g. muslo / cadera): the total stays fixed, so adding one of a kind takes one from another.
  function paintCounts(fs, g) {
    const sum = [...fs.querySelectorAll('.count-row output')].reduce((a, o) => a + Number(o.textContent), 0);
    fs.querySelectorAll('.count-row').forEach((r) => {
      const n = Number(r.querySelector('output').textContent);
      r.classList.toggle('on', n > 0);
      r.querySelector('[data-cnt="-1"]').disabled = n <= 0;
      r.querySelector('[data-cnt="1"]').disabled = g.total != null ? n >= g.total : sum >= (g.max ?? 99);
    });
  }
  $('#itemBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cnt]'); if (!b) return;
    const fs = b.closest('fieldset'); const g = currentItem().options.find((o) => o.id === fs.dataset.opt);
    const rows = [...fs.querySelectorAll('.count-row')]; const row = b.closest('.count-row');
    const out = (r) => r.querySelector('output'); const get = (r) => Number(out(r).textContent);
    const d = Number(b.dataset.cnt); const others = rows.filter((r) => r !== row);
    if (g.total == null) { // free counts (extras): each row on its own, up to max in all
      const sum = rows.reduce((a, r) => a + get(r), 0);
      if (d > 0 && sum < (g.max ?? 99)) out(row).textContent = get(row) + 1;
      if (d < 0 && get(row) > 0) out(row).textContent = get(row) - 1;
    } else if (d > 0) {
      const from = [...others].reverse().find((r) => get(r) > 0); if (!from || get(row) >= g.total) return;
      out(from).textContent = get(from) - 1; out(row).textContent = get(row) + 1;
    } else {
      const to = others[0]; if (!to || get(row) <= 0) return;
      out(to).textContent = get(to) + 1; out(row).textContent = get(row) - 1;
    }
    paintCounts(fs, g); fs.querySelector('[data-err]')?.classList.remove('show');
    syncGroups(); updateItemFoot();
  });
  $('#itemBody').addEventListener('change', (e) => {
    const fs = e.target.closest('fieldset');
    fs?.querySelector('[data-err]')?.classList.remove('show');
    // Multi-select: ticking "Solo X" unticks "Sin X" and vice versa.
    if (fs && e.target.type === 'checkbox' && e.target.checked) {
      const g = currentItem().options.find((o) => o.id === fs.dataset.opt);
      const c = g?.choices.find((x) => x.id === e.target.value);
      for (const other of c?.conflicts || []) { const box = fs.querySelector(`input[value="${other}"]`); if (box) box.checked = false; }
    }
    syncGroups(); updateItemFoot();
  });
  $('#itemForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const it = currentItem();
    let options;
    try { options = ELOptions.normalize(it, readRaw(it), { lang: EL.lang }); }
    catch (err) {
      const fs = itemSheet.querySelector(`fieldset[data-opt="${err.group}"]`);
      const box = fs?.querySelector('[data-err]');
      if (box) {
        box.textContent = err.message; box.classList.add('show');
        const body = $('#itemBody');
        body.scrollTo({ top: fs.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12, behavior: 'smooth' });
      }
      return;
    }
    const note = line0Note(); // per-item notes were removed from the popup
    if (editingKey) cart = cart.filter((l) => l.key !== editingKey);
    addToCart({ id: it.id, qty: sheetQty, options, note });
    const wasEditing = editingKey; editingKey = null;
    itemSheet.close();
    if (wasEditing) openCart(); else toast(t('added', { n: it.name }));
  });

  // ---------------- Cart ----------------
  const lineKey = (l) => `${l.id}|${JSON.stringify(l.options)}|${l.note}`;
  function addToCart(l) {
    const key = lineKey(l);
    const ex = cart.find((x) => x.key === key);
    if (ex) ex.qty = Math.min(data.maxQty, ex.qty + l.qty); else cart.push({ ...l, key });
    saveCart(); renderMenu(); renderCartBar();
  }
  function saveCart() { store.set('el_cart_v1', cart); }
  function totals() {
    const subtotal = cart.reduce((s, l) => s + unitPrice(items.get(l.id), l.options) * l.qty, 0);
    const tax = Math.round(subtotal * data.taxRate);
    return { subtotal, tax, total: subtotal + tax, count: cart.reduce((s, l) => s + l.qty, 0) };
  }
  function renderCartBar() {
    const tt = totals();
    $('#cartbar').classList.toggle('show', tt.count > 0);
    $('#cartCount').textContent = tt.count; $('#cartTotal').textContent = money(tt.total);
  }
  function optLabels(l) {
    const it = items.get(l.id); let out = [];
    try { out = ELOptions.summary(it, ELOptions.normalize(it, l.options), EL.lang); } catch {}
    if (l.note) out.push(`“${l.note}”`);
    return out.join(' · ');
  }

  const cartSheet = $('#cartSheet');
  function openCart() { renderCart(); cartSheet.showModal(); $('#cartBody').scrollTop = 0; }
  $('#openCart').onclick = openCart;

  function renderCart() {
    const s = data.status; const tt = totals();
    $('#cartTitle').textContent = t('yourOrder');
    $('#cartSub').textContent = `${data.restaurant.name} · ${t('pickupOnly')}`;
    if (!cart.length) {
      $('#cartBody').innerHTML = `<p class="empty-cart">${t('emptyCart')}</p>`;
      $('#cartFoot').hidden = true; return;
    }
    $('#cartFoot').hidden = false;
    let html = '<ul class="lines">';
    for (const l of cart) {
      const it = items.get(l.id);
      html += `<li class="line" data-key="${esc(l.key)}">
        <div class="line-name"><span class="num">${it.num}</span>${esc(it.name)}</div>
        <div class="line-price">${money(unitPrice(it, l.options) * l.qty)}</div>
        ${optLabels(l) ? `<div class="line-opts">${esc(optLabels(l))}</div>` : ''}
        <div class="line-ctl">
          <div class="stepper sm"><button type="button" data-q="-1" aria-label="Menos">−</button><output>${l.qty}</output><button type="button" data-q="1" aria-label="Más" ${l.qty >= data.maxQty ? 'disabled' : ''}>+</button></div>
          <button class="linkbtn" type="button" data-edit>${t('edit')}</button>
          <button class="linkbtn danger" type="button" data-rm>${t('remove')}</button>
        </div></li>`;
    }
    html += '</ul>';

    // Pickup
    html += `<div class="section-title">${t('pickup')}</div><div class="choices" style="margin-bottom:20px">`;
    if (s.asap) html += `<label class="choice"><input type="radio" name="pickup" value="asap" ${pickup.type === 'asap' ? 'checked' : ''}><span><b>${t('asap')}</b><br><small style="color:var(--muted)">${t('asapSub', { m: s.prepMinutes })}</small></span></label>`;
    if (s.slots.length) {
      html += `<label class="choice"><input type="radio" name="pickup" value="scheduled" ${pickup.type === 'scheduled' ? 'checked' : ''}><span style="flex:1"><b>${t('schedule')}</b><br><small style="color:var(--muted)">${t('scheduleSub')}</small></span></label>`;
      html += `<select id="slotSel" aria-label="${esc(t('pickTime'))}" ${pickup.type === 'scheduled' ? '' : 'hidden'}>${s.slots.map((x) => `<option value="${x}" ${x === pickup.at ? 'selected' : ''}>${time(x)}</option>`).join('')}</select>`;
    }
    html += '</div>';

    // Customer
    html += `<div class="section-title">${t('yourInfo')}</div>
      <div class="field" id="fName"><label class="label" for="cName">${t('name')}</label>
        <input class="input" id="cName" autocomplete="name" maxlength="60" value="${esc(saved.name || '')}"><div class="err">${t('errName')}</div></div>
      <div class="field" id="fPhone"><label class="label" for="cPhone">${t('phone')}</label>
        <input class="input" id="cPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="787-555-1234" value="${esc(saved.phone || '')}">
        <div class="err">${t('errPhone')}</div><div class="hint">${t('phoneHint')}</div></div>
      <div class="field"><label class="label" for="cNotes">${t('orderNotes')}</label>
        <textarea id="cNotes" maxlength="240" placeholder="${esc(t('orderNotesPh'))}">${esc(saved.notes || '')}</textarea></div>`;

    html += `<dl class="totals"><div><dt>${t('subtotal')}</dt><dd>${money(tt.subtotal)}</dd></div>
      <div><dt>${esc(data.taxLabel)}</dt><dd>${money(tt.tax)}</dd></div>
      <div class="grand"><dt>${t('total')}</dt><dd>${money(tt.total)}</dd></div></dl>`;
    $('#cartBody').innerHTML = html;
    $('#payBtn').innerHTML = `${t('pay')} <span class="amt">${money(tt.total)}</span>`;
    $('#payBtn').disabled = !s.canOrder;
    $('#payErr').classList.remove('show');
  }

  $('#cartBody').addEventListener('click', (e) => {
    const li = e.target.closest('.line'); if (!li) return;
    const l = cart.find((x) => x.key === li.dataset.key); if (!l) return;
    const q = Number(e.target.closest('[data-q]')?.dataset.q);
    if (q) { l.qty += q; if (l.qty < 1) cart = cart.filter((x) => x !== l); }
    else if (e.target.closest('[data-rm]')) cart = cart.filter((x) => x !== l);
    else if (e.target.closest('[data-edit]')) { rememberForm(); cartSheet.close(); openItem(l.id, l); return; }
    else return;
    rememberForm(); saveCart(); renderCart(); renderMenu(); renderCartBar();
  });
  $('#cartBody').addEventListener('change', (e) => {
    if (e.target.name === 'pickup') {
      pickup = e.target.value === 'asap' ? { type: 'asap', at: null } : { type: 'scheduled', at: pickup.at || data.status.slots[0] };
      $('#slotSel')?.toggleAttribute('hidden', pickup.type !== 'scheduled');
    }
    if (e.target.id === 'slotSel') pickup.at = e.target.value;
  });
  $('#cartBody').addEventListener('input', (e) => { e.target.closest('.field')?.classList.remove('invalid'); });
  function rememberForm() {
    if (!$('#cName')) return;
    saved.name = $('#cName').value; saved.phone = $('#cPhone').value; saved.notes = $('#cNotes').value;
  }

  $('#payBtn').onclick = async () => {
    rememberForm();
    const name = saved.name.trim(); const digits = saved.phone.replace(/\D/g, '');
    let ok = true;
    if (name.length < 2) { $('#fName').classList.add('invalid'); ok = false; }
    if (digits.length < 10 || digits.length > 11) { $('#fPhone').classList.add('invalid'); ok = false; }
    if (!ok) { cartSheet.querySelector('.invalid .input').focus(); return; }
    store.set('el_customer', { name: saved.name, phone: saved.phone });
    const btn = $('#payBtn'); btn.disabled = true; btn.textContent = t('paying');
    try {
      const r = await fetch('/api/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map(({ id, qty, options, note }) => ({ id, qty, options, note })),
          name, phone: saved.phone, notes: saved.notes, pickup, lang: EL.lang,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Error');
      store.set('el_last_order_cart', cart);
      cart = []; saveCart();
      location.href = j.url;
    } catch (err) {
      const box = $('#payErr'); box.textContent = err.message === 'Failed to fetch' ? t('network') : err.message; box.classList.add('show');
      btn.disabled = false; btn.innerHTML = `${t('pay')} <span class="amt">${money(totals().total)}</span>`;
      refreshStatus();
    }
  };

  // Freeze the menu behind an open popup (and put it back exactly where it was).
  let lockedY = 0;
  function lockPage() {
    if (document.body.classList.contains('locked')) return;
    lockedY = window.scrollY;
    document.body.style.top = `-${lockedY}px`;
    document.body.classList.add('locked');
  }
  function unlockPage() {
    if (document.querySelector('dialog.sheet[open]') || !document.body.classList.contains('locked')) return;
    document.body.classList.remove('locked'); document.body.style.top = '';
    window.scrollTo({ top: lockedY, behavior: 'instant' });
  }
  for (const d of document.querySelectorAll('dialog.sheet')) {
    new MutationObserver(() => (d.open ? lockPage() : unlockPage())).observe(d, { attributes: true, attributeFilter: ['open'] });
  }

  // Close buttons + tap outside to close
  document.querySelectorAll('dialog.sheet').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) { if (d === cartSheet) rememberForm(); d.close(); } });
  });

  load();
})();
