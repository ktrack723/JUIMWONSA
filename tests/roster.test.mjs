// node --test tests/roster.test.mjs — 명부. 채번·전입/전역 수명주기·저장.
// LLM도 프롬프트도 여기 없다 — 명부는 보관과 순환만 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Roster, makeSerial, dischargeDate, staggeredJoinDates, assignJob, ROSTER_SIZE } from '../js/roster.js';

const unit = {
  id: 'probe', serviceMonths: 18,
  serial: { tag: 'PB', pad: 7 },
  jobs: ['a', 'b', 'c', 'd'],
};
const memStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
};
const soldier = (over = {}) => ({ name: '병사', sheet: '시트', job: 'a', grade: 'B', character: '중', joined: '2026-01-10', ...over });

test('군번은 군별 형식으로 코드가 채번한다', () => {
  assert.equal(makeSerial(unit, '2026-01-10', 1234), 'PB26-0001234');
  assert.equal(makeSerial({ ...unit, serial: { tag: 'XX', pad: 5 } }, '2025-12-31', 7), 'XX25-00007');
});

test('정원은 16이고, 전입마다 군번이 하나씩 는다', () => {
  assert.equal(ROSTER_SIZE, 16);
  const r = new Roster(unit, { storage: memStorage() });
  r.seq = 1000;
  const a = r.enlist(soldier());
  const b = r.enlist(soldier({ name: '병사2' }));
  assert.equal(a.serial, 'PB26-0001000');
  assert.equal(b.serial, 'PB26-0001001');
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
