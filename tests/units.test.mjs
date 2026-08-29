// node --test tests/units.test.mjs — 부대 프롬프트 대장 검증.
//
// 셋째 군은 units.js에 항목 하나를 더하는 것으로 끝나야 한다 (M5).
// 그러려면 (1) 스키마가 다섯 절을 강제하고, (2) 코드 어디에도 특정 부대를 아는
// 분기가 없어야 한다. 둘 다 여기서 못박는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UNITS, UNIT_BY_ID, UNIT_FIELDS } from '../js/units.js';

test('구현 대상 부대는 해병 성채 · 공군 체계단 둘이다', () => {
  assert.equal(UNITS.length, 2);
  const names = UNITS.map(u => u.name).sort();
  assert.deepEqual(names, ['공군 체계단', '해병 성채']);
});

test('부대마다 다섯 절이 전부 있다 — ①문화 ②규정 ③병사간 룰 ④지능 ⑤마초', () => {
  for (const u of UNITS) {
    for (const f of ['culture', 'rules', 'soldierRules']) {
      assert.ok(u[f].trim().length >= 20, `${u.id}.${f} 절이 부실하다`);
    }
    for (const f of ['intel', 'macho']) {
      assert.equal(typeof u[f].score, 'number', `${u.id}.${f} 수치가 없다`);
      assert.ok(u[f].score >= 0 && u[f].score <= 10);
      assert.ok(u[f].desc.length >= 2, `${u.id}.${f} 서술이 없다`);
    }
  }
});

test('④⑤는 수치+서술 한 쌍이다 — 기획서의 초기 데이터 스케치 그대로', () => {
  const marine = UNIT_BY_ID['marine-fort'], air = UNIT_BY_ID['airforce-sys'];
  assert.equal(marine.intel.score, 4);
  assert.equal(marine.macho.score, 9);
  assert.equal(marine.difficulty, 8);
  assert.equal(marine.serviceMonths, 18);
  assert.equal(air.intel.score, 8);
  assert.equal(air.macho.score, 2);
  assert.equal(air.difficulty, 3);
  assert.equal(air.serviceMonths, 21);
});

test('스키마 밖 필드가 없다 — 검증은 로드 시 이미 죽였겠지만, 목록도 못박는다', () => {
  assert.deepEqual([...UNIT_FIELDS].sort(), [
    'branch', 'culture', 'desc', 'difficulty', 'id', 'intel', 'jobs',
    'macho', 'name', 'rules', 'serial', 'serviceMonths', 'soldierRules',
  ]);
  for (const u of UNITS) {
    assert.deepEqual(Object.keys(u).sort(), [...UNIT_FIELDS].sort());
  }
});

test('군번 형식과 직무 슬롯이 부대마다 있다 — 채번과 배정은 코드 몫이다', () => {
  for (const u of UNITS) {
    assert.ok(u.serial.tag.length >= 1);
    assert.ok(u.serial.pad >= 4);
    assert.ok(u.jobs.length >= 4);
  }
});

// M5의 핵심 — 코드 어디에도 특정 부대를 아는 분기를 두지 않는다.
test('부대 id가 units.js 밖의 어떤 코드에도 등장하지 않는다', async () => {
  const files = ['params.js', 'prompts.js', 'engine.js', 'roster.js', 'game.js', 'boot.js', 'llm.js', 'ui.js'];
  for (const f of files) {
    const src = await readFile(new URL(`../js/${f}`, import.meta.url), 'utf8');
    for (const u of UNITS) {
      assert.ok(!src.includes(`'${u.id}'`) && !src.includes(`"${u.id}"`),
        `js/${f}가 부대 「${u.id}」를 안다 — 셋째 군이 units.js 항목 하나로 끝나지 않게 된다`);
      assert.ok(!src.includes(u.name), `js/${f}에 부대 이름 「${u.name}」이 박혀 있다`);
    }
  }
});

test('부대별 용어·문화가 실제로 프롬프트 재료에 들어 있다', () => {
  const marine = UNIT_BY_ID['marine-fort'], air = UNIT_BY_ID['airforce-sys'];
  for (const term of ['딸녀', '악기바리', '기수']) assert.ok(marine.culture.includes(term), `해병 용어 ${term} 누락`);
  for (const term of ['딸수', '짬찌', '찐빠']) assert.ok(air.culture.includes(term), `공군 용어 ${term} 누락`);
  assert.ok(air.soldierRules.includes('따돌림'), '공군의 취약점(따돌림형 부조리)이 빠졌다');
});
