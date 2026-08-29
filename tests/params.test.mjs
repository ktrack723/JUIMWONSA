// node --test tests/params.test.mjs — params 단독 테스트. LLM 없이 전부 돈다 (§9.3).
//
// 특히 못박는 것:
//   · 갈등 8 이상에서만 큰 사건 위험이 열리는가
//   · 평판이 개입 횟수만으로 움직이는가 (어떤 LLM 판정도 평판을 못 움직인다)
//   · 사고 후 카운터는 0인데 파라미터·명부는 그대로인가
//   · 날짜는 언제나 전진하고, 진급 심사일만 밀리는가
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PM from '../js/params.js';

const seq = arr => { let i = 0; return () => (i < arr.length ? arr[i++] : 0.999); };

// ── 눈금과 밴드 ─────────────────────────────────────────
test('눈금은 0~10이고 밴드는 5단계다 — 수치는 라벨로만 나간다', () => {
  assert.equal(PM.SCALE.min, 0);
  assert.equal(PM.SCALE.max, 10);
  assert.equal(PM.band(0), 'very-low');
  assert.equal(PM.band(1), 'very-low');
  assert.equal(PM.band(2), 'low');
  assert.equal(PM.band(5), 'mid');
  assert.equal(PM.band(8), 'high');
  assert.equal(PM.band(10), 'very-high');
  for (let v = 0; v <= 10; v++) {
    assert.ok(PM.BAND_LABELS.includes(PM.band(v)));
    assert.ok(!/\d/.test(PM.band(v)), '밴드 라벨에 숫자가 섞였다 — 수치 누출 통로다');
  }
});

test('솔직도·이행률 등급도 라벨이다 — 숫자도 한글도 없다', () => {
  for (let rep = 0; rep <= 10; rep++) {
    for (const g of [PM.honestyOf(rep), PM.complianceOf(rep)]) {
      assert.equal(typeof g, 'string');
      assert.ok(!/\d/.test(g), `등급 라벨에 숫자: ${g}`);
      assert.ok(!/[가-퟿]/.test(g), `등급 라벨에 한글: ${g}`);
    }
  }
  // 평판이 높을수록 솔직해진다 — 등급이 실제로 갈린다
  assert.notEqual(PM.honestyOf(0), PM.honestyOf(10));
  assert.notEqual(PM.complianceOf(0), PM.complianceOf(10));
});

// ── 날짜 규칙 ───────────────────────────────────────────
test('부임일 = 오늘 − 100일. 완주하면 정확히 오늘 심사를 맞는다', () => {
  const today = '2026-08-29';
  const start = PM.startDateFor(today);
  assert.equal(start, '2026-05-21');
  assert.equal(PM.dateAdd(start, PM.TUNING.goal), today);
  // 무사고 0일차에 부임: 심사일 = 부임일 + 100 = 오늘
  assert.equal(PM.reviewDate(start, 0), today);
});

test('사고가 나면 심사일이 미래로 밀린다 — 날짜는 안 돌아간다', () => {
  // 50일차까지 무사고: 심사일 = 오늘 + 50
  assert.equal(PM.reviewDate('2026-07-10', 50), '2026-08-29');
  // 같은 날 사고로 streak 0: 심사일 = 오늘 + 100
  assert.equal(PM.reviewDate('2026-07-10', 0), '2026-10-18');
});

test('계절·요일은 날짜에서 계산한다 — 여름·겨울 +1, 주말 일과 없음', () => {
  assert.equal(PM.seasonOf('2026-07-15'), 'summer');
  assert.equal(PM.seasonOf('2026-12-25'), 'winter');
  assert.equal(PM.seasonOf('2026-04-10'), 'spring');
  assert.equal(PM.effectiveDifficulty(8, '2026-07-15'), 9);    // 혹서기 (수요일)
  assert.equal(PM.effectiveDifficulty(8, '2026-12-23'), 9);    // 제설 (수요일)
  assert.equal(PM.effectiveDifficulty(8, '2026-04-08'), 8);    // 평시 (수요일)
  assert.ok(PM.isWeekend('2026-08-29'), '토요일이 주말이 아니라니');
  assert.equal(PM.effectiveDifficulty(8, '2026-08-29'), PM.TUNING.season.weekendDifficulty);
});

test('주말에는 일과 슬롯이 개인정비로 바뀐다 — 슬롯은 언제나 아홉이다', () => {
  const weekday = PM.slotsFor('2026-08-26');  // 수요일
  const weekend = PM.slotsFor('2026-08-29');  // 토요일
  assert.equal(weekday.length, 9);
  assert.equal(weekend.length, 9);
  assert.ok(weekday.some(s => s.kind === 'work'));
  assert.ok(!weekend.some(s => s.kind === 'work'), '주말에 일과 슬롯이 남아 있다');
});

