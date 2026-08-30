// node --test tests/incidents.test.mjs — 사고 유형 대장의 계약.
//
// 이 게임에서 지침은 자유롭게 쓰지만 **사건의 씨앗은 풀 밖으로 안 나간다**(EVENT_POOL).
// 그래서 장면이 아무리 갈라져도 유형은 언제나 열둘 중 하나로 떨어지고, 유형 하나에
// 그림 한 장이 대응한다. 여기서 지키는 것은 그 대응이 안 끊기는가다 —
//   · 풀의 모든 항목이 아는 유형을 쓰는가 (확전 후 넘어갈 유형까지)
//   · 유형 열둘이 전부 풀에서 도달 가능한가 (그림이 노는 유형이 없는가)
//   · 유형마다 그림 파일이 실제로 디스크에 있는가
//   · 프롬프트로 나가는 표기(en)가 영어인가 — 지시문은 영어다 (§9.4)
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { UNITS } from '../js/units.js';
import * as PM from '../js/params.js';
import {
  INCIDENT_CATEGORIES, CATEGORY_KEYS, CATEGORY_CLASSES, EVENT_POOL, PLACES, SLOTS,
  ABSENCE_KINDS, absenceFor, TUNING,
  categoryFor, artFor, pickEvent, pullWeight,
} from '../js/params.js';

const SLOT_KINDS = new Set(SLOTS.flatMap(s => [s.kind, s.weekendKind].filter(Boolean)));
const exists = async rel => access(new URL(`../${rel}`, import.meta.url)).then(() => true, () => false);

// ── 유형 대장 ───────────────────────────────────────────
test('유형마다 이름·갈래·글자·영문 표기가 있고, 갈래는 셋뿐이다', () => {
  assert.ok(CATEGORY_KEYS.length >= 10, '유형이 너무 적다 — 이미지가 붙을 자리가 없다');
  for (const [id, c] of Object.entries(INCIDENT_CATEGORIES)) {
    assert.match(id, /^[a-z-]+$/, `${id}: 유형 id는 파일 이름이 된다 — 소문자 영문이어야 한다`);
    assert.ok(c.label, `${id}: 화면 이름이 없다`);
    assert.ok(c.icon, `${id}: 그림이 없을 때 세울 글자가 없다`);
    assert.ok(CATEGORY_CLASSES[c.class], `${id}: 모르는 갈래 「${c.class}」`);
  }
  // 군이 실제로 쓰는 구분이다 — 이 셋은 이름을 바꾸면 안 된다 (docs/research.md §14)
  assert.deepEqual(Object.keys(CATEGORY_CLASSES).sort(), ['discipline', 'personnel', 'safety']);
});

test('프롬프트로 나가는 표기는 전부 영어다 — 지시문 언어와 같아야 한다', () => {
  const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿ﾠ-ￜ]/;
  for (const [id, c] of Object.entries(INCIDENT_CATEGORIES)) {
    assert.ok(c.en, `${id}: 프롬프트 표기(en)가 없다`);
    assert.ok(!HANGUL.test(c.en), `${id}: en에 한글이 들어 있다 — E-1 지시문으로 새어 나간다`);
  }
});

test('유형마다 그림 파일이 있다 — 대장에 있는데 파일이 없으면 안 된다', async () => {
  for (const id of CATEGORY_KEYS) {
    const rel = artFor(id);
    assert.equal(rel, `assets/incidents/${id}.svg`, '그림 경로 규칙이 바뀌었다 — README도 같이 고쳐라');
    assert.ok(await exists(rel), `${id}: ${rel}이 없다`);
  }
});

// ── 풀과 유형의 대응 ────────────────────────────────────
test('풀의 모든 사건이 아는 유형을 쓴다 — 확전해서 넘어갈 유형까지', () => {
  for (const e of EVENT_POOL) {
    assert.ok(INCIDENT_CATEGORIES[e.cat], `${e.id}: 모르는 유형 「${e.cat}」`);
    if (e.becomes) assert.ok(INCIDENT_CATEGORIES[e.becomes], `${e.id}: 모르는 확전 유형 「${e.becomes}」`);
    assert.notEqual(e.becomes, e.cat, `${e.id}: 안 바뀌는 becomes는 적지 않는다`);
  }
});

test('유형 열둘이 전부 풀에서 도달한다 — 그림이 노는 유형은 없다', () => {
  const reachable = new Set(EVENT_POOL.flatMap(e => [e.cat, e.becomes].filter(Boolean)));
  const idle = CATEGORY_KEYS.filter(k => !reachable.has(k));
  assert.deepEqual(idle, [], `풀에서 못 나오는 유형: ${idle.join(', ')}`);
});

