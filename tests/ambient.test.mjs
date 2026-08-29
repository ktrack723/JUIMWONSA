// node --test tests/ambient.test.mjs — 병영 소음 풀.
//
// 이 파일이 지키는 것 하나: **스프라이트 대사는 하루의 콜 수를 늘리지 않는다.**
// 잡담은 부임 때 한 번 받아 눕히고, 군가는 units.js의 static 인용이라 아예 공짜다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbientPool } from '../js/ambient.js';
import { UNIT_BY_ID, songLines } from '../js/units.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
};
const marine = UNIT_BY_ID['marine-fort'];   // songMode chorus
const air = UNIT_BY_ID['airforce-sys'];     // songMode broadcast

const LINES = [
  { slot: 'reveille', text: '또 아침이네' }, { slot: 'reveille', text: '모포 각 좀 잡아라' },
  { slot: 'breakfast', text: '오늘도 국이 미지근하다' },
  { slot: 'lunch', text: '배식 줄 왜 이렇게 기냐' },
];
const seq = arr => { let i = 0; return () => (i < arr.length ? arr[i++] : 0.999); };

test('빈 풀은 ready가 아니다 — 엔진이 그걸 보고 한 번만 채운다', () => {
  const p = new AmbientPool(marine, { storage: memStorage() });
  assert.equal(p.ready(), false);
  assert.equal(p.size(), 0);
});

test('fill은 슬롯별로 눕히고 빈 줄·중복을 걸러낸다', () => {
  const p = new AmbientPool(marine, { storage: memStorage() });
  const n = p.fill([...LINES, { slot: 'reveille', text: '또 아침이네' }, { slot: '', text: 'x' }, { slot: 'lunch', text: '  ' }]);
  assert.equal(n, 4, '중복과 빈 줄이 안 걸러졌다');
  assert.deepEqual(p.chatter.reveille, ['또 아침이네', '모포 각 좀 잡아라']);
  assert.ok(p.ready());
});

test('저장·로드가 왕복한다 — 부임당 한 콜의 근거다', () => {
  const storage = memStorage();
  new AmbientPool(marine, { storage }).fill(LINES);
  const again = new AmbientPool(marine, { storage });
  assert.ok(again.load(), '저장된 풀을 못 집었다 — 매 부팅마다 다시 부르게 된다');
  assert.equal(again.size(), 4);
  again.clear();
  assert.equal(new AmbientPool(marine, { storage }).load(), false);
});

test('부대마다 저장 자리가 다르다 — 해병 소음이 공군에서 나오지 않는다', () => {
  const storage = memStorage();
  new AmbientPool(marine, { storage }).fill(LINES);
  assert.equal(new AmbientPool(air, { storage }).load(), false);
});

test('군가는 저장되지 않는다 — units.js가 언제나 원본이다', () => {
  const storage = memStorage();
  const p = new AmbientPool(marine, { storage });
  p.fill(LINES);
  const saved = JSON.parse(storage.getItem(`csm_ambient_${marine.id}`));
  assert.deepEqual(Object.keys(saved), ['chatter'], '군가가 캐시에 눌러앉았다');
  for (const s of songLines(marine)) {
    assert.ok(!JSON.stringify(saved).includes(s.text), `군가 「${s.text}」가 저장됐다`);
  }
});

test('군가는 songSlots에서만 나온다 — 자리는 부대 데이터가 정한다', () => {
  const p = new AmbientPool(marine, { storage: memStorage() });
  p.fill(LINES);
  assert.ok(p.singsAt('reveille'), '해병 아침점호에 군가가 없다');
  assert.ok(!p.singsAt('lunch'), '점심에 군가가 울린다');
  // rng 0 = 군가 확률을 무조건 통과
  assert.equal(p.pick('reveille', seq([0, 0])).kind, 'song');
  assert.equal(p.pick('lunch', seq([0, 0])).kind, 'chatter', '군가 자리가 아닌데 군가가 나왔다');
});

test('군가 인용은 units.js의 그 소절 그대로다 — 화면이 지어내지 않는다', () => {
  const p = new AmbientPool(marine, { storage: memStorage() });
  const got = p.pick('reveille', seq([0, 0]));
  const known = songLines(marine).map(s => s.text);
  assert.ok(known.includes(got.text), `풀 밖의 가사가 나왔다: ${got.text}`);
  assert.equal(got.mode, 'chorus');
  assert.ok(got.title, '어느 곡인지가 안 실렸다');
});

test('부르는 방식이 부대마다 다르게 실린다 — 목이냐 스피커냐', () => {
  const m = new AmbientPool(marine, { storage: memStorage() }).pick('reveille', seq([0, 0]));
  const a = new AmbientPool(air, { storage: memStorage() }).pick('reveille', seq([0, 0]));
  assert.equal(m.mode, 'chorus');
  assert.equal(a.mode, 'broadcast');
  assert.notEqual(m.text, a.text, '두 부대가 같은 군가를 부른다');
});

test('풀이 비어도 군가 자리에서는 소리가 난다 — A 호출이 실패해도 무대는 산다', () => {
  const p = new AmbientPool(marine, { storage: memStorage() });
  assert.equal(p.pick('reveille', seq([0, 0])).kind, 'song');
  assert.equal(p.pick('lunch', seq([0.9])), null, '빈 슬롯에서 없는 말을 지어냈다');
});

test('picks는 서로 다른 대사를 준다 — 셋이 같은 말을 하지 않는다', () => {
  const p = new AmbientPool(marine, { storage: memStorage() });
  p.fill([
    { slot: 'lunch', text: 'A' }, { slot: 'lunch', text: 'B' }, { slot: 'lunch', text: 'C' },
  ]);
  const got = p.picks('lunch', 3, Math.random);
  assert.equal(new Set(got.map(g => g.text)).size, got.length);
  // 후보보다 많이 달라고 하면 있는 만큼만 준다 — 무한루프에 안 빠진다
  assert.ok(p.picks('lunch', 99, Math.random).length <= 3);
});
