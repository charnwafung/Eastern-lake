// Shared helpers for the customer pages.
window.EL = (() => {
  const STR = {
    es: {
      orderNow: 'Ordenar ahora', orderNowSub: 'Para recoger · listo en ~{m} min', orderLaterSub: 'Para recoger · programa tu orden',
      viewMenu: 'Ver menú', viewMenuSub: 'Platos y precios', servicarro: 'Servicarro y órdenes por teléfono disponibles',
      hoursT: 'Horario', everyDay: 'Todos los días, de lunes a domingo', todayHours: 'Hoy', closedToday: 'Cerrado hoy', callUs: 'Llámanos',
      menuTitle: 'Menú', menuSub: 'Precios no incluyen IVU · Para recoger en Villa Andalucía', back: 'Volver',
      comboNote: 'Con arroz y papas, arroz y tostones (+$2.50), o solo', miniNote: 'Con arroz frito, papas, arroz blanco o tostones', vegNote: 'Vegetales mixtos o brócoli',
      open: 'Abierto', closesAt: 'cierra {t}', closed: 'Cerrado', opensAt: 'abre {t}', opensTomorrow: 'abre mañana {t}',
      paused: 'Órdenes en línea en pausa', preorder: 'Abre a las {t} — puedes ordenar ahora para recoger más tarde.',
      closedNotice: 'Estamos cerrados ahora. Puedes ver el menú; las órdenes en línea abren {t}.', whenToday: 'hoy a las {t}', whenTomorrow: 'mañana a las {t}',
      pausedNotice: 'No estamos aceptando órdenes en línea en este momento. Llámanos al {p}.',
      pickupOnly: 'Solo para recoger', search: 'Buscar en el menú', noResults: 'No encontramos nada con “{q}”.',
      viewOrder: 'Ver orden', add: 'Añadir', addToOrder: 'Añadir', update: 'Actualizar', soldOut: 'Agotado',
      required: 'Requerido', notes: 'Instrucciones especiales', notesPh: 'Ej.: sin cebolla, salsa aparte', optional: 'opcional',
      yourOrder: 'Tu orden', edit: 'Editar', remove: 'Quitar', emptyCart: 'Tu orden está vacía.',
      pickup: 'Recogido', asap: 'Lo antes posible', asapSub: 'Listo en ~{m} min', schedule: 'Programar hora', scheduleSub: 'Hoy',
      pickTime: 'Escoge la hora',
      yourInfo: 'Tus datos', name: 'Nombre', phone: 'Teléfono', phoneHint: 'Te llamamos solo si hay algún problema con tu orden.',
      orderNotes: 'Nota para el restaurante', orderNotesPh: 'Opcional',
      subtotal: 'Subtotal', total: 'Total', pay: 'Pagar', paying: 'Abriendo pago seguro…',
      secure: 'Pago seguro con Stripe · tarjetas, Apple Pay y Google Pay',
      errName: 'Escribe tu nombre.', errPhone: 'Escribe un teléfono de 10 dígitos.', errOption: 'Escoge una opción.',
      added: 'Añadido: {n}', cancelled: 'Pago cancelado. Tu orden sigue aquí.', network: 'No hay conexión. Intenta otra vez.',
      soldOutRemoved: '{n} se agotó y se quitó de tu orden.',
      // status page
      orderNo: 'Orden', confirming: 'Confirmando tu pago…', received: '¡Recibimos tu orden!', receivedSub: 'Te avisamos aquí cuando esté lista.',
      ready: '¡Tu orden está lista!', readySub: 'Pasa a recogerla. Menciona tu número de orden.',
      doneT: 'Orden recogida', doneSub: '¡Gracias por tu compra! Buen provecho.',
      cancelledT: 'Orden cancelada', cancelledSub: 'Llámanos si tienes preguntas.', refunded: 'Se reembolsó el pago a tu tarjeta.',
      expiredT: 'El pago no se completó', expiredSub: 'No se hizo ningún cargo. Puedes intentarlo otra vez.',
      stepPaid: 'Pagado', stepKitchen: 'En cocina', stepReady: 'Lista',
      pickupAround: 'Recoger aprox.', pickupAt: 'Recoger a las', directions: 'Cómo llegar', call: 'Llamar',
      backToMenu: 'Volver al menú', newOrder: 'Nueva orden', notFound: 'No encontramos esa orden.', keepOpen: 'Esta página se actualiza sola.',
      paidTotal: 'Total pagado',
    },
    en: {
      orderNow: 'Order now', orderNowSub: 'Pickup · ready in ~{m} min', orderLaterSub: 'Pickup · schedule your order',
      viewMenu: 'View menu', viewMenuSub: 'Dishes & prices', servicarro: 'Drive-through and phone orders available',
      hoursT: 'Hours', everyDay: 'Every day, Monday to Sunday', todayHours: 'Today', closedToday: 'Closed today', callUs: 'Call us',
      menuTitle: 'Menu', menuSub: 'Prices before IVU tax · Pickup at Villa Andalucía', back: 'Back',
      comboNote: 'With rice & fries, rice & tostones (+$2.50), or plain', miniNote: 'With fried rice, fries, white rice or tostones', vegNote: 'Mixed vegetables or broccoli',
      open: 'Open', closesAt: 'closes {t}', closed: 'Closed', opensAt: 'opens {t}', opensTomorrow: 'opens tomorrow {t}',
      paused: 'Online ordering paused', preorder: 'Opens at {t} — you can order now for later pickup.',
      closedNotice: 'We’re closed right now. You can browse the menu; online ordering opens {t}.', whenToday: 'today at {t}', whenTomorrow: 'tomorrow at {t}',
      pausedNotice: 'We’re not taking online orders right now. Please call {p}.',
      pickupOnly: 'Pickup only', search: 'Search the menu', noResults: 'Nothing matches “{q}”.',
      viewOrder: 'View order', add: 'Add', addToOrder: 'Add', update: 'Update', soldOut: 'Sold out',
      required: 'Required', notes: 'Special instructions', notesPh: 'e.g. no onions, sauce on the side', optional: 'optional',
      yourOrder: 'Your order', edit: 'Edit', remove: 'Remove', emptyCart: 'Your order is empty.',
      pickup: 'Pickup', asap: 'As soon as possible', asapSub: 'Ready in ~{m} min', schedule: 'Schedule a time', scheduleSub: 'Today',
      pickTime: 'Choose a time',
      yourInfo: 'Your details', name: 'Name', phone: 'Phone', phoneHint: 'We’ll only call if there’s a problem with your order.',
      orderNotes: 'Note for the restaurant', orderNotesPh: 'Optional',
      subtotal: 'Subtotal', total: 'Total', pay: 'Pay', paying: 'Opening secure checkout…',
      secure: 'Secure payment by Stripe · cards, Apple Pay & Google Pay',
      errName: 'Please enter your name.', errPhone: 'Please enter a 10-digit phone number.', errOption: 'Please choose an option.',
      added: 'Added: {n}', cancelled: 'Payment cancelled. Your order is still here.', network: 'No connection. Please try again.',
      soldOutRemoved: '{n} sold out and was removed from your order.',
      orderNo: 'Order', confirming: 'Confirming your payment…', received: 'We got your order!', receivedSub: 'This page will tell you when it’s ready.',
      ready: 'Your order is ready!', readySub: 'Come pick it up — mention your order number.',
      doneT: 'Order picked up', doneSub: 'Thank you! Enjoy your meal.',
      cancelledT: 'Order cancelled', cancelledSub: 'Please call us with any questions.', refunded: 'Your payment was refunded to your card.',
      expiredT: 'Payment wasn’t completed', expiredSub: 'You were not charged. You can try again.',
      stepPaid: 'Paid', stepKitchen: 'In the kitchen', stepReady: 'Ready',
      pickupAround: 'Pickup around', pickupAt: 'Pickup at', directions: 'Directions', call: 'Call',
      backToMenu: 'Back to menu', newOrder: 'New order', notFound: 'We couldn’t find that order.', keepOpen: 'This page updates by itself.',
      paidTotal: 'Total paid',
    },
  };

  // Spanish unless the customer picked English with the ES/EN button (remembered on their device).
  let lang = 'es';
  try { lang = localStorage.getItem('el_lang_v2') || 'es'; } catch {}
  if (!STR[lang]) lang = 'es';

  const t = (k, vars = {}) => (STR[lang][k] ?? STR.es[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const TZ = 'America/Puerto_Rico';
  const time = (iso) => new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-PR', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  const sameDay = (a, b) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(a) === new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(b);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  function setLang(l) { lang = l; try { localStorage.setItem('el_lang_v2', l); } catch {} document.documentElement.lang = l; }
  document.documentElement.lang = lang;

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  return { t, money, time, sameDay, esc, store, toast, setLang, get lang() { return lang; } };
})();
