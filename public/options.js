// Item option rules, shared by the browser (window.ELOptions) and the server (require).
// Option group fields:
//   id, label{es,en}, type: 'single' | 'multi' | 'count', required, default (choice id)
//   'count': the customer splits `total` pieces between the choices, e.g. { muslo: 3, cadera: 2 };
//            default is a counts object; each choice's price is charged per piece.
//            Without `total` the counts are free (0 up to `max` pieces in all), e.g. optional extra pieces.
//   showIf: { group, in: [choice ids] }  -> only asked when an earlier group has one of those answers
//   choices: [{ id, label{es,en}, summary{es,en}?, sub{es,en}?, price (cents), conflicts: [choice ids] }]
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.ELOptions = lib;
})(typeof self !== 'undefined' ? self : this, () => {
  class OptionError extends Error {
    constructor(message, group) { super(message); this.group = group; }
  }

  const L = (obj, lang) => (obj ? obj[lang] || obj.es : '');

  // Which groups are currently asked, given the answers so far (a group is hidden if the group it depends on is hidden).
  function isVisible(groups, group, sel, seen = new Set()) {
    if (!group.showIf) return true;
    if (seen.has(group.id)) return false;
    seen.add(group.id);
    const dep = groups.find((g) => g.id === group.showIf.group);
    if (!dep || !isVisible(groups, dep, sel, seen)) return false;
    return group.showIf.in.includes(sel[dep.id]);
  }

  /**
   * Clean up raw answers: drop answers to hidden groups, apply defaults, validate ids and conflicts.
   * Throws OptionError when a required answer is missing or something is invalid.
   */
  function normalize(item, raw = {}, { lang = 'es' } = {}) {
    const groups = item.options || [];
    const sel = {};
    for (const g of groups) {
      if (!isVisible(groups, g, sel)) continue;
      const val = raw ? raw[g.id] : undefined;
      if (g.type === 'count') {
        if (val != null && val !== '' && (typeof val !== 'object' || Array.isArray(val))) throw new OptionError('Opción inválida.', g.id);
        const src = val || g.default || {};
        const counts = {}; let sum = 0;
        for (const [id, n] of Object.entries(src)) {
          if (!g.choices.some((c) => c.id === id)) throw new OptionError('Opción inválida.', g.id);
          const k = Number(n);
          if (!Number.isInteger(k) || k < 0 || k > (g.total ?? g.max ?? 99)) throw new OptionError('Cantidad inválida.', g.id);
          sum += k;
        }
        if (g.total != null && sum !== g.total) throw new OptionError(`${L(g.label, lang)}: escoge ${g.total} en total.`, g.id);
        if (g.total == null && g.max != null && sum > g.max) throw new OptionError(`${L(g.label, lang)}: máximo ${g.max}.`, g.id);
        if (!sum) { if (g.required) throw new OptionError(`Escoge una opción: ${L(g.label, lang)}.`, g.id); continue; }
        for (const c of g.choices) { const k = Number(src[c.id] || 0); if (k) counts[c.id] = k; } // menu order
        sel[g.id] = counts;
      } else if (g.type === 'multi') {
        const ids = [...new Set((Array.isArray(val) ? val : val ? [val] : []).map(String))];
        for (const id of ids) if (!g.choices.some((c) => c.id === id)) throw new OptionError('Opción inválida.', g.id);
        for (const id of ids) {
          const c = g.choices.find((x) => x.id === id);
          const clash = (c.conflicts || []).find((x) => ids.includes(x));
          if (clash) {
            const other = g.choices.find((x) => x.id === clash);
            throw new OptionError(`No puedes escoger “${L(c.label, lang)}” y “${L(other.label, lang)}” a la vez.`, g.id);
          }
        }
        if (g.required && !ids.length) throw new OptionError(`Escoge una opción: ${L(g.label, lang)}.`, g.id);
        if (ids.length) sel[g.id] = g.choices.filter((c) => ids.includes(c.id)).map((c) => c.id); // menu order
      } else {
        const id = val != null && val !== '' ? String(val) : g.default;
        const c = g.choices.find((x) => x.id === id);
        if (!c) {
          if (g.required) throw new OptionError(`Escoge una opción: ${L(g.label, lang)}.`, g.id);
          continue;
        }
        sel[g.id] = c.id;
      }
    }
    return sel;
  }

  function chosen(item, sel) {
    const out = [];
    for (const g of item.options || []) {
      const v = sel[g.id];
      if (v == null) continue;
      if (g.type === 'count') {
        for (const c of g.choices) if (v[c.id]) out.push({ group: g.id, choice: c, qty: v[c.id] });
        continue;
      }
      for (const id of Array.isArray(v) ? v : [v]) {
        const c = g.choices.find((x) => x.id === id);
        if (c) out.push({ group: g.id, choice: c });
      }
    }
    return out;
  }

  const unitPrice = (item, sel) => item.price + chosen(item, sel).reduce((s, x) => s + (x.choice.price || 0) * (x.qty || 1), 0);

  // Short labels for the cart, Stripe receipt, kitchen screen and ticket.
  const label = (x, lang = 'es') => (x.qty ? `${x.qty} ${L(x.choice.label, lang)}` : L(x.choice.summary || x.choice.label, lang));
  const summary = (item, sel, lang = 'es') => chosen(item, sel).filter((x) => x.choice.summary !== null).map((x) => label(x, lang));

  return { OptionError, isVisible, normalize, chosen, unitPrice, summary, label };
});
