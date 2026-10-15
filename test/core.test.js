const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');

function makePool(n, seed = 7) {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, (_, i) => ({
    id: i, rating: 65 + Math.floor(r() * 22), club: Math.floor(r() * 30),
    league: Math.floor(r() * 8), nation: Math.floor(r() * 20),
    rarity: r() < 0.4 ? 'rare' : r() < 0.05 ? 'special' : 'common',
  }));
}

test('squadRating: одинаковые рейтинги', () => {
  assert.strictEqual(C.squadRating(Array(11).fill(83)), 83);
});
test('squadRating: превышение над средним повышает рейтинг', () => {
  assert.ok(C.squadRating([90, 90, 90, 80, 80, 80, 80, 80, 80, 80, 80]) > 82);
});
test('solve: выполняет рейтинг, редкие и лиги', () => {
  const req = { size: 11, minRating: 84, rules: [
    { kind: 'count', field: 'rarity', key: 'rare', op: 'min', n: 3 },
    { kind: 'distinct', field: 'league', op: 'min', n: 2 },
  ] };
  const res = C.solve(makePool(600), req, { seed: 3 });
  assert.ok(res.ok);
  assert.ok(res.rating >= 84);
  assert.strictEqual(C.violations(res.players, req), 0);
  assert.strictEqual(new Set(res.players.map((p) => p.id)).size, 11);
});
test('solve: химия выполняется', () => {
  const req = { size: 11, minRating: 80, minChem: 20 };
  const res = C.solve(makePool(800), req, { seed: 5 });
  assert.ok(res.ok);
  assert.ok(res.chem >= 20);
});
test('solve: дубликаты и непродаваемые выбираются первыми', () => {
  const pool = makePool(300);
  pool.forEach((p) => { p.rating = Math.min(p.rating, 76); });
  pool.slice(0, 11).forEach((p) => { p.rating = 78; p.duplicate = true; p.untradeable = true; });
  const res = C.solve(pool, { size: 11, minRating: 78 }, { seed: 2 });
  assert.ok(res.ok);
  assert.ok(res.players.filter((p) => p.duplicate).length >= 9);
});
test('solve: защищённые карточки не берутся', () => {
  const res = C.solve(makePool(400), { size: 11, minRating: 80 }, { protectRating: 85, seed: 4 });
  assert.ok(res.ok);
  assert.ok(res.players.every((p) => p.rating < 85));
});
test('solve: невыполнимо -> ok=false', () => {
  const res = C.solve(makePool(100), { size: 11, minRating: 99 }, { seed: 1 });
  assert.strictEqual(res.ok, false);
});
