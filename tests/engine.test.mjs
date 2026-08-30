// node --test tests/engine.test.mjs — 하네스. 결정적 가짜 LLM으로 하루 3턴 (§9.5).
//
//   1일차: 조용한 날 — 브리핑 한 콜로 하루가 끝난다. 제일 싼 날.
//         (병영 소음은 부임 때 한 번만 채워지므로 미리 채워 두고 시작한다 — 실제 게임도
//          둘째 날부터는 그 상태다. 「부임 첫날만 한 콜 더」는 따로 못박는다.)
//   2일차: 사건 → 지침 → 확전(사고) — 카운터 0 회귀, 병사·파라미터는 그대로.
//   3일차: 브리핑에 어제가 코드 요약으로 실린다.
//
// 키도 크레딧도 필요 없다. rng도 주입식이라 롤까지 결정적으로 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { Roster } from '../js/roster.js';
import { AmbientPool } from '../js/ambient.js';
import { TUNING, INCIDENT_CATEGORIES, absenceFor, incidentRisk, PLACES } from '../js/params.js';
import { RECRUIT_SCHEMA as P_RECRUIT } from '../js/prompts.js';

// ── 가짜 LLM — label로 갈라 결정적 응답을 준다 ──────────
class FakeLLM {
  constructor() {
    this.calls = [];
    this.judgeQueue = [];    // 확전 판정 스크립트
    this.noticeVerdict = { gara: 'down', happy: 'down', conflict: 'same', reaction: '또 뭘 금지한대' };
    // 환송회 — 기본 응답에 **명부에 없는 이름**을 하나 섞어 둔다. 걸러지는지가 계약이다.
    this.farewellOut = {
      scene: '환송회장면',
      lines: [
        { name: '기존5', text: '고생하셨습니다.' },
        { name: '없는놈', text: '저도 인사드립니다.' },
      ],
      closing: '위병소를 나선다',
    };
  }
  async call(req) {
    // messages 배열은 엔진이 계속 밀어 넣는 살아 있는 참조다 — 호출 시점의 모습을 얼려 둔다.
    this.calls.push({ ...req, messages: structuredClone(req.messages || []) });
    const l = req.label || '';
    if (l.startsWith('전입')) return { sheet: `시트${this.calls.length}` };
    if (l.startsWith('병영 소음')) return { lines: [{ slot: 'reveille', text: '또 아침이네' }, { slot: 'amwork', text: '장갑 한 짝 어디 갔냐' }] };
    if (l.startsWith('아침 브리핑')) return { briefing: '브리핑본문', slots: Array.from({ length: 9 }, (_, i) => `조각${i}`) };
    if (l.startsWith('사건 장면')) return '사건장면텍스트';
    if (l.startsWith('대응 결과')) return '결과장면텍스트';
    if (l.startsWith('확전 판정')) return this.judgeQueue.shift() || { outcome: 'contained', gara: 'same', happy: 'same', conflict: 'same' };
    if (l.startsWith('면담')) return '병사의 대답';
    if (l.startsWith('불시점검')) return '점검소견텍스트';
    if (l.startsWith('공지 판정')) return this.noticeVerdict;
    if (l.startsWith('검열 강평')) return '강평문텍스트';
    if (l.startsWith('환송회')) return this.farewellOut;
    throw new Error(`모르는 호출: ${l}`);
  }
  labels() { return this.calls.map(c => c.label); }
  byLabel(prefix) { return this.calls.filter(c => (c.label || '').startsWith(prefix)); }
}

const seqRng = (vals = []) => { let i = 0; return () => (i < vals.length ? vals[i++] : 0.999); };

const memStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
};

const unit = {
  id: 'probe', name: '표식부대', branch: '표식군', desc: '감사용',
  culture: 'CULT표식', rules: 'REGS표식', soldierRules: 'SRULES표식',
  intel: { score: 5, desc: '보통 머리' }, macho: { score: 5, desc: '보통 피' },
  comrade: { score: 5, desc: '보통 사이' },
  difficulty: 5, serviceMonths: 18, serial: { branchCode: '3', seqBase: 70000000 },
  cohort: { base: 1300, at: '2023-11' }, rankMonths: [2, 8, 14], nameStyle: 'elite',
  jobs: ['a', 'b', 'c', 'd'],
  songMode: 'chorus', songSlots: ['reveille'],
  songs: [{ title: '군가표식', note: '감사용 곡', lines: ['군가소절표식'] }],
};

const memStore = memStorage;

/** 같은 패턴을 100일 내내 되풀이하는 난수 — 장기 회귀 테스트가 결정적으로 돈다. */
function cycleRng(pattern) {
  let i = 0;
  return () => pattern[i++ % pattern.length];
}

function fixture({ rng, garaRng, judges = [], ambientReady = true, unit: u = unit } = {}) {
  const llm = new FakeLLM();
  llm.judgeQueue = judges;
  // 병영 소음은 부임 때 한 번 채워지고 끝이다. 하루 루프를 재는 테스트는 채워진 채로 시작한다.
  const ambient = new AmbientPool(u, { storage: memStore() });
  if (ambientReady) ambient.fill([{ slot: 'reveille', text: '또 아침이네' }, { slot: 'amwork', text: '장갑 한 짝' }]);
  const roster = new Roster(u, { storage: memStorage() });
  for (let i = 0; i < 16; i++) {
    roster.enlist({ name: `기존${i}`, sheet: `기존시트${i}`, job: u.jobs[i % 4], grade: 'B', character: '중', joined: '2026-05-01' });
  }
  // 부임일이 2026-05-18(월)이 되도록 오늘을 고정 — 평일이라 일과 슬롯이 산다.
  const state = Engine.newCampaign(u, '2026-08-26');
  const events = [];
  const engine = new Engine(llm, {
    unit: u, roster, state, ambient, rng: rng || seqRng(), garaRng: garaRng || seqRng(),
    handlers: {
      briefing: e => events.push(['briefing', e]),
      slot: e => {
        events.push(['slot', e.slot.key]);
        if (e.chatter?.length) events.push(['slotChatter', e.chatter]);
      },
      incident: e => { events.push(['incident', e]); return engine._directive ?? null; },
      outcome: e => events.push(['outcome', e]),
      verdict: e => events.push(['verdict', e]),
      dayEnd: e => events.push(['dayEnd', e]),
      censorOpen: e => events.push(['censorOpen', e]),
      censorSlot: e => events.push(['censorSlot', e]),
      censorReport: e => events.push(['censorReport', e]),
    },
  });
  return { llm, roster, state, engine, events, ambient };
}

// ── 1일차: 조용한 날 ────────────────────────────────────
test('조용한 날은 브리핑 한 콜로 하루가 끝난다', async () => {
  const { llm, engine, state, events } = fixture();
  assert.equal(state.startDate, '2026-05-18');
  assert.equal(state.date, '2026-05-18');

  const snap = await engine.runDay();
  assert.deepEqual(llm.labels(), ['아침 브리핑'], '조용한 날의 콜 수는 1이어야 한다');
  assert.equal(snap.streak, 1);
  assert.equal(snap.date, '2026-05-19', '달력은 전진한다');
  assert.equal(snap.day, 1);
  assert.equal(events.filter(e => e[0] === 'slot').length, 9, '슬롯 아홉이 다 돌아야 한다');
  // 개입 없는 조용한 날 — 평판 +1 회복
  assert.equal(state.params.rep, TUNING.start.rep + 1);
});

test('브리핑 user에는 밴드 라벨이 실리고 원수치는 실리지 않는다', async () => {
  const { llm, engine } = fixture();
  await engine.runDay();
  const req = llm.byLabel('아침 브리핑')[0];
  const user = req.messages[0].content;
  assert.ok(/corner-cutting: (very-low|low|mid|high|very-high)/.test(user));
  assert.ok(!/corner-cutting: \d/.test(user), '가라 원수치가 프롬프트에 샜다');
  assert.ok(!user.includes('streak'), '카운터가 프롬프트에 샜다');
  assert.ok(req.system.includes('CULT표식'), '브리핑 system에 부대 프롬프트가 없다');
});

// ── 2일차: 사건 → 확전(사고) ────────────────────────────
// rng 소비 순서: 명부 표본 4 → 슬롯 롤들. 슬롯2(오전일과)에서 0.001로 사건을 켠다.
const incidentRng = () => seqRng([
  0.999, 0.999, 0.999, 0.999,   // sample(4)
  0.999, 0.999,                 // 아침점호 · 아침식사 롤
  0.001,                        // 오전일과 롤 — 사건 발생
  0.001,                        // 보고 롤 — 올라온다 (표식부대는 중립이라 0.95)
  0, 0,                         // pickEvent · pickInvolved
]);

/** 같은 사건인데 **안 올라가는** 날. 보고 롤만 뒤집는다 — 그 한 칸이 이 게임의 절반이다. */
const buryRng = () => seqRng([
  0.999, 0.999, 0.999, 0.999,
  0.999, 0.999,
  0.001,                        // 사건 발생
  0.99,                         // 보고 롤 — 안 올라간다
  0, 0,                         // pickEvent · pickInvolved
]);

/** 침묵이 두꺼운 부대 — 잔사건 보고 확률 0.30. 표식부대와 성향만 다르다. */
const silentUnit = {
  ...unit,
  id: 'silent', name: '침묵부대',
  macho: { score: 9, desc: '증명해야 하는 피' },
  comrade: { score: 10, desc: '같이 덮는다' },
};

test('사건은 E-1·E-2·E-3 세 콜이고, 확전이면 카운터만 0이 된다', async () => {
  const { llm, engine, state, roster } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'up', happy: 'down', conflict: 'up' }],
  });
  engine._directive = '지침표식문장';
  state.streak = 87;   // 87일차의 악몽

  const before = { params: { ...state.params }, sheets: roster.soldiers.map(s => s.sheet) };
  const snap = await engine.runDay();

  assert.deepEqual(llm.labels(), ['아침 브리핑', '사건 장면', '대응 결과', '확전 판정'], '사건 하나는 +3콜이다');
  // 사고 — 무사고 카운터만 0. 하루 마감 +1도 없다.
  assert.equal(snap.streak, 0, '확전인데 카운터가 살아 있다');
  assert.equal(state.accidents.length, 1);
  // 사고 대장에는 유형이 같이 찍힌다 — 화면이 여기에 그림을 붙인다
  const filed = state.accidents[0];
  assert.ok(INCIDENT_CATEGORIES[filed.category], `사고 대장에 유형이 안 찍혔다: ${filed.category}`);
  assert.ok(filed.desc && filed.tier, '사고 대장에 사건 내용·티어가 빠졌다');
  // 날짜는 안 돌아간다
  assert.equal(snap.date, '2026-05-19');
  // 병사 데이터와 파라미터는 유지된다 — 리셋되는 것은 카운터뿐이다
  assert.deepEqual(roster.soldiers.map(s => s.sheet), before.sheets, '사고가 병사를 지웠다');
  assert.equal(roster.soldiers.length, 16);
  // 판정이 민 가라는 **그날 저녁에 안 돌아온다.** 가라의 제자리 회복은 조용한 날이
  // 이틀 쌓여야 붙는다(drift.restDays) — 매일 당기면 판정이 민 한 칸을 그날 저녁에 정확히
  // 도로 가져가서 바늘이 언다. 관행은 「한 번 잡는 것」이 아니라 「계속 잡는 것」인데,
  // 그러려면 잡기 전에 **올라가 있을 수 있어야** 한다.
  assert.equal(state.params.gara, before.params.gara + 1, '판정이 민 가라가 그날 저녁에 지워졌다');
  assert.equal(snap.calm.gara, 0, '움직인 축의 조용한 날 카운터가 리셋 안 됐다');
});

test('밀린 축은 조용한 날이 쌓여야 제자리로 돌아온다 — 그 며칠이 바늘이 노는 폭이다', async () => {
  const { engine, state } = fixture({ rng: seqRng([0.999]) });   // 사건 없는 날들
  state.params.gara = TUNING.start.gara + 1;
  const need = TUNING.drift.restDays.gara;
  for (let d = 1; d < need; d++) {
    await engine.runDay();
    assert.equal(state.params.gara, TUNING.start.gara + 1, `조용한 날 ${d}일째에 벌써 돌아왔다`);
  }
  await engine.runDay();
  assert.equal(state.params.gara, TUNING.start.gara, `조용한 날 ${need}일째에도 안 돌아왔다`);
});