// ── 사고 판정 롤 ────────────────────────────────────────
test('큰 사건 위험은 갈등이 big.open(8) 이상일 때만 열린다', () => {
  const unit = { intel: 5, macho: 5, difficulty: 5 };
  for (let c = 0; c < PM.TUNING.roll.big.open; c++) {
    assert.equal(PM.incidentRisk({ gara: 5, conflict: c }, unit).big, 0, `갈등 ${c}에서 큰 사건이 열렸다`);
  }
  const at8 = PM.incidentRisk({ gara: 5, conflict: 8 }, unit).big;
  const at10 = PM.incidentRisk({ gara: 5, conflict: 10 }, unit).big;
  assert.ok(at8 > 0, '갈등 8에서 큰 사건이 안 열린다');
  assert.ok(at10 > at8, '눌러 놓은 게 클수록 크게 터져야 한다');
});

test('힘든 일을 대충 하면 다친다 — 가라+난이도 초과분이 위험을 올린다', () => {
  const unit = h => ({ intel: 5, macho: 5, difficulty: h });
  const low = PM.incidentRisk({ gara: 3, conflict: 3 }, unit(5)).small;
  const high = PM.incidentRisk({ gara: 8, conflict: 3 }, unit(8)).small;
  assert.ok(high > low, '가라 8 + 난이도 8이 가라 3 + 난이도 5보다 안전하다니');
});

test('가라가 높은데 지능이 낮으면 사고 위험 가중 — 알아서 잘 대충 할 머리가 없다', () => {
  const smart = PM.incidentRisk({ gara: 7, conflict: 3 }, { intel: 8, macho: 5, difficulty: 3 }).small;
  const dumb = PM.incidentRisk({ gara: 7, conflict: 3 }, { intel: 4, macho: 5, difficulty: 3 }).small;
  assert.ok(dumb > smart);
});

test('갈등이 적당히 높으면 잔사고가 준다 — 군기가 눌러 놓는다', () => {
  const unit = { intel: 5, macho: 5, difficulty: 5 };
  const loose = PM.incidentRisk({ gara: 5, conflict: 2 }, unit).small;
  const pressed = PM.incidentRisk({ gara: 5, conflict: 6 }, unit).small;
  assert.ok(pressed < loose);
});

test('rollSlot은 결정적 rng로 결정적으로 돈다 — 큰 롤이 먼저다', () => {
  const params = { gara: 5, conflict: 10 };
  const unit = { intel: 5, macho: 5, difficulty: 5 };
  assert.deepEqual(PM.rollSlot(params, unit, 'work', seq([0.0001])), { tier: 'major' });
  assert.equal(PM.rollSlot(params, unit, 'work', seq([0.99, 0.99])), null);
  const calm = { gara: 0, conflict: 0 };
  const safeUnit = { intel: 10, macho: 0, difficulty: 1 };
  assert.deepEqual(PM.rollSlot(calm, safeUnit, 'work', seq([0.0001])), { tier: 'minor' });
});

test('사건 풀 밖 창작은 없다 — pickEvent는 티어·슬롯에 맞는 후보만 준다', () => {
  for (let i = 0; i < 20; i++) {
    const e = PM.pickEvent('major', 'rollcall', Math.random);
    assert.equal(e.tier, 'major');
    assert.ok(PM.EVENT_POOL.includes(e));
  }
  const minor = PM.pickEvent('minor', 'work', seq([0]));
  assert.ok(minor.kinds.includes('work'));
});

// ── 등급 추첨 ───────────────────────────────────────────
test('지능이 높을수록 에이스가, 마초가 높을수록 폐급·인성 하위가 두꺼워진다', () => {
  const pAce = w => w[4] / w.reduce((a, b) => a + b, 0);
  const pWorst = w => w[0] / w.reduce((a, b) => a + b, 0);
  assert.ok(pAce(PM.gradeWeights(3)) > pAce(PM.gradeWeights(0)), '상향 가중이 에이스를 안 늘린다');
  assert.ok(pWorst(PM.gradeWeights(-3)) > pWorst(PM.gradeWeights(0)), '하향 가중이 폐급을 안 늘린다');
  for (const w of [PM.gradeWeights(5), PM.gradeWeights(-5)]) {
    assert.ok(w.every(x => x > 0), '가중이 음수로 떨어졌다');
  }
});

test('rollGrades는 언제나 5단계 안의 라벨을 돌려준다', () => {
  const units = [
    { intel: { score: 8 }, macho: { score: 2 } },
    { intel: { score: 4 }, macho: { score: 9 } },
  ];
  for (const u of units) {
    for (let i = 0; i < 50; i++) {
      const { grade, character } = PM.rollGrades(u, Math.random);
      assert.ok(PM.GRADES.includes(grade));
      assert.ok(PM.CHARACTERS.includes(character));
    }
  }
});

test('연루 병사 선정은 중복이 없고 등급 하위가 잘 걸린다', () => {
  const roster = PM.GRADES.map((g, i) => ({ serial: `s${i}`, grade: g }));
  const picked = PM.pickInvolved(roster, 2, seq([0, 0]));
  assert.equal(picked.length, 2);
  assert.notEqual(picked[0].serial, picked[1].serial);
  // rng 0 = 가중 목록의 맨 앞 — 폐급이 먼저 걸린다
  assert.equal(picked[0].grade, '폐급');
});

