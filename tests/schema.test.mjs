// node --test tests/schema.test.mjs — 구조화 출력 스키마 계약 테스트.
// Claude 구조화 출력은 JSON Schema 전체가 아니라 부분집합만 받는다.
// 연애조작단에서 maxItems 하나가 섞여 화면이 통째로 멈춘 적이 있다.
// 다시는 그 상태로 배포되지 않게, 실제로 보내는 스키마를 여기서 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUnsupportedSchemaKeys } from '../js/llm.js';
import * as P from '../js/prompts.js';

// API가 거부하는 키워드 (엔진이 아니라 API 쪽 제약이다)
const BANNED = [
  'maxItems', 'minItems', 'uniqueItems', 'maxLength', 'minLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'maxProperties', 'minProperties', 'patternProperties', 'default',
];
const NAME_MAPS = new Set(['properties', '$defs', 'definitions']);

// properties 아래의 키는 필드 이름이라 검사 대상이 아니다. 키워드 자리만 본다.
function bannedKeys(node, path = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => bannedKeys(n, `${path}[${i}]`, found));
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  for (const [k, v] of Object.entries(node)) {
    if (BANNED.includes(k)) found.push(`${path}.${k}`);
    if (NAME_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [name, sub] of Object.entries(v)) bannedKeys(sub, `${path}.${k}.${name}`, found);
    } else {
      bannedKeys(v, `${path}.${k}`, found);
    }
  }
  return found;
}

// export되는 *_SCHEMA = 실제로 API에 보내는 최상위 스키마 전부.
const SCHEMAS = Object.entries(P).filter(([k, v]) => k.endsWith('_SCHEMA') && v && typeof v === 'object');

test('내보내는 스키마가 하나도 빠짐없이 존재한다 — A·P·D·E-3·N·F 여섯', () => {
  const names = SCHEMAS.map(([k]) => k).sort();
  assert.deepEqual(names,
    ['AMBIENT_SCHEMA', 'BRIEFING_SCHEMA', 'ESCALATION_SCHEMA', 'FAREWELL_SCHEMA', 'NOTICE_SCHEMA', 'RECRUIT_SCHEMA']);
});

for (const [name, schema] of SCHEMAS) {
  test(`${name}에 API가 거부하는 키워드가 없다`, () => {
    assert.deepEqual(bannedKeys(schema, name), [], `${name}에 지원되지 않는 키워드가 있다`);
  });
  test(`${name}은 required가 곧 properties다 — 선택 필드로 새는 축이 없다`, () => {
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    assert.equal(schema.additionalProperties, false);
  });
}

test('보내기 직전 정리기가 남은 키워드를 걷어낸다', () => {
  const dirty = {
    type: 'object',
    properties: {
      slots: { type: 'array', maxItems: 9, minItems: 9, items: { type: 'string', maxLength: 80 } },
      name: { type: 'string', pattern: '^x$', description: '설명은 살아남는다' },
    },
    required: ['slots', 'name'],
    additionalProperties: false,
  };
  const clean = stripUnsupportedSchemaKeys(dirty);
  assert.deepEqual(bannedKeys(clean, '$'), []);
  assert.equal(clean.properties.slots.type, 'array');
  assert.equal(clean.properties.slots.items.type, 'string');
  assert.deepEqual(clean.required, ['slots', 'name']);
  assert.equal(clean.properties.name.description, '설명은 살아남는다');
  assert.equal(dirty.properties.slots.maxItems, 9, '원본 스키마는 건드리지 않는다');
});

test('슬롯 아홉 개 상한은 스키마가 아니라 프롬프트 지시와 코드가 지킨다', () => {
  // BRIEFING_SCHEMA의 slots에 minItems/maxItems를 걸면 400이다 — 개수는 지시로만
  assert.ok(!('minItems' in P.BRIEFING_SCHEMA.properties.slots));
  assert.match(P.BRIEFING_SCHEMA.properties.slots.description, /Same count as the slots/);
  // 앰비언트도 같다 — 줄 수는 지시로 말하고, 넘치거나 모자란 것은 ambient.js가 받아낸다
  assert.ok(!('maxItems' in P.AMBIENT_SCHEMA.properties.lines));
  assert.match(P.AMBIENT_SCHEMA.properties.lines.description, /three or four lines each/);
  // 환송회도 같다 — 인사하는 인원 수는 코드가 고른 명단이 정하고, 스키마는 안 센다
  assert.ok(!('maxItems' in P.FAREWELL_SCHEMA.properties.lines));
  assert.match(P.FAREWELL_SCHEMA.properties.lines.description, /one entry per man/);
});
