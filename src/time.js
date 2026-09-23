// Time helpers that work in the restaurant's timezone regardless of where the server runs.

function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour, M: +p.minute, S: +p.second, wd };
}

// Offset (ms) between the zone's wall clock and UTC at a given instant.
function offsetMs(date, tz) {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Wall-clock time in `tz` -> Date
function zonedDate(y, m, d, H, M, tz) {
  const guess = Date.UTC(y, m - 1, d, H, M);
  const off = offsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

function dayKey(date, tz) {
  const p = partsIn(date, tz);
  return `${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}${String(p.y).slice(-2)}`;
}

function fmtTime(date, tz, locale = 'es-PR') {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}

/**
 * Store status for "now": whether ordering is possible, and which pickup slots can be chosen.
 */
function storeStatus(config, { paused = false, prepMinutes, now = new Date() } = {}) {
  const tz = config.timezone;
  const p = partsIn(now, tz);
  const prep = prepMinutes ?? config.defaultPrepMinutes;
  const hours = config.hours[String(p.wd)];
  const base = { paused, prepMinutes: prep, now: now.toISOString() };

  const nextOpening = () => {
    for (let i = 0; i < 8; i++) {
      const dt = new Date(now.getTime() + i * 86400000);
      const q = partsIn(dt, tz);
      const h = config.hours[String(q.wd)];
      if (!h) continue;
      const [oh, om] = h[0].split(':').map(Number);
      const open = zonedDate(q.y, q.m, q.d, oh, om, tz);
      if (open > now) return open.toISOString();
    }
    return null;
  };

  if (!hours) return { ...base, open: false, canOrder: false, asap: false, slots: [], nextOpen: nextOpening() };

  const [oh, om] = hours[0].split(':').map(Number);
  const [ch, cm] = hours[1].split(':').map(Number);
  const openAt = zonedDate(p.y, p.m, p.d, oh, om, tz);
  const closeAt = zonedDate(p.y, p.m, p.d, ch, cm, tz);
  const lastOrderAt = new Date(closeAt.getTime() - config.lastOrderMinutesBeforeClose * 60000);
  const open = now >= openAt && now < closeAt;
  const asap = now >= openAt && now < lastOrderAt;

  // Scheduled pickup slots for later today (also allows pre-ordering before opening).
  const slotMs = config.scheduleSlotMinutes * 60000;
  const earliest = new Date(Math.max(now.getTime() + (prep + 10) * 60000, openAt.getTime() + prep * 60000));
  let t = new Date(Math.ceil(earliest.getTime() / slotMs) * slotMs);
  const slots = [];
  while (t <= lastOrderAt) { slots.push(t.toISOString()); t = new Date(t.getTime() + slotMs); }

  const canOrder = !paused && (asap || slots.length > 0);
  return {
    ...base, open, asap: asap && !paused, canOrder, slots: paused ? [] : slots,
    openAt: openAt.toISOString(), closeAt: closeAt.toISOString(), lastOrderAt: lastOrderAt.toISOString(),
    nextOpen: now >= lastOrderAt || !hours ? nextOpening() : openAt > now ? openAt.toISOString() : null,
  };
}

module.exports = { partsIn, zonedDate, dayKey, fmtTime, storeStatus };
