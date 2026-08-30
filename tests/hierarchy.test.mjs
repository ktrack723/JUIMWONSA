// node --test tests/hierarchy.test.mjs — 하이어아키 감사 (§9.1 · §9.2 · §9.4).
//
// 구조도는 어느 데이터가 어느 프롬프트에 들어가는지를 못박아 놓은 그림이다.
// 한 칸이라도 새거나 빠지면 그건 구조도와 다른 게임이다. 필드마다 표식을 심어
// 블록 전부(U·A·P·D·E-1·E-2·E-3·I-1·I-2·N)에 그 표식이 나타나는지 전수로 확인한다.
//
// §6의 차단 표가 곧 이 파일이다:
//   A 병영 소음  → 파라미터·명부·카운터를 **전부** 못 본다 (그래서 캐시될 수 있다)
//   E-3 확전 판정 → 지침 원문을 못 본다 · 파라미터를 못 본다 (밴드조차)
//   N 판정      → 파라미터를 못 본다
//   I-1 면담    → 부대 전체 파라미터를 못 본다 (자기 체감 밴드만)
//   P 생성      → 현재 파라미터·명부를 못 본다
//   D 브리핑    → 수치는 못 본다 (밴드까지만)
//   평판        → 어떤 LLM 판정도 못 움직인다 (스키마에 자리 자체가 없다)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/prompts.js';

// ── 표식 부대·병사·입력 ─────────────────────────────────
const M = {
  cult: 'CULT표식', regs: 'REGS표식', srules: 'SRULES표식',
  intelDesc: 'INTELDESC표식', machoDesc: 'MACHODESC표식', comradeDesc: 'BONDDESC표식',
  sheet: 'SHEET표식', othersheet: 'NEWCOMER표식',   // ⚠ 표식끼리 서로를 품으면 안 된다
  bandGara: 'BANDGARA표식', bandHappy: 'BANDHAPPY표식', bandConf: 'BANDCONF표식', bandDiff: 'BANDDIFF표식',
  feltRoom: 'FELTROOM표식', feltWork: 'FELTWORK표식', spirit: 'SPIRITBAND표식',
  honesty: 'HONESTY표식', standing: 'STANDING표식',
  yesterday: 'YESTER표식', notice: 'NOTICE표식', directive: 'DIRECTIVE표식',
  question: 'QUESTION표식', scene: 'SCENE표식', event: 'EVENT표식', place: 'PLACE표식',
};

const unit = {
  id: 'probe', name: '표식부대', branch: '표식군', desc: 'UNITDESC표식',
  culture: M.cult, rules: M.regs, soldierRules: M.srules,
  intel: { score: 7, desc: M.intelDesc },
  macho: { score: 9, desc: M.machoDesc },
  comrade: { score: 4, desc: M.comradeDesc },
  difficulty: 8, serviceMonths: 18, serial: { branchCode: '3', seqBase: 70000000 },
  cohort: { base: 1300, at: '2023-11' }, rankMonths: [2, 8, 14], nameStyle: 'elite',
  jobs: ['j'],
  songMode: 'chorus', songSlots: ['reveille'],
  songs: [{ title: 'SONGTITLE표식', note: 'SONGNOTE표식', lines: ['SONGLINE표식'] }],
};
const soldier = { name: '병사표식', serial: 'PRXX-표식', job: 'JOB표식', grade: 'GRADE표식', character: 'CHAR표식', sheet: M.sheet, joined: 'JOINED표식' };
const other = { ...soldier, name: '타병사표식', serial: 'PRYY-표식', sheet: M.othersheet };
const bands = { gara: M.bandGara, happy: M.bandHappy, conflict: M.bandConf };

