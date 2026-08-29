// node --test tests/engine.test.mjs — 하네스. 결정적 가짜 LLM으로 하루 3턴 (§9.5).
//
//   1일차: 조용한 날 — 브리핑 한 콜로 하루가 끝난다. 제일 싼 날.
//   2일차: 사건 → 지침 → 확전(사고) — 카운터 0 회귀, 병사·파라미터는 그대로.
//   3일차: 브리핑에 어제가 코드 요약으로 실린다.
//
// 키도 크레딧도 필요 없다. rng도 주입식이라 롤까지 결정적으로 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { Roster } from '../js/roster.js';
import { TUNING } from '../js/params.js';

// ── 가짜 LLM — label로 갈라 결정적 응답을 준다 ──────────
class FakeLLM {
  constructor() {
    this.calls = [];
    this.judgeQueue = [];    // 확전 판정 스크립트
    this.noticeVerdict = { gara: 'down', happy: 'down', conflict: 'same', reaction: '또 뭘 금지한대' };
  }
  async call(req) {
    // messages 배열은 엔진이 계속 밀어 넣는 살아 있는 참조다 — 호출 시점의 모습을 얼려 둔다.
    this.calls.push({ ...req, messages: structuredClone(req.messages || []) });
    const l = req.label || '';
    if (l.startsWith('전입')) return { name: `병사${this.calls.length}`, sheet: `시트${this.calls.length}` };
    if (l.startsWith('아침 브리핑')) return { briefing: '브리핑본문', slots: Array.from({ length: 9 }, (_, i) => `조각${i}`) };
    if (l.startsWith('사건 장면')) return '사건장면텍스트';
    if (l.startsWith('대응 결과')) return '결과장면텍스트';
    if (l.startsWith('확전 판정')) return this.judgeQueue.shift() || { outcome: 'contained', gara: 'same', happy: 'same', conflict: 'same' };
    if (l.startsWith('면담')) return '병사의 대답';
    if (l.startsWith('불시점검')) return '점검소견텍스트';
    if (l.startsWith('공지 판정')) return this.noticeVerdict;
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
  difficulty: 5, serviceMonths: 18, serial: { tag: 'PR', pad: 7 }, jobs: ['a', 'b', 'c', 'd'],
};

function fixture({ rng, judges = [] } = {}) {
  const llm = new FakeLLM();
  llm.judgeQueue = judges;
  const roster = new Roster(unit, { storage: memStorage() });
  for (let i = 0; i < 16; i++) {
    roster.enlist({ name: `기존${i}`, sheet: `기존시트${i}`, job: unit.jobs[i % 4], grade: 'B', character: '중', joined: '2026-05-01' });
  }
  // 부임일이 2026-05-18(월)이 되도록 오늘을 고정 — 평일이라 일과 슬롯이 산다.
  const state = Engine.newCampaign(unit, '2026-08-26');
  const events = [];
  const engine = new Engine(llm, {
    unit, roster, state, rng: rng || seqRng(),
    handlers: {
      briefing: e => events.push(['briefing', e]),
      slot: e => events.push(['slot', e.slot.key]),
      incident: e => { events.push(['incident', e]); return engine._directive ?? null; },
      outcome: e => events.push(['outcome', e]),
      verdict: e => events.push(['verdict', e]),
      dayEnd: e => events.push(['dayEnd', e]),
    },
  });
  return { llm, roster, state, engine, events };
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
  0, 0,                         // pickEvent · pickInvolved
]);

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
  // 날짜는 안 돌아간다
  assert.equal(snap.date, '2026-05-19');
  // 병사 데이터와 파라미터는 유지된다 — 리셋되는 것은 카운터뿐이다
  assert.deepEqual(roster.soldiers.map(s => s.sheet), before.sheets, '사고가 병사를 지웠다');
  assert.equal(roster.soldiers.length, 16);
  assert.equal(state.params.gara, before.params.gara + 1, '판정 방향(가라 up)이 안 먹혔다');
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

// ── 개입 셋 — 전부 평판 −1, 그날 회복 없음 ──────────────
test('면담: 평판 −1, 왕복 가능, 프롬프트에는 그 병사와 체감 밴드만', async () => {
  const { llm, engine, state } = fixture();
  const rep0 = state.params.rep;
  const h = await engine.interview(engine.roster.soldiers[0].serial, '요즘 어때');
  assert.equal(h.reply, '병사의 대답');
  assert.equal(state.params.rep, rep0 - 1);
  assert.equal(engine.interventionsToday, 1);

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
  const out = await engine.postNotice('족구 금지');
  assert.equal(out.reaction, '또 뭘 금지한대');
  assert.deepEqual(state.notices, ['족구 금지']);
  assert.equal(state.params.gara, gara0 - 1, 'N 판정 방향(down)이 안 먹혔다');
  assert.equal(state.params.rep, rep0 - 1, '공지의 평판 비용은 개입 1회분이다');
  // 판정 user에 부대 상태가 없다
  const user = llm.byLabel('공지 판정')[0].messages[0].content;
  assert.ok(!/(very-low|very-high|corner-cutting|morale|friction)/.test(user), 'N 판정이 부대 상태를 봤다');
});

test('개입한 날은 평판 회복이 없다 — 개입은 일과 중에 일어난다', async () => {
  const { engine, state } = fixture();
  // 첫 슬롯에서 공지 하나 — 실제 게임과 같은 자리(일과 중 handlers)에서 개입한다
  engine.h.slot = async ({ index }) => { if (index === 0) await engine.postNotice('아무 공지'); };
  await engine.runDay();
  assert.equal(engine.interventionsToday, 1, '공지 한 번은 개입 1회다');
  // 시작 5 → 공지 −1 = 4. 조용한 날 회복(+1)이 붙었다면 5다.
  assert.equal(state.params.rep, TUNING.start.rep - 1, '개입한 날인데 조용한 날 회복이 붙었다');
});

// ── 진급 ────────────────────────────────────────────────
test('무사고 100일이면 진급이다', async () => {
  const { engine, state } = fixture();
  state.streak = 99;
  const snap = await engine.runDay();
  assert.equal(snap.streak, 100);
  assert.ok(snap.promoted, '100일을 찍었는데 진급이 안 됐다');
});
