// node --test tests/stage.test.mjs — 무대의 순수 계산부. three.js도 DOM도 없이 돈다.
//
// Stage 클래스 자체는 WebGL이라 여기서 안 만든다 (브라우저 스모크가 본다).
// 여기서 보는 것은 「해가 제 시각에 뜨는가」와 「슬롯이 제 자리로 보내는가」다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { skyAt, sunAt, GROUND, BUBBLE_GAP, bubbleSpots } from '../js/sprites.js';
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

// ── 말풍선이 말한 놈을 가리키는가 ─────────────────────────
// 고정 사다리(34%·51%·68%)에 걸어 놨던 자리다. 판때기 정수리는 48~54%에 있고 판때기는
// 3%~97%를 걸어 다니는데 가로까지 [25%,75%]로 죄어 놔서, 첫 풍선은 가슴팍을 찌르고
// 셋째는 허공에 떴고 끝에 선 놈의 풍선은 아무도 없는 자리를 가리켰다.
const heads = xs => xs.map(x => ({ x, head: GROUND + 0.3 }));

test('풍선은 판때기 정수리 바로 위에 선다 — 고정 높이가 아니다', () => {
  const [a, b] = bubbleSpots([{ x: 0.2, head: 0.48 }, { x: 0.8, head: 0.54 }], 2);
  assert.ok(Math.abs(a.bottom - (0.48 + BUBBLE_GAP)) < 1e-9, `정수리를 안 따라간다: ${a.bottom}`);
  assert.ok(Math.abs(b.bottom - (0.54 + BUBBLE_GAP)) < 1e-9, '키가 다른 놈이 같은 높이에 섰다');
  // 정수리보다 위여야 한다 — 아래로 잡으면 꼬리가 몸통을 찌른다
  assert.ok(a.bottom > 0.48 && b.bottom > 0.54);
});

test('가로를 안 죈다 — 무대 끝에 선 놈의 풍선도 그놈을 가리킨다', () => {
  const spots = bubbleSpots(heads([0.03, 0.5, 0.97]), 3);
  assert.equal(spots[0].x, 0.03, '왼쪽 끝이 안쪽으로 끌려왔다');
  assert.equal(spots[2].x, 0.97, '오른쪽 끝이 안쪽으로 끌려왔다');
  // 잘리는 것은 css의 --shift가 몸통만 밀어서 푼다. 꼬리는 여기 x에 남는다.
});

test('말할 놈을 가로로 흩어 고른다 — 한 자리에 몰린 놈들만 뽑히면 안 된다', () => {
  // 왼쪽에 다섯이 몰려 서 있고 오른쪽에 하나
  const spots = bubbleSpots(heads([0.10, 0.12, 0.14, 0.16, 0.18, 0.90]), 3);
  const xs = spots.map(s => s.x);
  assert.equal(Math.min(...xs), 0.10, '제일 왼쪽을 안 골랐다');
  assert.equal(Math.max(...xs), 0.90, '제일 오른쪽을 안 골랐다');
});

test('그래도 가까이 서면 올려서 비껴 세운다 — 겹쳐 놓으면 둘 다 못 읽는다', () => {
  const spots = bubbleSpots(heads([0.50, 0.52, 0.54]), 3);
  const bottoms = spots.map(s => s.bottom);
  assert.equal(new Set(bottoms.map(b => b.toFixed(4))).size, 3, '셋이 같은 높이에 겹쳤다');
  for (let i = 1; i < bottoms.length; i++) {
    assert.ok(bottoms[i] > bottoms[i - 1], '뒤에 오는 풍선이 안 올라갔다');
  }
});

test('무대가 안 열려도(WebGL 없음) 자리는 나온다 — 게임은 그대로 돈다', () => {
  const spots = bubbleSpots([], 3);
  assert.equal(spots.length, 3);
  for (const s of spots) {
    assert.ok(s.x > 0 && s.x < 1, `무대 밖이다: ${s.x}`);
    assert.ok(s.bottom > GROUND, '땅에 묻혔다');
  }
  assert.equal(new Set(spots.map(s => s.x)).size, 3, '전부 한 자리에 겹쳤다');
});

test('꼬리는 몸통을 밀어도 제 주인에게 남는다 — css가 --shift를 되민다', async () => {
  const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
  const body = css.match(/\.stage-bubbles \.bubble \{[^}]*\}/)[0];
  const tail = css.match(/\.stage-bubbles \.bubble::after \{[^}]*\}/)[0];
  assert.match(body, /transform:[^;]*calc\(-50% \+ var\(--shift/,
    '몸통이 --shift를 안 탄다 — 무대 끝 풍선이 잘린다');
  assert.match(tail, /left:\s*calc\(50% - var\(--shift/,
    '꼬리가 --shift를 안 되민다 — 몸통을 밀면 꼬리가 같이 끌려간다');
  // 애니메이션이 도는 동안에도 밀어 둔 자리를 지켜야 한다
  const anim = css.match(/@keyframes bubble-in \{[^}]*\}[^}]*\}/)[0];
  assert.ok((anim.match(/var\(--shift/g) || []).length >= 2,
    'bubble-in 키프레임이 --shift를 빠뜨렸다 — 뜨는 0.35초 동안 몸통이 튄다');
});