// ── 일곱 블록을 한 번씩 조립해 둔다. 이게 이 게임이 보내는 전부다 ──
const U = P.unitPrompt(unit);
const A = P.ambientSystem(unit) + '\n' + P.ambientUser({
  slots: [{ key: 'reveille', label: 'SLOT표식' }], songSlots: ['reveille'], songMode: 'chorus',
});
const Pb = P.recruitSystem(unit) + '\n' + P.recruitUser({
  name: soldier.name, serial: soldier.serial, standing: 'STANDING표식',
  job: soldier.job, grade: soldier.grade, character: soldier.character, joined: soldier.joined,
});
const D = P.daySystem(unit) + '\n' + P.briefingUser({
  date: 'DATE표식', weekday: 'WD표식', season: 'SEASON표식', slots: ['SLOT표식'],
  difficulty: M.bandDiff, bands, yesterday: M.yesterday,
  arrivals: [other], departures: [], excerpt: [soldier],
});
const E1 = P.incidentUser({ slotLabel: 'SLOT표식', place: M.place, tier: 'major', event: M.event, involved: [soldier], notices: [M.notice] });
const E2 = P.outcomeUser({ directive: M.directive, standing: M.standing });
const E2none = P.outcomeUser({ directive: null, standing: M.standing });
const E3 = P.JUDGE_SYSTEM + '\n' + P.judgeUser({ scene: M.scene, tier: 'major' });
const I1 = P.interviewSystem(unit) + '\n'
  + P.interviewOpen({ soldier: { ...soldier, spirit: M.spirit }, felt: { room: M.feltRoom, work: M.feltWork }, honesty: M.honesty, question: M.question })
  + '\n' + P.interviewFollowup('FOLLOWUP표식');
const I2 = P.inspectSystem(unit) + '\n' + P.inspectUser({ place: M.place, readings: { 'corner-cutting': M.bandGara } });
const N = P.noticeSystem(unit) + '\n' + P.noticeUser(M.notice);

const has = (hay, needle) => hay.includes(needle);

// 표식은 서로를 품으면 안 된다. 「OTHERSHEET표식」이 「SHEET표식」을 품고 있어서,
// 전입자 본문이 실린 것을 발췌 본문이 실린 것으로 잘못 읽은 적이 있다 —
// 부정 단언이 통째로 공허해지는 종류의 사고라 여기서 막는다.
test('표식끼리 서로를 품지 않는다 — 부정 단언이 공허해지지 않게', () => {
  const marks = Object.entries(M);
  for (const [ka, a] of marks) {
    for (const [kb, b] of marks) {
      if (ka === kb) continue;
      assert.ok(!a.includes(b), `표식 ${ka}(${a})가 ${kb}(${b})를 품는다`);
    }
  }
});

// ── U. 부대 프롬프트 — 재료 ─────────────────────────────
test('U는 다섯 절을 전부 싣는다 — ①문화 ②규정 ③병사간 룰 ④지능 서술 ⑤마초 서술', () => {
  for (const k of ['cult', 'regs', 'srules', 'intelDesc', 'machoDesc']) {
    assert.ok(has(U, M[k]), `U에 ${k}가 없다`);
  }
});

test('④⑤의 수치는 U에 없다 — 서술은 프롬프트로, 수치는 코드로', () => {
  assert.ok(!/\d/.test(U), `U에 숫자가 새어 들어갔다: ${(U.match(/\d+/g) || []).join(',')}`);
});

test('U는 이 부대의 군가가 무엇이고 어떻게 도착하는지를 싣는다', () => {
  assert.ok(has(U, 'SONGTITLE표식'), 'U에 군가 제목이 없다');
  assert.ok(has(U, 'SONGNOTE표식'), 'U에 군가 출처가 없다');
  // 가사 자체는 U에 안 실린다 — 그건 코드가 풀에 곧장 꽂는 static 데이터다
  assert.ok(!has(U, 'SONGLINE표식'), 'U에 가사가 실렸다 — 모형이 가사를 지어내게 된다');
});

test('부르는 방식이 U에서 갈린다 — 목이냐 스피커냐', () => {
  const chorus = P.unitPrompt(unit);
  const broadcast = P.unitPrompt({ ...unit, songMode: 'broadcast' });
  assert.notEqual(chorus, broadcast, '두 방식이 같은 프롬프트를 만든다');
  assert.ok(/loudspeaker/i.test(broadcast), '방송 부대의 스피커가 안 실렸다');
  assert.ok(!/loudspeaker/i.test(chorus), '목으로 부르는 부대에 스피커가 실렸다');
});

