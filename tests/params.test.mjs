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

test('부대 분위기가 멘탈을 쓸어간다 — 밝으면 +1, 어두우면 −1, 눌리면 또 −1', () => {
  const base = { gara: 5, rep: 5 };
  assert.equal(PM.mentalDrift(5, { ...base, happy: 9, conflict: 3 }), 6);
  assert.equal(PM.mentalDrift(5, { ...base, happy: 2, conflict: 3 }), 4);
  // 어둡고 눌리면 사유가 둘이지만 하루 한 걸음이다
  assert.equal(PM.mentalDrift(5, { ...base, happy: 2, conflict: 8 }), 4);
  assert.equal(PM.mentalDrift(5, { ...base, happy: 5, conflict: 5 }), 5, '보통 날에 움직였다');
  assert.equal(PM.mentalDrift(0, { ...base, happy: 0, conflict: 9 }), 0, '바닥 밑으로 뚫었다');
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
