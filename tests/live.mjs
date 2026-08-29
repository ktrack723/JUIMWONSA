// live.mjs — 실제 API로 확전 판정의 분포를 재는 밸런싱 하네스 (§9.6).
//
//   ANTHROPIC_API_KEY=sk-... node tests/live.mjs [옵션]
//   (OPENAI_API_KEY / OPENROUTER_API_KEY 도 받는다 — 업자는 키 접두사로 갈린다)
//     --units=marine-fort         돌릴 부대 id (기본: 둘 다)
//     --trials=4                  사건당 반복 수
//     --model=...                 업자별 하위 등급만 허용 (기본값 → tests/test-model.mjs)
//     --out=/tmp/live.json
//
// 질문은 하나다: **같은 사건에 「모범 지침 / 개입 없음」 두 갈래를 돌리면 확전율이 갈리는가.**
// 무대응 확전율이 지침 확전율과 같다면 심판이 판정을 하는 게 아니라 도장을 찍고 있는 것이다.
//
// 흐름은 엔진과 같은 세 콜이다 — E-1 장면 → E-2 결과 → E-3 확전 판정.
// 연루 병사는 고정 표본을 쓴다 (여기서 재는 것은 병사 생성이 아니라 심판이다).

import { LlmClient } from '../js/llm.js';
import * as P from '../js/prompts.js';
import { UNITS, UNIT_BY_ID } from '../js/units.js';
import { EVENT_POOL, PLACES } from '../js/params.js';
import { resolveTestModel, requireTestKey } from './test-model.mjs';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));

const KEY = requireTestKey();
const MODEL = resolveTestModel(args.model, process.argv, KEY);
const TRIALS = Number(args.trials || 4);
const UNIT_IDS = (args.units ? args.units.split(',') : UNITS.map(u => u.id))
  .filter(id => { if (!UNIT_BY_ID[id]) { console.error('알 수 없는 부대 id:', id); return false; } return true; });
const OUT = args.out || '/tmp/claude-0/live-results.json';

// 고정 표본 병사 — 심판을 재는 하네스라 병사는 손으로 쓴다.
const SAMPLE_SOLDIERS = [
  { name: '박이병', serial: 'LV26-0000001', job: '경계병', grade: '폐급', character: '하', joined: '2026-03-01', sheet: '자대 온 지 석 달. 시키는 것만 하고 그마저 자주 틀린다. 혼나면 사흘쯤 말이 없다.' },
  { name: '김상병', serial: 'LV25-0000002', job: '조리병', grade: 'B', character: '중', joined: '2025-06-01', sheet: '짬은 찼는데 요령만 늘었다. 후임한테 세다는 말을 듣지만 본인은 챙겨준다고 생각한다.' },
];

// 재는 사건 셋 — 경미 둘, 중대 하나.
const CASES = [
  { id: 'quarrel', directive: '둘 다 즉시 분리해라. 선임은 행정반 대기, 후임은 의무대 먼저. 오늘 안에 각자 따로 면담한다고 전해라.' },
  { id: 'work-accident', directive: '작업 전원 중지. 안전장구 착용 확인 전까지 재개 금지. 다친 놈 있으면 의무대부터.' },
  { id: 'desertion-sign', directive: '즉시 인원 파악하고 위병소·해안선부터 수색조 돌려라. 지휘통제실 보고는 내가 한다. 관물대는 손대지 말 것.' },
];

const llm = new LlmClient();
llm.apiKey = KEY;
llm.model = MODEL;

async function runOne(unit, kase, directive) {
  const event = EVENT_POOL.find(e => e.id === kase.id);
  const involved = SAMPLE_SOLDIERS.slice(0, event.involved);
  const place = PLACES[event.place].label;
  const sys = P.daySystem(unit);
  const thread = [{
    role: 'user',
    content: P.incidentUser({ slotLabel: '오전일과', place, tier: event.tier, event: event.desc, involved, notices: [] }),
  }];
  const scene = await llm.call({ label: `live E-1 ${kase.id}`, system: sys, messages: thread, cache: true, effort: 'low', maxTokens: 2000 });
  thread.push({ role: 'assistant', content: scene });
  thread.push({ role: 'user', content: P.outcomeUser({ directive, standing: 'mostly-followed' }) });
  const outcome = await llm.call({ label: `live E-2 ${kase.id}`, system: sys, messages: thread, cache: true, effort: 'low', maxTokens: 2000 });
  const verdict = await llm.call({
    label: `live E-3 ${kase.id}`, system: P.JUDGE_SYSTEM,
    messages: [{ role: 'user', content: P.judgeUser({ scene: outcome, tier: event.tier }) }],
    schema: P.ESCALATION_SCHEMA, cache: true, effort: 'low', maxTokens: 1500,
  });
  return { verdict, outcome };
}

const results = [];
for (const uid of UNIT_IDS) {
  const unit = UNIT_BY_ID[uid];
  for (const kase of CASES) {
    for (const arm of ['directive', 'none']) {
      for (let t = 0; t < TRIALS; t++) {
        try {
          const { verdict } = await runOne(unit, kase, arm === 'directive' ? kase.directive : null);
          results.push({ unit: uid, case: kase.id, arm, ...verdict });
          process.stdout.write(`${uid} ${kase.id} ${arm} #${t + 1}: ${verdict.outcome} (${verdict.gara}/${verdict.happy}/${verdict.conflict})\n`);
        } catch (e) {
          process.stdout.write(`${uid} ${kase.id} ${arm} #${t + 1}: ERR ${e.message}\n`);
          results.push({ unit: uid, case: kase.id, arm, error: e.message });
        }
      }
    }
  }
}

// ── 집계 — 두 갈래의 확전율이 갈리는가 ───────────────────
const ok = results.filter(r => !r.error);
const rate = arm => {
  const rows = ok.filter(r => r.arm === arm);
  return rows.length ? rows.filter(r => r.outcome === 'escalated').length / rows.length : NaN;
};
const dirRate = rate('directive'), noneRate = rate('none');
const sameRate = ['gara', 'happy', 'conflict'].map(k =>
  `${k} same ${(ok.filter(r => r[k] === 'same').length / Math.max(1, ok.length) * 100).toFixed(0)}%`).join(' · ');

console.log('\n── 집계 ──');
console.log(`지침 갈래 확전율   : ${(dirRate * 100).toFixed(0)}% (${ok.filter(r => r.arm === 'directive').length}판)`);
console.log(`무대응 갈래 확전율 : ${(noneRate * 100).toFixed(0)}% (${ok.filter(r => r.arm === 'none').length}판)`);
console.log(`방향 분포          : ${sameRate}`);
console.log(`비용                : $${llm.usage.cost.toFixed(3)} · ${llm.usage.calls}콜`);
if (!(noneRate > dirRate)) {
  console.log('\n⚠ 무대응이 지침보다 확전하지 않는다 — 심판이 판정이 아니라 도장을 찍고 있다. 프롬프트를 손봐라.');
}

fs.mkdirSync(OUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, results }, null, 1));
console.log(`\n원장: ${OUT}`);