// ── A. 병영 소음 — 캐시될 수 있는 이유는 아무 상태도 안 보기 때문이다 ──
test('A는 슬롯 목록과 군가가 울리는 자리만 받는다', () => {
  assert.ok(has(A, 'SLOT표식'), 'A에 슬롯 이름이 없다');
  assert.ok(has(A, 'reveille'), 'A에 군가가 울리는 자리가 없다');
  assert.ok(has(A, M.cult), 'A의 system에 부대 프롬프트가 없다');
});

test('A는 파라미터·명부·어제·지침을 전부 못 본다 — 하나라도 보면 캐시가 거짓말이 된다', () => {
  for (const k of ['bandGara', 'bandHappy', 'bandConf', 'bandDiff', 'sheet', 'othersheet',
    'yesterday', 'notice', 'directive', 'standing', 'honesty']) {
    assert.ok(!has(A, M[k]), `A에 ${k}가 새어 들어갔다 — 부임 첫날 상태로 100일을 떠들게 된다`);
  }
});

test('A는 가사를 쓰지 않는다 — 진짜 소절은 static이라 코드가 꽂는다', () => {
  assert.ok(/Never write song lyrics/i.test(A), '가사 금지 못이 빠졌다');
  assert.ok(!has(A, 'SONGLINE표식'), 'A에 실제 가사가 실렸다');
});

test('A의 대사는 익명이고 사건이 아니다 — 100일 내내 재사용되기 때문이다', () => {
  assert.ok(/anonymous soldier/i.test(A), '익명 규칙이 빠졌다');
  assert.ok(/reused for months/i.test(A), '재사용된다는 못이 빠졌다');
  assert.ok(/Nothing that would be an incident/i.test(A), '사건 금지가 빠졌다');
});

test('A의 출력은 슬롯과 대사 둘뿐이고, 슬롯은 실존 슬롯만 받는다', async () => {
  const { SLOT_KEYS } = await import('../js/params.js');
  const item = P.AMBIENT_SCHEMA.properties.lines.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ['slot', 'text']);
  assert.deepEqual(item.properties.slot.enum, SLOT_KEYS, '앰비언트 슬롯 enum이 실제 슬롯과 어긋났다');
});

test('U는 모든 생성 계열 system의 접두사다 — 판정(E-3)에는 없다', () => {
  for (const [name, built] of [['P', Pb], ['D', D], ['I-1', I1], ['I-2', I2], ['N', N]]) {
    assert.ok(has(built, M.cult), `${name}의 system에 부대 프롬프트가 없다`);
  }
  assert.ok(!has(E3, M.cult), 'E-3이 부대 프롬프트를 본다 — 판정 system은 부임 내내 부대 무관하게 동일해야 한다');
});

// ── P. 전입 병사 생성 ───────────────────────────────────
test('P는 굴려진 이름·등급·직무·군번·기수계급을 받는다 — LLM은 시트만 쓴다', () => {
  for (const k of ['병사표식', 'GRADE표식', 'CHAR표식', 'JOB표식', 'PRXX-표식', 'JOINED표식', 'STANDING표식']) {
    assert.ok(has(Pb, k), `P에 ${k}가 없다`);
  }
  // 이름은 굴림이 정한다 — 출력에 이름이 있으면 부대가 통째로 「김민준」으로 수렴한다
  assert.deepEqual(Object.keys(P.RECRUIT_SCHEMA.properties), ['sheet']);
});

test('P는 현재 파라미터·명부를 못 본다 — 전입자는 부대 상태와 무관하게 온다', () => {
  for (const k of ['bandGara', 'bandHappy', 'bandConf', 'sheet', 'othersheet', 'yesterday', 'notice']) {
    assert.ok(!has(Pb, M[k]), `P에 ${k}가 새어 들어갔다`);
  }
});

// ── D. 아침 브리핑 ──────────────────────────────────────
test('D는 밴드·어제 요약·명부 발췌·전입을 받는다', () => {
  for (const k of ['bandGara', 'bandHappy', 'bandConf', 'bandDiff', 'yesterday', 'othersheet']) {
    assert.ok(has(D, M[k]), `D에 ${k}가 없다`);
  }
  // 발췌는 머리줄이라 본문(sheet)이 아니라 이름·군번이 실린다
  assert.ok(has(D, '병사표식') && has(D, 'PRXX-표식'), 'D에 명부 발췌가 없다');
});

