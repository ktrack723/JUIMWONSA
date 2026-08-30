// node --test tests/llm.test.mjs — 업자 판별과 방언 변환 계약 테스트.
//
// 이 파일이 지키는 것 하나: **요원은 업자를 고르지 않는다.**
// 키 문자열 하나가 종점·헤더·요청 형태·가격표를 전부 결정한다.
// 여기가 깨지면 OpenAI 키로 Anthropic 종점을 두드리거나(404), Claude 모델 id를
// GPT로 보내는(404) 사고가 조용히 배포된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmClient, detectProvider, providerOf, defaultModelOf, modelFitsProvider,
  supportsEffort, supportsCacheControl, priceOf, normalizeUsage, readResponse,
  parseJson, unsupportedParam, PROVIDERS,
} from '../js/llm.js';

// 실제 fetch 대신 요청을 가로채 돌려주는 가짜. 마지막 요청을 통째로 남긴다.
function stubFetch(respond) {
  const sent = [];
  globalThis.fetch = async (url, opt) => {
    sent.push({ url, headers: opt.headers, body: JSON.parse(opt.body) });
    const r = respond(sent.length);
    return { ok: r.ok !== false, status: r.status || 200, statusText: '', json: async () => r.data };
  };
  return sent;
}
const okAnthropic = { data: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '이상무' }], usage: { input_tokens: 10, output_tokens: 3 } } };
const okOpenai = { data: { model: 'gpt-5', choices: [{ finish_reason: 'stop', message: { content: '이상무' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } } };

const orig = globalThis.fetch;
test.after(() => { globalThis.fetch = orig; });

// ── 판별 ────────────────────────────────────────────────
test('키 접두사만으로 업자가 갈린다', () => {
  assert.equal(detectProvider('sk-ant-api03-abc'), 'anthropic');
  assert.equal(detectProvider('sk-or-v1-abc'), 'openrouter');
  assert.equal(detectProvider('sk-proj-abc'), 'openai');
  assert.equal(detectProvider('sk-svcacct-abc'), 'openai');
  assert.equal(detectProvider('sk-abcdef'), 'openai');
  assert.equal(detectProvider('  sk-ant-api03-abc  '), 'anthropic', '앞뒤 공백은 무시한다');
});

test('키가 아닌 문자열은 판별되지 않는다', () => {
  for (const junk of ['', null, undefined, '내 키', 'AIzaSyD-fake', 'sk', 'sk-']) {
    assert.equal(detectProvider(junk), null, `${junk}가 키로 통과했다`);
  }
});

test('sk-or- 는 sk- 보다 먼저 걸린다 (순서가 규칙이다)', () => {
  assert.equal(detectProvider('sk-or-v1-abc'), 'openrouter');
  assert.notEqual(detectProvider('sk-or-v1-abc'), 'openai');
});

test('업자마다 종점과 방언이 다르다', () => {
  assert.equal(providerOf('anthropic').url, 'https://api.anthropic.com/v1/messages');
  assert.equal(providerOf('openai').url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(providerOf('openrouter').url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(providerOf('anthropic').dialect, 'anthropic');
  assert.equal(providerOf('openai').dialect, 'openai');
  assert.equal(providerOf('openrouter').dialect, 'openai');
});

test('모든 업자가 모형 목록과 기본 모형을 들고 있다', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, id, `${id} 명세의 id가 어긋난다`);
    assert.ok(p.models.length >= 3, `${id} 모형 목록이 비었다`);
    assert.equal(defaultModelOf(id), p.models[0][0]);
    assert.ok(modelFitsProvider(defaultModelOf(id), id), `${id} 기본 모형이 자기 업자 형식이 아니다`);
  }
});

// ── 키를 바꿔 끼우면 업자와 모형이 따라온다 ───────────────
test('키를 넣으면 업자가 정해지고, 안 맞는 모형은 그 업자 기본값으로 갈린다', () => {
  const llm = new LlmClient();
  assert.equal(llm.provider, 'anthropic');
  assert.equal(llm.model, 'claude-opus-5');

  llm.apiKey = 'sk-proj-abc';
  assert.equal(llm.provider, 'openai');
  assert.equal(llm.model, 'gpt-5', 'claude-opus-5를 든 채로 OpenAI에 가면 404다');

  llm.apiKey = 'sk-or-v1-abc';
  assert.equal(llm.provider, 'openrouter');
  assert.ok(llm.model.includes('/'), 'OpenRouter는 vendor/model 형식이어야 한다');

  llm.apiKey = 'sk-ant-api03-abc';
  assert.equal(llm.provider, 'anthropic');
  assert.equal(llm.model, 'claude-opus-5');
});

test('내가 고른 모형이 그 업자 것이면 건드리지 않는다', () => {
  const llm = new LlmClient();
  llm.apiKey = 'sk-ant-api03-abc';
  llm.model = 'claude-haiku-4-5-20251001';
  llm.apiKey = 'sk-ant-api03-other';
  assert.equal(llm.model, 'claude-haiku-4-5-20251001');
});

test('판별 안 되는 문자열은 업자를 바꾸지 않는다', () => {
  const llm = new LlmClient();
  llm.apiKey = 'sk-proj-abc';
  llm.apiKey = '아무말';
  assert.equal(llm.provider, 'openai', '판별 실패가 업자를 뒤엎으면 안 된다');
  assert.equal(llm.apiKey, '아무말');
});

// ── 방언 ────────────────────────────────────────────────
test('Anthropic 키면 Anthropic 종점·헤더·형태로 나간다', async () => {
  const sent = stubFetch(() => okAnthropic);
  const llm = new LlmClient();
  llm.apiKey = 'sk-ant-api03-abc';
  await llm.call({ label: 't', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  const [req] = sent;
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-ant-api03-abc');
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.body.max_tokens, 100);
  assert.deepEqual(req.body.system, [{ type: 'text', text: 'SYS' }], 'system은 별도 필드다');
  assert.equal(req.body.output_config.effort, 'low');
});

test('OpenAI 키면 Bearer + chat/completions 형태로 나간다', async () => {
  const sent = stubFetch(() => okOpenai);
  const llm = new LlmClient();
  llm.apiKey = 'sk-proj-abc';
  await llm.call({ label: 't', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  const [req] = sent;
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-proj-abc');
  assert.equal(req.headers['x-api-key'], undefined);
  assert.equal(req.body.system, undefined, 'system은 필드가 아니라 첫 메시지다');
  assert.deepEqual(req.body.messages[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(req.body.messages[1], { role: 'user', content: 'hi' });
  assert.equal(req.body.max_completion_tokens, 100, '추론 모델은 max_tokens를 거부한다');
  assert.equal(req.body.max_tokens, undefined);
  assert.equal(req.body.reasoning_effort, 'low');
});

test('OpenRouter는 max_tokens와 reasoning.effort, 그리고 실비 보고를 쓴다', async () => {
  const sent = stubFetch(() => okOpenai);
  const llm = new LlmClient();
  llm.apiKey = 'sk-or-v1-abc';
  llm.model = 'openai/gpt-5';
  await llm.call({ label: 't', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, effort: 'medium' });

  const [req] = sent;
  assert.equal(req.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-or-v1-abc');
  assert.equal(req.body.max_tokens, 100);
  assert.equal(req.body.max_completion_tokens, undefined);
  assert.deepEqual(req.body.reasoning, { effort: 'medium' });
  assert.deepEqual(req.body.usage, { include: true }, '실제 청구액을 실어 달라고 해야 한다');
});

test('구조화 출력은 업자별 자리에 들어간다', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string', maxLength: 3 } }, required: ['a'], additionalProperties: false };
  const jsonBody = t => ({ data: { model: 'm', choices: [{ finish_reason: 'stop', message: { content: t } }], usage: {} } });

  let sent = stubFetch(() => ({ data: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":"x"}' }], usage: {} } }));
  const a = new LlmClient(); a.apiKey = 'sk-ant-api03-abc';
  assert.deepEqual(await a.call({ label: 't', messages: [], schema }), { a: 'x' });
  assert.equal(sent[0].body.output_config.format.type, 'json_schema');
  assert.equal(sent[0].body.output_config.format.schema.properties.a.maxLength, undefined, '지원 안 되는 키워드는 걷어낸다');

  sent = stubFetch(() => jsonBody('{"a":"x"}'));
  const o = new LlmClient(); o.apiKey = 'sk-proj-abc';
  assert.deepEqual(await o.call({ label: 't', messages: [], schema }), { a: 'x' });
  assert.equal(sent[0].body.response_format.type, 'json_schema');
  assert.equal(sent[0].body.response_format.json_schema.strict, true);
  assert.equal(sent[0].body.response_format.json_schema.schema.properties.a.maxLength, undefined);
});

// ── 캐시 breakpoint ─────────────────────────────────────
test('캐시 breakpoint는 찍어도 되는 조합에만 찍는다', () => {
  assert.equal(supportsCacheControl('claude-opus-5', 'anthropic'), true);
  assert.equal(supportsCacheControl('gpt-5', 'openai'), false, 'OpenAI에 cache_control을 보내면 400이다');
  assert.equal(supportsCacheControl('anthropic/claude-opus-4.5', 'openrouter'), true);
  assert.equal(supportsCacheControl('openai/gpt-5', 'openrouter'), false);
});

test('OpenAI로는 cache_control이 한 조각도 새 나가지 않는다', async () => {
  const sent = stubFetch(() => okOpenai);
  const llm = new LlmClient();
  llm.apiKey = 'sk-proj-abc';
  await llm.call({ label: 't', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], cache: true });
  assert.equal(JSON.stringify(sent[0].body).includes('cache_control'), false);
});

test('OpenRouter+Claude면 시스템과 마지막 사용자 메시지에 breakpoint가 붙는다', async () => {
  const sent = stubFetch(() => okOpenai);
  const llm = new LlmClient();
  llm.apiKey = 'sk-or-v1-abc';
  llm.model = 'anthropic/claude-opus-4.5';
  await llm.call({
    label: 't', system: 'SYS', cache: true,
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
  });
  const m = sent[0].body.messages;
  assert.equal(m[0].content[0].cache_control.type, 'ephemeral', '시스템 프롬프트에 breakpoint가 없다');
  assert.equal(m[3].content[0].text, 'c');
  assert.equal(m[3].content[0].cache_control.type, 'ephemeral', '마지막 사용자 메시지에 breakpoint가 없다');
  assert.equal(m[1].content, 'a', '앞선 메시지에는 안 붙는다');
});

// ── effort ──────────────────────────────────────────────
test('effort는 받는 모델에만 보낸다', () => {
  assert.equal(supportsEffort('claude-opus-5', 'anthropic'), true);
  assert.equal(supportsEffort('claude-haiku-4-5-20251001', 'anthropic'), false);
  assert.equal(supportsEffort('gpt-5', 'openai'), true);
  assert.equal(supportsEffort('gpt-5-mini', 'openai'), true);
  assert.equal(supportsEffort('o4-mini', 'openai'), true);
  assert.equal(supportsEffort('gpt-4.1', 'openai'), false, 'gpt-4.1에 reasoning_effort를 보내면 400이다');
  assert.equal(supportsEffort('gpt-4o', 'openai'), false);
  assert.equal(supportsEffort('openai/gpt-5', 'openrouter'), true);
  assert.equal(supportsEffort('deepseek/deepseek-chat', 'openrouter'), false);
});

// ── 파라미터 협상 ────────────────────────────────────────
test('모델이 못 받는 파라미터를 짚어주면 빼고 다시 보낸다', async () => {
  const sent = stubFetch(n => n === 1
    ? { ok: false, status: 400, data: { error: { type: 'invalid_request_error', message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", param: 'reasoning_effort' } } }
    : okOpenai);
  const llm = new LlmClient();
  llm.apiKey = 'sk-proj-abc';
  llm.model = 'gpt-5';
  assert.equal(await llm.call({ label: 't', messages: [{ role: 'user', content: 'hi' }] }), '이상무');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.reasoning_effort, 'low');
  assert.equal(sent[1].body.reasoning_effort, undefined, '두 번째 요청에서 빠졌어야 한다');
});

test('구조화 출력을 못 받는 모델에는 스키마를 말로 준다', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  const sent = stubFetch(n => n === 1
    ? { ok: false, status: 400, data: { error: { message: 'response_format.type: json_schema is not supported by this model' } } }
    : { data: { model: 'm', choices: [{ finish_reason: 'stop', message: { content: '```json\n{"a":"x"}\n```' } }], usage: {} } });
  const llm = new LlmClient();
  llm.apiKey = 'sk-or-v1-abc';
  llm.model = 'some/model';
  assert.deepEqual(await llm.call({ label: 't', system: 'SYS', messages: [], schema }), { a: 'x' });
  assert.equal(sent[1].body.response_format, undefined);
  assert.match(sent[1].body.messages[0].content, /OUTPUT FORMAT/, '스키마를 프롬프트로 내려줘야 한다');
});

test('한 번 배운 미지원 파라미터는 다음 호출에서 처음부터 뺀다', async () => {
  const sent = stubFetch(n => n === 1
    ? { ok: false, status: 400, data: { error: { message: "Unrecognized request argument supplied: max_completion_tokens" } } }
    : okOpenai);
  const llm = new LlmClient();
  llm.apiKey = 'sk-proj-abc';
  await llm.call({ label: 't', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  await llm.call({ label: 't2', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].body.max_tokens, 100, '세 번째 요청은 처음부터 max_tokens로 나가야 한다');
  assert.equal(sent[2].body.max_completion_tokens, undefined);
});

test('업자를 갈아 끼우면 배운 것도 지운다', async () => {
  const sent = stubFetch(n => n === 1
    ? { ok: false, status: 400, data: { error: { message: "Unsupported parameter: 'reasoning_effort'" } } }
    : okOpenai);
  const llm = new LlmClient();
  llm.apiKey = 'sk-proj-abc';
  await llm.call({ label: 't', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(llm.dropped.size, 1);
  llm.apiKey = 'sk-or-v1-abc';
  assert.equal(llm.dropped.size, 0, '다른 업자의 다른 모델에까지 물려줄 이유가 없다');
  assert.equal(sent.length, 2);
});

test('키가 틀리면 401도 403도 인증 실패로 끝난다 (재시도 없음)', async () => {
  for (const status of [401, 403]) {
    const sent = stubFetch(() => ({ ok: false, status, data: { error: { message: 'no' } } }));
    const llm = new LlmClient();
    llm.apiKey = 'sk-proj-abc';
    await assert.rejects(() => llm.call({ label: 't', messages: [] }), /인증 실패/);
    assert.equal(sent.length, 1, `${status}에 재시도가 붙었다`);
  }
});

test('OpenRouter가 200에 실어 보내는 상류 오류도 오류로 읽는다', async () => {
  const sent = stubFetch(() => ({ data: { error: { code: 401, message: 'No auth credentials found' } } }));
  const llm = new LlmClient();
  llm.apiKey = 'sk-or-v1-abc';
  await assert.rejects(() => llm.call({ label: 't', messages: [] }), /인증 실패/);
  assert.equal(sent.length, 1);
});

// ── 응답·사용량 ─────────────────────────────────────────
test('두 방언의 응답을 같은 모양으로 읽는다', () => {
  assert.deepEqual(
    readResponse({ content: [{ type: 'text', text: ' 답 ' }, { type: 'thinking', text: '안 보임' }], stop_reason: 'end_turn' }),
    { text: '답', stop: 'end_turn', refusal: undefined });
  assert.equal(readResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop, 'max_tokens',
    'finish_reason:length는 상한에 잘린 것이다');
  assert.equal(readResponse({ choices: [{ finish_reason: 'stop', message: { refusal: '못 하겠다' } }] }).stop, 'refusal');
});

test('사용량은 캐시분 이중 계상 없이 눕는다', () => {
  assert.deepEqual(
    normalizeUsage({ usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 900 } }),
    { input: 100, output: 20, cacheWrite: 5, cacheRead: 900, cost: null });
  // OpenAI의 prompt_tokens는 캐시분을 포함한다 — 빼지 않으면 입력이 부풀어 비용 보고가 거짓말이 된다
  assert.deepEqual(
    normalizeUsage({ usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } }),
    { input: 100, output: 20, cacheWrite: 0, cacheRead: 900, cost: null });
  assert.equal(normalizeUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.0042 } }).cost, 0.0042);
});

test('OpenRouter가 알려준 실비를 추정치보다 앞세운다', async () => {
  stubFetch(() => ({ data: { model: 'some/unknown-model', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.25 } } }));
  const llm = new LlmClient();
  llm.apiKey = 'sk-or-v1-abc';
  llm.model = 'some/unknown-model';
  await llm.call({ label: 't', messages: [] });
  assert.equal(llm.usage.cost, 0.25);
  assert.equal(llm.usage.inputTokens, 1000);
});

test('가격표는 접두사로 보고, vendor/ 접두어도 떼고 한 번 더 본다', () => {
  assert.deepEqual(priceOf('claude-haiku-4-5-20251001'), [1, 5]);
  assert.deepEqual(priceOf('gpt-5-2025-08-07'), [1.25, 10]);
  assert.deepEqual(priceOf('gpt-5-mini-2025-08-07'), [0.25, 2], '더 긴 접두사가 이긴다');
  assert.deepEqual(priceOf('anthropic/claude-opus-4.5'), [5, 25]);
  assert.deepEqual(priceOf('openai/gpt-5-mini'), [0.25, 2]);
  assert.equal(priceOf('mystery/model-9'), null);
});

test('모르는 모델이어도 비용을 지어내지 않는다', async () => {
  stubFetch(() => ({ data: { model: 'mystery/model-9', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } } }));
  const llm = new LlmClient();
  llm.apiKey = 'sk-or-v1-abc';
  llm.model = 'mystery/model-9';
  await llm.call({ label: 't', messages: [] });
  assert.equal(llm.usage.cost, 0, '단가를 모르면 0이지, 오퍼스 단가로 찍으면 안 된다');
  assert.equal(llm.usage.outputTokens, 500, '토큰은 그래도 센다');
});

// ── 파싱 ────────────────────────────────────────────────
test('코드펜스에 싸서 오거나 한마디 붙여 와도 JSON을 건진다', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('네, 여기 있습니다:\n{"a":1}\n이상입니다.'), { a: 1 });
  assert.equal(parseJson('그냥 문장'), null);
  assert.equal(parseJson(''), null);
  assert.equal(parseJson('"문자열"'), null, '객체가 아니면 판정 결과로 쓸 수 없다');
});

test('미지원 파라미터 판별이 엉뚱한 오류를 삼키지 않는다', () => {
  assert.equal(unsupportedParam("Unsupported parameter: 'reasoning_effort' is not supported"), 'effort');
  assert.equal(unsupportedParam('Unrecognized request argument supplied: max_completion_tokens'), 'max_completion_tokens');
  assert.equal(unsupportedParam('response_format is not supported by this model'), 'schema');
  assert.equal(unsupportedParam('cache_control: unknown field'), 'cache_control');
  assert.equal(unsupportedParam('rate_limit_error: too many requests'), null);
  assert.equal(unsupportedParam('max_tokens: 50000 > 32000, which is the maximum allowed'), null,
    '상한을 넘긴 건 미지원이 아니다 — 삼키면 상한 확대 재시도가 죽는다');
  assert.equal(unsupportedParam(''), null);
});

// ── 가격표 — 콘솔의 비용 표시가 거짓말을 하지 않게 ──────
// 이 표가 틀리면 게임이 죽지는 않는다. 다만 요원이 보는 「약 $0.03」이 조용히 틀린다.
// 요율은 Anthropic 공식 요율표 기준이다 (docs/research.md §13).
test('가격표가 현행 요율과 맞다', () => {
  const RATES = {
    'claude-fable-5': [10, 50],
    'claude-opus-5': [5, 25],
    'claude-opus-4-8': [5, 25],
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-4-6': [3, 15],
    'claude-haiku-4-5': [1, 5],
  };
  for (const [id, want] of Object.entries(RATES)) {
    assert.deepEqual(priceOf(id), want, `${id}의 단가가 요율과 다르다`);
  }
});

test('Sonnet 5는 Sonnet 4.6보다 싸다 — 접두사 순서에 물리면 조용히 뒤집힌다', () => {
  assert.ok(priceOf('claude-sonnet-5')[0] < priceOf('claude-sonnet-4-6')[0]);
});

test('날짜가 붙은 실제 id도 같은 단가로 읽힌다', () => {
  assert.deepEqual(priceOf('claude-haiku-4-5-20251001'), [1, 5]);
  assert.deepEqual(priceOf('claude-opus-5-20260101'), [5, 25]);
});

test('OpenRouter의 점 표기도 같은 표로 읽힌다 — 안 그러면 비용이 $0으로 찍힌다', () => {
  // Anthropic은 claude-haiku-4-5, OpenRouter는 anthropic/claude-haiku-4.5로 적는다
  assert.deepEqual(priceOf('anthropic/claude-haiku-4.5'), [1, 5]);
  assert.deepEqual(priceOf('anthropic/claude-opus-4.5'), [5, 25]);
  assert.deepEqual(priceOf('openai/gpt-5-mini'), [0.25, 2]);
});

test('모르는 모델은 null이다 — 아는 척하지 않는다', () => {
  assert.equal(priceOf('google/gemini-2.5-pro'), null);
  assert.equal(priceOf(''), null);
});
