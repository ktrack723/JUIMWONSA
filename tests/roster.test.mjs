// node --test tests/roster.test.mjs — 명부. 채번·전입/전역 수명주기·저장.
// LLM도 프롬프트도 여기 없다 — 명부는 보관과 순환만 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Roster, makeSerial, dischargeDate, staggeredJoinDates, assignJob, ROSTER_SIZE,
  RANKS, rankOf, cohortOf, rankLine, monthsBetween,
} from '../js/roster.js';
import { UNIT_BY_ID } from '../js/units.js';

const unit = {
  id: 'probe', serviceMonths: 18,
  serial: { branchCode: '3', seqBase: 70000000 },
  cohort: { base: 1300, at: '2023-11' },
  rankMonths: [2, 8, 14],
  nameStyle: 'elite',
  jobs: ['a', 'b', 'c', 'd'],
};
const memStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
};
const soldier = (over = {}) => ({ name: '병사', sheet: '시트', job: 'a', grade: 'B', character: '중', joined: '2026-01-10', ...over });

test('군번은 실제 병 군번 형식이다 — 입대연도 두 자리 + 여덟 자리', () => {
  assert.equal(makeSerial(unit, '2026-01-10', 70001234), '26-70001234');
  assert.equal(makeSerial(unit, '2025-12-31', 7), '25-00000007');
  assert.match(makeSerial(unit, '2026-01-10', 1), /^\d{2}-\d{8}$/);
});

test('정원은 16이고, 전입마다 군번이 하나씩 는다', () => {
  assert.equal(ROSTER_SIZE, 16);
  const r = new Roster(unit, { storage: memStorage() });
  r.seq = 1000;
  const a = r.enlist(soldier());
  const b = r.enlist(soldier({ name: '병사2' }));
  assert.equal(a.serial, '26-00001000');
  assert.equal(b.serial, '26-00001001');
  assert.equal(r.vacancies(), ROSTER_SIZE - 2);
  assert.equal(r.bySerial(a.serial), a);
});

test('복무기간이 차면 전역한다 — 그 전에는 안 나간다', () => {
  const r = new Roster(unit, { storage: memStorage() });
  r.enlist(soldier({ joined: '2024-06-01' }));   // 전역일 2025-12-01
  r.enlist(soldier({ name: '신병', joined: '2026-01-01' }));
  assert.equal(dischargeDate(unit, '2024-06-01'), '2025-12-01');
  assert.equal(r.discharge('2025-11-30').length, 0, '복무기간 전에 전역했다');
  const out = r.discharge('2025-12-01');
  assert.equal(out.length, 1);
  assert.equal(out[0].joined, '2024-06-01');
  assert.equal(r.soldiers.length, 1);
});

test('초기 명부의 전입일은 복무기간에 고르게 흩어진다 — 전역이 몰리지 않는다', () => {
  const dates = staggeredJoinDates(unit, '2026-05-21', 16, Math.random);
  assert.equal(dates.length, 16);
  const days = dates.map(d => (Date.parse('2026-05-21') - Date.parse(d)) / 86400000);
  for (const d of days) {
    assert.ok(d >= 0 && d <= unit.serviceMonths * 30.4 + 1, `전입일이 복무기간 밖이다: ${d}일 전`);
  }
  // 등분 칸에 하나씩이므로 첫 놈과 끝 놈의 간격이 복무기간의 절반은 넘는다
  assert.ok(Math.max(...days) - Math.min(...days) > unit.serviceMonths * 15);
});

test('직무 배정은 덜 찬 직무부터 간다', () => {
  const r = [{ job: 'a' }, { job: 'a' }, { job: 'b' }, { job: 'c' }, { job: 'd' }];
  for (let i = 0; i < 10; i++) {
    const j = assignJob(unit, r, Math.random);
    assert.notEqual(j, 'a', '이미 두 명인 직무에 또 넣었다');
  }
});