test('풀 항목의 자리와 슬롯이 실존한다', () => {
  const ids = new Set();
  for (const e of EVENT_POOL) {
    assert.ok(!ids.has(e.id), `사건 id가 겹친다: ${e.id}`);
    ids.add(e.id);
    assert.ok(['minor', 'major'].includes(e.tier), `${e.id}: 모르는 티어`);
    assert.ok(PLACES[e.place], `${e.id}: 대응표에 없는 자리 「${e.place}」`);
    assert.ok(e.kinds.length, `${e.id}: 날 수 있는 슬롯이 없다`);
    for (const k of e.kinds) assert.ok(SLOT_KINDS.has(k), `${e.id}: 없는 슬롯 성격 「${k}」`);
    assert.ok(e.involved >= 1, `${e.id}: 연루자가 없다`);
    assert.ok((e.weight ?? 1) > 0, `${e.id}: 무게가 0 이하다 — 영영 안 나온다`);
    assert.ok(e.desc, `${e.id}: 사건 설명이 없다`);
  }
});

test('큰 사건은 무겁게 끝나는 유형뿐이다 — 갈등 8을 넘겨야 열리는 자리다', () => {
  const major = EVENT_POOL.filter(e => e.tier === 'major');
  assert.ok(major.length >= 3);
  const heavy = new Set(['absent', 'selfharm', 'abuse', 'firearm', 'blast']);
  for (const e of major) assert.ok(heavy.has(e.cat), `${e.id}: 큰 사건에 어울리지 않는 유형 「${e.cat}」`);
});

// ── categoryFor — 확전하면 유형이 넘어간다 ───────────────
test('사건은 cat으로, 사고는 becomes로 그려진다', () => {
  const shifting = EVENT_POOL.find(e => e.becomes);
  assert.ok(shifting, '확전하면 유형이 바뀌는 사건이 하나도 없다');
  assert.equal(categoryFor(shifting, false).id, shifting.cat);
  assert.equal(categoryFor(shifting, true).id, shifting.becomes);

  const plain = EVENT_POOL.find(e => !e.becomes);
  assert.equal(categoryFor(plain, true).id, plain.cat, 'becomes가 없으면 유형은 그대로다');

  const c = categoryFor(EVENT_POOL[0]);
  assert.equal(c.art, artFor(c.id));
  assert.ok(c.className, '화면에 쓸 갈래 이름이 없다');
  assert.equal(categoryFor(null), null);
  assert.equal(categoryFor({ cat: 'nope' }), null, '모르는 유형은 조용히 null이다');
});

// ── 추첨 — 무게를 따르되 티어·슬롯을 지킨다 ──────────────
test('어느 티어·슬롯에서 뽑아도 유형이 붙은 사건이 나온다', () => {
  for (const tier of ['minor', 'major']) {
    for (const kind of SLOT_KINDS) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const e = pickEvent(tier, kind, () => r);
        assert.ok(e, `${tier}·${kind}에서 아무것도 안 나왔다`);
        assert.equal(e.tier, tier, `${tier}·${kind}에서 다른 티어가 나왔다`);
        assert.ok(categoryFor(e), `${e.id}에 유형이 안 붙는다`);
      }
    }
  }
});

test('무게가 큰 사건이 실제로 더 자주 나온다', () => {
  // 같은 슬롯·티어 안에서만 겨룬다 — 일과 슬롯의 경미 사건들.
  let seed = 1;
  const rng = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const count = {};
  for (let i = 0; i < 20000; i++) {
    const e = pickEvent('minor', 'work', rng);
    count[e.id] = (count[e.id] || 0) + 1;
  }
  const pool = EVENT_POOL.filter(e => e.tier === 'minor' && e.kinds.includes('work'));
  for (const e of pool) assert.ok(count[e.id] > 0, `${e.id}: 20000번을 굴려도 한 번도 안 나왔다`);
  const heavy = pool.reduce((a, b) => ((a.weight ?? 1) >= (b.weight ?? 1) ? a : b));
  const light = pool.reduce((a, b) => ((a.weight ?? 1) <= (b.weight ?? 1) ? a : b));
  assert.ok(count[heavy.id] > count[light.id],
    `무게가 안 먹는다 — ${heavy.id}(${heavy.weight}) ${count[heavy.id]} vs ${light.id}(${light.weight}) ${count[light.id]}`);
});

