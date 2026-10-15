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
    maxCost: 0,             // 0 = без лимита ценности; иначе пропускать дорогие
    onlyNames: [],          // подстроки названий наборов; пусто = все
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


  // --- Пакетный режим: все открытые SBC подряд ---
  // Пропускает: завершённые, неизвестные требования, не собираемые из клуба, дороже maxCost.
  async function runBatch(report) {
    let club = await loadClub();
    const sets = (await call(services.SBC.requestSets())).data.sets
      .filter((s) => !s.isComplete || !s.isComplete());
    const log = [];
    for (const set of sets) {
      if (cfg.onlyNames && cfg.onlyNames.length && !cfg.onlyNames.some((n) => set.name.includes(n))) continue;
      const chs = (await call(services.SBC.requestChallengesForSet(set))).data.challenges;
      for (const ch of chs) {
        if (ch.isCompleted && ch.isCompleted()) continue;
        const tag = `${set.name} / ${ch.name}`;
        try {
          await call(services.SBC.loadChallenge(ch));
          const req = parseRequirements(ch);
          if (!req) { log.push([tag, 'пропуск: неизвестное требование']); continue; }
          const res = FCSBC.solve(club, req, { protectRating: cfg.protectRating, protectSpecial: cfg.protectSpecial });
          if (!res.ok) { log.push([tag, 'пропуск: не собирается']); continue; }
          if (cfg.maxCost && res.cost > cfg.maxCost) { log.push([tag, `пропуск: дорого (${Math.round(res.cost)})`]); continue; }
          const used = await runChallenge(ch, set, club);
          club = club.filter((p) => !used.has(p.id));
          log.push([tag, 'выполнено']);
        } catch (e) { log.push([tag, 'ошибка: ' + (e.message || e)]); }
        report && report(log);
        await jitter(cfg.delayMin * 2, cfg.delayMax * 3);
      }
    }
    LOG('итог пакета', log);
    return log;
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

  function injectHub() {
    if (typeof UTSBCHubViewController === 'undefined') return;
    const proto = UTSBCHubViewController.prototype, orig = proto.viewDidAppear;
    proto.viewDidAppear = function (...a) {
      const r = orig.apply(this, a);
      if (!document.getElementById('fcsbc-batch')) {
        const b = document.createElement('button');
        b.id = 'fcsbc-batch'; b.textContent = '⚡ Пакет SBC';
        Object.assign(b.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999, padding: '12px 18px', borderRadius: '8px', background: '#238636', color: '#fff', border: 0, cursor: 'pointer', font: '600 15px sans-serif' });
        b.onclick = async () => {
          b.disabled = true;
          try { const log = await runBatch((l) => { b.textContent = `… ${l.length}`; }); b.textContent = `✔ ${log.filter((x) => x[1] === 'выполнено').length}/${log.length}`; }
          catch (e) { LOG('ошибка', e); b.textContent = '✖ ошибка'; }
          b.disabled = false;
        };
        document.body.appendChild(b);
      }
      return r;
    };
    const o2 = proto.viewDidDisappear;
    proto.viewDidDisappear = function (...a) { const b = document.getElementById('fcsbc-batch'); if (b) b.remove(); return o2 ? o2.apply(this, a) : undefined; };
  }

  const wait = setInterval(() => {
    if (typeof services !== 'undefined' && services.Club && typeof UTSBCSquadOverviewViewController !== 'undefined') {
      clearInterval(wait); inject(); injectHub(); LOG('готов');
    }
  }, 1000);
})();
