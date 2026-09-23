// Item option rules, shared by the browser (window.ELOptions) and the server (require).
// Option group fields:
//   id, label{es,en}, type: 'single' | 'multi', required, default (choice id)
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
      if (g.type === 'multi') {
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
      for (const id of Array.isArray(v) ? v : [v]) {
        const c = g.choices.find((x) => x.id === id);
        if (c) out.push({ group: g.id, choice: c });
      }
    }
    return out;
  }

  const unitPrice = (item, sel) => item.price + chosen(item, sel).reduce((s, x) => s + (x.choice.price || 0), 0);

  // Short labels for the cart, Stripe receipt, kitchen screen and ticket.
  const summary = (item, sel, lang = 'es') => chosen(item, sel).filter((x) => x.choice.summary !== null).map((x) => L(x.choice.summary || x.choice.label, lang));

  return { OptionError, isVisible, normalize, chosen, unitPrice, summary };
});