test('❗의 높이는 코드가 정한다 — css가 bottom을 박으면 판때기 가슴에 걸린다', async () => {
  const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
  const mark = css.match(/\.stage-bubbles \.incident-mark \{[^}]*\}/)[0];
  assert.ok(!/bottom:/.test(mark), 'css가 ❗의 bottom을 박아 놨다 — 정수리를 못 따라간다');
  const bob = css.match(/@keyframes mark-bob \{[^}]*\}[^}]*\}/)[0];
  assert.ok(!/bottom:/.test(bob), '까딱임이 bottom을 만진다 — 코드가 세운 높이를 덮는다');
  assert.match(bob, /translateY/, '까딱임이 transform으로 안 돈다');
});

// ── 왼쪽 칼럼 배치 ───────────────────────────────────────
// 좁은 화면에서 .day-left는 display:contents로 풀려 자식들이 그리드 아이템이 된다.
// 그때 order가 없는 패널은 0으로 떨어져 **상황판보다 위로** 올라간다 — 부조리 내역과
// 검열 내역이 그렇게 페이지 맨 위에 얹혀 있었고, 그래서 같은 종류인 가라 내역과
// 화면 반 페이지쯤 떨어져 있었다. 새 패널을 붙일 때 조용히 재발하는 자리라 못박는다.
const leftColumn = html => html.slice(html.indexOf('class="day-left"'), html.indexOf('class="day-right"'));

test('왼쪽 칼럼의 패널은 전부 좁은 화면 순서를 가진다 — 없으면 맨 위로 튄다', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../css/style.css', import.meta.url), 'utf8'),
  ]);
  const mq = css.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/)[0];
  const panels = [...leftColumn(html).matchAll(/class="panel95 ([a-z0-9-]+)/g)].map(m => m[1]);
  assert.ok(panels.length >= 4, `왼쪽 칼럼에서 패널을 못 찾았다: ${panels}`);
  for (const p of new Set(panels)) {
    assert.match(mq, new RegExp(`\\.${p}\\s*\\{[^}]*order:`),
      `.${p}에 좁은 화면 order가 없다 — display:contents 아래에서 상황판보다 위로 올라간다`);
  }
});

test('배치는 중요도 순이다 — 상황판·계기판이 먼저고 지침이 끝이다', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../css/style.css', import.meta.url), 'utf8'),
  ]);
  const left = leftColumn(html);
  const at = cls => left.indexOf(cls);
  // 오늘 무엇을 할지 정하는 것부터 — 목표(상황판) → 바늘(계기판) → 아는 것(내역) → 사람(병력)
  assert.ok(at('hud') < at('gauges'), '계기판이 상황판보다 앞이다');
  assert.ok(at('gauges') < at('ledger-panel'), '내역이 계기판보다 앞이다');
  assert.ok(at('ledger-panel') < at('roster-panel'), '병력 현황이 내역보다 앞이다');
  // 지나간 일(검열 기록)과 잘 안 바뀌는 것(지침)이 끝이다
  assert.ok(at('roster-panel') < at('censor-panel'), '검열 기록이 병력 현황보다 앞이다');
  assert.ok(at('censor-panel') < at('notice-board'), '활성 지침이 검열 기록보다 앞이다');

  // 좁은 화면 순서도 같은 순서여야 한다 — 데스크톱과 다르면 같은 게임이 두 배치가 된다
  const mq = css.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/)[0];
  const ord = cls => Number(mq.match(new RegExp(`\\.${cls}\\s*\\{[^}]*order:\\s*(\\d+)`))[1]);
  const seq = ['ledger-panel', 'roster-panel', 'censor-panel', 'notice-board'].map(ord);
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] > seq[i - 1], '좁은 화면 순서가 데스크톱과 어긋난다');
  }
});

test('가라와 부조리는 한 패널 안에 붙어 있다 — 같은 종류의 안개다', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const panel = html.match(/<div class="panel95 ledger-panel"[\s\S]*?\n          <\/div>/)[0];
  for (const id of ['gara-tally', 'gara-known', 'gara-seen', 'abuse-tally', 'abuse-known']) {
    assert.ok(panel.includes(`id="${id}"`), `${id}가 내역 패널 밖으로 나갔다`);
  }
  // 설명은 접혀 있어야 한다 — 문단이 사이에 서면 둘이 다시 멀어진다
  assert.match(panel, /<details class="ledger-help">/, '읽는 법이 안 접혀 있다');
  const beforeHelp = panel.slice(0, panel.indexOf('ledger-help'));
  assert.ok(!/class="meter-note"/.test(beforeHelp), '명부 사이에 설명 문단이 서 있다');
});