test('D의 지시문에 「수치를 말하지 말라. 증상으로만 말하라」가 박혀 있다', () => {
  assert.ok(/never\s+numbers/i.test(P.daySystem(unit)), '수치 금지 못이 빠졌다');
  assert.ok(/symptom/i.test(P.daySystem(unit)), '증상으로 말하라는 못이 빠졌다');
  assert.ok(/No accident-free day counts/.test(P.daySystem(unit)), '무사고 카운터 함구 못이 빠졌다');
});

test('활성 지침은 D에 안 실린다 — 구조도의 E-1 자리에만 실린다', () => {
  assert.ok(!has(D, M.notice), '공지가 브리핑에 새어 들어갔다');
});

// ── E-1. 사건 장면 ──────────────────────────────────────
test('E-1은 슬롯·장소·심각도·연루 병사·활성 지침을 받는다', () => {
  for (const k of ['place', 'event', 'sheet', 'notice']) {
    assert.ok(has(E1, M[k]), `E-1에 ${k}가 없다`);
  }
  assert.ok(/severity-tier/.test(E1));
});

test('E-1은 파라미터 밴드를 못 본다 — 부대 상태는 브리핑이 이미 스레드에 깔았다', () => {
  for (const k of ['bandGara', 'bandHappy', 'bandConf', 'bandDiff']) {
    assert.ok(!has(E1, M[k]), `E-1에 ${k}가 새어 들어갔다`);
  }
});

// ── E-2. 대응 결과 ──────────────────────────────────────
test('E-2는 지침 원문을 그대로 싣는다 — 채점하지 않는다', () => {
  assert.ok(has(E2, M.directive), 'E-2에 지침이 안 실렸다');
  assert.ok(has(E2, M.standing), 'E-2에 평판 밴드(먹히는 정도)가 없다');
});

test('지침이 없으면 「개입 없음」이 명시된다 — 조용히 채워 넣지 않는다', () => {
  assert.ok(!has(E2none, M.directive));
  assert.ok(/no intervention/.test(E2none), '개입 없음이 명시되지 않는다');
});

// ── E-3. 확전 판정 — 이 게임에서 제일 중요한 차단선 ─────
test('E-3은 지침 원문을 못 본다 — 심판이 읽는 것은 결과 장면뿐이다', () => {
  assert.ok(!has(E3, M.directive), '확전 판정에 지침이 새어 들어갔다 — 심판이 지시의 영리함을 채점하게 된다');
  assert.ok(has(E3, M.scene), 'E-3에 결과 장면이 없다');
});

test('E-3은 파라미터를 못 본다 — 밴드조차', () => {
  for (const k of ['bandGara', 'bandHappy', 'bandConf', 'bandDiff', 'standing']) {
    assert.ok(!has(E3, M[k]), `E-3에 ${k}가 새어 들어갔다 — 자기참조 판정이 된다`);
  }
});

test('E-3의 출력은 확전 여부 + 방향 셋뿐이다 — 점수도 해설도 평판도 없다', () => {
  assert.deepEqual(Object.keys(P.ESCALATION_SCHEMA.properties).sort(), ['conflict', 'gara', 'happy', 'outcome']);
  assert.deepEqual(P.ESCALATION_SCHEMA.properties.outcome.enum, ['contained', 'escalated']);
  for (const k of ['gara', 'happy', 'conflict']) {
    assert.deepEqual(P.ESCALATION_SCHEMA.properties[k].enum, ['up', 'down', 'same']);
  }
});

// ── I-1. 면담 ───────────────────────────────────────────
test('I-1은 그 병사의 프로필·체감 밴드·멘탈 밴드·솔직도·질문을 받는다', () => {
  for (const k of ['sheet', 'feltRoom', 'feltWork', 'spirit', 'honesty', 'question']) {
    assert.ok(has(I1, M[k]), `I-1에 ${k}가 없다`);
  }
});