test('저장·로드가 왕복한다 — 사고가 나도 병사 데이터는 유지되는 근거다', () => {
  const storage = memStorage();
  const r = new Roster(unit, { storage });
  r.seq = 5000;
  r.enlist(soldier({ name: '김보존' }));
  const r2 = new Roster(unit, { storage });
  assert.ok(r2.load());
  assert.equal(r2.soldiers.length, 1);
  assert.equal(r2.soldiers[0].name, '김보존');
  assert.equal(r2.seq, 5001, '채번 시퀀스가 저장 안 됐다 — 군번이 겹치게 된다');
  r2.clear();
  const r3 = new Roster(unit, { storage });
  assert.ok(!r3.load());
});

test('저장이 차단된 환경에서도 죽지 않는다', () => {
  const broken = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); }, removeItem: () => { throw new Error('nope'); } };
  const r = new Roster(unit, { storage: broken });
  assert.ok(!r.load());
  r.enlist(soldier());   // save가 안에서 터져도 전입은 성사된다
  assert.equal(r.soldiers.length, 1);
});

// ── 계급 — 저장하지 않고 전입일에서 계산한다 ────────────
test('계급 넷은 이병·일병·상병·병장이다', () => {
  assert.deepEqual(RANKS, ['이병', '일병', '상병', '병장']);
});

test('진급은 최저복무기간이 차면 자동이다 — 2·6·6이 만드는 눈금', () => {
  const j = '2025-01-15';
  // rankMonths [2, 8, 14] = 일병 2개월차 · 상병 8개월차 · 병장 14개월차
  assert.equal(rankOf(unit, j, '2025-01-15'), '이병', '전입 당일부터 일병일 수는 없다');
  assert.equal(rankOf(unit, j, '2025-03-14'), '이병', '2개월이 아직 안 찼다');
  assert.equal(rankOf(unit, j, '2025-03-15'), '일병', '2개월이 찼는데 이병이다');
  assert.equal(rankOf(unit, j, '2025-09-14'), '일병');
  assert.equal(rankOf(unit, j, '2025-09-15'), '상병', '8개월이 찼는데 일병이다');
  assert.equal(rankOf(unit, j, '2026-03-15'), '병장', '14개월이 찼는데 상병이다');
  assert.equal(rankOf(unit, j, '2030-01-01'), '병장', '병장 위로 올라갔다');
});

test('같은 병사의 계급이 날이 가면 오른다 — 저장하면 안 되는 이유다', () => {
  const j = '2025-06-01';
  const seq = ['2025-06-02', '2025-09-01', '2026-02-01', '2026-09-01']
    .map(d => rankOf(unit, j, d));
  assert.deepEqual(seq, ['이병', '일병', '상병', '병장']);
});

test('실제 부대의 복무기간 안에서 병장까지 간다', () => {
  for (const u of Object.values(UNIT_BY_ID)) {
    const j = '2025-01-01';
    const end = new Date(Date.UTC(2025, u.serviceMonths, 1)).toISOString().slice(0, 10);
    assert.equal(rankOf(u, j, end), '병장', `${u.id}: 전역할 때까지 병장이 못 된다`);
  }
});

// ── 기수 ────────────────────────────────────────────────
test('기수는 기준점에서 달수로 계산된다 — 월 1개 기수', () => {
  assert.equal(cohortOf(unit, '2023-11-20'), 1300, '기준점 자체가 안 맞는다');
  assert.equal(cohortOf(unit, '2023-12-18'), 1301);
  assert.equal(cohortOf(unit, '2024-11-01'), 1312);
  // 같은 달에 온 둘은 같은 기수다
  assert.equal(cohortOf(unit, '2024-03-02'), cohortOf(unit, '2024-03-28'));
});

