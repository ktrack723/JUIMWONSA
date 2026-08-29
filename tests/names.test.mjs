// node --test tests/names.test.mjs — 이름 생성기.
//
// 이름은 등급과 같은 자리다: **코드가 굴리고 LLM은 안 짓는다.**
// LLM에 맡기면 부대가 통째로 「김민준·이서준」으로 수렴해서, 부대마다 이름의 결이
// 다르다는 사실 자체가 사라진다. 여기서 지키는 것은 그 「결이 실제로 갈리는가」다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rollName, rollUniqueName, poolSize, NAME_STYLES } from '../js/names.js';
import { UNITS } from '../js/units.js';

// 세 글자가 보통이지만 외자 이름(장겸·최온유의 「겸」)도 실제로 있다. 두 글자부터 받는다.
const HANGUL_NAME = /^[가-힣]{2,4}$/;

test('결은 둘이다 — 해병문학 밈과 명문대생', () => {
  assert.deepEqual([...NAME_STYLES].sort(), ['elite', 'marine-meme']);
});

test('부대마다 고른 결이 실제로 존재하는 결이다', () => {
  for (const u of UNITS) assert.ok(NAME_STYLES.has(u.nameStyle), `${u.id}의 결이 없다`);
});

test('어느 결이든 한글 이름이 나온다', () => {
  for (const style of NAME_STYLES) {
    for (let i = 0; i < 200; i++) {
      const n = rollName(style);
      assert.match(n, HANGUL_NAME, `${style}에서 이상한 이름: ${n}`);
    }
  }
});

test('모르는 결은 명문대생 통으로 떨어진다 — 죽지 않는다', () => {
  assert.match(rollName('그런결없음'), HANGUL_NAME);
});

test('두 결이 서로 다른 이름을 낸다 — 섞이면 부대를 가르는 의미가 없다', () => {
  const meme = new Set(Array.from({ length: 400 }, () => rollName('marine-meme')));
  const elite = new Set(Array.from({ length: 400 }, () => rollName('elite')));
  const overlap = [...meme].filter(n => elite.has(n));
  assert.equal(overlap.length, 0, `두 통이 겹친다: ${overlap.join(', ')}`);
});

test('해병문학 결은 흔한 성을 안 쓴다 — 그래야 그 장르의 낯섦이 산다', () => {
  const COMMON = ['김', '이', '박', '최', '정'];
  const names = Array.from({ length: 400 }, () => rollName('marine-meme'));
  const hits = names.filter(n => COMMON.includes(n[0]));
  assert.equal(hits.length, 0, `해병 통에 흔한 성이 섞였다: ${hits.slice(0, 3).join(', ')}`);
});

test('명문대생 결은 흔한 성을 쓴다', () => {
  const COMMON = new Set(['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
    '한', '오', '서', '신', '권', '황', '안', '송', '류', '전']);
  for (let i = 0; i < 200; i++) {
    const n = rollName('elite');
    assert.ok(COMMON.has(n[0]), `명문대생 통에 낯선 성: ${n}`);
  }
});

test('통이 정원(16)보다 훨씬 크다 — 동명이인이 흔하면 안 된다', () => {
  for (const style of NAME_STYLES) {
    assert.ok(poolSize(style) > 16 * 20, `${style} 통이 ${poolSize(style)}밖에 안 된다`);
  }
});

test('rollUniqueName은 이미 있는 이름을 피한다', () => {
  const taken = Array.from({ length: 30 }, () => rollName('elite'));
  for (let i = 0; i < 100; i++) {
    assert.ok(!taken.includes(rollUniqueName('elite', taken)), '이미 있는 이름을 또 냈다');
  }
});

test('통이 말라도 무한루프에 안 빠진다 — 겹쳐도 내보낸다', () => {
  // 통 전체를 taken으로 넣는다. 피할 이름이 없다.
  const all = new Set();
  for (let i = 0; i < 20000 && all.size < poolSize('elite'); i++) all.add(rollName('elite'));
  const got = rollUniqueName('elite', [...all]);
  assert.match(got, HANGUL_NAME, '통이 말랐을 때 이름이 안 나왔다');
});

test('rng를 주면 결정적으로 돈다', () => {
  const fixed = () => 0.5;
  assert.equal(rollName('marine-meme', fixed), rollName('marine-meme', fixed));
  assert.equal(rollName('elite', fixed), rollName('elite', fixed));
});

test('외자 이름은 명문대생 결에만 있다 — 해병문학 작명법은 언제나 두 음절이다', () => {
  for (let i = 0; i < 400; i++) {
    assert.equal(rollName('marine-meme').length, 3, '해병 이름이 세 글자가 아니다');
  }
});