test('I-1은 상담이다 — 취조가 아니라는 못이 지시문에 박혀 있다', () => {
  const role = P.interviewSystem(unit);
  assert.ok(/not to interrogate/i.test(role), '취조 금지 못이 빠졌다');
  assert.ok(/check on\s+him/i.test(role), '살피러 불렀다는 못이 빠졌다');
  assert.ok(/Let the talk move him/i.test(role), '대화가 사람을 움직인다는 못이 빠졌다 — 멘탈 회복의 서사 근거다');
});

test('멘탈은 프롬프트에 밴드로만 간다 — 숫자가 오면 빌더가 죽는다', () => {
  assert.throws(() => P.soldierRoll({ ...soldier, spirit: 3 }), '숫자 멘탈이 통과했다');
  assert.throws(() => P.soldierRoll({ ...soldier, spirit: '3' }));
  // spirit이 없으면 줄 자체가 안 붙는다 (전입 굴림 직후 등)
  assert.ok(!P.soldierRoll(soldier).includes('spirit'), 'spirit 없는 병사에 빈 줄이 붙었다');
});

test('I-1은 부대 전체 파라미터를 못 본다 — 병사는 자기 체감만 안다', () => {
  for (const k of ['bandGara', 'bandHappy', 'bandConf', 'bandDiff', 'yesterday', 'notice', 'directive']) {
    assert.ok(!has(I1, M[k]), `I-1에 ${k}가 새어 들어갔다`);
  }
});

// ── I-2. 불시점검 ───────────────────────────────────────
test('I-2는 장소와 그 장소가 드러내는 밴드만 받는다', () => {
  assert.ok(has(I2, M.place));
  assert.ok(has(I2, M.bandGara), 'I-2에 드러날 밴드가 없다');
  for (const k of ['sheet', 'notice', 'question', 'yesterday', 'bandHappy', 'bandConf']) {
    assert.ok(!has(I2, M[k]), `I-2에 ${k}가 새어 들어갔다 — 장소-대응표 밖이다`);
  }
});

// ── N. 공지 판정 ────────────────────────────────────────
test('N은 공지 원문과 부대 프롬프트만 받는다', () => {
  assert.ok(has(N, M.notice));
  assert.ok(has(N, M.cult));
  for (const k of ['bandGara', 'bandHappy', 'bandConf', 'sheet', 'directive', 'yesterday']) {
    assert.ok(!has(N, M[k]), `N에 ${k}가 새어 들어갔다 — 「이미 높으니 same」식 자기참조 판정이 된다`);
  }
});

test('N의 출력은 방향 셋 + 반응 한 줄뿐이다 — 평판이 낄 자리가 없다', () => {
  assert.deepEqual(Object.keys(P.NOTICE_SCHEMA.properties).sort(), ['conflict', 'gara', 'happy', 'reaction']);
});

test('어느 판정 스키마에도 평판이 없다 — 개입 횟수가 곧 평판이다', () => {
  for (const s of [P.ESCALATION_SCHEMA, P.NOTICE_SCHEMA]) {
    assert.ok(!('rep' in s.properties));
    assert.ok(!/reputation/i.test(JSON.stringify(s)));
  }
});

// ── §9.2 수치 누출 검사 — 밴드 라벨만 허용 ──────────────
test('밴드 자리에 수치가 들어오면 프롬프트가 만들어지기 전에 죽는다', () => {
  assert.throws(() => P.briefingUser({ date: 'd', weekday: 'w', season: 's', slots: [], difficulty: 'mid', bands: { gara: 7, happy: 'mid', conflict: 'mid' }, yesterday: '' }));
  assert.throws(() => P.briefingUser({ date: 'd', weekday: 'w', season: 's', slots: [], difficulty: 'mid', bands: { gara: '7', happy: 'mid', conflict: 'mid' }, yesterday: '' }), '숫자 문자열도 막아야 한다');
  assert.throws(() => P.outcomeUser({ directive: 'x', standing: 3 }));
  assert.throws(() => P.interviewOpen({ soldier, felt: { room: 2, work: 'mid', mood: 'mid' }, honesty: 'candid', question: 'q' }));
  assert.throws(() => P.inspectUser({ place: 'p', readings: { morale: 5 } }));
});

