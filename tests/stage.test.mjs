// node --test tests/stage.test.mjs — 무대의 순수 계산부. three.js도 DOM도 없이 돈다.
//
// Stage 클래스 자체는 WebGL이라 여기서 안 만든다 (브라우저 스모크가 본다).
// 여기서 보는 것은 「해가 제 시각에 뜨는가」와 「슬롯이 제 자리로 보내는가」다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { skyAt, sunAt, GROUND } from '../js/sprites.js';
import { SLOTS, SLOT_KEYS, PLACES, slotsFor, dayFraction } from '../js/params.js';

const HEX = /^#[0-9a-f]{6}$/;

test('하늘은 어느 시각에나 색 두 개를 준다', () => {
  for (let f = 0; f <= 1.0001; f += 0.05) {
    const s = skyAt(f);
    assert.match(s.top, HEX, `${f.toFixed(2)}의 위 색이 이상하다`);
    assert.match(s.bot, HEX, `${f.toFixed(2)}의 아래 색이 이상하다`);
  }
  // 범위 밖도 안 깨진다
  assert.match(skyAt(-1).top, HEX);
  assert.match(skyAt(9).top, HEX);
});

test('한낮이 한밤보다 밝다 — 해가 도는 것이 눈에 보여야 한다', () => {
  const lum = h => [1, 3, 5].reduce((n, i) => n + parseInt(h.slice(i, i + 2), 16), 0);
  assert.ok(lum(skyAt(0.5).bot) > lum(skyAt(0.05).bot) + 200, '한낮과 한밤이 비슷하다');
});

test('해는 06시에 떠서 18시에 진다', () => {
  assert.equal(sunAt(dayFraction('06:00')).night, false);
  assert.equal(sunAt(dayFraction('12:00')).night, false);
  assert.equal(sunAt(dayFraction('23:00')).night, true, '밤 11시에 해가 떠 있다');
  assert.equal(sunAt(dayFraction('03:00')).night, true);
  // 정오가 제일 높다
  assert.ok(sunAt(dayFraction('12:00')).y > sunAt(dayFraction('09:00')).y);
  assert.ok(sunAt(dayFraction('12:00')).y > sunAt(dayFraction('16:00')).y);
  // 동에서 서로 — x가 단조증가
  const xs = ['07:00', '10:00', '13:00', '16:00'].map(t => sunAt(dayFraction(t)).x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], '해가 거꾸로 간다');
});

test('시각 문자열이 하루의 몇 할인지로 바뀐다', () => {
  assert.equal(dayFraction('00:00'), 0);
  assert.equal(dayFraction('12:00'), 0.5);
  assert.equal(dayFraction('06:00'), 0.25);
  assert.equal(dayFraction(undefined), 0.5, '시각이 없으면 한낮으로 떨어져야 한다');
});

test('슬롯마다 시각과 갈 자리가 있고, 시각은 하루 순서대로다', () => {
  let last = -1;
  for (const s of SLOTS) {
    assert.match(s.time, /^\d\d:\d\d$/, `${s.key}에 시각이 없다`);
    assert.ok(PLACES[s.at], `${s.key}가 대응표에 없는 자리 「${s.at}」로 간다`);
    const f = dayFraction(s.time);
    assert.ok(f > last, `${s.key}의 시각이 앞 슬롯보다 이르다`);
    last = f;
  }
});

test('주말에도 아홉 슬롯 전부 갈 자리가 있다', () => {
  for (const s of slotsFor('2026-08-29')) {
    assert.ok(PLACES[s.at], `주말 ${s.key}가 없는 자리로 간다`);
    assert.match(s.time, /^\d\d:\d\d$/);
  }
});

test('장소마다 무대 위 자리가 있고 서로 겹치지 않는다', () => {
  const xs = Object.values(PLACES).map(p => p.x);
  for (const x of xs) assert.ok(x >= 0 && x <= 1, '장소가 무대 밖에 있다');
  assert.equal(new Set(xs).size, xs.length, '두 장소가 같은 자리에 겹쳤다');
});

test('SLOT_KEYS가 SLOTS와 같다 — 앰비언트 스키마의 enum이 이걸 쓴다', () => {
  assert.deepEqual(SLOT_KEYS, SLOTS.map(s => s.key));
  assert.equal(SLOT_KEYS.length, 9);
});

test('땅 높이가 CSS와 JS에서 같다 — 어긋나면 병사가 땅에 묻히거나 뜬다', async () => {
  const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
  const m = css.match(/\.stage-ground\s*\{[^}]*height:\s*(\d+)%/);
  assert.ok(m, 'CSS에서 .stage-ground의 높이를 못 찾았다');
  assert.equal(Number(m[1]) / 100, GROUND,
    `CSS 땅 높이(${m[1]}%)와 sprites.js의 GROUND(${GROUND})가 어긋났다`);
});

test('무대 층위가 아래에서 위로 쌓인다 — 땅이 병사를 덮으면 발목이 잘린다', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../css/style.css', import.meta.url), 'utf8'),
  ]);
  // DOM 순서: 땅이 canvas보다 먼저 와야 한다
  assert.ok(html.indexOf('stage-ground') < html.indexOf('stage-canvas'),
    '땅이 병사 canvas보다 뒤에 있다 — 발목이 잘린다');
  assert.ok(html.indexOf('stage-canvas') < html.indexOf('stage-bubbles'),
    '말풍선이 병사보다 뒤에 있다');
  // z-index로도 못박아 둔다 — DOM 순서만 믿으면 나중에 조용히 깨진다
  const z = k => Number((css.match(new RegExp(`\\.${k}\\s*\\{[^}]*z-index:\\s*(\\d+)`)) || [])[1]);
  assert.ok(z('stage-sun') < z('stage-ground'), '해가 땅보다 위에 있다');
  assert.ok(z('stage-ground') < z('stage-canvas'), '땅이 병사보다 위에 있다');
  assert.ok(z('stage-canvas') < z('stage-bubbles'), '병사가 말풍선보다 위에 있다');
});