test('판정이 민 가라는 그날 안에서는 살아 있다 — 되돌리는 것은 하루 마감이다', async () => {
  const seen = [];
  const { engine, state } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'contained', gara: 'up', happy: 'same', conflict: 'same' }],
  });
  engine._directive = null;
  const dawn = state.params.gara;
  engine.h.verdict = async () => { seen.push(state.params.gara); };
  await engine.runDay();
  assert.equal(seen[0], dawn + 1, '판정 직후에 가라가 안 올랐다 — 그날의 사고 롤이 이걸 본다');
  assert.equal(state.params.gara, dawn + 1, '움직인 축이 그날 저녁에 제자리로 끌려갔다');
});

// ── 안 올라간 사건 — 이 게임에서 화면도 콜도 없는 유일한 사건 ──────
// 전우애가 높다고 사건이 덜 나는 것이 아니다. **안 올라올 뿐이다.** 그 차이가 코드에서
// 갈리는 자리가 여기다: 같은 롤, 같은 씨앗, 같은 사람들 — 갈리는 것은 보고 롤 한 칸이다.
test('안 올라간 사건은 콜도 화면도 안 쓴다 — 주임원사가 못 본 것을 쓸 수는 없다', async () => {
  const { llm, engine, state, events } = fixture({ rng: buryRng() });
  await engine.runDay();

  assert.deepEqual(llm.labels(), ['아침 브리핑'], '안 올라간 사건이 콜을 썼다');
  assert.ok(!events.some(([k]) => k === 'incident' || k === 'outcome' || k === 'verdict'),
    '화면이 못 본 사건을 그렸다');
  const [, ledger] = events.findLast(([k]) => k === 'dayEnd');
  assert.equal(ledger.today.incidents, 0, '장부에 안 올라온 사건이 올랐다');
  assert.equal(ledger.today.accidents, 0);
  assert.equal(ledger.today.surfaced, 0, '안 터진 날에 뭔가 올라왔다');
  // 그래도 일어난 일이다
  assert.equal(state.buried.length, 1, '더미에 안 쌓였다');
  assert.equal(state.silence.happened, 1, '누계가 사건을 안 셌다');
  assert.equal(state.silence.buried, 1, '누계가 침묵을 안 셌다');
  assert.equal(state.streak, 1, '안 올라간 사건이 무사고 카운터를 깼다 — 장부는 그걸 모른다');
});

test('묻힌 잔사건은 멘탈을 안 깎는다 — 이름이 오르는 것 자체는 상처가 아니다', async () => {
  const { engine, state, roster } = fixture({ rng: buryRng() });
  const before = new Map(roster.present.map(m => [m.serial, m.mental ?? TUNING.mental.default]));
  let midday = null;
  engine.h.slot = () => {
    if (state.buried.length && !midday) midday = new Map(roster.present.map(m => [m.serial, m.mental]));
  };
  await engine.runDay();
  assert.ok(midday, '사건이 안 묻혔다');
  for (const man of roster.present.filter(m => state.buried[0].names.includes(m.name))) {
    assert.equal(midday.get(man.serial), before.get(man.serial),
      `${man.name}: 잔사건이 멘탈을 깎았다 — 묻혔다고 규칙이 달라지면 안 된다`);
  }
});

test('덮였다는 것은 안 다쳤다는 뜻이 아니다 — 묻힌 중대 사건은 그대로 깎는다', async () => {
  // 갈등을 천장까지 올려 큰 사고의 문을 열어 두고, 오전일과에서 한 건을 묻는다.
  // 난수는 그 슬롯에 들어갈 때만 뒤집는다 — 인덱스를 세는 것보다 읽기 쉽고 안 깨진다.
  let armed = 0;
  const rng = () => (armed > 0 ? [0.001, 0.99, 0, 0][4 - armed--] : 0.999);
  const { engine, state, roster } = fixture({ rng });
  state.params.conflict = 10;

  const before = new Map(roster.present.map(m => [m.serial, m.mental ?? TUNING.mental.default]));
  let midday = null;
  engine.h.slot = e => {
    if (e.slot.key === 'amwork') armed = 4;                    // 발생 · 보고(안 올라감) · 씨앗 · 연루자
    if (state.buried.length && !midday) midday = new Map(roster.present.map(m => [m.serial, m.mental]));
  };
  await engine.runDay();

  assert.equal(state.buried.length, 1, '중대 사건이 안 묻혔다');
  assert.equal(state.buried[0].tier, 'major');
  assert.ok(midday, '사건 다음 슬롯을 못 잡았다');
  const names = state.buried[0].names;
  assert.ok(names.length > 0, '연루자가 없다');
  for (const man of roster.present.filter(m => names.includes(m.name))) {
    assert.ok(midday.get(man.serial) < before.get(man.serial),
      `${man.name}: 묻힌 중대 사건에 연루됐는데 멘탈이 그대로다 — 침묵이 공짜가 됐다`);
  }
});

test('묻힌 것이 쌓이면 큰 사고의 문턱이 앞당겨진다 — 계기판은 그걸 모른다', async () => {
  const { engine, state } = fixture({ rng: seqRng([0.999]) });
  const snap0 = engine.snapshot();
  state.buried = Array.from({ length: 5 }, (_, i) => ({
    date: '2026-05-10', tier: 'minor', desc: `묻힌${i}`, category: null,
    place: 'barracks', slot: 'amwork', names: ['기존0'],
  }));
  const snap1 = engine.snapshot();
  // 계기판이 읽는 것은 params뿐이고, 거기엔 더미가 없다
  assert.deepEqual(snap1.params, snap0.params, '더미가 계기판 수치를 움직였다');
  assert.equal(JSON.stringify(snap1).includes('묻힌0'), false, '스냅샷이 묻힌 것의 정체를 흘렸다');
  // 위험은 실제로 갈린다
  const stats = { macho: unit.macho.score, difficulty: unit.difficulty };
  const risk = b => incidentRisk({ ...state.params, conflict: 7, buried: b }, stats).big;
  assert.equal(risk(0), 0, '아무것도 안 묻었는데 갈등 7에서 문이 열렸다');
  assert.ok(risk(5) > 0, '다섯 건을 묻어 뒀는데 갈등 7이 안전하다');
});

test('더미가 갈등의 바닥을 만든다 — 이유가 장부에 안 적힌 한 칸이다', async () => {
  const { engine, state, events } = fixture({ rng: seqRng([0.999]) });   // 사건 없는 날
  state.params.conflict = 2;
  state.buried = Array.from({ length: 6 }, (_, i) => ({
    date: '2026-05-10', day: state.day, tier: 'minor', desc: `묻힌${i}`,
    category: null, place: 'barracks', slot: 'amwork', names: ['기존0'],
  }));
  await engine.runDay();

  assert.equal(state.params.conflict, 3, '더미가 갈등을 안 밀었다 — 하루 한 칸이다');
  const [, ledger] = events.findLast(([k]) => k === 'dayEnd');
  assert.equal(ledger.today.incidents, 0, '사건이 없는 날이어야 한다');
  assert.equal(ledger.today.interventions, 0, '개입이 없는 날이어야 한다');
  // 이유가 아무 데도 없다. 바늘만 올라간다 — 그게 침묵의 값이다.
  assert.equal(ledger.today.moved.conflict, 1, '움직인 자리가 장부에 안 남았다');
  assert.equal(state.calm.conflict, 0, '민 축이 「조용한 날」로 잡혔다 — 저녁에 도로 끌려간다');
});

test('바닥은 더미 크기까지다 — 래칫이 아니라 바닥이라 비면 같이 내려간다', async () => {
  const { engine, state } = fixture({ rng: seqRng([0.999]) });
  state.params.conflict = 4;
  state.buried = [{ date: '2026-05-10', day: state.day, tier: 'minor', desc: 'x', category: null, place: 'barracks', slot: 'amwork', names: ['기존0'] }];
  await engine.runDay();
  assert.ok(state.params.conflict <= 4, '더미(1건)가 갈등 4를 더 밀어 올렸다 — 바닥이 아니라 래칫이다');
});

test('묻힌 것은 삭는다 — 아무 일도 안 일어난 채 지나간 일이 된다', async () => {
  const { engine, state } = fixture({ rng: seqRng([0.999]) });
  const fade = TUNING.comrade.buried.fadeDays;
  state.buried = [
    { date: '2026-05-01', day: state.day - fade, tier: 'minor', desc: '오래된것', category: null, place: 'barracks', slot: 'amwork', names: ['기존0'] },
    { date: '2026-05-17', day: state.day, tier: 'minor', desc: '어제것', category: null, place: 'barracks', slot: 'amwork', names: ['기존0'] },
  ];
  await engine.runDay();
  assert.deepEqual(state.buried.map(b => b.desc), ['어제것'], '삭는 규칙이 안 돌거나 산 것까지 지웠다');
  // 삭은 것은 **올라온 것이 아니다.** 아무도 모른 채로 끝난 것이라 누계가 움직이면 안 된다.
  assert.equal(state.silence.surfaced, 0, '삭은 것이 「뒤늦게 올라온 것」으로 세어졌다');
});

test('사고가 나면 더미가 같이 터진다 — 그날 올라오는 것은 오늘 것이 아니다', async () => {
  const { engine, state, events } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  state.buried = Array.from({ length: 3 }, (_, i) => ({
    date: '2026-05-10', tier: 'minor', desc: `묻힌${i}`, category: null,
    place: 'barracks', slot: 'amwork', names: ['기존0'],
  }));
  await engine.runDay();

  assert.equal(state.buried.length, 0, '터졌는데 더미가 남았다');
  assert.equal(state.accidents.at(-1).surfaced, 3, '사고 기재에 뒤늦게 올라온 개수가 없다');
  assert.equal(state.silence.surfaced, 3, '누계가 올라온 것을 안 셌다');
  const [, v] = events.findLast(([k]) => k === 'verdict');
  assert.equal(v.surfaced, 3, '화면이 「전에도 있었다」를 못 받았다');
  const [, ledger] = events.findLast(([k]) => k === 'dayEnd');
  assert.equal(ledger.today.surfaced, 3, '장부에 안 실렸다');
});

test('확전이 아니면 더미는 그대로다 — 사건 하나 올라온 걸로 장부가 열리지는 않는다', async () => {
  const { engine, state } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'contained', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  state.buried = [{ date: '2026-05-10', tier: 'minor', desc: '묻힌0', category: null, place: 'barracks', slot: 'amwork', names: ['기존0'] }];
  await engine.runDay();
  assert.equal(state.buried.length, 1, '안 터졌는데 더미가 비었다');
});

test('E-1은 그 자리에 전에도 있었다는 것을 받는다 — 개수는 안 나간다', async () => {
  const { llm, engine, state } = fixture({ rng: incidentRng() });
  // 어느 자리에서 사건이 날지는 씨앗 추첨이 정하므로, 모든 자리에 한 건씩 묻어 둔다
  state.buried = Object.keys(PLACES).map(place => ({
    date: '2026-05-10', tier: 'minor', desc: '묻힌것', category: null,
    place, slot: 'amwork', names: ['기존0'],
  }));
  await engine.runDay();
  const e1 = llm.byLabel('사건 장면')[0];
  const user = e1.messages.at(-1).content;
  assert.ok(user.includes('NOBODY PUT UPSTAIRS'), 'E-1에 묻힌 이력 절이 없다');
  assert.ok(user.includes('Never state the count'), '개수를 쓰지 말라는 금지가 없다');
  assert.ok(!user.includes('묻힌것'), '묻힌 사건의 원문이 프롬프트로 샜다');
});