// ── 전송 스키마 대장 ────────────────────────────────────
test('보내는 스키마는 다섯뿐이다 — A·P·D·E-3·N', () => {
  const schemas = Object.keys(P).filter(k => k.endsWith('_SCHEMA'));
  assert.deepEqual(schemas.sort(),
    ['AMBIENT_SCHEMA', 'BRIEFING_SCHEMA', 'ESCALATION_SCHEMA', 'NOTICE_SCHEMA', 'RECRUIT_SCHEMA']);
});

// ── §9.4 한글 누출 검사 — 지시는 영어다 ─────────────────
// 데이터가 전부 ASCII인 가상 부대로 프롬프트를 만들면, 남는 한글은 전부 **지시문**이다.
test('전 블록의 지시문에 한글이 한 글자도 없다', () => {
  const ascii = {
    id: 'ascii', name: 'Fort Probe', branch: 'Navy', desc: 'a probe unit',
    culture: 'old and proud', rules: 'no phones', soldierRules: 'juniors clean',
    intel: { score: 5, desc: 'sharp enough' }, macho: { score: 5, desc: 'mild' },
    comrade: { score: 5, desc: 'they get along' },
    difficulty: 5, serviceMonths: 18, serial: { branchCode: '5', seqBase: 20000000 },
    cohort: { base: 800, at: '2020-01' }, rankMonths: [2, 8, 14], nameStyle: 'elite',
    jobs: ['cook'],
    songMode: 'chorus', songSlots: ['reveille'],
    songs: [{ title: 'Onward', note: 'written in 1949', lines: ['onward to the sea'] }],
  };
  const aSoldier = { name: 'Kim', serial: '26-20000001', standing: 'cohort 812, corporal', job: 'cook', grade: 'B', character: 'ok', sheet: 'a quiet man', joined: '2026-01-01' };
  const aBands = { gara: 'mid', happy: 'low', conflict: 'high' };
  const built = {
    U: P.unitPrompt(ascii),
    'U(방송)': P.unitPrompt({ ...ascii, songMode: 'broadcast' }),
    A: P.ambientSystem(ascii) + P.ambientUser({ slots: [{ key: 'reveille', label: 'reveille' }], songSlots: ['reveille'], songMode: 'chorus' }),
    'A(방송·군가없는자리)': P.ambientUser({ slots: [{ key: 'lunch', label: 'lunch' }], songSlots: [], songMode: 'broadcast' }),
    P: P.recruitSystem(ascii) + P.recruitUser({ name: 'Kim', serial: '26-20000001', standing: 'cohort 812, corporal', job: 'cook', grade: 'B', character: 'ok', joined: '2026-01-01' }),
    D: P.daySystem(ascii) + P.briefingUser({ date: '2026-08-29', weekday: 'Sat', season: 'summer', slots: ['reveille'], difficulty: 'high', bands: aBands, yesterday: 'quiet day', arrivals: [aSoldier], departures: [aSoldier], excerpt: [aSoldier] }),
    'D(첫날)': P.briefingUser({ date: 'd', weekday: 'w', season: 's', slots: [], difficulty: 'mid', bands: aBands, yesterday: '' }),
    'E-1': P.incidentUser({ slotLabel: 'work', place: 'yard', tier: 'minor', event: 'a fall', involved: [aSoldier], notices: ['no soccer'] }),
    'E-1(지침없음)': P.incidentUser({ slotLabel: 'work', place: 'yard', tier: 'major', event: 'a fall', involved: [aSoldier] }),
    'E-2': P.outcomeUser({ directive: 'stop it', standing: 'partial' }),
    'E-2(개입없음)': P.outcomeUser({ directive: null, standing: 'partial' }),
    'E-3': P.JUDGE_SYSTEM + P.judgeUser({ scene: 'it ended', tier: 'minor' }),
    'I-1': P.interviewSystem(ascii) + P.interviewOpen({ soldier: aSoldier, felt: { room: 'mid', work: 'mid', mood: 'low' }, honesty: 'guarded', question: 'how is it' }) + P.interviewFollowup('and then'),
    'I-2': P.inspectSystem(ascii) + P.inspectUser({ place: 'yard', readings: { morale: 'low' } }),
    N: P.noticeSystem(ascii) + P.noticeUser('no soccer'),
    // 스키마도 모형에게 간다 — 구조화 출력이 막히면 시스템 프롬프트에 통째로 붙는다.
    스키마: ['AMBIENT', 'RECRUIT', 'BRIEFING', 'ESCALATION', 'NOTICE'].map(k => JSON.stringify(P[`${k}_SCHEMA`])).join(''),
  };
  // 한글 전 영역 — 조합 자모 · 호환 자모 · 확장 A · 음절 · 반각까지 전부 본다.
  const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff\uffa0-\uffdc]/g;
  for (const [name, text] of Object.entries(built)) {
    // 예외는 **계급·직함 표기 넷뿐**이다. 인물들이 입 밖으로 그렇게 부르고, 「상사가
    // 원사로 진급한다」는 이 게임의 전제 자체가 그 표기에 걸려 있어서 번역하면 사라진다
    // (연애조작단의 「L 기관」과 같은 규칙). 긴 것부터 지운다 — 주임원사를 먼저 지워야
    // 원사가 안 남는다. 이 목록은 늘어나면 안 된다: 늘리는 순간 지시문이 한국어로 샌다.
    const RANKS = ['주임원사', '주임상사', '원사', '상사'];
    const stripped = RANKS.reduce((t, r) => t.split(r).join('RANK'), text);
    const han = [...new Set(stripped.match(HANGUL) || [])];
    assert.deepEqual(han, [], `${name} 지시문에 한글이 남아 있다: ${han.join('')}`);
  }
});