// ── 부재 규칙 — 어느 사고가 사람을 며칠 빼내는가 ──────────
// 유형만 보고 정한다(판정 호출은 안 는다). 폭(일수)은 언제나 코드가 굴린다.
test('부재 규칙의 유형은 전부 열둘 안에 있고, 종류는 입원·이탈 둘뿐이다', () => {
  for (const [cat, rule] of Object.entries(TUNING.absence.rules)) {
    assert.ok(INCIDENT_CATEGORIES[cat], `부재 규칙에 모르는 유형: ${cat}`);
    assert.ok(ABSENCE_KINDS[rule.kind], `${cat}: 모르는 부재 종류 ${rule.kind}`);
    const [lo, hi] = rule.days;
    assert.ok(lo >= 1 && hi >= lo, `${cat}: 부재 일수가 이상하다 ${lo}~${hi}`);
  }
  assert.deepEqual(Object.keys(ABSENCE_KINDS).sort(), ['awol', 'hospital']);
  for (const k of Object.values(ABSENCE_KINDS)) {
    assert.ok(k.label && k.icon && k.where, '부재 종류에 화면 몫이 빠졌다');
    assert.ok(!/[가-힣]/.test(k.en), `프롬프트 표기에 한글이 있다: ${k.en}`);
    assert.ok(k.line('아무개', '2026-06-01').includes('아무개'));
    assert.ok(k.back('아무개').includes('아무개'));
  }
});

test('탈영은 사라지고 부상·자해는 입원한다 — 나머지 유형은 사람을 안 빼낸다', () => {
  assert.equal(absenceFor('absent', () => 0).kind, 'awol');
  for (const cat of ['injury', 'vehicle', 'blast', 'health', 'selfharm']) {
    assert.equal(absenceFor(cat, () => 0).kind, 'hospital', `${cat}이 입원이 아니다`);
  }
  // 징계·행정으로 끝나는 유형은 부대 안에서 끝난다 — 폰 걸린 놈이 사라지지는 않는다
  for (const cat of ['violation', 'guard', 'firearm', 'abuse', 'supply', 'outside']) {
    assert.equal(absenceFor(cat, () => 0), null, `${cat}이 사람을 빼냈다`);
  }
  assert.equal(absenceFor(null, () => 0), null);
  assert.equal(absenceFor('없는유형', () => 0), null);
});

test('부재 일수는 규칙의 [최소, 최대] 안에서만 굴려진다', () => {
  for (const [cat, rule] of Object.entries(TUNING.absence.rules)) {
    const [lo, hi] = rule.days;
    assert.equal(absenceFor(cat, () => 0).days, lo, `${cat}: 최소치가 안 나온다`);
    assert.equal(absenceFor(cat, () => 0.9999).days, hi, `${cat}: 최대치를 넘거나 못 미친다`);
    let seed = 7;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 500; i++) {
      const d = absenceFor(cat, rng).days;
      assert.ok(d >= lo && d <= hi, `${cat}: 부재 일수가 범위를 벗어났다 ${d}`);
    }
  }
});

// ── 씨앗의 당김 — 같은 풀이 부대마다 다르게 뽑힌다 ──────
test('당김은 부대 id가 아니라 성향 수치를 본다 — 셋째 군이 와도 이 함수는 그대로다', () => {
  const src = readFileSync(new URL('../js/params.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function pullWeight'), src.indexOf('export function pickEvent'));
  for (const u of UNITS) assert.ok(!fn.includes(u.id), `당김 함수가 부대 id 「${u.id}」를 안다`);
  // 성향을 안 주면 무게가 그대로다
  for (const e of EVENT_POOL) assert.equal(pullWeight(e, {}), e.weight ?? 1);
});

test('마초가 높은 부대는 증명하려고 하는 짓이, 전우애가 얕은 부대는 조용히 커지는 일이 자주 난다', () => {
  const macho = EVENT_POOL.find(e => e.pull === 'macho');
  const lonely = EVENT_POOL.find(e => e.pull === 'lonely');
  assert.ok(macho && lonely, '두 결의 씨앗이 풀에 있어야 한다');
  const hard = { macho: 9, comrade: 10 }, soft = { macho: 2, comrade: 2 };
  assert.ok(pullWeight(macho, hard) > pullWeight(macho, soft), '마초 씨앗이 마초 부대에서 안 당겨진다');
  assert.ok(pullWeight(lonely, soft) > pullWeight(lonely, hard), '고립 씨앗이 얕은 부대에서 안 당겨진다');
  // 당김이 붙어도 무게가 0이 되지는 않는다 — 어느 부대에서도 도달 가능해야 한다
  for (const e of EVENT_POOL) for (const t of [hard, soft]) assert.ok(pullWeight(e, t) > 0);
});