test('실제 부대의 기수 기준점이 확인된 값이다', () => {
  // 해병 1300기 = 2023년 11월 · 공군 815기 = 2020년 6월 (docs/research.md)
  assert.equal(cohortOf(UNIT_BY_ID['marine-fort'], '2023-11-20'), 1300);
  assert.equal(cohortOf(UNIT_BY_ID['airforce-sys'], '2020-06-15'), 815);
  // 먼저 온 놈이 낮은 기수다 — 이 게임의 서열이 통째로 여기 걸려 있다
  for (const u of Object.values(UNIT_BY_ID)) {
    assert.ok(cohortOf(u, '2024-01-01') < cohortOf(u, '2025-01-01'), `${u.id}: 기수가 거꾸로다`);
  }
});

test('기수·계급 표기가 한 줄로 나온다 — 화면과 프롬프트가 같이 쓴다', () => {
  const line = rankLine(unit, { joined: '2024-11-01' }, '2025-06-01');
  assert.match(line, /^\d+기 (이병|일병|상병|병장)$/, `표기가 이상하다: ${line}`);
  assert.ok(line.startsWith('1312기'));
});

test('개월 계산은 날짜까지 본다 — 하루 모자라면 그 달은 안 찬 것이다', () => {
  assert.equal(monthsBetween('2025-01-15', '2025-02-14'), 0);
  assert.equal(monthsBetween('2025-01-15', '2025-02-15'), 1);
  assert.equal(monthsBetween('2025-01-31', '2026-01-31'), 12);
});

// ── 이름 ────────────────────────────────────────────────
test('이름을 안 주면 명부가 부대 결로 굴린다 — 동명이인 없이', () => {
  const r = new Roster(unit, { storage: memStorage() });
  for (let i = 0; i < ROSTER_SIZE; i++) r.enlist({ sheet: 's', job: 'a', grade: 'B', character: '중', joined: '2026-01-01' });
  const names = r.soldiers.map(s => s.name);
  assert.equal(names.length, ROSTER_SIZE);
  assert.equal(new Set(names).size, ROSTER_SIZE, '동명이인이 생겼다');
  for (const n of names) assert.match(n, /^[가-힣]{2,4}$/);
});

test('군번을 미리 예약할 수 있다 — 병렬 전입이 번호를 먼저 잡는 자리다', () => {
  const r = new Roster(unit, { storage: memStorage() });
  const a = r.reserveSerial('2026-01-01');
  const b = r.reserveSerial('2026-01-01');
  assert.notEqual(a, b, '미리 뗀 군번이 겹쳤다');
  // 떼어 온 번호를 그대로 써서 올릴 수 있다
  const s = r.enlist({ serial: a, sheet: 's', job: 'a', grade: 'B', character: '중', joined: '2026-01-01' });
  assert.equal(s.serial, a);
});

// ── 부재 — 사고가 데려간 사람 (입원·이탈) ────────────────
// 명부에 있다는 것과 부대에 있다는 것은 다르다. 제적이 아니라 부재다.
test('부재자는 명부에 남고 부대에서만 빠진다 — 자리는 안 채워진다', () => {
  const r = new Roster(unit, { storage: memStorage() });
  for (let i = 0; i < ROSTER_SIZE; i++) r.enlist(soldier({ name: `병${i}` }));
  assert.equal(r.vacancies(), 0);

  const man = r.soldiers[3];
  const gone = r.sendAway(man, { kind: 'hospital', days: 7, since: '2026-06-01' });
  assert.equal(gone, man);
  assert.equal(man.away.until, '2026-06-08', '복귀일이 굳지 않았다');
  assert.equal(r.soldiers.length, ROSTER_SIZE, '부재가 병사를 지웠다 — 제적이 아니다');
  assert.equal(r.present.length, ROSTER_SIZE - 1, '부재자가 아직 부대에 있다');
  assert.deepEqual(r.absent.map(s => s.name), ['병3']);
  // **요점** — 빈 자리를 정원으로 세지 않는다. 입원한 놈 자리에 신병이 오지 않는다
  assert.equal(r.vacancies(), 0, '부재로 빈 자리가 충원 대상이 됐다');
});