test('그래도 출력 언어 고정은 생성 블록 전부에 붙어 있다', () => {
  const KO = /Output is Korean|output in Korean/;
  for (const t of [A, Pb, D, I1, I2, N]) assert.ok(KO.test(t), '출력 언어 고정이 빠진 블록이 있다');
});

// ── 콜 비용 — 매일 정가로 나가는 것을 지킨다 ────────────
// D의 user 메시지는 캐시가 안 붙는다(날마다 내용이 달라진다). 그래서 여기 실리는 것은
// 100일 동안 100번 정가로 나간다 — 무엇을 싣고 무엇을 안 싣는지가 곧 비용이다.
test('D의 명부 발췌는 머리줄만 싣는다 — 인물 본문은 매일 정가로 나갈 자리가 아니다', () => {
  const withSheet = P.soldierSheet(soldier);
  const rollOnly = P.soldierRoll(soldier);
  // 발췌에 들어간 병사의 **본문**은 브리핑에 없어야 한다
  assert.ok(!has(D, M.sheet), 'D의 명부 발췌에 인물 본문이 실렸다 — 100일이면 100번 정가다');
  // 머리줄(이름·군번·기수계급·직무·등급)은 그대로 있어야 한다
  for (const k of ['병사표식', 'PRXX-표식', 'JOB표식', 'GRADE표식']) {
    assert.ok(has(D, k), `D의 명부 발췌에 ${k}가 없다 — 머리줄까지 지웠다`);
  }
  assert.ok(withSheet.startsWith(rollOnly), 'soldierSheet가 머리줄로 시작하지 않는다');
  assert.ok(withSheet.length > rollOnly.length, '본문이 붙지 않았다');
});

test('오늘 전입한 놈은 본문까지 실린다 — 소개가 필요한 자리다', () => {
  assert.ok(has(D, M.othersheet), 'D의 전입 신고에 인물 본문이 빠졌다');
});

test('실제로 움직이거나 입을 여는 자리에는 본문이 그대로 간다', () => {
  assert.ok(has(E1, M.sheet), 'E-1 연루 병사의 본문이 빠졌다 — 장면을 쓸 수가 없다');
  assert.ok(has(I1, M.sheet), 'I-1 면담 상대의 본문이 빠졌다 — 그 사람이 말을 못 한다');
});
