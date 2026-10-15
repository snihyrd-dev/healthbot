// Ядро подбора состава. Не зависит от браузера и EA — тестируется в Node.
const Core = (() => {
  // Рейтинг состава по формуле EA: сумма + превышение над средним, округление.
  function squadRating(ratings) {
    const n = ratings.length;
    if (!n) return 0;
    const sum = ratings.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const excess = ratings.reduce((a, r) => a + Math.max(0, r - avg), 0);
    return Math.round((sum + excess) / n - 1e-9);
  }

  const tierOf = (r) => (r >= 75 ? 'gold' : r >= 65 ? 'silver' : 'bronze');

  // Химия: упрощённая модель (игроки в родных позициях) — верхняя оценка.
  function chemistry(players) {
    const cnt = (f) => players.reduce((m, p) => (m[p[f]] = (m[p[f]] || 0) + 1, m), {});
    const club = cnt('club'), nat = cnt('nation'), lg = cnt('league');
    const pts = (c, t) => (c >= t[2] ? 3 : c >= t[1] ? 2 : c >= t[0] ? 1 : 0);
    let total = 0;
    for (const p of players) {
      if (p.icon) { total += 3; continue; }
      const v = pts(club[p.club], [2, 4, 7]) + pts(nat[p.nation], [2, 5, 8]) + pts(lg[p.league], [3, 5, 8]);
      total += Math.min(3, v);
    }
    return total;
  }

  // Цена «ценности» карточки: чем выше, тем меньше хочется её тратить.
  function defaultCost(p, cfg = {}) {
    if (p.locked) return Infinity;
    if (cfg.protectRating && p.rating >= cfg.protectRating) return Infinity;
    if (cfg.protectSpecial && p.rarity === 'special') return Infinity;
    let c = Math.pow(1.45, p.rating - 60) * 10;
    if (p.rarity === 'rare') c *= 1.5;
    if (p.rarity === 'special') c *= 6;
    if (p.untradeable) c *= 0.35;   // непродаваемые тратим в первую очередь
    if (p.duplicate) c *= 0.5;      // дубликаты — тоже
    return c;
  }

  // Нарушения ограничений (0 = всё выполнено).
  function violations(sel, req) {
    let v = 0;
    const r = squadRating(sel.map((p) => p.rating));
    if (req.minRating && r < req.minRating) v += (req.minRating - r) * 3;
    if (req.minChem) {
      const c = chemistry(sel);
      if (c < req.minChem) v += req.minChem - c;
    }
    for (const rule of req.rules || []) {
      const get = (p) => (rule.field === 'tier' ? tierOf(p.rating) : p[rule.field]);
      let have;
      if (rule.kind === 'count') {
        have = sel.filter((p) => get(p) === rule.key).length;
      } else if (rule.kind === 'distinct') {
        have = new Set(sel.map(get)).size;
      } else if (rule.kind === 'same') {
        const m = {};
        for (const p of sel) m[get(p)] = (m[get(p)] || 0) + 1;
        have = Math.max(0, ...Object.values(m));
      } else continue;
      if (rule.op === 'min' && have < rule.n) v += rule.n - have;
      if (rule.op === 'max' && have > rule.n) v += have - rule.n;
      if (rule.op === 'exact' && have !== rule.n) v += Math.abs(have - rule.n);
    }
    return v;
  }

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * solve(pool, req, opts) -> {ok, players, rating, chem, cost, violations}
   * req: {size, minRating, minChem, rules:[{kind,field,key,op,n}]}
   * Имитация отжига с несколькими перезапусками; нарушения штрафуются сильнее любой цены.
   */
  function solve(pool, req, opts = {}) {
    const size = req.size || 11;
    const costFn = opts.cost || ((p) => defaultCost(p, opts));
    const cand = pool.map((p) => ({ ...p, _c: costFn(p) })).filter((p) => isFinite(p._c));
    if (cand.length < size) return { ok: false, reason: 'not-enough-players', players: [] };
    const rnd = mulberry32(opts.seed || 1);
    const PEN = 1e6;
    const restarts = opts.restarts || 12, iters = opts.iterations || 6000;
    const score = (idx) => {
      const sel = idx.map((i) => cand[i]);
      const viol = violations(sel, req);
      return { s: sel.reduce((a, p) => a + p._c, 0) + PEN * viol, viol, sel };
    };
    let best = null;
    const byCost = cand.map((_, i) => i).sort((a, b) => cand[a]._c - cand[b]._c);
    for (let r = 0; r < restarts; r++) {
      const used = new Set();
      let idx = [];
      // старт: дешёвые + шум; в каждом перезапуске разный
      const window = Math.min(cand.length, size * (2 + r * 3));
      while (idx.length < size) {
        const i = byCost[Math.floor(rnd() * window)];
        if (!used.has(i)) { used.add(i); idx.push(i); }
      }
      let cur = score(idx);
      for (let k = 0; k < iters; k++) {
        const T = 1 - k / iters;
        const slot = Math.floor(rnd() * size);
        // 70%: из «вероятно дешёвых», 30%: любой
        const ni = rnd() < 0.7 ? byCost[Math.floor(rnd() * Math.min(cand.length, 400))] : Math.floor(rnd() * cand.length);
        if (used.has(ni)) continue;
        const old = idx[slot];
        idx[slot] = ni;
        const nxt = score(idx);
        const d = nxt.s - cur.s;
        const accept = d <= 0 || rnd() < Math.exp(-d / (Math.max(1, cur.s * 0.02) * T + 1e-9));
        if (accept) { used.delete(old); used.add(ni); cur = nxt; }
        else idx[slot] = old;
        if (cur.viol === 0 && (!best || cur.s < best.s)) best = { ...cur };
      }
      if (cur.viol === 0 && (!best || cur.s < best.s)) best = { ...cur };
    }
    if (!best) return { ok: false, reason: 'infeasible', players: [] };
    const players = best.sel.map(({ _c, ...p }) => p);
    return {
      ok: true,
      players,
      rating: squadRating(players.map((p) => p.rating)),
      chem: chemistry(players),
      cost: best.sel.reduce((a, p) => a + p._c, 0),
      violations: 0,
    };
  }

  return { squadRating, chemistry, tierOf, defaultCost, violations, solve };
})();
if (typeof module !== 'undefined') module.exports = Core;