test('없는 놈이 또 사라지지는 않는다 — 두 번째 부재는 무시된다', () => {
  const r = new Roster(unit, { storage: memStorage() });
  const man = r.enlist(soldier());
  r.sendAway(man, { kind: 'awol', days: 5, since: '2026-06-01' });
  assert.equal(r.sendAway(man, { kind: 'hospital', days: 30, since: '2026-06-02' }), null);
  assert.equal(man.away.until, '2026-06-06', '첫 복귀일이 덮어써졌다');
});

test('복귀일이 되면 돌아온다 — 하루 전에는 안 돌아온다', () => {
  const r = new Roster(unit, { storage: memStorage() });
  const a = r.enlist(soldier({ name: '입원' }));
  const b = r.enlist(soldier({ name: '이탈' }));
  r.sendAway(a, { kind: 'hospital', days: 3, since: '2026-06-01' });   // → 06-04
  r.sendAway(b, { kind: 'awol', days: 9, since: '2026-06-01' });       // → 06-10

  assert.deepEqual(r.returnFrom('2026-06-03'), [], '복귀일 전에 돌아왔다');
  const back = r.returnFrom('2026-06-04');
  assert.deepEqual(back.map(s => s.name), ['입원']);
  assert.equal(back[0].away.kind, 'hospital', '어디에 있었는지가 복귀 명단에 없다');
  assert.equal(a.away, undefined, '돌아온 놈에게 부재가 남아 있다');
  assert.deepEqual(r.present.map(s => s.name), ['입원']);
  // 나머지 하나는 아직 밖이다
  assert.deepEqual(r.returnFrom('2026-06-10').map(s => s.name), ['이탈']);
  assert.equal(r.absent.length, 0);
});

test('부재자는 전역도 못 하고 브리핑 표본에도 안 뜬다 — 돌아와야 나간다', () => {
  const r = new Roster(unit, { storage: memStorage() });
  const stay = r.enlist(soldier({ name: '재직', joined: '2026-01-10' }));
  const away = r.enlist(soldier({ name: '입원중', joined: '2024-01-10' }));   // 복무 18개월 — 이미 만기
  r.sendAway(away, { kind: 'hospital', days: 20, since: '2026-06-01' });

  assert.deepEqual(r.discharge('2026-06-02'), [], '부재자가 전역 신고를 했다');
  assert.equal(r.soldiers.length, 2);
  assert.deepEqual(r.sample(5, () => 0).map(s => s.name), ['재직'], '없는 사람이 무대에 섰다');
  // 돌아온 날, 전역일이 이미 지나 있으면 그날 나간다
  r.returnFrom('2026-06-21');
  assert.deepEqual(r.discharge('2026-06-21').map(s => s.name), ['입원중']);
  assert.equal(stay.away, undefined);
});

test('부재는 저장에 실려 다니고, 복귀일 없는 옛 저장분은 부대로 되돌아온다', () => {
  const storage = memStorage();
  const r = new Roster(unit, { storage });
  const man = r.enlist(soldier({ name: '후송' }));
  r.sendAway(man, { kind: 'hospital', days: 4, since: '2026-06-01' });

  const again = new Roster(unit, { storage });
  again.load();
  assert.equal(again.absent.length, 1, '부재가 저장 안 됐다');
  assert.equal(again.absent[0].away.until, '2026-06-05');

  // 깨진 저장분 — 복귀일이 없으면 영원히 안 돌아온다. 그건 명부가 아니라 무덤이다
  const broken = memStorage();
  broken.setItem(`csm_roster_${unit.id}`, JSON.stringify({
    soldiers: [{ ...soldier({ name: '깨짐' }), serial: '26-00000001', away: { kind: 'awol' } }], seq: 5,
  }));
  const fixed = new Roster(unit, { storage: broken });
  fixed.load();
  assert.equal(fixed.present.length, 1, '복귀일 없는 부재가 그대로 남았다');
});