// ── 방향 판정과 평판 ────────────────────────────────────
test('심판은 방향만 고르고 폭은 코드가 정한다 — 한 걸음 1칸', () => {
  const p = PM.initialParams();
  const out = PM.applyDirections(p, { gara: 'up', happy: 'down', conflict: 'same' });
  assert.equal(out.gara, p.gara + 1);
  assert.equal(out.happy, p.happy - 1);
  assert.equal(out.conflict, p.conflict);
  assert.notEqual(out, p, '원본을 돌려줬다 — 순수 함수가 아니다');
});

test('어떤 LLM 판정도 평판을 못 움직인다 — 개입 횟수가 곧 평판이다', () => {
  const p = PM.initialParams();
  // 판정에 rep 방향을 몰래 실어도 무시된다
  const judged = PM.applyDirections(p, { gara: 'up', happy: 'up', conflict: 'up', rep: 'up' });
  assert.equal(judged.rep, p.rep, '판정이 평판을 건드렸다');
  // 개입은 −1
  assert.equal(PM.applyIntervention(p).rep, p.rep - 1);
  // 조용한 날은 +1, 개입한 날은 회복 없음
  assert.equal(PM.applyDrift(p, 5, { interventions: 0 }).rep, p.rep + 1);
  assert.equal(PM.applyDrift(p, 5, { interventions: 2 }).rep, p.rep);
});

test('모르는 방향 값은 same으로 떨어진다', () => {
  assert.equal(PM.direction('up'), 1);
  assert.equal(PM.direction('down'), -1);
  assert.equal(PM.direction('sideways'), 0);
  assert.equal(PM.direction(undefined), 0);
});

// ── 드리프트 — 파라미터끼리 얽히는 공식 ─────────────────
test('가라↑ → 행복 드리프트↑, 가라↓ → 행복 드리프트↓', () => {
  const base = { gara: 8, happy: 5, conflict: 5, rep: 5 };
  assert.equal(PM.applyDrift(base, 5, { interventions: 1 }).happy, 6);
  assert.equal(PM.applyDrift({ ...base, gara: 2 }, 5, { interventions: 1 }).happy, 4);
});

test('난이도가 높으면 행복도 갈등도 내려간다 — 힘들면 싸울 기력도 없다', () => {
  const base = { gara: 5, happy: 5, conflict: 5, rep: 5 };
  const out = PM.applyDrift(base, 9, { interventions: 1 });
  assert.equal(out.happy, 4);
  assert.equal(out.conflict, 4);
});

test('행복이 바닥이면 갈등이 오르고, 행복이 높으면 갈등이 내린다', () => {
  const sad = PM.applyDrift({ gara: 5, happy: 2, conflict: 5, rep: 5 }, 5, { interventions: 1 });
  assert.equal(sad.conflict, 6);
  const glad = PM.applyDrift({ gara: 5, happy: 9, conflict: 5, rep: 5 }, 5, { interventions: 1 });
  assert.equal(glad.conflict, 4);
});

test('드리프트는 하루 최대 ±1칸이다 — 겹쳐도 한 걸음', () => {
  // 가라 2(행복↓) + 난이도 9(행복↓) + 갈등 8(행복↓) = 사유 셋이라도 −1
  const out = PM.applyDrift({ gara: 2, happy: 5, conflict: 8, rep: 5 }, 9, { interventions: 1 });
  assert.equal(out.happy, 4);
});

// ── 카운터 — 사고만이 리셋한다 ──────────────────────────
test('사고 후 카운터는 0인데 파라미터는 그대로다', () => {
  assert.equal(PM.endOfDayStreak(87, true), 0);
  assert.equal(PM.endOfDayStreak(87, false), 88);
  // applyDirections·applyDrift 어디에도 카운터가 없다 — 카운터는 파라미터가 아니다
  const p = PM.initialParams();
  assert.ok(!('streak' in p));
  assert.equal(PM.isPromoted(99), false);
  assert.equal(PM.isPromoted(100), true);
});

// ── 장소-파라미터 대응표 ────────────────────────────────
test('장소마다 드러내는 파라미터가 있고, 전부 실존 파라미터다', () => {
  const keys = Object.keys(PM.PLACES);
  assert.ok(keys.length >= 4);
  for (const [k, p] of Object.entries(PM.PLACES)) {
    assert.ok(p.label, `${k} 라벨 없음`);
    assert.ok(p.reveals.length >= 1, `${k}가 아무것도 안 드러낸다`);
    for (const r of p.reveals) assert.ok(['gara', 'happy', 'conflict'].includes(r), `${k}가 모르는 축 ${r}을 드러낸다`);
  }
  // 생활관은 갈등을, 작업장은 가라를 — 기획서의 두 예시는 못박는다
  assert.ok(PM.PLACES.barracks.reveals.includes('conflict'));
  assert.ok(PM.PLACES.worksite.reveals.includes('gara'));
  // 평판은 어느 장소도 안 드러낸다 — 평판은 병사가 아니라 주임원사의 것이다
  for (const p of Object.values(PM.PLACES)) assert.ok(!p.reveals.includes('rep'));
});