test('침묵이 두꺼운 부대는 장부가 조용하다 — 사건은 더 나는데 콜은 더 적다', async () => {
  const pattern = [0.999, 0.999, 0.999, 0.999, 0.001, 0.5, 0, 0];
  const loud = fixture({ rng: cycleRng(pattern) });
  const quiet = fixture({ rng: cycleRng(pattern), unit: silentUnit });
  for (let i = 0; i < 5; i++) { await loud.engine.runDay(); await quiet.engine.runDay(); }

  // 같은 난수, 같은 롤 — 갈리는 것은 보고뿐이다
  assert.equal(quiet.state.silence.happened, loud.state.silence.happened,
    '보고 확률이 사건 발생 자체를 갈랐다 — 이 축은 발생을 안 만진다');
  assert.ok(quiet.state.silence.buried > loud.state.silence.buried,
    '침묵이 두꺼운데 더 많이 올라왔다');
  assert.ok(quiet.llm.byLabel('사건 장면').length < loud.llm.byLabel('사건 장면').length,
    '조용한 부대가 콜을 더 썼다');
});

test('E-3은 지침을 못 보고, 부대 프롬프트도 없다 — 결과 장면만 읽는다', async () => {
  const { llm, engine } = fixture({ rng: incidentRng() });
  engine._directive = '지침표식문장';
  await engine.runDay();

  const e2 = llm.byLabel('대응 결과')[0];
  assert.ok(JSON.stringify(e2.messages).includes('지침표식문장'), 'E-2에는 지침이 그대로 실려야 한다');

  const judge = llm.byLabel('확전 판정')[0];
  const whole = JSON.stringify({ system: judge.system, messages: judge.messages });
  assert.ok(!whole.includes('지침표식문장'), '확전 판정이 지침을 봤다');
  assert.ok(!whole.includes('CULT표식'), '확전 판정 system에 부대 프롬프트가 붙었다 — 바이트 동일성이 깨진다');
  assert.ok(whole.includes('결과장면텍스트'), '확전 판정이 결과 장면을 못 받았다');
  assert.ok(judge.messages[0].content.includes('minor'), '심각도 티어가 없다');
});

test('개입 없음이면 E-2에 no intervention이 실린다', async () => {
  const { llm, engine } = fixture({ rng: incidentRng() });
  engine._directive = null;
  await engine.runDay();
  const e2 = llm.byLabel('대응 결과')[0];
  assert.ok(JSON.stringify(e2.messages).includes('no intervention'));
});

// ── 3일차: 어제가 코드 요약으로 넘어간다 ────────────────
test('다음 날 브리핑에 어제의 사건·사고가 요약되어 실린다 — 원문 스레드는 닫힌다', async () => {
  const { llm, engine } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  engine._directive = '지침표식문장';
  await engine.runDay();                       // 사건이 터진 날
  llm.calls.length = 0;
  await engine.runDay();                       // 다음 날 (조용)

  const brief = llm.byLabel('아침 브리핑')[0];
  const user = brief.messages[0].content;
  assert.ok(user.includes('2026-05-18:'), '어제 요약에 날짜가 없다');
  assert.ok(user.includes('사고로 확전'), '어제의 사고가 요약에 없다');
  assert.equal(brief.messages.length, 1, '어제의 원문 스레드를 끌고 왔다 — 코드 요약으로 시작해야 한다');
});

// ── 전입 ────────────────────────────────────────────────
test('fillRoster는 빈 자리 수만큼 P를 부르고, 군번이 전부 다르다', async () => {
  const llm = new FakeLLM();
  const roster = new Roster(unit, { storage: memStorage() });
  const engine = new Engine(llm, { unit, roster, state: Engine.newCampaign(unit, '2026-08-26'), handlers: {} });
  const arrivals = await engine.fillRoster();
  assert.equal(arrivals.length, 16);
  assert.equal(llm.byLabel('전입').length, 16);
  assert.equal(new Set(arrivals.map(a => a.serial)).size, 16, '군번이 겹쳤다');
  // P 호출에 명부(다른 병사 시트)가 안 실린다
  const anyP = llm.byLabel('전입')[15];
  assert.ok(!JSON.stringify(anyP.messages).includes('시트1'), 'P가 명부를 봤다');
});

