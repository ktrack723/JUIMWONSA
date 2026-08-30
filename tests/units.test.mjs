// node --test tests/units.test.mjs — 부대 프롬프트 대장 검증.
//
// 셋째 군은 units.js에 항목 하나를 더하는 것으로 끝나야 한다 (M5).
// 그러려면 (1) 스키마가 다섯 절을 강제하고, (2) 코드 어디에도 특정 부대를 아는
// 분기가 없어야 한다. 둘 다 여기서 못박는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UNITS, UNIT_BY_ID, UNIT_FIELDS, SONG_MODES, songLines } from '../js/units.js';

test('구현 대상 부대는 해병 성채 · 공군 체계단 둘이다', () => {
  assert.equal(UNITS.length, 2);
  const names = UNITS.map(u => u.name).sort();
  assert.deepEqual(names, ['공군 체계단', '해병 성채']);
});

test('부대마다 여섯 절이 전부 있다 — ①문화 ②규정 ③병사간 룰 ④지능 ⑤마초 ⑥전우애', () => {
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
    'branch', 'cohort', 'comrade', 'culture', 'desc', 'difficulty', 'id', 'intel', 'jobs',
    'macho', 'name', 'nameStyle', 'rankMonths', 'rules', 'serial', 'serviceMonths',
    'soldierRules', 'songMode', 'songSlots', 'songs',
  ]);
  for (const u of UNITS) {
    assert.deepEqual(Object.keys(u).sort(), [...UNIT_FIELDS].sort());
  }
});

