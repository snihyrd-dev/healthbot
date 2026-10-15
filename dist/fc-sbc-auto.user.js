// ==UserScript==
// @name         FC SBC Auto
// @namespace    healthbot
// @version      0.1.0
// @description  Анализ клуба и автосборка SBC в EA FC Web App
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*
// @match        https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Ядро подбора состава. Не зависит от браузера и EA — тестируется в Node.
const FCSBC = (() => {
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


// ===== Обвязка для EA FC Web App =====
// ВНИМАНИЕ: всё, что обращается к внутренним классам EA (services, UT*), написано по
// известным конвенциям Web App и не проверено на живом приложении — см. README, «Калибровка».
(() => {
  'use strict';
  const LOG = (...a) => console.log('[FC-SBC]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => sleep(min + Math.random() * (max - min)); // «человеческие» паузы

  const cfg = Object.assign({
    protectRating: 86,      // карточки с рейтингом >= этого не трогаем
    protectSpecial: true,   // особые карточки (TOTW, промо) не трогаем
    maxRepeats: 1,          // сколько раз подряд выполнить повторяемый SBC
    submit: true,           // true = отправлять сам; false = только заполнить
    delayMin: 900, delayMax: 2200,
  }, JSON.parse(localStorage.getItem('fcsbc.cfg') || '{}'));

  // --- Обёртка над observable EA: promise ---
  const call = (obs) => new Promise((resolve, reject) => {
    const ctx = {};
    obs.observe(ctx, (sender, res) => {
      sender.unobserve(ctx);
      res && res.success === false ? reject(res) : resolve(res);
    });
  });

  // --- Клуб ---
  function toPlayer(it) {
    const rarity = it.rareflag === 0 ? 'common' : it.rareflag === 1 ? 'rare' : 'special';
    return {
      id: it.id, defId: it.definitionId, rating: it.rating,
      club: it.teamId, league: it.leagueId, nation: it.nationId,
      position: it.preferredPosition, rarity,
      icon: it.rareflag === 12 || it.rareflag === 47, // иконы/хиро; уточнить по сезону
      untradeable: it.untradeable === true || (it.isTradeable && !it.isTradeable()),
      duplicate: it.isDuplicate ? it.isDuplicate() : false,
      locked: !!(it.isInUse && it.isInUse()) || !!it.loans, // в составе/в аренде
      _item: it,
    };
  }

  async function loadClub() {
    const out = [];
    for (let offset = 0; ; offset += 91) {
      const c = new UTSearchCriteriaDTO();
      c.type = 'player'; c.count = 91; c.offset = offset;
      const res = await call(services.Club.search(c));
      const items = (res.response && res.response.items) || [];
      out.push(...items);
      if (items.length < 91) break;
      await jitter(cfg.delayMin / 3, cfg.delayMax / 3);
    }
    LOG('клуб загружен:', out.length);
    return out.map(toPlayer).filter((p) => p.rating);
  }

  // --- Требования челленджа -> формат ядра ---
  // Возвращает null, если встретилось неизвестное требование (тогда ничего не делаем).
  function parseRequirements(challenge) {
    const req = { size: 11, rules: [] };
    const K = (typeof SBCEligibilityKey !== 'undefined') ? SBCEligibilityKey : {};
    const keyName = (v) => Object.keys(K).find((k) => K[k] === v);
    const opOf = (scope) => (scope === 0 ? 'exact' : scope === 1 ? 'min' : 'max'); // SBCEligibilityScope
    for (const r of challenge.eligibilityRequirements || []) {
      const kv = r.getFirstKV ? r.getFirstKV() : null;
      const name = kv ? keyName(kv._key !== undefined ? kv._key : kv.key) : null;
      const val = kv ? (kv._value !== undefined ? kv._value : kv.value) : null;
      const n = r.count, op = opOf(r.scope);
      switch (name) {
        case 'TEAM_RATING': req.minRating = n; break;
        case 'TEAM_CHEMISTRY': req.minChem = n; break;
        case 'PLAYER_COUNT': req.size = n; break;
        case 'PLAYER_RARITY': req.rules.push({ kind: 'count', field: 'rarity', key: val === 1 ? 'rare' : 'common', op, n }); break;
        case 'PLAYER_LEVEL': req.rules.push({ kind: 'count', field: 'tier', key: ['bronze', 'silver', 'gold'][val] || 'gold', op, n }); break;
        case 'NATION_ID': req.rules.push({ kind: 'count', field: 'nation', key: val, op, n }); break;
        case 'LEAGUE_ID': req.rules.push({ kind: 'count', field: 'league', key: val, op, n }); break;
        case 'CLUB_ID': req.rules.push({ kind: 'count', field: 'club', key: val, op, n }); break;
        case 'NATION_COUNT': req.rules.push({ kind: 'distinct', field: 'nation', op, n }); break;
        case 'LEAGUE_COUNT': req.rules.push({ kind: 'distinct', field: 'league', op, n }); break;
        case 'CLUB_COUNT': req.rules.push({ kind: 'distinct', field: 'club', op, n }); break;
        case 'SAME_NATION_COUNT': req.rules.push({ kind: 'same', field: 'nation', op, n }); break;
        case 'SAME_LEAGUE_COUNT': req.rules.push({ kind: 'same', field: 'league', op, n }); break;
        case 'SAME_CLUB_COUNT': req.rules.push({ kind: 'same', field: 'club', op, n }); break;
        default:
          LOG('неизвестное требование, останавливаюсь:', name, val, n, r);
          return null;
      }
    }
    return req;
  }

  // --- Один челлендж ---
  async function runChallenge(challenge, set, club) {
    const req = parseRequirements(challenge);
    if (!req) throw new Error('Не распознал требования SBC (см. консоль)');
    const res = FCSBC.solve(club, req, { protectRating: cfg.protectRating, protectSpecial: cfg.protectSpecial, seed: Date.now() & 0xffff });
    if (!res.ok) throw new Error('Состав не собирается из клуба: ' + res.reason);
    LOG(`подобрано: рейтинг ${res.rating}, химия~${res.chem}, ценность ${Math.round(res.cost)}`);
    await jitter(cfg.delayMin, cfg.delayMax);

    challenge.squad.setPlayers(res.players.map((p) => p._item), true);
    await jitter(cfg.delayMin, cfg.delayMax);
    if (!challenge.canSubmit || !challenge.canSubmit()) {
      throw new Error('EA не засчитал состав (возможно, химия/позиции). Состав оставлен на экране.');
    }
    // использованные карточки больше не доступны для следующего повтора
    const used = new Set(res.players.map((p) => p.id));
    if (cfg.submit) {
      await call(services.SBC.submitChallenge(challenge, set, true, true));
      LOG('отправлено');
    }
    return used;
  }

  async function runCurrent(ctrl) {
    const challenge = ctrl._challenge, set = ctrl._set;
    if (!challenge) throw new Error('Не нашёл открытый челлендж');
    let club = await loadClub();
    for (let i = 0; i < cfg.maxRepeats; i++) {
      const used = await runChallenge(challenge, set, club);
      club = club.filter((p) => !used.has(p.id));
      await jitter(cfg.delayMin * 2, cfg.delayMax * 2);
      if (i + 1 < cfg.maxRepeats) {
        await call(services.SBC.loadChallenge(challenge)); // перезагрузка для повтора
      }
    }
  }

  // --- UI: кнопка на экране состава SBC ---
  function inject() {
    const proto = UTSBCSquadOverviewViewController.prototype;
    const orig = proto.viewDidAppear;
    proto.viewDidAppear = function (...a) {
      const r = orig.apply(this, a);
      if (!document.getElementById('fcsbc-btn')) {
        const b = document.createElement('button');
        b.id = 'fcsbc-btn'; b.textContent = '⚡ Авто-сборка';
        Object.assign(b.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999, padding: '12px 18px', borderRadius: '8px', background: '#1f6feb', color: '#fff', border: 0, cursor: 'pointer', font: '600 15px sans-serif' });
        b.onclick = async () => {
          b.disabled = true; b.textContent = '… собираю';
          try { await runCurrent(this); b.textContent = '✔ готово'; }
          catch (e) { LOG('ошибка', e); b.textContent = '✖ ' + (e.message || 'ошибка').slice(0, 40); }
          setTimeout(() => { b.disabled = false; b.textContent = '⚡ Авто-сборка'; }, 4000);
        };
        document.body.appendChild(b);
      }
      return r;
    };
    const orig2 = proto.viewDidDisappear;
    proto.viewDidDisappear = function (...a) {
      const b = document.getElementById('fcsbc-btn'); if (b) b.remove();
      return orig2 ? orig2.apply(this, a) : undefined;
    };
  }

  const wait = setInterval(() => {
    if (typeof services !== 'undefined' && services.Club && typeof UTSBCSquadOverviewViewController !== 'undefined') {
      clearInterval(wait); inject(); LOG('готов');
    }
  }, 1000);
})();