// 게이트 LLM — 콜을 붙잡아 두고 밖에서 하나씩 놓아준다. 동시성(몇 콜이 함께 떠 있나)을 재는 용도.
function gatedLLM() {
  const llm = new FakeLLM();
  const orig = llm.call.bind(llm);
  const gates = [];
  llm.call = req => new Promise((resolve, reject) => {
    gates.push({ label: req.label, open: () => resolve(orig(req)), fail: e => reject(e) });
  });
  return { llm, gates };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('fillRoster는 첫 콜로 캐시를 데운 뒤 나머지 15콜을 병렬로 쏜다', async () => {
  const { llm, gates } = gatedLLM();
  const roster = new Roster(unit, { storage: memStorage() });
  const engine = new Engine(llm, { unit, roster, state: Engine.newCampaign(unit, '2026-08-26'), handlers: {} });
  const progress = [], totals = [];
  const done = engine.fillRoster(null, (n, _roll, total) => { progress.push(n); totals.push(total); });

  await tick();
  assert.equal(gates.length, 1, '첫 콜은 홀로 나가야 한다 — 캐시 예열 중에 뒤가 따라붙었다');
  gates.shift().open();
  await tick();
  assert.equal(gates.length, 15, '예열이 끝나면 나머지 15콜이 한꺼번에 떠 있어야 한다');
  while (gates.length) gates.shift().open();

  const arrivals = await done;
  assert.equal(arrivals.length, 16);
  assert.equal(new Set(arrivals.map(a => a.serial)).size, 16, '병렬 채번에서 군번이 겹쳤다');
  assert.equal(roster.soldiers.length, 16);
  assert.deepEqual(progress, Array.from({ length: 16 }, (_, i) => i + 1), '진행 콜백이 완료 수를 세지 못했다');
  assert.deepEqual([...new Set(totals)], [16], '진행 콜백에 전체 수가 안 실렸다');
  assert.equal(new Set(arrivals.map(a => a.name)).size, 16, '병렬 굴림에서 동명이인이 생겼다');
  // 직무 균형 — 선굴림이 병렬 대기분을 못 세면 한 직무로 몰린다 (4직무 × 4명)
  const counts = {};
  for (const a of arrivals) counts[a.job] = (counts[a.job] || 0) + 1;
  assert.deepEqual(Object.values(counts).sort(), [4, 4, 4, 4], '직무가 균형을 잃었다');
});

test('병렬 전입 중 하나가 실패해도 나머지는 명부에 오르고, 오류는 다 가라앉은 뒤 던진다', async () => {
  const { llm, gates } = gatedLLM();
  const roster = new Roster(unit, { storage: memStorage() });
  const engine = new Engine(llm, { unit, roster, state: Engine.newCampaign(unit, '2026-08-26'), handlers: {} });
  const done = engine.fillRoster();
  await tick(); gates.shift().open();   // 예열 콜 통과
  await tick();
  gates.shift().fail(new Error('회선 두절'));
  while (gates.length) gates.shift().open();
  await assert.rejects(done, /회선 두절/);
  assert.equal(roster.soldiers.length, 15, '성공분이 명부에 안 올랐다');
  assert.equal(roster.vacancies(), 1, '재시도가 채울 빈 자리는 하나여야 한다');
});

test('부임 첫날 소음 콜은 브리핑과 나란히 난다 — 직렬 대기가 없다', async () => {
  const { llm, gates } = gatedLLM();
  const ambient = new AmbientPool(unit, { storage: memStorage() });
  const roster = new Roster(unit, { storage: memStorage() });
  for (let i = 0; i < 16; i++) {
    roster.enlist({ name: `기존${i}`, sheet: `기존시트${i}`, job: unit.jobs[i % 4], grade: 'B', character: '중', joined: '2026-05-01' });
  }
  const engine = new Engine(llm, {
    unit, roster, ambient, state: Engine.newCampaign(unit, '2026-08-26'), rng: seqRng(), handlers: {},
  });
  const done = engine.runDay();
  await tick();
  assert.deepEqual(gates.map(g => g.label), ['병영 소음 생성', '아침 브리핑'], '소음과 브리핑이 동시에 떠 있지 않다 — 직렬로 돌아갔다');
  while (gates.length) gates.shift().open();
  await done;
  assert.ok(ambient.ready(), '소음 풀이 안 채워졌다');
});

test('브리핑이 죽어 하루를 다시 열어도, 떠 있는 소음 콜을 또 쏘지 않는다', async () => {
  const { llm, gates } = gatedLLM();
  const ambient = new AmbientPool(unit, { storage: memStorage() });
  const roster = new Roster(unit, { storage: memStorage() });
  for (let i = 0; i < 16; i++) {
    roster.enlist({ name: `기존${i}`, sheet: `기존시트${i}`, job: unit.jobs[i % 4], grade: 'B', character: '중', joined: '2026-05-01' });
  }
  const engine = new Engine(llm, {
    unit, roster, ambient, state: Engine.newCampaign(unit, '2026-08-26'), rng: seqRng(), handlers: {},
  });
  const day1 = engine.runDay();
  await tick();
  gates.pop().fail(new Error('회선 두절'));   // 브리핑만 죽인다 — 소음 콜은 아직 떠 있다
  await assert.rejects(day1, /회선 두절/);

  const day2 = engine.runDay();   // 재시도
  await tick();
  const noiseCalls = gates.filter(g => g.label === '병영 소음 생성');
  assert.equal(noiseCalls.length, 1, '재시도가 소음 콜을 중복 발사했다');
  while (gates.length) gates.shift().open();
  await day2;
  assert.ok(ambient.ready(), '재시도 후에도 소음 풀이 안 채워졌다');
});

// ── 개입 셋 — 하루 첫 번은 공짜, 그 뒤로 평판 −1, 그날 회복 없음 ──────
test('하루 첫 개입은 평판을 안 깎는다 — 값이 붙는 것은 「또 오는 것」이다', async () => {
  const { engine, state } = fixture();
  const rep0 = state.params.rep;
  const free = TUNING.rep.freePerDay;
  for (let i = 1; i <= free; i++) {
    await engine.inspect('barracks');
    assert.equal(state.params.rep, rep0, `${i}번째 개입이 공짜가 아니다`);
  }
  await engine.inspect('barracks');
  assert.equal(state.params.rep, rep0 - 1, '무료분을 넘긴 개입이 안 깎였다');
  await engine.inspect('barracks');
  assert.equal(state.params.rep, rep0 - 2, '남발이 누적으로 안 붙는다');
  // 개입 횟수 자체는 전부 센다 — 조용한 날 회복은 「한 번도 안 왔다」에만 붙는다
  assert.equal(engine.interventionsToday, free + 2);
});

test('면담: 평판 비용, 왕복 가능, 프롬프트에는 그 병사와 체감 밴드만', async () => {
  const { llm, engine, state } = fixture();
  const rep0 = state.params.rep;
  engine.interventionsToday = TUNING.rep.freePerDay;   // 무료분은 이미 썼다
  const h = await engine.interview(engine.roster.soldiers[0].serial, '요즘 어때');
  assert.equal(h.reply, '병사의 대답');
  assert.equal(state.params.rep, rep0 - 1);
  assert.equal(engine.interventionsToday, TUNING.rep.freePerDay + 1);

  const req = llm.byLabel('면담')[0];
  const user = req.messages[0].content;
  assert.ok(user.includes('기존시트0'), '면담에 병사 프로필이 없다');
  assert.ok(user.includes('요즘 어때'), '면담에 질문이 없다');
  assert.ok(/your barracks room lately: (very-low|low|mid|high|very-high)/.test(user), '체감 밴드가 없다');

  // 왕복 — 추가 평판 비용 없음, 스레드가 자란다
  await h.ask('더 말해봐');
  assert.equal(state.params.rep, rep0 - 1);
  assert.equal(llm.byLabel('면담')[1].messages.length, 3);
});

test('불시점검: 그 장소가 드러내는 밴드만 실린다', async () => {
  const { llm, engine, state } = fixture();
  const rep0 = state.params.rep;
  engine.interventionsToday = TUNING.rep.freePerDay;
  const out = await engine.inspect('barracks');
  assert.equal(out.findings, '점검소견텍스트');
  assert.equal(state.params.rep, rep0 - 1);
  const user = llm.byLabel('불시점검')[0].messages[0].content;
  assert.ok(user.includes('friction-and-abuse'), '생활관이 갈등을 안 드러낸다');
  assert.ok(!user.includes('morale'), '생활관이 행복도까지 드러냈다 — 대응표 밖이다');
  assert.ok(!user.includes('corner-cutting'), '생활관이 가라까지 드러냈다');
});

test('공지: 게시는 저장, 판정은 방향뿐 — 평판은 판정이 못 건드린다', async () => {
  const { llm, engine, state } = fixture();
  const rep0 = state.params.rep, gara0 = state.params.gara;
  engine.interventionsToday = TUNING.rep.freePerDay;
  const out = await engine.postNotice('족구 금지');
  assert.equal(out.reaction, '또 뭘 금지한대');
  assert.deepEqual(state.notices, [{ text: '족구 금지', bans: [] }]);
  assert.equal(state.params.gara, gara0 - 1, 'N 판정 방향(down)이 안 먹혔다');
  assert.equal(state.params.rep, rep0 - 1, '공지의 평판 비용은 개입 1회분이다');
  // 판정 user에 부대 상태가 없다
  const user = llm.byLabel('공지 판정')[0].messages[0].content;
  assert.ok(!/(very-low|very-high|corner-cutting|morale|friction)/.test(user), 'N 판정이 부대 상태를 봤다');
});

test('개입한 날은 평판 회복이 없다 — 무료 한 번을 썼어도 조용한 날은 아니다', async () => {
  const { engine, state } = fixture();
  // 첫 슬롯에서 공지 하나 — 실제 게임과 같은 자리(일과 중 handlers)에서 개입한다
  engine.h.slot = async ({ index }) => { if (index === 0) await engine.postNotice('아무 공지'); };
  await engine.runDay();
  assert.equal(engine.interventionsToday, 1, '공지 한 번은 개입 1회다');
  // 하루 첫 개입은 평판을 안 깎지만(freePerDay), 그날이 「조용한 날」이 되지도 않는다.
  // 그래서 하루 한 번 손대는 플레이는 평판이 **정지**한다 — 오르지도 내리지도 않는 자리가
  // 있어야 평판이 0 아니면 10인 깃발이 아니라 화폐가 된다.
  assert.equal(state.params.rep, TUNING.start.rep, '무료 개입인데 평판이 움직였다');

  // 개입이 아예 없는 날은 회복이 붙는다
  const quiet = fixture();
  await quiet.engine.runDay();
  assert.equal(quiet.state.params.rep, TUNING.start.rep + TUNING.rep.quietDay);
});

// ── 하루의 장부 — 화면이 「오늘 무슨 일이 있었나」를 쓸 재료 ──
test('마감 스냅샷이 오늘의 장부를 싣는다 — 사건·개입·움직인 바늘', async () => {
  const { engine, events } = fixture({
    rng: seqRng([0.999, 0.999, 0.999, 0.999, 0.0001, 0]),   // 첫 슬롯에서 사건 하나
  });
  engine._directive = null;
  const snap = await engine.runDay();
  const t = snap.today;
  assert.ok(t, '장부가 안 실렸다');
  assert.equal(t.date, '2026-05-18', '장부는 오늘 날짜로 찍힌다 — 마감 시점의 내일이 아니다');
  assert.equal(t.incidents, 1);
  assert.equal(t.accidents, 0);
  assert.equal(t.interventions, 0);
  assert.equal(t.moved.rep, +1, '조용한 날 평판 회복이 장부에 안 잡혔다');
  // 손잡이가 받는 것과 돌려주는 것이 같아야 화면과 저장분이 안 갈린다
  assert.deepEqual(events.find(e => e[0] === 'dayEnd')[1].today, t);
});

test('장부의 「움직인 바늘」이 개입·판정·드리프트를 전부 합쳐서 센다', async () => {
  const { engine, state } = fixture();
  const dawn = { ...state.params };
  // 개입은 **일과 중에** 일어난다 — 하루가 열리기 전에 부르면 그 하루의 장부가 아니다.
  // 두 번 들이닥친다 — 하루 첫 개입은 공짜라(freePerDay) 평판이 움직이는 것을 보려면 둘째가 필요하다
  engine.h.slot = async ({ index }) => { if (index <= 1) await engine.inspect('barracks'); };
  const snap = await engine.runDay();
  const t = snap.today;
  assert.equal(t.interventions, 2);
  assert.ok(t.moved.rep < 0, '무료분을 넘겼는데 평판이 안 깎였다');
  // 장부는 **새벽과 마감의 차이**다 — 축마다 실제 이동량과 정확히 같아야 한다
  for (const k of ['gara', 'happy', 'conflict', 'rep']) {
    assert.equal(t.moved[k] ?? 0, state.params[k] - dawn[k], `${k} 장부가 실제 이동과 다르다`);
  }
  // 안 움직인 축은 아예 안 실린다 — 화면이 「바늘은 그대로다」를 쓸 수 있어야 한다
  for (const [k, v] of Object.entries(t.moved)) assert.notEqual(v, 0, `${k}가 0인 채로 실렸다`);
});

test('dayNo는 지금 date가 부임 며칠째인가다 — 첫날은 0일차가 아니라 1일차다', async () => {
  const { engine } = fixture();
  assert.equal(engine.snapshot().dayNo, 1, '부임 첫날이 0일차로 찍힌다');
  const snap = await engine.runDay();
  assert.equal(snap.day, 1, 'day는 마감한 날 수 그대로다');
  assert.equal(snap.dayNo, 2, '달력이 내일로 갔는데 부임일차가 안 따라갔다');
  assert.equal(snap.date, '2026-05-19');
});

// ── 드리프트 — 부대의 평소치가 하루 마감에 실린다 ────────
test('하루 마감은 이 부대의 평소 난이도를 같이 넘긴다 — 빡센 부대의 매일이 힘든 날이 되지 않게', async () => {
  // 난이도 8로 저작된 부대를 무개입으로 30일 굴린다. 예전에는 이레 만에 행복이 0에 붙었다.
  const hard = { ...unit, difficulty: 8 };
  const llm = new FakeLLM();
  const roster = new Roster(hard, { storage: memStorage() });
  for (let i = 0; i < 16; i++) {
    roster.enlist({ name: `기존${i}`, sheet: 's', job: hard.jobs[i % 4], grade: 'B', character: '중', joined: '2026-05-01' });
  }
  const ambient = new AmbientPool(hard, { storage: memStorage() });
  ambient.fill([{ slot: 'reveille', text: '또 아침이네' }]);
  const engine = new Engine(llm, {
    unit: hard, roster, ambient, state: Engine.newCampaign(hard, '2026-08-26'),
    rng: () => 0.999,       // 사건 없음 — 순수 드리프트만 본다
    garaRng: () => 0.999,   // 검열도 아무것도 못 잡는다. 이 30일이 재는 것은 달력뿐이다
    handlers: { incident: () => null },
  });
  for (let d = 0; d < 30; d++) await engine.runDay();
  assert.ok(engine.state.params.happy >= 4, `무개입 30일에 행복이 ${engine.state.params.happy}까지 내려갔다`);
  assert.ok(roster.soldiers.every(m => m.mental >= 4), '방치만 했는데 전원 멘탈이 무너졌다');
});

// ── 멘탈 경제가 한 방향으로 흐르지 않는다 (실측으로 고친 자리) ──────
// 예전에는 어느 플레이를 해도 100일이면 열여섯 명 전원이 0에 눌러앉았다. 원인 셋을 고쳤다:
// 하락에 인원을 주고(전원 → 몇 명), 회복에 하한을 주고(전우애 0.5명 → 최소 1명),
// 잔사건 연루가 사람을 안 깎게 했다(사고가 된 것만 남는다).
// 그게 안 지켜지면 「멘탈 2 이하는 큰 사고의 문」이라던 예외가 상시 켜진 기본값이 되고,
// 무사고 완주가 산술적으로 불가능해진다. 이 테스트가 그 회귀를 막는다.
test('사건이 매일 나는 부대에서도 사람이 전멸하지 않는다 — 100일 뒤에도 명부가 살아 있다', async () => {
  const { engine, roster } = fixture({
    // 사건을 매일 하나씩 만들되 전부 수습된다 — 잔사건만으로 부대가 죽는지 본다
    rng: cycleRng([0.999, 0.999, 0.999, 0.999, 0.0001, 0]),
  });
  engine._directive = null;
  for (let d = 0; d < 100; d++) await engine.runDay();
  const men = roster.present.map(m => m.mental ?? 6);
  const avg = men.reduce((a, b) => a + b, 0) / men.length;
  assert.ok(avg >= 3, `잔사건만 100일 겪었는데 멘탈 평균이 ${avg.toFixed(1)}이다`);
  assert.ok(men.some(m => m > TUNING.mental.dangerAt),
    '전원이 큰 사고 문턱 아래로 내려갔다 — 예외적 위험이 기본값이 됐다');
});

// ── 진급 ────────────────────────────────────────────────
test('무사고 100일이면 진급이다', async () => {
  const { engine, state } = fixture();
  state.streak = 99;
  const snap = await engine.runDay();
  assert.equal(snap.streak, 100);
  assert.ok(snap.promoted, '100일을 찍었는데 진급이 안 됐다');
});

// ── F. 환송회 — 마지막 밤. 행복도가 연다 ────────────────
test('행복한 부대는 환송회를 차린다 — 병사들이 나와서 인사한다', async () => {
  const { llm, engine, state, roster } = fixture();
  state.params.happy = 9;
  roster.soldiers.forEach((m, i) => { m.mental = i === 5 ? 10 : 3; });   // 기존5가 제일 잘 버텼다
  const out = await engine.farewell();

  assert.equal(out.tone, 'grand');
  assert.deepEqual(llm.labels(), ['환송회'], '마지막 밤은 한 콜이다');
  assert.equal(out.speakers.length, TUNING.farewell.speakers.grand);
  assert.equal(out.scene, '환송회장면');
  assert.equal(out.closing, '위병소를 나선다');
  // 프롬프트에는 결과 사기 밴드까지만 간다 — 숫자는 못 나간다
  const user = JSON.stringify(llm.byLabel('환송회')[0].messages);
  assert.ok(user.includes('grand'), '코드가 정한 결이 안 실렸다');
  assert.ok(user.includes('very-high'), '사기 밴드가 안 실렸다');
  assert.ok(!/\bhappy\b.{0,4}9/.test(user), '행복도 수치가 샜다');
});

test('명부에 없는 놈은 인사할 수 없다 — 마지막 장면이 명부에 대해 거짓말하지 않는다', async () => {
  const { engine, state, roster } = fixture();
  state.params.happy = 9;
  roster.soldiers.forEach((m, i) => { m.mental = i === 5 ? 10 : 3; });
  const out = await engine.farewell();
  assert.deepEqual(out.lines.map(l => l.name), ['기존5'], '없는 병사가 인사하고 갔다');
  // 군번이 붙어야 화면이 그날의 계급을 찍을 수 있다
  assert.equal(out.lines[0].serial, roster.soldiers[5].serial);
});

test('불행한 부대의 마지막 밤에는 아무도 없다 — 모형이 대사를 써 보내도 안 실린다', async () => {
  const { engine, state } = fixture();
  state.params.happy = 1;
  const out = await engine.farewell();
  assert.equal(out.tone, 'none');
  assert.deepEqual(out.speakers, [], '아무도 없는 밤에 사람이 섰다');
  assert.deepEqual(out.lines, [], '아무도 없는데 인사가 들렸다');
  assert.equal(out.scene, '환송회장면', '빈 방도 장면은 있다');
});

test('중간이면 몇 명만 남는다 — 거하지도, 아무도 없지도 않다', async () => {
  const { engine, state, roster } = fixture();
  state.params.happy = 5;
  roster.soldiers.forEach((m, i) => { m.mental = i === 5 ? 10 : 3; });
  const out = await engine.farewell();
  assert.equal(out.tone, 'thin');
  assert.equal(out.speakers.length, TUNING.farewell.speakers.thin);
  assert.deepEqual(out.lines.map(l => l.name), ['기존5']);
});

test('마지막 밤은 한 번뿐이다 — 다시 열어도 같은 밤이고 콜은 안 나간다', async () => {
  const { llm, engine, state } = fixture();
  state.params.happy = 9;
  const first = await engine.farewell();
  llm.farewellOut = { scene: '다른장면', lines: [], closing: '다른마무리' };
  const second = await engine.farewell();
  assert.deepEqual(second, first, '두 번째로 연 밤이 달라졌다');
  assert.equal(llm.byLabel('환송회').length, 1, '콜이 한 번 더 나갔다');
  // 저장분에도 눕는다 — 화면을 새로 열어도 그 밤 그대로다
  assert.deepEqual(state.farewell, first);
  assert.deepEqual(engine.snapshot().farewell, first);
});

test('환송회는 파라미터도 카운터도 안 민다 — 끝난 자리에는 되돌릴 것이 없다', async () => {
  const { engine, state } = fixture();
  state.params.happy = 9;
  const before = { ...state.params };
  const streak = state.streak;
  await engine.farewell();
  assert.deepEqual(state.params, before, '마지막 밤이 파라미터를 밀었다');
  assert.equal(state.streak, streak);
});

// ── A. 병영 소음 — 부임 때 한 콜, 그 뒤로는 공짜 ────────
test('부임 첫날만 소음을 한 콜 더 받는다 — 둘째 날부터는 브리핑 하나뿐이다', async () => {
  const { llm, engine, ambient } = fixture({ ambientReady: false });
  assert.equal(ambient.ready(), false);

  await engine.runDay();
  assert.deepEqual(llm.labels(), ['병영 소음 생성', '아침 브리핑'], '부임 첫날 콜이 둘이 아니다');
  assert.ok(ambient.ready(), '소음 풀이 안 채워졌다');

  llm.calls.length = 0;
  await engine.runDay();
  assert.deepEqual(llm.labels(), ['아침 브리핑'], '둘째 날에 소음을 또 받았다 — 캐시가 안 먹었다');
});

test('소음 호출은 부대 상태를 한 글자도 안 본다 — 그래서 100일을 버틴다', async () => {
  const { llm, engine, state } = fixture({ ambientReady: false });
  state.yesterday = '어제표식';
  state.notices.push('지침표식');
  await engine.runDay();
  const req = llm.byLabel('병영 소음')[0];
  const whole = JSON.stringify({ system: req.system, messages: req.messages });
  for (const leak of ['어제표식', '지침표식', 'very-low', 'very-high', 'mid', '기존시트0']) {
    assert.ok(!whole.includes(leak), `소음 호출이 「${leak}」를 봤다`);
  }
  assert.ok(whole.includes('CULT표식'), '소음 호출에 부대 프롬프트가 없다');
});

test('슬롯마다 스프라이트 대사가 딸려 나온다 — 콜은 하나도 안 는다', async () => {
  const { llm, engine, events } = fixture();
  await engine.runDay();
  assert.deepEqual(llm.labels(), ['아침 브리핑'], '대사 때문에 콜이 늘었다');
  const withChatter = events.filter(e => e[0] === 'slotChatter');
  assert.ok(withChatter.length > 0, '슬롯 핸들러가 대사를 못 받았다');
});

test('소음 호출이 실패해도 하루는 돈다 — 군가는 static이라 그대로 나온다', async () => {
  const { engine, ambient } = fixture({ ambientReady: false });
  engine.llm.call = async req => {
    if ((req.label || '').startsWith('병영 소음')) throw new Error('회선 두절');
    return new FakeLLM().call(req);
  };
  const snap = await engine.runDay();
  assert.equal(snap.streak, 1, '소음이 없다고 하루가 안 돌았다');
  assert.equal(ambient.ready(), false);
  // 잡담 풀이 비어도 군가 자리에서는 소리가 난다
  const got = engine.ambientFor('reveille', 3);
  assert.ok(got.every(g => g.kind === 'song'), '풀이 비었는데 없는 잡담이 나왔다');
});

test('연출은 게임 롤을 밀어내지 않는다 — 말풍선 수가 사고 확률을 바꾸면 안 된다', async () => {
  // 같은 게임 난수, 다른 대사 개수. 하루의 결과가 **바이트 동일**해야 한다.
  const run = async (chatterCount) => {
    const f = fixture({ rng: incidentRng() });
    f.engine._directive = null;
    // 슬롯마다 뽑는 대사 수를 바꿔 연출 난수를 다르게 소모시킨다
    const orig = f.engine.ambientFor.bind(f.engine);
    f.engine.ambientFor = k => orig(k, chatterCount);
    await f.engine.runDay();
    return { labels: f.llm.labels(), streak: f.state.streak, params: { ...f.state.params } };
  };
  const a = await run(1);
  const b = await run(3);
  assert.deepEqual(a.labels, b.labels, '대사 개수가 사건 발생 여부를 바꿨다 — 난수 통이 섞였다');
  assert.equal(a.streak, b.streak);
  assert.deepEqual(a.params, b.params);
  // 그리고 그 하루에는 실제로 사건이 있었다 — 빈 하루끼리 비교해 놓고 통과한 게 아니다
  assert.ok(a.labels.includes('사건 장면'), '사건이 없는 하루로 비교했다');
});

// ── 이름·계급·기수 — 굴림은 코드가 한다 ─────────────────
test('병렬로 굴려도 직무가 한쪽에 안 몰린다 — 굴림은 순서대로 끝내 놓기 때문이다', async () => {
  const llm = new FakeLLM();
  const roster = new Roster(unit, { storage: memStorage() });
  const engine = new Engine(llm, { unit, roster, state: Engine.newCampaign(unit, '2026-08-26'), handlers: {} });
  const arrivals = await engine.fillRoster();
  const counts = {};
  for (const a of arrivals) counts[a.job] = (counts[a.job] || 0) + 1;
  const n = Object.values(counts);
  assert.equal(Object.keys(counts).length, 4, '직무 넷을 다 안 썼다');
  assert.ok(Math.max(...n) - Math.min(...n) <= 1, `직무가 몰렸다: ${JSON.stringify(counts)}`);
});

test('P는 굴려진 이름·기수·계급을 받는다 — LLM은 이름을 안 짓는다', async () => {
  const llm = new FakeLLM();
  const roster = new Roster(unit, { storage: memStorage() });
  const engine = new Engine(llm, { unit, roster, state: Engine.newCampaign(unit, '2026-08-26'), handlers: {} });
  const [one] = await engine.fillRoster(['2026-01-10']);
  const user = llm.byLabel('전입')[0].messages[0].content;
  assert.ok(user.includes(`name: ${one.name}`), 'P에 굴려진 이름이 안 실렸다');
  assert.ok(/standing[^\n]*\d+기 (이병|일병|상병|병장)/.test(user), 'P에 기수·계급이 안 실렸다');
  assert.deepEqual(Object.keys(P_RECRUIT.properties), ['sheet'], 'P가 아직 이름을 내보낸다');
});

test('프롬프트로 나가는 병사에는 그날의 기수·계급이 붙는다', async () => {
  const { llm, engine } = fixture();
  await engine.runDay();
  const user = llm.byLabel('아침 브리핑')[0].messages[0].content;
  assert.match(user, /\d+기 (이병|일병|상병|병장)/, '명부 발췌에 기수·계급이 없다');
});

test('계급과 기수는 저장되지 않는다 — 날이 가면 계급이 오른다', async () => {
  const { roster } = fixture();
  for (const s of roster.soldiers) {
    assert.ok(!('rank' in s), '계급이 저장됐다 — 100일 내내 같은 계급이 된다');
    assert.ok(!('cohort' in s), '기수가 저장됐다');
  }
});

// ── 멘탈 — 저장되는 개인 상태. 상담이 올리고, 사건이 깎고, 분위기가 쓸어간다 ──
test('면담은 상담이다 — 그 병사의 멘탈이 +1 오르고, 왕복해도 한 번만 오른다', async () => {
  const { engine, roster, state } = fixture();
  const man = roster.soldiers[0];
  man.mental = 3;
  const rep0 = state.params.rep;
  engine.interventionsToday = TUNING.rep.freePerDay;
  engine.rng = () => 0;            // 평판이 높으니 면담은 먹힌다 (counselTakes)
  const h = await engine.interview(man.serial, '요즘 잠은 자냐');
  assert.equal(man.mental, 4, '상담이 멘탈을 안 올렸다');
  assert.equal(h.took, true);
  assert.deepEqual(h.mental, { before: 3, after: 4 }, '화면에 보여줄 회복량이 안 실렸다');
  await h.ask('더 얘기해봐');
  assert.equal(man.mental, 4, '왕복마다 올랐다 — 스팸으로 무한 회복이 된다');
  assert.equal(state.params.rep, rep0 - 1, '상담이어도 평판 비용은 개입 1회분이다');
});

test('씹히는 주임원사의 면담은 안 통한다 — 그래도 부른 값은 치른다', async () => {
  const { engine, roster, state } = fixture();
  const man = roster.soldiers[0];
  man.mental = 3;
  state.params.rep = 0;                  // 대놓고 안 듣는 자리
  engine.interventionsToday = TUNING.rep.freePerDay;
  engine.rng = () => 0.99;               // 수용 굴림 실패
  const h = await engine.interview(man.serial, '요즘 잠은 자냐');
  assert.equal(h.took, false, '평판 0인데 면담이 그대로 먹혔다');
  assert.equal(man.mental, 3, '안 통했는데 멘탈이 올랐다');
  // 불려간 것 자체가 소문이다 — 값은 이미 치렀다
  assert.equal(state.params.rep, 0, '평판이 눈금 아래로 갔다');
  assert.equal(engine.interventionsToday, TUNING.rep.freePerDay + 1);
});

test('면담 프롬프트에 그 병사의 멘탈이 밴드로 실린다 — 숫자는 안 나간다', async () => {
  const { llm, engine, roster } = fixture();
  roster.soldiers[0].mental = 1;
  await engine.interview(roster.soldiers[0].serial, '괜찮냐');
  const user = llm.byLabel('면담')[0].messages[0].content;
  assert.ok(/spirit: very-low/.test(user), '멘탈 밴드가 안 실렸다');
  assert.ok(!/spirit: 1\b/.test(user), '멘탈 숫자가 샜다');
});

test('점검은 군기 레버다 — 가라 −1 · 행복 −1이 코드로 확정 적용된다', async () => {
  const { engine, state } = fixture();
  const { gara, happy, rep } = state.params;
  engine.interventionsToday = TUNING.rep.freePerDay;
  const out = await engine.inspect('worksite');
  assert.equal(state.params.gara, gara - 1);
  assert.equal(state.params.happy, happy - 1);
  assert.equal(state.params.rep, rep - 1);
  assert.deepEqual(out.effect, { gara: -1, happy: -1 }, '화면에 보여줄 효과가 안 실렸다');
});

test('잔사건에 이름이 오르는 것은 상처가 아니다 — 남는 것은 사고가 된 것뿐이다', async () => {
  // 잔사건마다 −1이던 시절, 해병은 100일에 연루 연인원 142명이었다 — 부대 멘탈 총량이
  // 96점인데 타격만 142점이라 어느 플레이를 해도 전원이 0에 눌러앉았다.
  const contained = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'contained', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  for (const man of contained.roster.soldiers) man.mental = 6;
  contained.engine._directive = null;
  await contained.engine.runDay();
  assert.ok(contained.roster.soldiers.every(s => s.mental === 6),
    '수습된 잔사건이 사람을 깎았다 — 하루에 한 번씩 뭔가 있는 것이 군대다');

  // 사고가 되면 남는다
  const blown = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  for (const man of blown.roster.soldiers) man.mental = 6;
  blown.engine._directive = null;
  await blown.engine.runDay();
  const hit = blown.roster.soldiers.filter(s => s.mental < 6);
  assert.equal(hit.length, 1, '확전했는데 아무도 안 깎였다');
  assert.equal(hit[0].mental, 5, '잔사건이 사고가 된 몫은 한 칸이다');
});

test('부대가 어두우면 몇 명이 무너진다 — 전원이 아니라 그날 하필 그 사람들이다', async () => {
  const { engine, roster, state } = fixture();
  state.params.happy = 0;   // 끈끈한 부대는 분위기 방패가 두꺼워 문턱이 낮다
  for (const man of roster.soldiers) man.mental = 6;
  await engine.runDay();
  const down = roster.soldiers.filter(s => s.mental < 6);
  assert.ok(down.length > 0, '어두운 부대인데 아무도 안 무너졌다');
  assert.ok(down.length < roster.soldiers.length,
    '전원이 같은 밤에 무너졌다 — 하루의 하락이 열흘치 회복이 되면 경제가 성립하지 않는다');
  // 저장까지 — 다시 읽어도 남아 있어야 「어제 무너진 놈이 오늘도 무너져 있는」 게임이 된다
  const again = new Roster(unit, { storage: roster.storage });
  again.load();
  assert.deepEqual(again.soldiers.map(s => s.mental), roster.soldiers.map(s => s.mental), '멘탈이 저장 안 됐다');
});

test('멘탈이 바닥난 병사가 있으면 그 놈의 큰 사건이 열린다', async () => {
  const { llm, engine, roster } = fixture({
    // sample 4개 → 슬롯 롤 첫 개에서 큰 롤이 잡히게 0.001
    rng: seqRng([0.999, 0.999, 0.999, 0.999, 0.001, 0]),
  });
  roster.soldiers[7].mental = 1;   // 한 명이 무너져 있다
  engine._directive = null;
  await engine.runDay();
  const e1 = llm.byLabel('사건 장면')[0];
  assert.ok(e1, '멘탈 위험이 큰 사건을 안 열었다');
  const user = JSON.stringify(e1.messages);
  assert.ok(user.includes('기존7'), '무너진 그 놈이 아니라 딴 놈이 연루됐다');
  assert.ok(user.includes('major'), '큰 사건이 아니다');
});

test('전입 병사도 멘탈을 굴려 받는다 — 저장까지', async () => {
  const llm = new FakeLLM();
  const roster = new Roster(unit, { storage: memStorage() });
  const engine = new Engine(llm, { unit, roster, state: Engine.newCampaign(unit, '2026-08-26'), handlers: {} });
  const arrivals = await engine.fillRoster();
  assert.ok(arrivals.every(a => typeof a.mental === 'number' && a.mental >= 0 && a.mental <= 10));
});

// ══════════════════════════════════════════════════════════
// 가라 내역 — 개수는 계기판이, 정체는 점검이
//
// 이 절이 지키는 것은 「무엇을 보여주고 무엇을 숨기는가」다.
// 화면은 진짜 목록을 절대 못 받고, 명부는 확인한 그날의 사실로만 채워진다.
// ══════════════════════════════════════════════════════════

const GARA = await import('../js/params.js');
const placeOf = id => GARA.GARA_BY_ID[id].place;

test('부임하면 「가라 4」가 실제 관행 넷이 된다 — 수치가 원본이고 목록이 따라간다', () => {
  const { engine, state } = fixture();
  assert.equal(state.gara.active.length, state.params.gara);
  assert.equal(new Set(state.gara.active).size, state.gara.active.length);
  // 부임 첫날에는 아무것도 확인돼 있지 않다 — 들이닥친 적이 없으니까
  assert.deepEqual(state.gara.known, []);
  assert.deepEqual(state.gara.seen, {});
  assert.ok(engine.bannedGara().length === 0);
});

test('화면은 진짜 목록을 못 받는다 — 계기판은 개수만 말한다', () => {
  const { engine, state } = fixture();
  const snap = engine.snapshot();
  assert.equal(snap.gara.running, state.params.gara, '개수는 줘야 한다 — 그건 게이지다');
  assert.deepEqual(snap.gara.known, [], '확인한 것만 화면에 간다');
  // 진짜 목록이 스냅샷 어딘가에 통째로 실려 있으면 안 된다
  const dump = JSON.stringify(snap);
  for (const id of state.gara.active) {
    assert.ok(!dump.includes(id), `스냅샷에 확인도 안 한 ${id}가 실렸다 — 안개가 사라진다`);
  }
});

test('들이닥치면 그 자리 것이 명부에 오른다 — 산 정보가 그 자리에서 지워지지 않는다', async () => {
  // 적발 확률 1로 고정(rng 0) — 그 자리에서 도는 것은 전부 걸린다
  const { engine, state } = fixture({ garaRng: () => 0 });
  state.gara.active = GARA.GARA_IDS.slice();
  state.params.gara = 10;   // 눈금 상한. 목록이 더 길어도 점검 끝의 sync가 눈금까지 깎는다
  const here = state.gara.active.filter(id => placeOf(id) === 'barracks');
  const gara0 = state.params.gara;

  const out = await engine.inspect('barracks');
  assert.deepEqual(out.spotted.map(g => g.id).sort(), here.slice().sort(), '그 자리 것이 다 안 걸렸다');
  assert.equal(state.gara.seen.barracks, state.date, '확인 날짜가 안 찍혔다');
  assert.equal(state.params.gara, gara0 - 1, '점검의 가라 −1이 안 먹혔다');
  // 명부는 적발한 만큼 그대로 남는다 — 점검의 −1이 방금 산 정보를 도로 먹으면 안 된다.
  // (그렇게 만들었다가 「털고 나면 명부가 언제나 빈다」로 물린 자리다.)
  const known = state.gara.known.map(k => k.id).sort();
  assert.deepEqual(known, here.slice().sort(), '적발한 것이 명부에 안 남았다');
  for (const k of state.gara.known) assert.equal(k.on, state.date);
});

test('들이닥치면 그 자리에 묻혀 있던 것이 하나 올라온다 — 다른 자리 것은 그대로다', async () => {
  const { engine, state } = fixture({ garaRng: () => 0.999 });
  const rec = (place, i) => ({
    date: '2026-05-10', tier: 'minor', desc: `묻힌${place}${i}`, category: null,
    place, slot: 'amwork', names: ['기존0'],
  });
  state.buried = [rec('barracks', 0), rec('barracks', 1), rec('worksite', 0)];

  const out = await engine.inspect('barracks');
  const per = TUNING.comrade.buried.surfacePerInspect;
  assert.equal(out.surfaced.length, per, '들어가 봤는데 아무것도 안 나왔다');
  assert.equal(out.surfaced[0].place, 'barracks', '안 간 자리 것이 나왔다');
  assert.equal(state.buried.length, 3 - per, '올라온 것이 더미에서 안 빠졌다');
  assert.ok(state.buried.some(b => b.place === 'worksite'), '다른 자리 것까지 같이 올라왔다');
  assert.equal(state.silence.surfaced, per, '누계가 안 늘었다');
  // 뒤에 몇 건이 더 있는지는 여전히 안 준다 — 그게 이 게임에 남은 안개다
  assert.equal(out.buried, undefined, '점검이 더미 개수를 흘렸다');
});

test('아무것도 안 묻은 자리를 털면 조용하다 — 없는 것을 만들어 내지 않는다', async () => {
  const { engine, state } = fixture({ garaRng: () => 0.999 });
  state.buried = [];
  const out = await engine.inspect('barracks');
  assert.deepEqual(out.surfaced, [], '빈 더미에서 뭔가 나왔다');
  assert.equal(state.silence.surfaced, 0);
});

test('머리 좋은 부대는 들이닥쳐도 숨긴다 — 명부가 빈 채로 남는다', async () => {
  // 적발 굴림을 전부 실패시킨다(rng 0.999) — 「지능 높은 부대」의 극단
  const { engine, state } = fixture({ garaRng: () => 0.999 });
  const key = placeOf(state.gara.active[0]);
  const out = await engine.inspect(key);
  assert.deepEqual(out.spotted, [], '전부 숨겼는데 걸렸다');
  assert.deepEqual(state.gara.known, [], '못 봤는데 명부가 채워졌다');
  // 그래도 자리는 확인한 것으로 찍힌다 — 「가 봤는데 아무것도 못 봤다」도 정보다
  assert.equal(state.gara.seen[key], state.date);
  // 못 잡았어도 각은 잡힌다. 다만 멎는 것은 적발과 무관한 아무거나다
  assert.equal(state.params.gara, TUNING.start.gara - 1);
});

test('점검 소견 프롬프트에는 적발한 것만 실린다 — 숨긴 것은 모형도 모른다', async () => {
  const { llm, engine, state } = fixture({ garaRng: () => 0 });
  // 두 자리에서 돌게 만들어 두고 한 자리만 턴다 — 굴림에 맡기면 한 자리로 몰릴 수 있다
  state.gara.active = GARA.GARA_IDS.slice();
  state.params.gara = GARA.GARA_IDS.length;
  const key = 'barracks';
  const here = state.gara.active.filter(id => placeOf(id) === key);
  const elsewhere = state.gara.active.filter(id => placeOf(id) !== key);
  assert.ok(here.length && elsewhere.length, '이 단언에는 두 자리 이상의 관행이 필요하다');

  await engine.inspect(key);
  const user = llm.byLabel('불시점검')[0].messages[0].content;
  for (const id of here) assert.ok(user.includes(GARA.GARA_BY_ID[id].en), `적발한 ${id}가 소견 재료에 없다`);
  for (const id of elsewhere) assert.ok(!user.includes(GARA.GARA_BY_ID[id].en), `딴 자리 ${id}가 실렸다`);
});

test('사건 장면에는 그 자리·그 시간에 돌던 가라만 재료로 실린다 — 사건이 허공에서 안 난다', async () => {
  const { llm, engine, state } = fixture({ rng: seqRng([0.999, 0.999, 0.999, 0.999, 0.001, 0]) });
  // 대장 전체를 돌게 만들어 어느 자리에서 사건이 나든 재료가 있게 한다
  state.gara.active = GARA.GARA_IDS.slice();
  state.params.gara = 10;
  engine._directive = null;
  await engine.runDay();

  const e1 = llm.byLabel('사건 장면')[0];
  assert.ok(e1, '사건이 안 났다');
  const user = e1.messages.at(-1).content;
  const mentioned = GARA.GARA_POOL.filter(g => user.includes(g.en));
  // 실린 것이 하나도 없을 수는 있다 — 그 자리에 그 시간에 도는 것이 없으면 그게 맞다.
  // 대장 전체가 돌고 있어도 **자리와 시간이 둘 다 맞아야** 재료가 된다는 것이 이 표의 전부다.
  const places = new Set(mentioned.map(g => g.place));
  assert.ok(places.size <= 1, '한 자리 것만 실려야 한다 — 부대 전체 목록이 새면 안개가 사라진다');
  // 실린 것은 전부 그 시각에 실제로 도는 것이어야 한다
  const slotKey = GARA.SLOT_KEYS.find(k => mentioned.every(g => g.when.includes(k)));
  if (mentioned.length) assert.ok(slotKey, '그 시간에 안 도는 관행이 장면 재료로 실렸다');
});

test('시간이 안 맞으면 그 자리에 가도 안 걸린다 — 급습은 자리와 시간이 둘 다 맞아야 한다', () => {
  // 대리 점호는 생활관에서 점호 때만 돈다. 같은 생활관이라도 오후에 들이닥치면 없다.
  const roll = GARA.GARA_BY_ID['proxy-rollcall'];
  assert.deepEqual(GARA.garaAt([roll.id], 'barracks', 'reveille'), [roll.id]);
  assert.deepEqual(GARA.garaAt([roll.id], 'barracks', 'pmwork'), [], '점호 관행이 오후에도 잡혔다');
  assert.deepEqual(GARA.garaAt([roll.id], 'barracks'), [roll.id], '시간을 안 주면 자리 전부여야 한다');

  // 명부 정리도 같은 규칙을 지킨다 — 볼 수 있었던 것만 지운다.
  const known = [{ id: roll.id, on: '2026-05-01' }];
  const off = GARA.inspectGara({
    active: [], known, placeKey: 'barracks', slotKey: 'pmwork',
    intel: 5, on: '2026-05-10', rng: () => 0,
  });
  assert.deepEqual(off.known, known, '이 시간엔 원래 안 보이는데 명부에서 지웠다');
  const on = GARA.inspectGara({
    active: [], known, placeKey: 'barracks', slotKey: 'reveille',
    intel: 5, on: '2026-05-10', rng: () => 0,
  });
  assert.deepEqual(on.known, [], '볼 수 있었는데 없으면 지워야 한다');
});

// ── 공지 — 텍스트가 관행을 끊는 자리 ────────────────────
test('공지가 돌던 관행을 끊으면 가라가 그만큼 내려간다', async () => {
  const { llm, engine, state } = fixture();
  const running = state.gara.active.slice(0, 2);
  llm.noticeVerdict = { gara: 'up', happy: 'same', conflict: 'same', bans: running, reaction: '또 뭘 금지한대' };
  const gara0 = state.params.gara;

  const out = await engine.postNotice('폰통에 폰 안 넣는 놈들 오늘부터 내가 직접 센다');
  assert.deepEqual(out.cut.map(g => g.id).sort(), running.slice().sort());
  // 끊은 개수가 곧 가라 효과다 — 판정자의 gara 방향(up)은 버려진다
  assert.equal(state.params.gara, gara0 - running.length, '끊은 만큼 안 내려갔거나, 판정 방향까지 겹쳐 셌다');
  for (const id of running) assert.ok(!state.gara.active.includes(id), `끊은 ${id}가 아직 돈다`);
  assert.equal(state.gara.active.length, state.params.gara, '목록과 수치가 어긋났다');
});

test('안 돌던 것을 막으면 문만 닫힌다 — 가라는 안 내려간다', async () => {
  const { llm, engine, state } = fixture();
  const idle = GARA.GARA_IDS.filter(id => !state.gara.active.includes(id)).slice(0, 2);
  llm.noticeVerdict = { gara: 'same', happy: 'same', conflict: 'same', bans: idle, reaction: '뭐래' };
  const gara0 = state.params.gara;

  const out = await engine.postNotice('창고 재고는 실물과 맞춘다');
  assert.deepEqual(out.cut, [], '안 돌던 것을 끊었다고 한다');
  assert.deepEqual(out.banned.map(g => g.id).sort(), idle.slice().sort());
  assert.equal(state.params.gara, gara0, '안 돌던 것을 막았는데 가라가 내려갔다');
  assert.ok(engine.snapshot().gara.cap < GARA.GARA_POOL.length, '천장이 안 내려갔다');
});

test('막아 놓은 관행은 다시 안 생긴다 — 가라가 올라도 다른 것이 대신 선다', async () => {
  const { llm, engine, state } = fixture();
  const banned = GARA.GARA_IDS.slice(0, 6);
  llm.noticeVerdict = { gara: 'same', happy: 'same', conflict: 'same', bans: banned, reaction: '하' };
  await engine.postNotice('여섯 가지를 콕 집어 금지한다');

  // 가라를 천장까지 밀어 본다
  state.params.gara = 10;
  await engine.postNotice('아무 말');
  assert.ok(state.params.gara <= GARA.GARA_POOL.length - banned.length, '금지가 천장을 못 내렸다');
  for (const id of banned) assert.ok(!state.gara.active.includes(id), `막힌 ${id}가 다시 생겼다`);
});

test('지침을 철회하면 문만 다시 열린다 — 끊긴 가라가 되살아나지는 않는다', async () => {
  const { llm, engine, state } = fixture();
  const running = state.gara.active.slice(0, 1);
  llm.noticeVerdict = { gara: 'same', happy: 'same', conflict: 'same', bans: running, reaction: '흠' };
  await engine.postNotice('그거 하지 마라');
  const cutGara = state.params.gara;

  engine.removeNotice(0);
  assert.equal(engine.bannedGara().length, 0, '철회했는데 금지가 남았다');
  assert.equal(engine.snapshot().gara.cap, GARA.GARA_POOL.length, '천장이 안 돌아왔다');
  assert.equal(state.params.gara, cutGara, '철회했다고 가라가 도로 올라갔다 — 시간이 할 일이다');
});

// ── 저장·회귀 ───────────────────────────────────────────
test('옛 저장분을 읽어도 안 죽는다 — 지침이 문자열이던 시절, 가라 내역이 없던 시절', () => {
  const old = Engine.newCampaign(unit, '2026-08-26');
  old.notices = ['족구 금지', '흡연장 청소'];
  delete old.gara;
  const { engine } = (() => {
    const llm = new FakeLLM();
    const roster = new Roster(unit, { storage: memStorage() });
    return { engine: new Engine(llm, { unit, roster, state: old, handlers: {}, garaRng: seqRng() }) };
  })();
  assert.deepEqual(old.notices, [{ text: '족구 금지', bans: [] }, { text: '흡연장 청소', bans: [] }]);
  assert.equal(old.gara.active.length, old.params.gara, '옛 저장분에 가라 내역이 안 깔렸다');
  assert.deepEqual(engine.bannedGara(), []);
});

test('가라 난수는 사고 롤을 못 민다 — 말풍선 때 겪은 그 사고를 다시 안 겪는다', async () => {
  // 게임 난수는 똑같이 주고, 가라 통만 다르게 준다. 그날의 결과가 같아야 한다.
  const run = async (garaSeed) => {
    const { engine, state } = fixture({
      rng: seqRng([0.5, 0.5, 0.5, 0.5, 0.02, 0.4]),
      garaRng: seqRng(garaSeed),
      judges: [{ outcome: 'escalated', gara: 'up', happy: 'down', conflict: 'up' }],
    });
    engine._directive = '떼어놔라';
    const snap = await engine.runDay();
    return { streak: snap.streak, params: { ...state.params, gara: undefined }, accidents: snap.accidents };
  };
  assert.deepEqual(await run([0.1, 0.2, 0.3, 0.4]), await run([0.9, 0.8, 0.7, 0.6]),
    '가라를 어느 것으로 굴렸느냐가 그날의 사고 결과를 바꿨다');
});

test('점검은 놓친 것의 개수조차 안 알려준다 — 새면 숨긴다는 것 자체가 의미를 잃는다', async () => {
  const { engine, state } = fixture({ garaRng: () => 0.999 });   // 전부 숨긴다
  state.gara.active = GARA.GARA_IDS.slice();
  state.params.gara = 10;
  const out = await engine.inspect('barracks');
  const dump = JSON.stringify(out);
  assert.deepEqual(out.spotted, []);
  for (const id of GARA.GARA_IDS) assert.ok(!dump.includes(id), `놓친 ${id}가 결과에 실렸다`);
  assert.ok(!('missed' in out), '놓친 개수가 화면으로 나간다 — 그 자리의 진짜 개수가 통째로 샌다');
});

// ── 부재 — 사고가 사람을 데려간다 (입원·이탈) ─────────────
// 사고의 값이 카운터 0으로 끝나면 종이 위의 일이다. 확전한 사건은 유형에 따라
// 연루자 하나를 부대에서 실제로 빼내고, 그 자리는 복귀일까지 비어 있다.

// 부재 구간을 읽기 쉽게 — 브리핑 user의 한 섹션만 잘라 본다.
const section = (user, head) => user.split(`[${head}`)[1]?.split('\n[')[0] || '';

test('확전한 부상 사고는 병사를 입원시킨다 — 명부에는 남고 병력에서만 빠진다', async () => {
  const { engine, state, roster, events } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  engine._directive = null;
  const snap = await engine.runDay();

  const gone = roster.absent;
  assert.equal(gone.length, 1, '사고가 아무도 데려가지 않았다');
  assert.equal(gone[0].away.kind, 'hospital', '작업 중 부상인데 입원이 아니다');
  assert.equal(gone[0].away.since, '2026-05-18');
  assert.equal(gone[0].away.until, '2026-05-28', '복귀일이 안 굳었다 (부상 최대 10일)');
  // 제적이 아니다 — 명부는 열여섯 그대로고, 오늘 부대에 있는 인원만 열다섯이다
  assert.equal(roster.soldiers.length, 16);
  assert.equal(roster.present.length, 15);
  assert.equal(snap.roster, 15, '병력 표시가 부재자를 세고 있다');
  assert.deepEqual(snap.away.map(a => a.serial), [gone[0].serial]);
  // 사고 대장에도 누가 어디로 갔는지가 남는다
  assert.deepEqual(state.accidents[0].away.map(a => a.kind), ['hospital']);
  // 화면 손잡이로도 나간다 — 게임이 「누가 사라졌는지」를 말할 수 있어야 한다
  const verdict = events.find(e => e[0] === 'verdict')[1];
  assert.equal(verdict.absences[0].soldier.serial, gone[0].serial);
  assert.equal(verdict.absences[0].until, gone[0].away.until);
});

test('빈 자리는 충원되지 않는다 — 복귀할 때까지 열다섯으로 간다', async () => {
  const { llm, engine, roster } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  engine._directive = null;
  await engine.runDay();
  llm.calls.length = 0;

  await engine.runDay();   // 다음 날 — 전입 콜이 나가면 안 된다
  assert.deepEqual(llm.byLabel('전입'), [], '부재로 빈 자리에 신병이 왔다');
  assert.equal(roster.present.length, 15, '자리가 조용히 채워졌다');
  assert.equal(roster.vacancies(), 0);
});

test('멘탈이 무너진 놈의 큰 사고는 이탈이다 — 그 놈이 부대에서 사라진다', async () => {
  const { engine, roster, state } = fixture({
    rng: seqRng([0.999, 0.999, 0.999, 0.999, 0.001, 0, 0]),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  roster.soldiers[7].mental = 1;   // 한 명이 무너져 있다
  engine._directive = null;
  await engine.runDay();

  const gone = roster.absent;
  assert.equal(gone.length, 1);
  assert.equal(gone[0].name, '기존7', '무너진 그 놈이 아니라 딴 놈이 사라졌다');
  assert.equal(gone[0].away.kind, 'awol', '탈영인데 이탈이 아니다');
  assert.equal(state.accidents[0].category, 'absent');
});

test('없는 사람은 사건에도 안 걸리고 면담에도 못 부른다', async () => {
  const { engine, roster, state, events } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'contained', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  const man = roster.soldiers[0];
  roster.sendAway(man, { kind: 'awol', days: 9, since: '2026-05-18' });

  const rep0 = state.params.rep;
  await assert.rejects(() => engine.interview(man.serial, '어디 있었냐'), /부대에 없다/);
  assert.equal(state.params.rep, rep0, '부르지도 못했는데 평판이 깎였다');

  engine._directive = null;
  await engine.runDay();
  // 연루자는 언제나 부대에 있는 사람 중에서만 나온다 — 없는 놈이 족구를 하다 다칠 수는 없다
  const incident = events.find(e => e[0] === 'incident')[1];
  assert.ok(incident, '사건이 안 열렸다 — 이 테스트가 아무것도 안 재고 있다');
  assert.ok(!incident.involved.some(s => s.serial === man.serial), '없는 사람이 사건에 연루됐다');
  assert.ok(roster.absent.some(s => s.serial === man.serial), '부재가 하루 만에 풀렸다');
  assert.equal(man.mental, 6, '부재자가 부대 분위기에 쓸렸다 — 여기 없는 사람이다');
});

test('브리핑은 지금 없는 사람과 오늘 돌아온 사람을 안다', async () => {
  const { llm, engine, roster, events } = fixture();
  const out = roster.soldiers[1];   // 아직 밖에 있다
  const back = roster.soldiers[2];  // 오늘 아침 복귀
  roster.sendAway(out, { kind: 'awol', days: 9, since: '2026-05-18' });
  roster.sendAway(back, { kind: 'hospital', days: 1, since: '2026-05-17' });

  await engine.runDay();
  const user = llm.byLabel('아침 브리핑')[0].messages[0].content;
  const away = section(user, 'NOT IN THE UNIT');
  assert.ok(away.includes(out.name), '없는 사람이 브리핑에 안 실렸다');
  assert.ok(away.includes('absent without leave'), '어디에 있는지가 안 실렸다');
  assert.ok(!away.includes(back.name), '오늘 돌아온 사람이 아직 부재로 실린다');
  assert.ok(section(user, 'BACK TODAY').includes(back.name), '복귀자가 브리핑에 안 실렸다');
  // 수치 차단은 그대로다 — 부재도 날짜와 이름까지다
  assert.ok(!/corner-cutting: \d/.test(user));
  // 화면 손잡이에도 복귀가 실린다
  const brief = events.find(e => e[0] === 'briefing')[1];
  assert.deepEqual(brief.returns.map(r => r.name), [back.name]);
  assert.equal(brief.returns[0].away.kind, 'hospital', '어디에서 돌아왔는지가 없다');
  assert.equal(back.away, undefined);
});

test('부재는 어제 요약으로 다음 날 브리핑까지 간다', async () => {
  const { llm, engine, state } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  engine._directive = null;
  await engine.runDay();
  assert.match(state.yesterday, /입원 — 복귀 예정 2026-05-28/, '어제 요약에 부재가 없다');
  llm.calls.length = 0;
  await engine.runDay();
  const user = llm.byLabel('아침 브리핑')[0].messages[0].content;
  assert.ok(user.includes('복귀 예정 2026-05-28'), '어제의 부재가 오늘 브리핑에 안 실렸다');
});

test('수습된 사건과 징계 유형의 사고는 아무도 데려가지 않는다', async () => {
  // 수습 — 확전이 아니면 사람은 안 빠진다
  const kept = fixture({ rng: incidentRng(), judges: [{ outcome: 'contained', gara: 'same', happy: 'same', conflict: 'same' }] });
  kept.engine._directive = '분리해라';
  await kept.engine.runDay();
  assert.equal(kept.roster.absent.length, 0, '수습됐는데 사람이 빠졌다');

  // 징계 유형(경계 실패·규정위반 따위)은 사고가 돼도 부대 안에서 끝난다 —
  // 폰 걸린 놈이 사라지지는 않는다. 취침 슬롯에서 사건을 열어 뽑는다.
  const disc = fixture({
    rng: seqRng([0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999, 0.001, 0, 0]),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  disc.engine._directive = null;
  await disc.engine.runDay();
  const filed = disc.state.accidents[0];
  assert.equal(INCIDENT_CATEGORIES[filed?.category]?.class, 'discipline',
    `징계 유형 사고를 못 만들었다: ${filed?.category}`);
  assert.equal(absenceFor(filed.category, () => 0), null, '이 유형은 부재 규칙 밖이어야 한다');
  assert.equal(disc.roster.absent.length, 0, '징계로 끝날 사고가 사람을 데려갔다');
  assert.deepEqual(filed.away, []);
});

// ══════════════════════════════════════════════════════════
// 검열 — 밖에서 들어온 눈. 걸리는 것 자체가 사고인 유일한 자리
// ══════════════════════════════════════════════════════════

/** 부임 dayNo일차를 다음 runDay로 맞춘 판. 검열일을 정확히 짚어 들어간다. */
function atDay(dayNo, opts = {}) {
  const f = fixture(opts);
  f.state.day = dayNo - 1;
  return f;
}

test('검열은 정해진 날에만 열리고, 그날 검열관이 들어온다', async () => {
  const CD = TUNING.censor.days[0];
  const quiet = atDay(CD - 1, { garaRng: () => 0.999 });
  await quiet.engine.runDay();
  assert.equal(quiet.events.filter(([k]) => k === 'censorOpen').length, 0, '검열일이 아닌데 검열관이 왔다');

  const day = atDay(CD, { garaRng: () => 0.999 });
  const snap = await day.engine.runDay();
  const open = day.events.find(([k]) => k === 'censorOpen');
  assert.ok(open, '검열일인데 검열관이 안 왔다');
  assert.equal(open[1].label, TUNING.censor.labels[0]);
  assert.ok(day.events.some(([k]) => k === 'censorReport'), '강평이 안 나왔다');
  assert.equal(snap.today.censor.day, CD);
});

test('예고는 사흘 전부터 뜨고, 그전에는 날짜조차 안 보인다', () => {
  const C = TUNING.censor;
  const far = atDay(C.days[0] - C.warn - 1);
  assert.equal(far.engine.snapshot().censor.next, null, '예고 기간 밖인데 보인다');
  const near = atDay(C.days[0] - C.warn);
  assert.equal(near.engine.snapshot().censor.next.in, C.warn);
  const today = atDay(C.days[0]);
  assert.equal(today.engine.snapshot().censor.today.day, C.days[0]);
});

test('검열이 걸어낸 관행은 그 자리에서 멎는다 — 아무거나가 아니라 걸린 그것이다', async () => {
  const { engine, state } = atDay(TUNING.censor.days[0], { garaRng: () => 0.001 });
  // 가벼운 것만 돌려 놓는다 — 이 테스트가 재는 것은 「끊긴다」지 「터진다」가 아니다
  const petty = GARA.GARA_POOL.filter(g => g.tier === 'petty').slice(0, 3).map(g => g.id);
  state.gara.active = petty.slice();
  state.params.gara = petty.length;
  // 강평이 나온 그 순간의 장부를 본다 — 하루 마감의 드리프트가 얹히기 전이다
  let atReport = null;
  engine.h.censorReport = () => { atReport = { gara: state.params.gara, active: [...state.gara.active] }; };
  const snap = await engine.runDay();

  const c = snap.today.censor;
  assert.equal(c.findings.length, petty.length, '전부 걸렸어야 한다 (굴림 0.001)');
  assert.equal(atReport.gara, 0, '걸린 만큼 안 내려갔다');
  for (const id of petty) assert.ok(!atReport.active.includes(id), `${id}가 아직 돈다`);
  assert.deepEqual(c.blows, [], '가벼운 것이 터졌다');
  assert.equal(snap.streak, 1, '가벼운 지적으로 무사고 기록이 깨졌다');
  assert.equal(snap.accidents, 0);
});

test('드리프트가 가라를 밀면 목록이 따라온다 — 게이지와 목록이 하루도 안 벌어진다', async () => {
  const { engine, state } = fixture({ garaRng: () => 0.5 });
  for (let d = 0; d < 12; d++) {
    await engine.runDay();
    assert.equal(state.gara.active.length, state.params.gara,
      `부임 ${state.day}일차에 게이지 ${state.params.gara}와 목록 ${state.gara.active.length}가 벌어졌다`);
  }
});

test('재판급이 걸리면 그날이 사고다 — 장면도 지침도 없이, 걸리는 것 자체가 사고다', async () => {
  const { engine, state, roster } = atDay(TUNING.censor.days[0], { garaRng: () => 0.001 });
  const court = GARA.GARA_POOL.filter(g => g.tier === 'court').slice(0, 1).map(g => g.id);
  state.gara.active = court.slice();
  state.params.gara = 1;
  state.streak = 40;
  const before = roster.present.length;
  const snap = await engine.runDay();

  const c = snap.today.censor;
  assert.deepEqual(c.blows, court);
  assert.equal(snap.streak, 0, '재판급이 걸렸는데 무사고 기록이 살아 있다');
  assert.equal(snap.accidents, 1, '사고 대장에 안 올랐다');
  // 사고 기재는 검열 하나에 한 건이다 — 관행 몇이 무너진 것이 아니라 부대 하나가 무너졌다
  assert.equal(state.accidents.length, 1);
  assert.ok(state.accidents[0].desc.includes(GARA.GARA_BY_ID[court[0]].label));
  // 헌병대가 사람을 데려간다 — 사고 부재 규칙이 아니라 검열 자신이 정한 부재다
  assert.equal(roster.present.length, before - 1, '아무도 안 실려 갔다');
  assert.equal(roster.absent[0].away.kind, 'custody');
  assert.equal(c.taken.length, 1);
});

test('지적 0으로 넘기면 평판 +1 · 행복 +1 — 이 게임에 몇 안 되는 상방이다', async () => {
  const { engine, state } = atDay(TUNING.censor.days[0], { garaRng: () => 0.999 });
  state.params.rep = 5; state.params.happy = 5;
  const snap = await engine.runDay();
  assert.equal(snap.today.censor.clean, true, '굴림 0.999인데 뭔가 걸렸다');
  // 검열의 +1은 확정이고, 그 위에 하루 드리프트가 얹힌다 — 최소한 안 깎였어야 한다
  assert.ok(state.params.rep >= 6, `무결점인데 평판이 ${state.params.rep}이다`);
  assert.ok(state.params.happy >= 5, `무결점인데 행복이 ${state.params.happy}이다`);
});

test('관행 하나는 검열일 하루에 딱 한 번만 굴려진다 — 넓게 도는 것이 저절로 걸리면 안 된다', async () => {
  const { engine, state, events } = atDay(TUNING.censor.days[0], { garaRng: () => 0.999 });
  // 시간대가 여럿인 관행만 골라 돌린다
  const wide = GARA.GARA_POOL.filter(g => g.when.length >= 2).slice(0, 4).map(g => g.id);
  state.gara.active = wide.slice();
  state.params.gara = wide.length;
  await engine.runDay();
  const swept = events.filter(([k]) => k === 'censorSlot').flatMap(([, e]) => e.places);
  assert.ok(swept.length, '검열관이 아무 데도 안 갔다');
  // 굴려진 총 횟수는 돌던 관행 수를 넘을 수 없다
  const checkedTotal = events.filter(([k]) => k === 'censorSlot').length;
  assert.ok(checkedTotal <= wide.length, `${wide.length}개가 ${checkedTotal}번 굴려졌다`);
});

// ── 급습 — 자리와 시간이 둘 다 맞아야 한다 ─────────────
test('들이닥치는 시각은 일과를 세운 그 시각이다 — 시간이 어긋나면 방은 깨끗하다', async () => {
  const roll = 'proxy-rollcall';   // 생활관 · 아침점호/저녁점호
  const g = GARA.GARA_BY_ID[roll];
  const offHours = GARA.SLOTS.find(x => !g.when.includes(x.key) && x.at === g.place)
    || GARA.SLOTS.find(x => !g.when.includes(x.key));

  const mk = () => {
    const f = fixture({ garaRng: () => 0.001 });
    f.state.gara.active = [roll];
    f.state.params.gara = 1;
    return f;
  };
  // 도는 시간에 들이닥친다 — 걸린다
  const hit = mk();
  hit.engine.slotNow = GARA.SLOTS.find(x => x.key === g.when[0]);
  const a = await hit.engine.inspect(g.place);
  assert.equal(a.spotted.length, 1, '도는 시간에 들이닥쳤는데 안 걸렸다');
  assert.equal(a.slot.key, g.when[0], '점검 결과에 시각이 안 실렸다');

  // 안 도는 시간에 들이닥친다 — 같은 자리인데 아무것도 없다
  const miss = mk();
  miss.engine.slotNow = offHours;
  const b = await miss.engine.inspect(g.place);
  assert.deepEqual(b.spotted, [], '안 도는 시간인데 잡혔다');
  assert.deepEqual(miss.state.gara.known, [], '못 봤는데 명부가 채워졌다');
  // 그래도 개입으로는 셌다 — 헛걸음도 개입이다(하루 첫 번이라 평판은 안 깎였을 뿐)
  assert.equal(miss.engine.interventionsToday, 1);
});

test('재판급은 눈앞에서 나오면 그 자리에서 끊긴다 — 나머지는 정체만 산다', async () => {
  const court = GARA.GARA_POOL.find(g => g.tier === 'court');
  const petty = GARA.GARA_POOL.find(g => g.tier === 'petty' && g.place === court.place)
    || GARA.GARA_POOL.find(g => g.tier === 'petty');

  const f = fixture({ garaRng: () => 0.001 });
  f.state.gara.active = [court.id, petty.id];
  f.state.params.gara = 2;
  f.engine.slotNow = GARA.SLOTS.find(x => x.key === court.when[0]);
  const out = await f.engine.inspect(court.place);

  assert.deepEqual(out.pulled.map(g => g.id), [court.id], '재판급이 안 끊겼다');
  assert.ok(!f.state.gara.active.includes(court.id), '끊었다면서 아직 돈다');
  assert.ok(!f.state.gara.known.some(k => k.id === court.id), '끊긴 것이 명부에 남았다');
  // 적발 목록에는 등급이 실린다 — 화면이 「무슨 일이 나는 가라인가」를 말할 수 있어야 한다
  assert.ok(out.spotted.every(x => x.grade?.label), '적발 목록에 등급이 없다');
});

test('점검 소견에는 시각과 등급이 재료로 실린다 — 수치는 여전히 안 나간다', async () => {
  const court = GARA.GARA_POOL.find(g => g.tier === 'court');
  const f = fixture({ garaRng: () => 0.001 });
  f.state.gara.active = [court.id];
  f.state.params.gara = 1;
  const slot = GARA.SLOTS.find(x => x.key === court.when[0]);
  f.engine.slotNow = slot;
  await f.engine.inspect(court.place);
  const user = f.llm.byLabel('불시점검')[0].messages[0].content;
  assert.ok(user.includes(slot.time), '소견 재료에 시각이 안 실렸다');
  assert.ok(user.includes(court.en), '적발한 것이 재료에 없다');
  assert.ok(user.includes(GARA.GARA_TIERS.court.en), '등급이 재료에 안 실렸다');
  assert.ok(!/\b(가라|행복도|평판)\s*\d/.test(user), '수치가 샜다');
});