test('군번 형식과 직무 슬롯이 부대마다 있다 — 채번과 배정은 코드 몫이다', () => {
  for (const u of UNITS) {
    assert.match(u.serial.branchCode, /^[135]$/, `${u.id}: 군 코드가 이상하다`);
    assert.ok(u.serial.seqBase >= 0);
    assert.ok(u.jobs.length >= 4);
  }
  // 육군 1 · 해군/해병 3 · 공군 5 — 실제 군 코드다
  assert.equal(UNIT_BY_ID['marine-fort'].serial.branchCode, '3');
  assert.equal(UNIT_BY_ID['airforce-sys'].serial.branchCode, '5');
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

// ── 고증 — docs/research.md에 출처를 단 것들이 실제로 들어 있는가 ──
// 확인된 용어·상징만 싣는다. 근거를 못 찾아 뺀 것(「딸녀」·「딸수」)은 되살아나면 안 된다.
test('부대별 용어·문화가 실제로 프롬프트 재료에 들어 있다', () => {
  const marine = UNIT_BY_ID['marine-fort'], air = UNIT_BY_ID['airforce-sys'];
  for (const term of ['기수', '악기바리', '빨간명찰', '팔각모', '다나까']) {
    assert.ok(`${marine.culture}${marine.soldierRules}`.includes(term), `해병 용어 ${term} 누락`);
  }
  for (const term of ['짬찌', '찐빠']) assert.ok(air.culture.includes(term), `공군 용어 ${term} 누락`);
  assert.ok(air.soldierRules.includes('따돌림'), '공군의 취약점(따돌림형 부조리)이 빠졌다');
});

test('근거를 못 찾아 뺀 용어가 되살아나지 않았다', () => {
  const all = UNITS.map(u => `${u.culture}${u.rules}${u.soldierRules}`).join('\n');
  for (const dead of ['딸녀', '딸수']) {
    assert.ok(!all.includes(dead), `출처 없는 용어 「${dead}」가 되살아났다 — docs/research.md 참고`);
  }
});

test('팔각모의 뜻이 실제 상징 그대로 실렸다 — 오계·삼금·팔극', () => {
  const c = UNIT_BY_ID['marine-fort'].culture;
  for (const t of ['오계', '삼금', '팔계', '팔극']) assert.ok(c.includes(t), `팔각모 상징 ${t} 누락`);
});

test('기수열외는 「잔존 문화」가 아니라 금지된 악습이고 처벌이 붙어 있다', () => {
  const r = UNIT_BY_ID['marine-fort'].soldierRules;
  assert.ok(r.includes('기수열외'), '기수열외가 빠졌다');
  assert.ok(/금지/.test(r), '금지됐다는 사실이 빠졌다');
  assert.ok(r.includes('빨간명찰') && /전출/.test(r), '처벌(빨간명찰 박탈·전출)이 빠졌다');
});

test('휴대폰은 군별로 다르지 않다 — 전군 공통 「일과 후」이고 갈리는 것은 제한 사유다', () => {
  for (const u of UNITS) {
    assert.ok(/일과 후/.test(u.rules), `${u.id}: 일과 후 규정이 빠졌다`);
    assert.ok(u.rules.includes('21'), `${u.id}: 21시 반납이 빠졌다`);
  }
  // 해병은 경계·당직이 그 시간을 먹는다는 것이 실제 차이다
  assert.ok(/경계|당직/.test(UNIT_BY_ID['marine-fort'].rules), '해병의 실제 제한 사유가 빠졌다');
});

// ── 군가 ────────────────────────────────────────────────
test('부대마다 군가와 부르는 방식·자리가 있다', () => {
  for (const u of UNITS) {
    assert.ok(SONG_MODES.has(u.songMode), `${u.id}.songMode가 이상하다`);
    assert.ok(u.songs.length >= 1, `${u.id}에 군가가 없다`);
    assert.ok(u.songSlots.length >= 1, `${u.id}에 군가가 울리는 자리가 없다`);
    for (const s of u.songs) assert.ok(s.note.length > 5, `${u.id}.${s.title}에 출처가 없다`);
  }
});

test('군가 인용은 한 소절씩이다 — 전문을 싣지 않는다', () => {
  for (const u of UNITS) {
    for (const s of u.songs) {
      assert.ok(s.lines.length <= 3, `${u.id}.${s.title} 인용이 3소절을 넘는다`);
      for (const l of s.lines) assert.ok(l.length <= 40, `${u.id}.${s.title} 소절이 너무 길다: ${l}`);
    }
  }
});

test('부르는 방식이 군마다 실제와 맞다 — 해병은 목으로, 공군은 방송으로', () => {
  assert.equal(UNIT_BY_ID['marine-fort'].songMode, 'chorus');
  assert.equal(UNIT_BY_ID['airforce-sys'].songMode, 'broadcast');
  assert.ok(UNIT_BY_ID['airforce-sys'].culture.includes('기지방송'), '공군의 군가 방송 관행이 빠졌다');
});

test('songLines가 곡 제목을 달아 한 줄씩 펴 준다 — 풀과 화면이 이걸 쓴다', () => {
  const lines = songLines(UNIT_BY_ID['marine-fort']);
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.ok(l.title && l.text, '곡 제목이나 소절이 비었다');
  }
  assert.ok(lines.some(l => l.title === '팔각모 사나이'));
});

test('군가가 울리는 슬롯은 실존 슬롯이다', async () => {
  const { SLOT_KEYS } = await import('../js/params.js');
  for (const u of UNITS) {
    for (const k of u.songSlots) assert.ok(SLOT_KEYS.includes(k), `${u.id}가 없는 슬롯 「${k}」에서 노래한다`);
  }
});

// ── 저가 모델 배정 — 업자마다 하나씩 있어야 한다 ────────
// 빠진 업자는 판정(E-3·N·I-2)까지 기본 모델 정가로 낸다. OpenRouter가 그랬다.
test('llm.js가 아는 업자 전부에 저가 모델이 배정돼 있다', async () => {
  const [{ PROVIDERS, priceOf, defaultModelOf }, game] = await Promise.all([
    import('../js/llm.js'),
    readFile(new URL('../js/game.js', import.meta.url), 'utf8'),
  ]);
  const block = game.match(/const CHEAP_MODEL = \{([\s\S]*?)\};/);
  assert.ok(block, 'game.js에서 저가 모델 표를 못 찾았다');
  for (const id of Object.keys(PROVIDERS)) {
    assert.ok(new RegExp(`\\b${id}\\s*:`).test(block[1]), `업자 「${id}」에 저가 모델이 없다 — 판정까지 정가로 낸다`);
  }
  // 그리고 그 모델들이 실제로 기본 모델보다 싸야 한다
  for (const m of block[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
    const [, provider, cheap] = m;
    const cheapPrice = priceOf(cheap), basePrice = priceOf(defaultModelOf(provider));
    assert.ok(cheapPrice, `저가 모델 ${cheap}의 단가를 가격표가 모른다`);
    assert.ok(cheapPrice[0] < basePrice[0],
      `${provider}의 저가 모델 ${cheap}($${cheapPrice[0]})이 기본 모델($${basePrice[0]})보다 안 싸다`);
  }
});

// ── ⑥ 전우애 — 빡센 부대일수록 높다 ─────────────────────
test('전우애는 수치+서술 한 쌍이고 0~10이다', () => {
  for (const u of UNITS) {
    assert.ok(u.comrade.score >= 0 && u.comrade.score <= 10, `${u.id}: 전우애가 눈금 밖이다`);
    assert.ok(u.comrade.desc.length > 5, `${u.id}: 전우애 서술이 없다`);
  }
});

test('빡센 부대일수록 전우애가 높다 — 일과 난이도와 같이 간다', () => {
  const byHard = UNITS.slice().sort((a, b) => a.difficulty - b.difficulty);
  for (let i = 1; i < byHard.length; i++) {
    assert.ok(byHard[i].comrade.score >= byHard[i - 1].comrade.score,
      `${byHard[i].id}가 더 빡센데 전우애가 낮다 — 규칙이 뒤집혔다`);
  }
  // 두 부대의 실제 값
  assert.equal(UNIT_BY_ID['marine-fort'].comrade.score, 10);
  assert.equal(UNIT_BY_ID['airforce-sys'].comrade.score, 2);
});

test('④⑤⑥의 수치는 프롬프트에 안 나간다 — 서술만 간다', async () => {
  const P = await import('../js/prompts.js');
  // 부대 프롬프트에는 복무기간·연도 같은 정당한 숫자가 있다(문화·규정 원문).
  // 그러니 「숫자가 없다」로는 못 잰다. **수치만 바꿔도 프롬프트가 바이트 동일한가**로 잰다 —
  // 그게 「수치는 코드로, 서술은 프롬프트로」를 직접 증명하는 방법이다.
  for (const u of UNITS) {
    const base = P.unitPrompt(u);
    assert.ok(base.includes(u.comrade.desc), `${u.id}: 전우애 서술이 프롬프트에 없다`);
    for (const f of ['intel', 'macho', 'comrade']) {
      const bumped = P.unitPrompt({ ...u, [f]: { ...u[f], score: u[f].score === 10 ? 0 : 10 } });
      assert.equal(bumped, base, `${u.id}: ${f} 수치가 프롬프트에 샌다`);
    }
  }
});
