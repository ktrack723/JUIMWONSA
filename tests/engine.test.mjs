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
import { TUNING, INCIDENT_CATEGORIES } from '../js/params.js';
import { RECRUIT_SCHEMA as P_RECRUIT } from '../js/prompts.js';

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
    if (l.startsWith('전입')) return { sheet: `시트${this.calls.length}` };
    if (l.startsWith('병영 소음')) return { lines: [{ slot: 'reveille', text: '또 아침이네' }, { slot: 'amwork', text: '장갑 한 짝 어디 갔냐' }] };
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
  comrade: { score: 5, desc: '보통 사이' },
  difficulty: 5, serviceMonths: 18, serial: { branchCode: '3', seqBase: 70000000 },
  cohort: { base: 1300, at: '2023-11' }, rankMonths: [2, 8, 14], nameStyle: 'elite',
  jobs: ['a', 'b', 'c', 'd'],
  songMode: 'chorus', songSlots: ['reveille'],
  songs: [{ title: '군가표식', note: '감사용 곡', lines: ['군가소절표식'] }],
};

const memStore = memStorage;

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
  // 사고 대장에는 유형이 같이 찍힌다 — 화면이 여기에 그림을 붙인다
  const filed = state.accidents[0];
  assert.ok(INCIDENT_CATEGORIES[filed.category], `사고 대장에 유형이 안 찍혔다: ${filed.category}`);
  assert.ok(filed.desc && filed.tier, '사고 대장에 사건 내용·티어가 빠졌다');
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
  assert.deepEqual(state.notices, [{ text: '족구 금지', bans: [] }]);
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
  const h = await engine.interview(man.serial, '요즘 잠은 자냐');
  assert.equal(man.mental, 4, '상담이 멘탈을 안 올렸다');
  assert.deepEqual(h.mental, { before: 3, after: 4 }, '화면에 보여줄 회복량이 안 실렸다');
  await h.ask('더 얘기해봐');
  assert.equal(man.mental, 4, '왕복마다 올랐다 — 스팸으로 무한 회복이 된다');
  assert.equal(state.params.rep, rep0 - 1, '상담이어도 평판 비용은 개입 1회분이다');
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
  const out = await engine.inspect('worksite');
  assert.equal(state.params.gara, gara - 1);
  assert.equal(state.params.happy, happy - 1);
  assert.equal(state.params.rep, rep - 1);
  assert.deepEqual(out.effect, { gara: -1, happy: -1 }, '화면에 보여줄 효과가 안 실렸다');
});

test('사건 연루는 멘탈을 깎고, 사고가 되면 더 깎는다', async () => {
  const { engine, roster } = fixture({
    rng: incidentRng(),
    judges: [{ outcome: 'escalated', gara: 'same', happy: 'same', conflict: 'same' }],
  });
  for (const man of roster.soldiers) man.mental = 6;
  engine._directive = null;
  await engine.runDay();
  const hit = roster.soldiers.filter(s => s.mental < 6);
  assert.equal(hit.length, 1, '연루자 수만큼 깎여야 한다');
  // 확전 −2 + 그날 드리프트(행복 5·갈등 3 → 0) = 4
  assert.equal(hit[0].mental, 4, '확전인데 −2가 아니다');
});

test('부대가 어두우면 하루 마감에 전원의 멘탈이 내려간다 — 그리고 저장된다', async () => {
  const { engine, roster, state } = fixture();
  state.params.happy = 2;
  for (const man of roster.soldiers) man.mental = 6;
  await engine.runDay();
  assert.ok(roster.soldiers.every(s => s.mental === 5), '분위기 드리프트가 안 쓸었다');
  // 저장까지 — 다시 읽어도 남아 있어야 「어제 무너진 놈이 오늘도 무너져 있는」 게임이 된다
  const again = new Roster(unit, { storage: roster.storage });
  again.load();
  assert.ok(again.soldiers.every(s => s.mental === 5), '멘탈이 저장 안 됐다');
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

test('사건 장면에는 그 자리에서 돌던 가라가 재료로 실린다 — 사건이 허공에서 안 난다', async () => {
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
  assert.ok(mentioned.length, '그 자리 가라가 하나도 안 실렸다');
  const places = new Set(mentioned.map(g => g.place));
  assert.equal(places.size, 1, '한 자리 것만 실려야 한다 — 부대 전체 목록이 새면 안개가 사라진다');
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
