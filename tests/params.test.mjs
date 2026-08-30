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

test('감당 못 하는 관행이 많을수록 사고 위험이 오른다 — 어설프면 다친다', () => {
  // 예전에는 `max(0, 가라 − 지능)`이라는 근사치가 이 자리에 있었다. 목록이 생긴 뒤로는
  // 실물(garaOverreach)이 그 자리를 대신하고, 근사치 쪽 계수는 지웠다 — 엔진이 언제나
  // overreach를 넘기게 된 다음부터 한 번도 안 읽혔는데 튜닝표에 남아 있었다.
  const unit = { intel: 4, macho: 5, difficulty: 3, comrade: 5 };
  const fine = PM.incidentRisk({ gara: 7, conflict: 3, overreach: 0 }, unit).small;
  const over = PM.incidentRisk({ gara: 7, conflict: 3, overreach: 3 }, unit).small;
  assert.ok(over > fine, '감당 못 하는 관행이 위험을 안 올린다');
  // 지능은 이제 **어느 관행이 감당 밖인가**로만 들어온다 — 그건 garaOverreach가 센다
  assert.equal(PM.garaOverreach(PM.GARA_IDS, 4) > PM.garaOverreach(PM.GARA_IDS, 8), true,
    '머리가 나쁠수록 감당 밖인 관행이 많아야 한다');
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
  assert.deepEqual(PM.rollSlot(params, unit, 'work', seq([0.0001])), { tier: 'major', cause: 'conflict' });
  assert.equal(PM.rollSlot(params, unit, 'work', seq([0.99, 0.99])), null);
  const calm = { gara: 0, conflict: 0 };
  const safeUnit = { intel: 10, macho: 0, difficulty: 1 };
  assert.deepEqual(PM.rollSlot(calm, safeUnit, 'work', seq([0.0001])), { tier: 'minor' });
  // 멘탈이 바닥난 놈이 있으면 갈등이 낮아도 큰 롤이 열린다 — 원인이 mental로 찍힌다
  assert.deepEqual(PM.rollSlot({ gara: 0, conflict: 0, minMental: 1 }, safeUnit, 'work', seq([0.0001])),
    { tier: 'major', cause: 'mental' });
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

test('힘든 날은 그 부대의 평소 대비다 — 절대 눈금이 아니다', () => {
  const base = { gara: 5, happy: 5, conflict: 5, rep: 5 };
  // 난이도 9라도 그게 이 부대의 평소면 힘든 날이 아니다. 평소보다 한 칸 높아야 힘든 날이다.
  assert.equal(PM.applyDrift(base, 9, { interventions: 1, baseline: 9 }).conflict, 4,
    '제자리 회복이 갈등을 5→4로 당겨야 한다');
  assert.equal(PM.applyDrift(base, 9, { interventions: 1, baseline: 8 }).conflict, 4, '힘든 날인데 갈등이 안 내렸다');
  // 힘든 날은 **갈등만** 민다 — 난이도가 행복을 깎는 길은 달력이 아니라 사고 롤이다
  assert.equal(PM.applyDrift(base, 9, { interventions: 1, baseline: 8 }).happy, 5,
    '달력이 행복을 직접 깎았다 — 사고 롤과 이중 과금이다');
  // 평소보다 편한 날(주말)은 숨통이 트인다
  assert.equal(PM.applyDrift({ ...base, happy: 3 }, 1, { interventions: 1, baseline: 8 }).happy, 4);
});

test('빡센 부대라고 행복이 매일 깎이지 않는다 — 되돌릴 레버가 없는 단조 감소는 게임이 아니다', () => {
  // 난이도 8로 저작된 부대의 평일 100일. 예전에는 이레 만에 행복 0에 붙어 다시는 안 올라왔다.
  let p = PM.initialParams();
  for (let d = 0; d < 100; d++) p = PM.applyDrift(p, 8, { interventions: 0, baseline: 8 });
  assert.ok(p.happy >= 4, `방치한 부대의 행복이 ${p.happy}까지 내려갔다`);
  assert.ok(p.conflict <= 5, `방치한 부대의 갈등이 ${p.conflict}까지 올라갔다`);
});

test('아무것도 안 민 날은 제자리로 한 칸 돌아온다 — 평판의 조용한 날 회복과 같은 자리다', () => {
  const calm = { gara: 5, happy: 5, conflict: 3, rep: 5 };
  const still = PM.applyDrift(calm, 5, { interventions: 1, baseline: 5 });
  assert.equal(still.happy, PM.TUNING.start.happy, '제자리에 있는 값이 움직였다');
  assert.equal(still.conflict, PM.TUNING.start.conflict);
  // 밀린 값은 제자리 쪽으로 한 칸씩 (한 번에 벽까지 가지 않는다)
  assert.equal(PM.applyDrift({ ...calm, happy: 0 }, 5, { interventions: 1, baseline: 5 }).happy, 1);
  assert.equal(PM.applyDrift({ ...calm, happy: 10 }, 5, { interventions: 1, baseline: 5 }).happy, 9);
});

test('baseline을 안 주면 오늘이 곧 평소다 — 옛 호출이 힘든 날로 오독되지 않는다', () => {
  const base = { gara: 5, happy: 5, conflict: 5, rep: 5 };
  assert.deepEqual(PM.applyDrift(base, 9, { interventions: 1 }), PM.applyDrift(base, 9, { interventions: 1, baseline: 9 }));
});

test('행복이 바닥이면 갈등이 오르고, 행복이 높으면 갈등이 내린다', () => {
  const sad = PM.applyDrift({ gara: 5, happy: 2, conflict: 5, rep: 5 }, 5, { interventions: 1 });
  assert.equal(sad.conflict, 6);
  const glad = PM.applyDrift({ gara: 5, happy: 9, conflict: 5, rep: 5 }, 5, { interventions: 1 });
  assert.equal(glad.conflict, 4);
});

test('드리프트는 하루 최대 ±1칸이다 — 겹쳐도 한 걸음', () => {
  // 가라 2(행복↓) + 갈등 8(행복↓) = 사유 둘이라도 −1
  const out = PM.applyDrift({ gara: 2, happy: 5, conflict: 8, rep: 5 }, 9, { interventions: 1, baseline: 8 });
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

// ── 멘탈 — 병사별 저장 상태. 큰 사고의 두 번째 문이다 ────
test('멘탈 굴림은 0~10 안이고, 인성 하위는 낮게 시작한다', () => {
  for (let i = 0; i < 60; i++) {
    const m = PM.rollMental('중', Math.random);
    assert.ok(m >= 0 && m <= 10);
  }
  // 같은 난수면 인성만큼 정확히 낮다
  const fixed = () => 0.5;
  assert.equal(PM.rollMental('최악', fixed), PM.rollMental('중', fixed) - 2);
  assert.equal(PM.rollMental('하', fixed), PM.rollMental('중', fixed) - 1);
});

test('분위기의 하락은 전원에게 붙는다 — 어두우면 −1, 눌리면 또 −1', () => {
  const base = { gara: 5, rep: 5 };
  const N = PM.TUNING.comrade.neutral;
  assert.equal(PM.mentalDrift(5, { ...base, happy: 2, conflict: 3 }, N), 4);
  // 어둡고 눌리면 사유가 둘이지만 하루 한 걸음이다
  assert.equal(PM.mentalDrift(5, { ...base, happy: 2, conflict: 8 }, N), 4);
  assert.equal(PM.mentalDrift(5, { ...base, happy: 4, conflict: 5 }, N), 5, '아무 사유도 없는 날에 움직였다');
  assert.equal(PM.mentalDrift(0, { ...base, happy: 0, conflict: 9 }, N), 0, '바닥 밑으로 뚫었다');
  // 하락 함수는 회복을 모른다 — 회복은 인원이 정해져 있어서 명부 전체를 보는 자리의 몫이다
  assert.equal(PM.mentalDrift(3, { ...base, happy: 10, conflict: 0 }, N), 3, '개인 함수가 회복을 했다');
});

// ── 멘탈 경제 — 하락은 전원, 회복은 몇 명 ────────────────
test('회복은 하한 위에서 전우애가 정한다 — 시간은 어디서나 약이다', () => {
  const never = () => 0.999, always = () => 0;
  const M = PM.TUNING.mental;
  // 얕은 부대라도 하한만큼은 언제나 돌아온다. 없이 재 봤더니 그 부대는 100일이면 전원이
  // 멘탈 0에 눌러앉았다 — 「큰 사고의 문」이 예외가 아니라 상시 켜진 기본값이 됐다.
  assert.equal(PM.recoverCount(2, never), M.recoverMin, '얕은 부대의 회복이 하한 아래로 갔다');
  assert.ok(PM.recoverCount(10, never) > PM.recoverCount(2, never), '끈끈한 부대가 더 안 챙긴다');
  // 부대가 평소 아래면 전우애 몫이 꺼지고 하한만 남는다 — 서로 챙기는 것은 여유가 있을 때다
  assert.equal(PM.recoverCount(10, never, { warm: false }), M.recoverMin);
  assert.ok(PM.recoverCount(10, never, { warm: true }) > M.recoverMin);

  // 제일 힘든 놈부터, 평상 상태까지만
  const men = [1, 2, 3, 6, 6].map(m => ({ mental: m }));
  const ok = { happy: M.recoverAt, conflict: 3 };
  const warm = PM.mentalPass(men, ok, 10, never);
  assert.equal(warm[0], 2); assert.equal(warm[1], 3);
  assert.deepEqual(warm.slice(2), [3, 6, 6], '평상 상태인 사람까지 밀어 올렸다');
  const up = PM.mentalPass([{ mental: 8 }, { mental: 9 }], { happy: 10, conflict: 0 }, 10, () => 0);
  assert.deepEqual(up, [8, 9], '평상 상태 위인 사람이 회복 대상이 됐다');
});

test('분위기가 나쁜 밤에 무너지는 것은 전원이 아니라 몇 명이다', () => {
  const M = PM.TUNING.mental;
  // 하락이 전원이던 시절, 하루의 하락(16점)이 열흘치 회복이었다 — 그 비대칭 하나가
  // 멘탈 경제를 통째로 부쉈다. 이제 하락에도 인원이 있고, 누가 무너질지는 모른다.
  const bad = { happy: 0, conflict: 3 };
  const men = Array.from({ length: 16 }, () => ({ mental: 6 }));
  const out = PM.mentalPass(men, bad, PM.TUNING.comrade.neutral, () => 0);
  const dropped = out.filter(m => m < 6).length;
  assert.ok(dropped > 0 && dropped < men.length, `무너진 인원이 ${dropped}명이다 — 전원도 0명도 아니어야 한다`);
  // 하락 인원은 mentalFall이 정한다. 같은 밤에 회복 하한이 한 명을 도로 올려놓으므로
  // 명부에 남는 자국은 그보다 적거나 같다 — 하락과 회복이 같은 밤에 도는 것이 이 경제다.
  assert.ok(dropped <= PM.mentalFall(bad, PM.TUNING.comrade.neutral), '하락 인원이 정원을 넘었다');

  // 깊이도 본다 — 문턱을 더 지나칠수록 더 많이 무너진다. 「행복 3」과 「행복 0」이 같은
  // 부대면, 부대를 바닥까지 쥐어짜는 것이 공짜가 된다(실측: 그 플레이가 완주율 1위였다).
  assert.ok(PM.mentalFall({ happy: 0, conflict: 3 }, 5) > PM.mentalFall({ happy: 3, conflict: 3 }, 5));
  assert.equal(PM.mentalFall({ happy: M.recoverAt, conflict: 3 }, 5), 0, '평범한 부대에서 사람이 무너졌다');
  // 이미 바닥난 사람은 하락 추첨에서 빠진다 — 뽑아 봐야 아무 일도 안 난다.
  // (같은 밤에 회복 하한이 한 명을 올려놓으므로 총합은 오히려 는다.)
  const floored = PM.mentalPass([{ mental: 0 }, { mental: 0 }], bad, 5, () => 0);
  assert.ok(floored.every(m => m >= 0), '눈금 아래로 내려갔다');
  assert.equal(floored.reduce((a, b) => a + b, 0), M.recoverMin, '바닥난 사람이 또 깎였다');
});

test('명부 원본은 안 건드린다 — 새 값을 돌려줄 뿐이다', () => {
  const men = [{ mental: 2 }, { mental: 3 }];
  PM.mentalPass(men, { happy: 10, conflict: 0 }, 10, () => 0);
  assert.deepEqual(men.map(m => m.mental), [2, 3]);
});

// ── 전우애는 방패다 — 같은 분위기가 부대마다 다른 무게로 사람에게 닿는다 ──
test('전우애는 방패지 저주가 아니다 — 사건 한 건에 열여섯 명이 맞으면 안 된다', () => {
  const p = h => ({ gara: 5, rep: 5, happy: h, conflict: 3 });
  const one = PM.TUNING.start.happy - 1;   // 사건 한 건이 그날 만드는 행복 (판정은 하루 한 칸)
  // 얕은 부대도 **기본 눈금 그대로**다. 여기가 뚫리면 사건 한 건이 전원 −1이 되고,
  // 그 하락은 마감 드리프트가 행복을 제자리로 되돌려 놓아 계기판에도 안 보인다.
  for (const c of [0, 2, 5]) {
    assert.equal(PM.mentalDrift(5, p(one), c), 5, `전우애 ${c}에서 사건 한 건이 전원을 깎았다`);
    assert.equal(PM.mentalDrift(5, p(PM.TUNING.drift.happyLow), c), 4, `전우애 ${c}에서 기본 눈금이 안 먹었다`);
  }
  // 끈끈한 부대는 그 아래로도 버틴다 — 방패는 중립 위쪽으로만 작동한다
  assert.equal(PM.mentalDrift(5, p(PM.TUNING.drift.happyLow), 10), 5, '끈끈한 부대에 방패가 없다');
  assert.equal(PM.mentalDrift(5, p(1), 10), 4, '바닥에서도 안 무너지면 방패가 아니라 무적이다');
});

test('전우애가 높으면 전입 멘탈도 높게 굴린다 — 부임 첫날부터 문이 열려 있지 않게', () => {
  const roll = (c, r) => PM.rollMental('중', () => r, c);
  assert.ok(roll(10, 0.5) > roll(2, 0.5), '전우애가 전입 멘탈을 안 민다');
  // 인성 최악 + 얕은 전우애가 겹쳐도 눈금 밖으로는 안 나간다
  for (const c of [0, 5, 10]) for (const r of [0, 0.5, 0.99]) {
    const m = PM.rollMental('최악', () => r, c);
    assert.ok(m >= 0 && m <= 10, `굴림이 눈금 밖이다: ${m}`);
  }
});

test('상담은 +1, 연루는 −1, 사고가 되면 −2다', () => {
  assert.equal(PM.counselMental(4), 5);
  assert.equal(PM.counselMental(10), 10);
  assert.equal(PM.incidentMental(5, false), 4);
  assert.equal(PM.incidentMental(5, true), 3);
  assert.equal(PM.incidentMental(0, true), 0);
});

test('멘탈이 dangerAt(2) 이하로 떨어진 병사가 있으면 큰 사고가 열린다', () => {
  const unit = { intel: 5, macho: 5, difficulty: 5 };
  for (const ok of [10, 5, 3]) {
    assert.equal(PM.incidentRisk({ gara: 5, conflict: 3, minMental: ok }, unit).big, 0,
      `멘탈 ${ok}인데 큰 사고가 열렸다`);
  }
  const at2 = PM.incidentRisk({ gara: 5, conflict: 3, minMental: 2 }, unit);
  const at0 = PM.incidentRisk({ gara: 5, conflict: 3, minMental: 0 }, unit);
  assert.ok(at2.big > 0, '멘탈 2에서 안 열렸다');
  assert.ok(at0.big > at2.big, '더 무너졌는데 위험이 같다');
  assert.equal(at2.bigCause, 'mental');
  // 갈등과 멘탈이 둘 다 열렸으면 위험은 합산이고, 원인은 더 큰 쪽이다
  const both = PM.incidentRisk({ gara: 5, conflict: 10, minMental: 2 }, unit);
  assert.ok(both.big > at2.big);
  assert.equal(both.bigCause, 'conflict');
});

test('minMental을 안 주면 안전값이다 — 멘탈이 생기기 전의 호출이 안 깨진다', () => {
  const unit = { intel: 5, macho: 5, difficulty: 5 };
  assert.equal(PM.incidentRisk({ gara: 5, conflict: 3 }, unit).big, 0);
  assert.equal(PM.minMentalOf([]), 10, '빈 명부가 위험을 열었다');
  assert.equal(PM.minMentalOf([{ mental: 4 }, { mental: 7 }]), 4);
  assert.equal(PM.minMentalOf([{}]), PM.TUNING.mental.default, '멘탈 없는 옛 병사를 못 읽었다');
});

test('연루 가중은 등급이 낮을수록, 멘탈이 낮을수록 크다', () => {
  const w = (grade, mental) => PM.involveWeight({ grade, mental });
  assert.ok(w('폐급', 6) > w('에이스', 6));
  assert.ok(w('B', 2) > w('B', 6), '무너진 놈이 더 잘 걸려야 한다');
  assert.equal(w('B', 6), w('B', 8), '기준(6) 위는 가중이 없어야 한다');
  assert.equal(w('B', undefined), w('B', 6), '멘탈 없는 옛 병사는 중립이어야 한다');
});

// ── 불시점검(군기 점검) — 순수 코드 효과 ─────────────────
test('점검은 가라 −1 · 행복 −1이고, LLM은 폭을 못 만진다', () => {
  const p = { gara: 5, happy: 5, conflict: 5, rep: 5 };
  const out = PM.applyInspection(p);
  assert.equal(out.gara, 4);
  assert.equal(out.happy, 4);
  assert.equal(out.conflict, 5);
  assert.equal(out.rep, 5, '점검 효과가 평판을 건드렸다 — 평판은 applyIntervention 몫이다');
  assert.equal(PM.applyInspection({ ...p, gara: 0, happy: 0 }).gara, 0, '바닥을 뚫었다');
  assert.notEqual(out, p, '원본을 돌려줬다');
});

// ── 전우애 — 갈등을 흡수하는 부대 완충재 ────────────────
test('전우애가 높을수록 문턱이 뒤로 밀리고, 낮을수록 앞당겨진다', () => {
  const open = c => PM.comradeEffect(c).open;
  assert.equal(open(PM.TUNING.comrade.neutral), PM.TUNING.roll.big.open, '중립이 기준선이 아니다');
  assert.ok(open(10) > open(5), '끈끈한데 문턱이 안 밀렸다');
  assert.ok(open(1) < open(5), '서로 남인데 문턱이 그대로다');
  // 단조 — 전우애가 오르는 동안 문턱이 한 번도 안 내려가야 한다
  for (let c = 1; c <= 10; c++) assert.ok(open(c) >= open(c - 1), `전우애 ${c}에서 문턱이 거꾸로 갔다`);
});

test('전우애가 낮을수록 번짐 폭도 크고 잔사건도 잦다', () => {
  const e = c => PM.comradeEffect(c);
  assert.ok(e(1).scale > e(5).scale && e(5).scale > e(10).scale, '번짐 배수가 단조가 아니다');
  assert.ok(e(1).small > 0 && e(10).small < 0, '잔사건 가산의 부호가 뒤집혔다');
  assert.equal(e(5).scale, 1, '중립 배수가 1이 아니다');
  assert.equal(e(5).small, 0, '중립에서 잔사건이 움직였다');
  assert.ok(e(0).scale >= 0, '배수가 음수로 떨어졌다');
});

test('전우애를 안 주면 중립이다 — 옛 부대 데이터가 안 깨진다', () => {
  assert.deepEqual(PM.comradeEffect(undefined), PM.comradeEffect(PM.TUNING.comrade.neutral));
  const unit = { intel: 5, macho: 5, difficulty: 5 };
  const withNeutral = PM.incidentRisk({ gara: 5, conflict: 9 }, { ...unit, comrade: 5 });
  const without = PM.incidentRisk({ gara: 5, conflict: 9 }, unit);
  assert.deepEqual(without, withNeutral);
});

test('같은 갈등이라도 전우애가 얕은 부대에서만 큰 사고가 열린다', () => {
  const at = (comrade, conflict) =>
    PM.incidentRisk({ gara: 5, conflict }, { intel: 5, macho: 5, difficulty: 5, comrade }).big;
  // 갈등 8 — 기본 문턱이지만 전우애가 이걸 갈라놓는다
  assert.equal(at(10, 8), 0, '끈끈한 부대가 갈등 8에서 터졌다');
  assert.ok(at(2, 8) > 0, '서로 남인 부대가 갈등 8에서 멀쩡하다');
  // 열린 뒤에도 얕은 쪽이 더 크게 번진다
  assert.ok(at(2, 10) > at(10, 10), '갈등 10에서 번짐 폭이 안 갈렸다');
});

test('전우애는 큰 사고만 막는다 — 잔사고까지 없애 주지는 않는다', () => {
  // 끈끈하고 빡센 부대(마초·난이도 높음)는 여전히 작은 사건이 잦아야 한다
  const tough = PM.incidentRisk({ gara: 5, conflict: 3 }, { intel: 4, macho: 9, difficulty: 8, comrade: 10 });
  const easy = PM.incidentRisk({ gara: 5, conflict: 3 }, { intel: 8, macho: 2, difficulty: 3, comrade: 2 });
  assert.ok(tough.small > easy.small, '빡센 부대의 잔사고가 편한 부대보다 적다');
  assert.equal(tough.big, 0);
  assert.equal(easy.big, 0);
});

test('멘탈이 여는 문은 전우애와 무관하다 — 한 사람이 무너지는 것은 부대가 못 막는다', () => {
  const at = comrade =>
    PM.incidentRisk({ gara: 5, conflict: 0, minMental: 1 }, { intel: 5, macho: 5, difficulty: 5, comrade }).big;
  assert.ok(at(10) > 0, '전우애가 멘탈 위험까지 막아 버렸다');
  assert.equal(at(10), at(1), '멘탈 위험이 전우애를 탄다');
});

// ── 마지막 씬 — 환송회는 행복도가 연다 ──────────────────
test('행복도가 마지막 밤을 가른다 — 높으면 환송회, 낮으면 아무도 없다', () => {
  assert.equal(PM.farewellTone(10), 'grand');
  assert.equal(PM.farewellTone(PM.TUNING.farewell.grand), 'grand', '문턱 자리가 환송회로 안 떨어졌다');
  assert.equal(PM.farewellTone(PM.TUNING.farewell.grand - 1), 'thin');
  assert.equal(PM.farewellTone(PM.TUNING.farewell.empty), 'none', '문턱 자리가 빈 방으로 안 떨어졌다');
  assert.equal(PM.farewellTone(0), 'none');
  // 눈금 전 구간이 아는 갈래로만 떨어진다 — 화면이 모르는 결이 나오면 씬이 안 열린다
  for (let v = 0; v <= 10; v++) assert.ok(PM.FAREWELL_TONES.includes(PM.farewellTone(v)));
});

test('갈래는 행복도만 본다 — 무사고 기록도 평판도 마지막 밤을 못 산다', () => {
  // farewellTone은 행복도 한 값만 받는다. 다른 파라미터가 낄 자리가 시그니처에 없다.
  assert.equal(PM.farewellTone.length, 1);
  assert.equal(PM.farewellTone(9), PM.farewellTone(9));
});

test('아무도 안 온 밤에는 입을 여는 놈이 0이다', () => {
  const men = Array.from({ length: 5 }, (_, i) => ({ name: `병${i}`, mental: 8 - i, joined: '2026-01-01' }));
  assert.deepEqual(PM.pickSendoff(men, 'none'), []);
  assert.equal(PM.pickSendoff(men, 'thin').length, PM.TUNING.farewell.speakers.thin);
  assert.equal(PM.pickSendoff(men, 'grand').length, PM.TUNING.farewell.speakers.grand);
});

test('인사는 잘 버틴 놈들이 한다 — 사건 연루자 선정의 정확한 반대편이다', () => {
  const men = [
    { name: '무너진놈', mental: 1, joined: '2026-01-01' },
    { name: '버틴놈', mental: 9, joined: '2026-03-01' },
    { name: '중간놈', mental: 5, joined: '2026-02-01' },
  ];
  assert.deepEqual(PM.pickSendoff(men, 'grand').map(m => m.name), ['버틴놈', '중간놈', '무너진놈']);
  assert.deepEqual(PM.pickSendoff(men, 'thin').map(m => m.name), ['버틴놈']);
  // 정원보다 적어도 안 죽는다 (전역이 겹쳐 명부가 빈 경우)
  assert.deepEqual(PM.pickSendoff([], 'grand'), []);
});

test('멘탈이 같으면 짬 순이다 — 굴리지 않는다', () => {
  const men = [
    { name: '후임', mental: 6, joined: '2026-05-01' },
    { name: '고참', mental: 6, joined: '2025-11-01' },
  ];
  assert.deepEqual(PM.pickSendoff(men, 'thin').map(m => m.name), ['고참']);
  // 두 번 불러도 같다 — 마지막 밤은 굴리는 자리가 아니다
  assert.deepEqual(PM.pickSendoff(men, 'grand'), PM.pickSendoff(men, 'grand'));
});

// ══════════════════════════════════════════════════════════
// 가라 내역 — 게이지 눈금에 붙은 내용물
//
// 이 표가 지키는 계약은 하나다: **수치가 원본이고 목록이 따라간다.**
// 「가라 4」는 관행 넷이 돌고 있다는 뜻이고, 그 넷이 무엇인지는 플레이어가 사야 하는 정보다.
// ══════════════════════════════════════════════════════════

test('가라 대장은 모든 자리에 최소 하나씩 깔린다 — 점검으로 영원히 못 보는 관행이 없게', () => {
  for (const key of Object.keys(PM.PLACES)) {
    assert.ok(PM.GARA_POOL.some(g => g.place === key), `${key}에서 볼 수 있는 가라가 하나도 없다`);
  }
  assert.equal(new Set(PM.GARA_IDS).size, PM.GARA_IDS.length, 'id가 겹친다');
  // 수치 눈금(0~10)보다 대장이 길어야 가라가 만점까지 오를 수 있다
  assert.ok(PM.GARA_POOL.length >= PM.SCALE.max, '대장이 눈금보다 짧다 — 가라가 만점을 못 찍는다');
});

test('대장의 한국어 표기와 영어 표기는 갈려 있다 — 화면과 프롬프트는 다른 언어를 쓴다', () => {
  const HANGUL = /[가-퟿]/;
  for (const g of PM.GARA_POOL) {
    assert.ok(HANGUL.test(g.label) && HANGUL.test(g.desc), `${g.id}의 화면 표기가 한국어가 아니다`);
    assert.ok(!HANGUL.test(g.en), `${g.id}의 en에 한글이 있다 — §9.4가 깨진다`);
    assert.ok(!/\d/.test(g.en), `${g.id}의 en에 숫자가 있다`);
  }
});

test('목록 길이는 언제나 수치를 따라간다 — 가라 4는 관행 넷이다', () => {
  let list = [];
  for (const n of [4, 7, 2, 0, 10]) {
    list = PM.syncGaraList(list, n, { rng: seq([0.1, 0.4, 0.7, 0.2, 0.9, 0.3, 0.5, 0.6, 0.05, 0.8]) });
    assert.equal(list.length, n, `가라 ${n}인데 목록이 ${list.length}개다`);
    assert.equal(new Set(list).size, list.length, '같은 관행이 두 번 돈다');
  }
});

test('줄어도 남는 놈은 그대로 남는다 — 목록이 매번 새로 굴려지지 않는다', () => {
  const four = PM.syncGaraList([], 4, { rng: seq([0.1, 0.4, 0.7, 0.2]) });
  const three = PM.syncGaraList(four, 3, { rng: seq([0.5]) });
  assert.equal(three.length, 3);
  assert.equal(three.filter(id => four.includes(id)).length, 3, '남은 셋이 새로 굴려졌다');
});

test('줄일 때 무엇이 멎는지는 아무도 못 고른다 — 점검은 정체를 사고, 끊는 것은 지침의 일이다', () => {
  // 「적발한 것부터 멎게 한다」를 넣었다가 물린 자리다. 한 자리에 도는 관행이 평균 한 건이라
  // 산 정보가 같은 개입의 부수효과에 지워졌다(실측: 털고 나면 명부가 언제나 비었다).
  const list = PM.syncGaraList([], 4, { rng: seq([0.1, 0.4, 0.7, 0.2]) });
  const dropped = new Set();
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const after = PM.syncGaraList(list, 3, { rng: seq([r]) });
    assert.equal(after.length, 3);
    list.filter(id => !after.includes(id)).forEach(id => dropped.add(id));
  }
  assert.ok(dropped.size > 1, '난수를 바꿔도 언제나 같은 놈이 멎는다 — 무작위가 아니다');
});

test('지침으로 막힌 관행은 돌지도, 새로 생기지도 않는다', () => {
  const banned = PM.GARA_IDS.slice(0, 3);
  // 이미 돌고 있었어도 막히면 빠진다
  const list = PM.syncGaraList(banned.slice(), 3, { banned, rng: seq([0.1, 0.4, 0.7]) });
  for (const id of banned) assert.ok(!list.includes(id), `막힌 ${id}가 아직 돈다`);
  // 몇 번을 다시 채워도 막힌 것은 안 들어온다
  const filled = PM.syncGaraList([], 9, { banned, rng: Math.random });
  for (const id of banned) assert.ok(!filled.includes(id), `막힌 ${id}가 새로 생겼다`);
});

test('금지가 늘수록 가라의 천장이 내려간다 — 지침이 가라를 「제한」한다는 것이 이것이다', () => {
  assert.equal(PM.garaCap([]), PM.GARA_POOL.length);
  assert.equal(PM.garaCap(PM.GARA_IDS.slice(0, 4)), PM.GARA_POOL.length - 4);
  assert.equal(PM.garaCap(PM.GARA_IDS), 0, '전부 막으면 가라가 아예 못 돈다');
  // 천장이 목표보다 낮으면 목록이 천장에서 멈춘다 (수치 클램프는 엔진 몫)
  const banned = PM.GARA_IDS.slice(0, PM.GARA_POOL.length - 2);
  assert.equal(PM.syncGaraList([], 10, { banned, rng: Math.random }).length, 2);
});

test('적발 확률은 부대 지능이 정한다 — 머리 좋은 부대일수록 잘 숨긴다', () => {
  const dumb = PM.spotChance(4), smart = PM.spotChance(8);
  assert.ok(dumb > smart, '지능이 높은데 더 잘 걸린다');
  // 어느 쪽도 0도 1도 아니다 — 완전히 못 보는 부대도, 전부 보이는 부대도 없다
  for (const intel of [0, 5, 10]) {
    const p = PM.spotChance(intel);
    assert.ok(p > 0 && p < 1, `지능 ${intel}의 적발 확률이 ${p}다`);
  }
  assert.ok(PM.spotChance(10) >= PM.TUNING.gara.spotFloor, '바닥이 안 걸렸다');
});

// ── 확인 명부 — 두 방향으로 틀릴 수 있어야 한다 ─────────
const KNOWN = (id, on) => ({ id, on });
const atPlace = key => PM.GARA_POOL.filter(g => g.place === key).map(g => g.id);

test('들이닥치면 잡힌 것이 오늘 날짜로 명부에 오른다', () => {
  const here = atPlace('barracks');
  const out = PM.inspectGara({ active: here, known: [], placeKey: 'barracks', intel: 0, on: '2026-06-01', rng: () => 0 });
  assert.deepEqual(out.spotted.sort(), here.slice().sort(), '지능 0인데도 놓쳤다');
  assert.deepEqual(out.known.map(k => k.on), here.map(() => '2026-06-01'));
});

test('숨긴 것은 안 보인다 — 이미 알고 있었다면 그 믿음은 그대로 남는다', () => {
  const here = atPlace('barracks');
  const out = PM.inspectGara({
    active: here, known: [KNOWN(here[0], '2026-05-01')],
    placeKey: 'barracks', intel: 10, on: '2026-06-01', rng: () => 0.999,   // 전부 숨긴다
  });
  assert.deepEqual(out.spotted, [], '숨겼는데 잡혔다');
  const kept = out.known.find(k => k.id === here[0]);
  assert.ok(kept, '숨긴 것을 알고 있었는데 명부에서 지워졌다');
  assert.equal(kept.on, '2026-05-01', '못 봤는데 날짜가 새로 찍혔다');
});

test('없어진 것은 명부에서 지워진다 — 들어가 봤으면 안다', () => {
  const here = atPlace('barracks');
  const out = PM.inspectGara({
    active: [],                                  // 이 자리에서는 이제 아무것도 안 돈다
    known: [KNOWN(here[0], '2026-05-01')],
    placeKey: 'barracks', intel: 5, on: '2026-06-01', rng: () => 0,
  });
  assert.deepEqual(out.known, [], '없어진 것이 명부에 남았다');
});

test('다른 자리의 명부는 안 건드린다 — 생활관에 들이닥쳐도 창고는 낡은 채로 남는다', () => {
  const store = atPlace('storage')[0];
  const out = PM.inspectGara({
    active: [], known: [KNOWN(store, '2026-05-01')],
    placeKey: 'barracks', intel: 5, on: '2026-06-01', rng: () => 0,
  });
  assert.deepEqual(out.known, [KNOWN(store, '2026-05-01')], '안 가 본 자리의 기록이 손을 탔다');
});

test('명부는 두 방향으로 틀릴 수 있다 — 낡아서 틀리고, 못 봐서 빈다', () => {
  const here = atPlace('barracks');
  assert.ok(here.length >= 2, '이 단언에는 생활관 관행이 둘 이상 필요하다');
  // 하나만 돌고 있는데 그 하나를 숨겼다 → 명부는 비어 있고(못 봐서), 진실은 하나다
  const blind = PM.inspectGara({ active: [here[0]], known: [], placeKey: 'barracks', intel: 10, on: 'd2', rng: () => 0.999 });
  assert.equal(blind.known.length, 0);
  assert.equal(blind.missed.length, 1, '못 본 것이 집계되지 않았다');
  // 반대로 명부에 있는데 실제로는 딴 것이 돈다 → 안 가 보면 영영 모른다
  const stale = [KNOWN(here[0], 'd1')];
  assert.deepEqual(
    PM.inspectGara({ active: [here[1]], known: stale, placeKey: 'storage', intel: 5, on: 'd9', rng: () => 0 }).known,
    stale, '엉뚱한 자리를 털었는데 명부가 고쳐졌다');
});

// ── 하루의 이동량 상한 — 판정도 드리프트와 같은 속도 제한을 받는다 ──
test('사건이 몇 건이 나든 하루의 총 이동은 축마다 한 칸이다', () => {
  const dawn = { gara: 4, happy: 5, conflict: 3, rep: 5 };
  // 사건 다섯 건이 전부 가라를 올린 하루
  let p = { ...dawn };
  for (let i = 0; i < 5; i++) p = PM.applyDirections(p, { gara: 'up', happy: 'down', conflict: 'up' });
  assert.equal(p.gara, 9, '전제 확인 — 판정만으로는 다섯 칸이 뛴다');
  const capped = PM.capDay(p, dawn);
  assert.equal(capped.gara, dawn.gara + 1);
  assert.equal(capped.happy, dawn.happy - 1);
  assert.equal(capped.conflict, dawn.conflict + 1);
});

test('한 칸 안에서 움직인 날은 상한이 아무것도 안 건드린다', () => {
  const dawn = { gara: 4, happy: 5, conflict: 3, rep: 5 };
  const one = PM.applyDirections(dawn, { gara: 'up', happy: 'same', conflict: 'down' });
  assert.deepEqual(PM.capDay(one, dawn), one);
  // 평판은 판정이 못 건드리지만, 개입으로 여러 칸 깎인 날은 그대로 둬야 한다 —
  // 상한은 「하루 한 걸음」 규칙이지 평판 환불이 아니다… 평판도 같은 규칙을 받는다.
  const spent = PM.applyIntervention(PM.applyIntervention(PM.applyIntervention(dawn)));
  assert.equal(spent.rep, 2);
  assert.equal(PM.capDay(spent, dawn).rep, 4, '평판도 하루 한 걸음으로 묶인다');
});

test('달력은 제자리를 넘어서 밀지 않는다 — 계절이 한 축을 죽이지 않게', () => {
  const S = PM.TUNING.start;
  // 힘든 날: 갈등이 평소보다 높을 때만 눌러 준다
  const high = PM.applyDrift({ gara: 5, happy: 5, conflict: S.conflict + 2, rep: 5 }, 9, { interventions: 1, baseline: 8 });
  assert.equal(high.conflict, S.conflict + 1, '평소보다 높은 갈등이 안 눌렸다');
  const atRest = PM.applyDrift({ gara: 5, happy: 5, conflict: S.conflict, rep: 5 }, 9, { interventions: 1, baseline: 8 });
  assert.equal(atRest.conflict, S.conflict, '힘든 날이 갈등을 평소 아래로 밀었다');
  // 여름 평일을 40일 이어 붙여도 갈등 축이 안 죽는다
  let p = PM.initialParams();
  for (let d = 0; d < 40; d++) p = PM.applyDrift(p, 9, { interventions: 1, baseline: 8 });
  assert.equal(p.conflict, S.conflict, `계절이 갈등을 ${p.conflict}까지 밀었다 — 축이 죽으면 큰 사고의 문이 안 열린다`);
});

// ══════════════════════════════════════════════════════════
// 가라의 네 요소 — 등급 · 자리와 시간 · 난이도 · 내용
//
// 눈금에 내용물을 붙인 다음의 계약이다: 관행 하나는 **무슨 일이 나는가**(등급),
// **언제 어디서 도는가**(자리·시간), **감당이 되는가**(난이도), **뭘 잘라먹는가**(내용)를
// 전부 들고 있어야 한다. 넷 중 하나라도 비면 그 관행은 게임에서 죽은 칸이 된다.
// ══════════════════════════════════════════════════════════

test('관행 하나는 등급·시간·난이도·내용을 전부 들고 있다', () => {
  for (const g of PM.GARA_POOL) {
    assert.ok(PM.GARA_TIERS[g.tier], `${g.id}의 등급이 표에 없다`);
    assert.ok(g.when.length && g.when.every(k => PM.SLOT_KEYS.includes(k)), `${g.id}의 시간대가 일과표 밖이다`);
    assert.ok(g.need >= 0 && g.need <= 10, `${g.id}의 난이도가 눈금 밖이다`);
    assert.ok(PM.INCIDENT_CATEGORIES[g.cat], `${g.id}가 터졌을 때의 유형이 없다`);
    assert.ok(g.tell && g.counter, `${g.id}에 단서나 대응책이 없다`);
  }
  // 등급 셋이 다 쓰여야 한다 — 재판급이 없으면 검열이 터질 자리가 없고,
  // 가벼운 것이 없으면 「너무 잡지 마라」가 성립하지 않는다.
  for (const t of PM.GARA_TIER_KEYS) {
    assert.ok(PM.GARA_POOL.some(g => g.tier === t), `${t} 등급의 관행이 대장에 하나도 없다`);
  }
  // 터지는 것은 재판급뿐이다. 이 한 줄이 「무엇을 먼저 끊을 것인가」의 전부다.
  assert.deepEqual(PM.GARA_TIER_KEYS.filter(t => PM.GARA_TIERS[t].blows), ['court']);
});

test('자리 여덟과 시간 아홉에 죽은 칸이 없다 — 어느 칸을 골라도 헛수고가 아니어야 한다', () => {
  for (const k of Object.keys(PM.PLACES)) {
    assert.ok(PM.GARA_POOL.some(g => g.place === k), `${k}에 깔린 관행이 없다`);
  }
  for (const k of PM.SLOT_KEYS) {
    assert.ok(PM.GARA_POOL.some(g => g.when.includes(k)), `${k} 시간대에 도는 관행이 없다`);
  }
});

test('급습은 자리와 시간이 둘 다 맞아야 한다 — 하나만 맞으면 방은 비어 있다', () => {
  const roll = 'proxy-rollcall';   // 생활관 · 점호 때
  const g = PM.GARA_BY_ID[roll];
  assert.deepEqual(PM.garaAt([roll], g.place, g.when[0]), [roll]);
  const wrongTime = PM.SLOT_KEYS.find(k => !g.when.includes(k));
  assert.deepEqual(PM.garaAt([roll], g.place, wrongTime), [], '시간이 어긋났는데 잡혔다');
  const wrongPlace = Object.keys(PM.PLACES).find(k => k !== g.place);
  assert.deepEqual(PM.garaAt([roll], wrongPlace, g.when[0]), [], '자리가 어긋났는데 잡혔다');
  // 시간을 안 주면 옛 동작 그대로 — 그 자리 전부다
  assert.deepEqual(PM.garaAt([roll], g.place), [roll]);
});

test('등급이 높을수록 덜 걸리고, 감당 못 하는 난이도는 표가 난다', () => {
  const intel = 5;
  const petty = PM.GARA_POOL.find(g => g.tier === 'petty' && g.need <= intel);
  const court = PM.GARA_POOL.find(g => g.tier === 'court' && g.need <= intel);
  assert.ok(petty && court, '비교할 관행이 대장에 없다');
  assert.ok(PM.spotChance(intel, court.id) < PM.spotChance(intel, petty.id),
    '재판급이 가벼운 것보다 잘 걸린다 — 그러면 안개가 안 생긴다');

  // 같은 재판급이라도 부대가 감당을 못 하면 크게 걸린다
  const hard = PM.GARA_POOL.find(g => g.tier === 'court' && g.need >= 7);
  assert.ok(PM.spotChance(hard.need - 3, hard.id) > PM.spotChance(hard.need, hard.id),
    '감당 못 하는 부대에서 더 잘 걸려야 한다 — 어설프면 표가 난다');
  // 지능이 오르면 전반적으로 덜 걸린다(등급을 고정한 채)
  assert.ok(PM.spotChance(8, petty.id) < PM.spotChance(2, petty.id));
  // id를 안 주면 옛 계산 그대로다
  assert.equal(PM.spotChance(4), Math.max(PM.TUNING.gara.spotFloor,
    Math.min(PM.TUNING.gara.spotCeil, PM.TUNING.gara.spotBase - 4 * PM.TUNING.gara.spotIntelPer)));
});

test('명부 정리는 볼 수 있었던 것에만 성립한다 — 시간이 안 맞으면 판단을 유보한다', () => {
  const id = 'proxy-rollcall';
  const g = PM.GARA_BY_ID[id];
  const known = [{ id, on: '2026-05-01' }];
  const offHours = PM.SLOT_KEYS.find(k => !g.when.includes(k));

  // 안 도는 시간에 들어갔다 — 없어졌는지 아닌지 알 수가 없다. 명부는 그대로 남는다.
  const a = PM.inspectGara({ active: [], known, placeKey: g.place, slotKey: offHours, intel: 5, on: '2026-05-10', rng: () => 0 });
  assert.deepEqual(a.known, known);
  // 도는 시간에 들어갔는데 없었다 — 이제는 안다. 지운다.
  const b = PM.inspectGara({ active: [], known, placeKey: g.place, slotKey: g.when[0], intel: 5, on: '2026-05-10', rng: () => 0 });
  assert.deepEqual(b.known, []);
  // 도는 시간에 들어갔고 있었다 — 날짜가 오늘로 새로 찍힌다
  const c = PM.inspectGara({ active: [id], known, placeKey: g.place, slotKey: g.when[0], intel: 5, on: '2026-05-10', rng: () => 0 });
  assert.deepEqual(c.spotted, [id]);
  assert.deepEqual(c.known, [{ id, on: '2026-05-10' }]);
});

test('무게 합과 감당 못 하는 개수는 개수가 못 보는 것을 본다', () => {
  const court = PM.GARA_POOL.filter(g => g.tier === 'court').slice(0, 1).map(g => g.id);
  const petty = PM.GARA_POOL.filter(g => g.tier === 'petty').slice(0, 3).map(g => g.id);
  // 가벼운 셋보다 재판급 하나가 무겁다 — 계기판의 「3 대 1」이 뒤집히는 자리다
  assert.ok(PM.garaWeight(court) > PM.garaWeight(petty), '재판급 하나가 가벼운 셋보다 가볍다');
  assert.equal(PM.garaWeight([]), 0);
  assert.deepEqual(PM.garaCourt([...court, ...petty]), court);

  const hard = PM.GARA_POOL.find(g => g.need >= 7);
  assert.equal(PM.garaOverreach([hard.id], hard.need - 1), 1, '감당 못 하는데 안 세어졌다');
  assert.equal(PM.garaOverreach([hard.id], hard.need), 0, '감당되는데 세어졌다');
});

test('감당 못 하는 관행과 무거운 등급은 사고 위험을 올린다 — 목록이 있을 때만', () => {
  const unit = { intel: 5, macho: 5, difficulty: 5, comrade: 5 };
  const base = PM.incidentRisk({ gara: 4, conflict: 3 }, unit);
  const over = PM.incidentRisk({ gara: 4, conflict: 3, overreach: 2 }, unit);
  const hot = PM.incidentRisk({ gara: 4, conflict: 3, overreach: 0, heat: 4 }, unit);
  assert.ok(over.small > PM.incidentRisk({ gara: 4, conflict: 3, overreach: 0 }, unit).small,
    '감당 못 하는 관행이 위험을 안 올린다');
  assert.ok(hot.small > PM.incidentRisk({ gara: 4, conflict: 3, overreach: 0 }, unit).small,
    '무거운 등급이 위험을 안 올린다');
  // 목록을 안 주면 옛 수식 그대로 — 회귀 테스트 전부가 이 한 줄에 기대고 있다
  assert.equal(base.small, PM.incidentRisk({ gara: 4, conflict: 3 }, unit).small);
});

// ══════════════════════════════════════════════════════════
// 검열 — 선글라스에 검은 옷. 밖에서 들어온 눈
// ══════════════════════════════════════════════════════════

test('검열은 정해진 날에 오고, 사흘 전부터 보인다 — 치울 시간이 곧 게임이다', () => {
  const C = PM.TUNING.censor;
  for (const d of C.days) {
    assert.ok(PM.censorOn(d), `부임 ${d}일차가 검열일이 아니다`);
    assert.equal(PM.censorOn(d).day, d);
    // 예고는 warn일 안에서만 보인다 — 100일 전체가 보이면 예고가 아니라 달력이다
    assert.equal(PM.censorAhead(d - C.warn)?.day, d, '예고 첫날이 안 보인다');
    assert.equal(PM.censorAhead(d - 1)?.in, 1, '하루 전인데 남은 날이 안 맞는다');
    // 검열 당일에는 오늘 것이 예고로 안 뜬다 — 오늘은 예고가 아니라 오늘이다
    assert.notEqual(PM.censorAhead(d)?.day, d);
  }
  // 예고 기간 밖은 안 보인다. 첫 검열 기준으로 못박는다.
  assert.equal(PM.censorAhead(C.days[0] - C.warn - 1), null, '예고 기간 밖인데 보인다');
  assert.equal(PM.censorOn(1), null);
  assert.equal(PM.censorAhead(1), null, '부임 첫날에 아직 안 보여야 한다');
  assert.equal(PM.censorAhead(C.days.at(-1) + 1), null, '마지막 검열 뒤에도 예고가 뜬다');
  // 갈수록 빡세진다
  for (let i = 1; i < C.days.length; i++) {
    assert.ok(PM.censorChance(5, i) > PM.censorChance(5, i - 1), '회차가 올라가는데 안 빡세진다');
  }
  // 검열관은 주임원사보다 세다 — 등급을 안 보는 일반 굴림끼리 비교한다
  assert.ok(PM.censorChance(5, 0) > 0 && PM.censorChance(9, 0) < PM.censorChance(3, 0),
    '지능이 검열 적발을 안 누른다');
});

test('검열관은 자리를 안 고른다. 대신 관행 하나는 하루에 딱 한 번 굴려진다', () => {
  const g = PM.GARA_BY_ID['proxy-rollcall'];
  const active = [g.id];
  // 그 시간이 아니면 굴려지지도 않는다
  const off = PM.censorSweep({ active, slotKey: PM.SLOT_KEYS.find(k => !g.when.includes(k)), intel: 5, rng: () => 0 });
  assert.deepEqual(off.checked, []);
  assert.deepEqual(off.caught, []);
  // 그 시간이면 굴려지고, 굴림이 낮으면 걸린다
  const on = PM.censorSweep({ active, slotKey: g.when[0], intel: 5, rng: () => 0 });
  assert.deepEqual(on.checked, [g.id]);
  assert.deepEqual(on.caught, [g.id]);
  // 이미 굴린 것은 다음 시간대에 다시 안 굴린다 — 넓게 도는 것일수록 저절로 걸리면
  // 등급도 난이도도 안 보고 「자주 도는 것부터」 걸리는 판이 된다
  const again = PM.censorSweep({ active, slotKey: g.when[1], intel: 5, rng: () => 0, done: [g.id] });
  assert.deepEqual(again.checked, []);
});

test('강평은 무거운 것부터 적히고, 재판급 하나면 그날이 사고다', () => {
  const court = PM.GARA_POOL.find(g => g.tier === 'court').id;
  const petty = PM.GARA_POOL.find(g => g.tier === 'petty').id;
  const r = PM.censorReport([petty, court]);
  assert.deepEqual(r.findings, [court, petty], '무거운 것이 위로 안 왔다');
  assert.deepEqual(r.blows, [court]);
  assert.equal(r.clean, false);
  assert.equal(r.effect.happy, PM.TUNING.censor.flagged.happy);
  assert.equal(r.effect.conflict, PM.TUNING.censor.seriousConflict, '징계감 이상인데 갈등이 안 올랐다');

  // 가벼운 것만 걸리면 사고가 아니다 — 지적으로 끝난다
  const light = PM.censorReport([petty]);
  assert.deepEqual(light.blows, []);
  assert.equal(light.effect.conflict, undefined, '가벼운 것에 갈등이 붙었다');

  // 백지로 넘기면 이 게임에 몇 안 되는 상방이 열린다
  const clean = PM.censorReport([]);
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.effect, PM.TUNING.censor.clean);
  assert.ok(clean.effect.rep > 0 && clean.effect.happy > 0);

  // 같은 것이 두 번 걸려도 한 건이다
  assert.equal(PM.censorReport([petty, petty]).findings.length, 1);
});

test('검열 효과는 확정이고, 평판은 검열이 못 깎는다 — 주임원사가 부른 것이 아니다', () => {
  const p = { gara: 5, happy: 5, conflict: 3, rep: 5 };
  const flagged = PM.applyCensor(p, PM.censorReport(['stash-corner']).effect);
  assert.equal(flagged.happy, 4);
  assert.equal(flagged.rep, 5, '검열이 평판을 깎았다 — 개입이 아닌데');
  const clean = PM.applyCensor(p, PM.censorReport([]).effect);
  assert.equal(clean.rep, 6);
  assert.equal(clean.happy, 6);
  // 눈금 밖으로는 안 나간다
  assert.equal(PM.applyCensor({ ...p, rep: 10, happy: 10 }, PM.censorReport([]).effect).rep, 10);
});

// ══════════════════════════════════════════════════════════
// 부조리 내역 — 「갈등 3」이 누가 누구에게 하는 무엇 셋인가
//
// 가라 내역과 같은 계약(수치가 원본, 목록이 따라간다)인데 결정적으로 다른 것이 하나 있다:
// **가라는 자리에 붙고 부조리는 사람에 붙는다.** 그 한 줄이 나머지를 전부 가른다.
// ══════════════════════════════════════════════════════════

const abuseRoster = (n = 16) => Array.from({ length: n }, (_, i) => ({
  serial: `s${i}`, name: `병${i}`, grade: PM.GRADES[i % 5], character: PM.CHARACTERS[i % 5], mental: 6,
  cohort: 100 + i * 3,
}));
const abuseCohort = m => m.cohort;

test('부조리 하나는 등급·자리·시간·기수차·단서를 전부 들고 있다', () => {
  for (const a of PM.ABUSE_POOL) {
    assert.ok(PM.ABUSE_TIERS[a.tier], `${a.id}의 등급이 표에 없다`);
    assert.ok(PM.PLACES[a.place], `${a.id}의 자리가 대응표에 없다`);
    assert.ok(a.when.length && a.when.every(k => PM.SLOT_KEYS.includes(k)), `${a.id}의 시간대가 일과표 밖이다`);
    assert.ok(a.gap >= 0, `${a.id}에 기수 차이 조건이 없다`);
    assert.ok(PM.INCIDENT_CATEGORIES[a.cat], `${a.id}가 터졌을 때의 유형이 없다`);
    assert.ok(a.tell && a.sign, `${a.id}에 단서(눈)와 징후(입)가 다 없다`);
    assert.ok(!/[가-퟿]/.test(a.en), `${a.id}의 en에 한글이 있다 — §9.4가 깨진다`);
  }
  // 등급 셋이 다 쓰이고, 터지는 것은 형사건뿐이다
  for (const t of PM.ABUSE_TIER_KEYS) assert.ok(PM.ABUSE_POOL.some(a => a.tier === t), `${t}가 대장에 없다`);
  assert.deepEqual(PM.ABUSE_TIER_KEYS.filter(t => PM.ABUSE_TIERS[t].pulls), ['crime']);
  // 분위기와 무관하게 매일 깎는 것도 형사건뿐이다
  assert.deepEqual(PM.ABUSE_TIER_KEYS.filter(t => PM.ABUSE_TIERS[t].daily), ['crime']);
});

test('부조리는 무거워지는 방향으로만 자란다 — 방치가 이득이면 안 된다', () => {
  for (const a of PM.ABUSE_POOL) {
    if (!a.becomes) { assert.equal(PM.ABUSE_TIERS[a.tier].rank, 2, `${a.id}는 안 자라는데 형사건도 아니다`); continue; }
    const next = PM.ABUSE_BY_ID[a.becomes];
    assert.ok(next, `${a.id}가 없는 것으로 자란다`);
    assert.ok(PM.ABUSE_TIERS[next.tier].rank > PM.ABUSE_TIERS[a.tier].rank, `${a.id}가 더 가벼운 것으로 자란다`);
  }
});

test('부조리는 위계를 타고 흐른다 — 기수 차이가 없으면 성립하지 않는다', () => {
  const entry = PM.ABUSE_POOL.find(a => a.gap >= 2);
  const flat = abuseRoster(4).map(m => ({ ...m, cohort: 500 }));   // 전원 같은 기수
  assert.equal(PM.pickAbusePair(entry, flat, { cohortOf: abuseCohort, rng: () => 0.5 }), null,
    '기수가 전부 같은데 부조리가 성립했다');
  const spread = abuseRoster(8);
  const pair = PM.pickAbusePair(entry, spread, { cohortOf: abuseCohort, rng: () => 0.5 });
  assert.ok(pair, '기수 차이가 있는데 짝이 안 만들어졌다');
  const by = spread.find(m => m.serial === pair.by), to = spread.find(m => m.serial === pair.to);
  assert.ok(to.cohort - by.cohort >= entry.gap, '후임이 선임을 괴롭힌다 — 위계가 거꾸로다');
});

test('목록은 갈등 수치를 따라가고, 씨앗은 언제나 제일 가벼운 것이다', () => {
  const roster = abuseRoster();
  const opts = { roster, cohortOf: abuseCohort, macho: 9, date: '2026-05-18', rng: seq([0.1, 0.4, 0.7, 0.2, 0.9, 0.3, 0.5, 0.6, 0.05, 0.8]) };
  let list = [];
  for (const n of [3, 5, 2, 0, 4]) {
    list = PM.syncAbuseList(list, n, { ...opts, rng: Math.random });
    assert.equal(list.length, n, `갈등 ${n}인데 목록이 ${list.length}건이다`);
  }
  // 새로 생기는 것은 전부 제일 가벼운 등급이다 — 무거운 것은 **자라서** 되는 것이지 생기는 게 아니다.
  // 이게 없으면 부임 첫날부터 형사건이 굴러다니고, 방치가 아니라 시작이 값을 치른다.
  const fresh = PM.syncAbuseList([], 6, { ...opts, rng: Math.random });
  for (const a of fresh) assert.equal(PM.ABUSE_TIERS[PM.ABUSE_BY_ID[a.id].tier].rank, 0, `${a.id}가 씨앗으로 깔렸다`);
  // 같은 관행이 같은 피해자에게 두 번 붙지 않는다
  const keys = fresh.map(a => `${a.id}|${a.to}`);
  assert.equal(new Set(keys).size, keys.length, '같은 관행이 한 사람에게 두 번 붙었다');
});

test('줄어들 때는 가벼운 것부터 — 무거워진 것은 저절로 안 없어진다', () => {
  const roster = abuseRoster();
  const heavy = PM.ABUSE_POOL.find(a => a.tier === 'crime').id;
  const light = PM.ABUSE_POOL.find(a => a.tier === 'nagging').id;
  const list = [
    { id: heavy, by: 's0', to: 's9', since: '2026-01-01' },
    { id: light, by: 's1', to: 's8', since: '2026-05-01' },
  ];
  const out = PM.syncAbuseList(list, 1, { roster, cohortOf: abuseCohort, date: '2026-05-18', rng: () => 0 });
  assert.deepEqual(out.map(a => a.id), [heavy], '무거운 것이 저절로 사라졌다 — 그러면 덮칠 이유가 없어진다');
});

test('아무도 안 말리면 무거워진다 — 형사건은 놓친 결과지 주사위가 준 것이 아니다', () => {
  const seed = PM.ABUSE_POOL.find(a => a.becomes && a.tier === 'nagging');
  const days = PM.TUNING.abuse.ripenDays;
  const a = [{ id: seed.id, by: 'x', to: 'y', since: '2026-05-01' }];
  assert.equal(PM.ripenAbuse(a, PM.dateAdd('2026-05-01', days - 1))[0].id, seed.id, '아직인데 벌써 자랐다');
  const grown = PM.ripenAbuse(a, PM.dateAdd('2026-05-01', days));
  assert.equal(grown[0].id, seed.becomes, '방치했는데 안 자랐다');
  assert.equal(grown[0].since, PM.dateAdd('2026-05-01', days), '자란 날부터 다시 세야 한다');
  // 두 단계를 지나야 형사건이다 — 임기에 한 번 나오는 일이어야 한다
  const older = PM.ripenAbuse(grown, PM.dateAdd('2026-05-01', days * 2));
  assert.equal(PM.ABUSE_TIERS[PM.ABUSE_BY_ID[older[0].id].tier].rank, 2, '두 단계를 지났는데 형사건이 아니다');
});

test('가라는 지능이 숨기고 부조리는 전우애가 숨긴다 — 두 부대가 정반대로 어렵다', () => {
  const id = PM.ABUSE_POOL.find(a => a.tier === 'nagging').id;
  // 끈끈한 부대일수록 자기들끼리 덮는다
  assert.ok(PM.catchChance(10, id) < PM.catchChance(2, id), '끈끈한 부대가 더 잘 걸린다');
  // 가라는 반대다 — 머리 좋을수록 잘 숨긴다
  const g = PM.GARA_POOL.find(x => x.tier === 'petty').id;
  assert.ok(PM.spotChance(8, g) < PM.spotChance(4, g));
  // 등급이 높을수록 덜 걸리는 것은 둘 다 같다
  const crime = PM.ABUSE_POOL.find(a => a.tier === 'crime').id;
  assert.ok(PM.catchChance(5, crime) < PM.catchChance(5, id), '형사건이 갈굼보다 잘 걸린다');
  // 알고 들어가면 잘 잡힌다 — 면담과 급습을 하나의 수순으로 묶는 자리
  assert.ok(PM.catchChance(5, crime, null, { lead: true }) > PM.catchChance(5, crime), '단서가 아무 값도 안 한다');
  // 평판이 낮으면 오기 전에 소문이 돈다
  assert.ok(PM.catchChance(5, id, 0) < PM.catchChance(5, id, 10));
});

test('실토는 평판이 정하고, 무거운 것일수록 잘 나온다', () => {
  const light = PM.ABUSE_POOL.find(a => a.tier === 'nagging').id;
  const crime = PM.ABUSE_POOL.find(a => a.tier === 'crime').id;
  assert.ok(PM.tellChance(10, light) > PM.tellChance(0, light), '평판이 솔직도를 안 민다');
  assert.ok(PM.tellChance(5, crime) > PM.tellChance(5, light), '맞고 있는 사람이 갈굼보다 말을 안 한다');
  assert.ok(PM.tellChance(10, crime) <= 1);
});

test('급습은 자리와 시간이 둘 다 맞아야 덮치고, 덮친 것은 그 자리에서 끊긴다', () => {
  const e = PM.ABUSE_BY_ID['verbal-grind'];
  const one = { id: e.id, by: 'a', to: 'b', since: '2026-05-01' };
  const base = { active: [one], comrade: 2, on: '2026-05-18', rng: () => 0 };
  // 시간이 어긋나면 아무 일도 안 일어난다
  const off = PM.inspectAbuse({ ...base, placeKey: e.place, slotKey: PM.SLOT_KEYS.find(k => !e.when.includes(k)) });
  assert.deepEqual(off.caught, []);
  assert.deepEqual(off.active, [one], '안 도는 시간인데 목록이 바뀌었다');
  // 맞으면 덮치고, **그 자리에서 끊긴다** — 가라의 「점검은 정체만 산다」가 여기서는 성립 안 한다
  const hit = PM.inspectAbuse({ ...base, placeKey: e.place, slotKey: e.when[0] });
  assert.deepEqual(hit.caught.map(a => a.id), [e.id]);
  assert.deepEqual(hit.active, [], '덮쳤는데 아직 돈다');
  assert.equal(hit.known[0].how, 'caught');
});

test('단서는 관행 이름이 아니라 그 짝을 따라간다 — 자라도 어디를 볼지는 안다', () => {
  const seed = PM.ABUSE_POOL.find(a => a.becomes && a.tier === 'nagging');
  const grown = PM.ABUSE_BY_ID[seed.becomes];
  const now = { id: grown.id, by: 'a', to: 'b', since: '2026-05-10' };
  const stale = [{ id: seed.id, by: 'a', to: 'b', on: '2026-04-01', how: 'told' }];   // 자라기 전에 들은 것
  // 낡은 단서라도 짝이 같으면 보너스가 붙는다. 굴림을 경계 사이에 놓고 가른다.
  const p = PM.catchChance(5, grown.id, null, { lead: true });
  const bare = PM.catchChance(5, grown.id);
  assert.ok(p > bare);
  const mid = (p + bare) / 2;
  const withLead = PM.inspectAbuse({ active: [now], known: stale, placeKey: grown.place, slotKey: grown.when[0], comrade: 5, on: '2026-05-18', rng: () => mid });
  const without = PM.inspectAbuse({ active: [now], known: [], placeKey: grown.place, slotKey: grown.when[0], comrade: 5, on: '2026-05-18', rng: () => mid });
  assert.equal(withLead.caught.length, 1, '낡은 단서가 통째로 죽었다 — 오래 쫓을수록 아는 게 없어진다');
  assert.equal(without.caught.length, 0);
});

test('무너지는 것은 당하는 놈부터다 — 인원은 그대로고 순서만 생긴다', () => {
  const men = Array.from({ length: 8 }, (_, i) => ({ serial: `s${i}`, mental: 6 }));
  const bad = { happy: 0, conflict: 3 };
  const abuse = [{ id: PM.ABUSE_POOL.find(a => a.tier === 'hazing').id, by: 's0', to: 's5', since: '2026-05-18' }];
  const out = PM.mentalPass(men, bad, PM.TUNING.comrade.neutral, () => 0, { abuse, today: '2026-05-18' });
  assert.ok(out[5] < 6, '당하고 있는데 안 무너졌다');
  // 인원은 안 늘었다 — 부조리는 「누가」를 정할 뿐이다
  const plain = PM.mentalPass(men, bad, PM.TUNING.comrade.neutral, () => 0);
  const hurt = a => a.filter(m => m < 6).length;
  assert.equal(hurt(out), hurt(plain), '부조리가 하락 인원을 늘렸다');
});

test('형사건은 분위기가 멀쩡해도 매일 깎는다 — 다만 이틀에 한 번이다', () => {
  // 회복이 같은 밤에 도니까(하한은 언제나 붙는다) 절대값이 아니라 **차이**를 본다.
  const men = [{ serial: 'a', mental: 6 }, { serial: 'b', mental: 6 }, { serial: 'c', mental: 2 }];
  const fine = { happy: PM.TUNING.mental.recoverAt, conflict: 0 };   // 분위기는 멀쩡하다
  const crime = [{ id: PM.ABUSE_POOL.find(a => a.tier === 'crime').id, by: 'a', to: 'b', since: '2026-05-01' }];
  const none = PM.mentalPass(men, fine, 5, () => 0.999);
  const even = PM.mentalPass(men, fine, 5, () => 0.999, { abuse: crime, today: '2026-05-03' });
  const odd = PM.mentalPass(men, fine, 5, () => 0.999, { abuse: crime, today: '2026-05-02' });
  assert.ok(even[1] < none[1], '계기판이 멀쩡한데 맞고 있는 사람이 안 깎였다');
  assert.equal(odd[1], none[1], '매를 매일 맞는다 — 그러면 형사건 하나가 부대 회복 정원을 통째로 먹는다');
});

test('형사건은 갈등 문턱과 무관하게 큰 사건의 문을 연다', () => {
  const unit = { intel: 5, macho: 5, difficulty: 5, comrade: 10 };   // 문턱이 사실상 닫힌 부대
  const shut = PM.incidentRisk({ gara: 4, conflict: 3 }, unit);
  assert.equal(shut.big, 0, '갈등도 멘탈도 멀쩡한데 문이 열려 있다');
  const open = PM.incidentRisk({ gara: 4, conflict: 3, crimes: 1 }, unit);
  assert.ok(open.big > 0, '맞고 있는 사람이 있는데 문이 안 열렸다');
  assert.equal(open.bigCause, 'abuse', '사건이 그 사람에게 안 간다');
});

test('성과가 있는 급습은 분위기를 안 깎는다 — 값이 붙는 것은 헛걸음이다', () => {
  const p = { gara: 5, happy: 5, conflict: 3, rep: 5 };
  const wasted = PM.applyInspection(p);
  assert.equal(wasted.happy, 4, '헛걸음인데 분위기가 안 깎였다');
  assert.equal(wasted.gara, 4, '각은 어느 쪽이든 잡힌다');
  const found = PM.applyInspection(p, { found: true });
  assert.equal(found.happy, 5, '뭔가 나온 걸음인데 분위기를 깎았다');
  assert.equal(found.gara, 4);
});
