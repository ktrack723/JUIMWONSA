// llm.js — LLM 채팅 API의 브라우저용 클라이언트 래퍼.
// 역할은 여기까지다: 요청 전송, 프롬프트 캐싱, 재시도/백오프, 구조화 출력 파싱, 거절 처리, 사용량 집계, 호출 로그.
// 에이전트를 턴마다 물려 돌리는 '하네스'는 engine.js다.
//
// 업자는 셋이다: Anthropic · OpenAI · OpenRouter.
// **고르는 화면은 없다.** 키를 붙여넣는 순간 접두사로 어디 키인지 판별하고, 그 업자의
// 종점·헤더·요청 형태·가격표가 통째로 따라 붙는다. 요원이 "업자 선택" 같은 걸 할 일이 없다.

// ── 업자 판별 ─────────────────────────────────────────────
// 순서가 규칙이다: 좁은 접두사 먼저, sk- 하나만 남은 건 마지막에 OpenAI로 떨어진다.
// (Anthropic sk-ant-… / OpenRouter sk-or-… / OpenAI sk-proj-…·sk-svcacct-…·sk-…)
const KEY_PATTERNS = [
  ['anthropic', /^sk-ant-/],
  ['openrouter', /^sk-or-/],
  ['openai', /^sk-[A-Za-z0-9_\-]/],
];

/** 키 문자열 하나로 업자를 정한다. 모르는 형식이면 null. */
export function detectProvider(key) {
  const k = String(key || '').trim();
  for (const [id, re] of KEY_PATTERNS) if (re.test(k)) return id;
  return null;
}

export const DEFAULT_PROVIDER = 'anthropic';
const API_VERSION = '2023-06-01';   // Anthropic Messages API 버전 헤더

// 업자별 명세. 모델 목록은 부팅 화면의 드롭다운이 그대로 읽는다(첫 항목이 기본값).
// OpenRouter는 목록이 수백 개라 대표 몇 개만 세우고, 나머지는 부팅 화면의 직접 입력으로 받는다.
export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    keyHint: 'sk-ant-api03-...',
    host: 'api.anthropic.com',
    url: 'https://api.anthropic.com/v1/messages',
    dialect: 'anthropic',
    freeModel: false,   // 목록에 없는 모델을 직접 적을 수 있는가
    models: [
      ['claude-opus-5', '본부 권장'],
      ['claude-sonnet-5', '표준'],
      ['claude-haiku-4-5', '예산 절감'],
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyHint: 'sk-proj-... / sk-...',
    host: 'api.openai.com',
    url: 'https://api.openai.com/v1/chat/completions',
    dialect: 'openai',
    freeModel: true,
    models: [
      ['gpt-5', '본부 권장'],
      ['gpt-5-mini', '표준'],
      ['gpt-5-nano', '예산 절감'],
      ['gpt-4.1', '구형'],
      ['gpt-4.1-mini', '구형 · 예산 절감'],
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyHint: 'sk-or-v1-...',
    host: 'openrouter.ai',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    dialect: 'openai',
    freeModel: true,
    models: [
      ['anthropic/claude-opus-4.5', '본부 권장'],
      ['anthropic/claude-sonnet-4.5', '표준'],
      ['openai/gpt-5', 'GPT'],
      ['openai/gpt-5-mini', 'GPT · 예산 절감'],
      ['google/gemini-2.5-pro', '기타'],
      ['deepseek/deepseek-chat', '기타 · 저가'],
    ],
  },
};

/** 업자 명세를 꺼낸다. 모르는 id면 기본 업자. */
export function providerOf(id) { return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER]; }

/** 그 업자의 기본 모델 = 목록 첫 항목. */
export function defaultModelOf(id) { return providerOf(id).models[0][0]; }

/** 그 모델 id가 이 업자 것으로 보이는가. 키를 바꿔 끼웠을 때 모델을 갈아줄지 판단한다. */
export function modelFitsProvider(model, providerId) {
  const m = String(model || '');
  if (!m) return false;
  if (providerId === 'openrouter') return m.includes('/');       // OpenRouter는 vendor/model 형식
  if (providerId === 'anthropic') return m.startsWith('claude-');
  if (providerId === 'openai') return !m.includes('/') && !m.startsWith('claude-');
  return false;
}

// effort(추론 강도)를 지원하지 않는 모델.
// **접두사로 본다** — 실제 id에는 날짜가 붙는다(claude-haiku-4-5-20251001).
// 정확 일치로 두면 그 날짜 붙은 id가 안 걸려서 전 호출이 invalid_request_error로 죽는다.
const NO_EFFORT_PREFIXES = ['claude-haiku-'];
// OpenAI 쪽은 반대로 '추론 모델만' 받는다. gpt-4o/4.1에 reasoning_effort를 보내면 400이다.
const OPENAI_EFFORT_RE = /(^|\/)(gpt-5|o[1345](-|$))/;

export const supportsEffort = (m, provider = 'anthropic') => {
  const s = String(m || '');
  if (provider === 'anthropic') return !NO_EFFORT_PREFIXES.some(p => s.startsWith(p));
  return OPENAI_EFFORT_RE.test(s);   // openai · openrouter 공통
};

// 프롬프트 캐시 breakpoint(cache_control)를 직접 찍어야 하는 조합.
// Anthropic은 언제나. OpenRouter는 Anthropic 모델을 태울 때만(그쪽이 그대로 전달한다).
// OpenAI는 접두사 캐시가 자동이라 우리가 찍을 게 없고, 찍으면 미지의 필드로 400이 난다.
export function supportsCacheControl(model, provider = 'anthropic') {
  if (provider === 'anthropic') return true;
  if (provider === 'openrouter') return /claude|anthropic/i.test(String(model || ''));
  return false;
}

// 모델 id → 단가. 정확 일치 먼저, 없으면 접두사가 가장 긴 항목을 쓴다.
// OpenRouter의 vendor/model은 vendor를 떼고 한 번 더 본다(anthropic/claude-opus-4.5 → claude-opus-4.5).
export function priceOf(model) {
  const m = String(model || '');
  if (!m) return null;
  const hit = lookupPrice(m);
  if (hit) return hit;
  const slash = m.indexOf('/');
  return slash >= 0 ? lookupPrice(m.slice(slash + 1)) : null;
}
function lookupPrice(m) {
  // 같은 모델을 업자마다 다르게 적는다: Anthropic은 claude-haiku-4-5, OpenRouter는
  // claude-haiku-4.5다. 점을 대시로 눕혀 한 표로 본다 — 안 그러면 OpenRouter 쪽 비용이
  // 통째로 null이 되어 콘솔이 $0을 찍는다.
  for (const cand of [m, m.replace(/\./g, '-')]) {
    if (PRICES[cand]) return PRICES[cand];
    const hit = Object.keys(PRICES).filter(k => cand.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (hit) return PRICES[hit];
  }
  return null;
}

const PRICES = { // $ per MTok (input, output)
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4': [5, 25],
  'claude-sonnet-5': [2, 10],    // Sonnet 5는 4.6($3/$15)보다 싸다 — 접두사가 겹치니 이 줄이 먼저다
  'claude-sonnet-4': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'gpt-5-nano': [0.05, 0.4],
  'gpt-5-mini': [0.25, 2],
  'gpt-5': [1.25, 10],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1': [2, 8],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
  'o4-mini': [1.1, 4.4],
  'o3-mini': [1.1, 4.4],
  'o3': [2, 8],
};
const CACHE_WRITE_MULT = 1.25;  // 캐시 기록은 입력 단가의 1.25배 (Anthropic)
const CACHE_READ_MULT = 0.1;    // 캐시 적중은 0.1배

// 구조화 출력(output_config.format.schema)이 받지 않는 JSON Schema 키워드.
// 하나라도 섞이면 400 invalid_request_error가 나면서 그 화면이 통째로 멈춘다
// (예: "For 'array' type, property 'maxItems' is not supported").
// OpenAI strict 모드도 같은 부분집합만 받으므로 업자와 무관하게 똑같이 걷어낸다.
// 스키마 쪽에서 안 쓰는 게 원칙이지만, 하나 흘러들었다고 게임이 서면 안 되니 보내기 직전에 걷어낸다.
// 개수·길이 상한 같은 건 프롬프트로 지시하고 실제 강제는 파싱 후 sanitize 단계가 한다.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'maxItems', 'minItems', 'uniqueItems', 'contains', 'maxContains', 'minContains',
  'maxLength', 'minLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'maxProperties', 'minProperties', 'patternProperties', 'propertyNames',
  'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
]);

// properties / $defs 아래의 키는 키워드가 아니라 '필드 이름'이다.
// 하필 이름이 format이나 pattern인 필드를 지우면 안 되니, 이 자리에서는 걸러내지 않는다.
const SCHEMA_NAME_MAPS = new Set(['properties', '$defs', 'definitions']);

// 스키마를 재귀로 훑어 지원되지 않는 키워드만 제거한 사본을 만든다. 원본은 건드리지 않는다.
export function stripUnsupportedSchemaKeys(node) {
  if (Array.isArray(node)) return node.map(n => stripUnsupportedSchemaKeys(n));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    if (SCHEMA_NAME_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = {};
      for (const [name, sub] of Object.entries(v)) inner[name] = stripUnsupportedSchemaKeys(sub);
      out[k] = inner;
      continue;
    }
    out[k] = stripUnsupportedSchemaKeys(v);
  }
  return out;
}

export class RefusalError extends Error {
  constructor(msg) { super(msg || 'LLM이 이 요청을 정중히 거절했다'); this.name = 'RefusalError'; }
}

export class LlmClient {
  constructor() {
    this._key = null;
    this.provider = DEFAULT_PROVIDER;
    this.model = defaultModelOf(DEFAULT_PROVIDER);
    this.log = [];
    this.usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, cost: 0, saved: 0 };
    this.listeners = new Set();
    this.maxLog = 80;
    // 이 업자·모델이 못 받는다고 확인된 파라미터. 한 번 400을 맞으면 빼고 다시 보낸다.
    this.dropped = new Set();
  }

  // 키를 넣는 순간 업자가 정해진다 — 이게 이 파일의 전부다.
  // 쓰던 모델이 새 업자 것이 아니면 그 업자의 기본 모델로 갈아 끼운다
  // (Anthropic 키로 놀다 OpenAI 키를 붙였는데 model이 claude-opus-5면 그냥 404다).
  set apiKey(key) {
    this._key = key || null;
    const p = detectProvider(key);
    if (!p) return;
    if (p !== this.provider) this.dropped.clear();
    this.provider = p;
    if (!modelFitsProvider(this.model, p)) this.model = defaultModelOf(p);
  }
  get apiKey() { return this._key; }

  onLog(fn) { this.listeners.add(fn); }
  #emit(entry) { for (const fn of this.listeners) { try { fn(entry, this.usage); } catch { /* UI 리스너 실패는 무시 */ } } }

  // system을 캐시 가능한 블록 배열로. 시스템 프롬프트는 턴마다 바이트 단위로 동일해야 캐시가 붙는다.
  #systemBlocks(system, cache) {
    if (!system) return undefined;
    const block = { type: 'text', text: system };
    if (cache) block.cache_control = { type: 'ephemeral' };
    return [block];
  }

  // 마지막 사용자 메시지를 블록 형태로 바꿔 캐시 breakpoint를 단다. 원본은 건드리지 않는다.
  #cacheTail(messages) {
    if (!messages?.length) return messages;
    const out = messages.slice();
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      out[i] = { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
      break;
    }
    return out;
  }

  // ── 요청 조립 ───────────────────────────────────────────
  // 업자마다 방언이 다르다. 여기서 갈리고, 그 아래는 전부 공통이다.
  #buildBody({ system, messages, schema, effort, maxTokens, cache, useModel }) {
    const drop = k => !this.dropped.has(k);
    return providerOf(this.provider).dialect === 'anthropic'
      ? this.#anthropicBody({ system, messages, schema, effort, maxTokens, cache, useModel, drop })
      : this.#openaiBody({ system, messages, schema, effort, maxTokens, cache, useModel, drop });
  }

  #anthropicBody({ system, messages, schema, effort, maxTokens, cache, useModel, drop }) {
    const body = {
      model: useModel,
      max_tokens: maxTokens,
      messages: cache ? this.#cacheTail(messages) : messages,
    };
    const sys = this.#systemBlocks(system, cache);
    if (sys) body.system = sys;

    const outputConfig = {};
    if (supportsEffort(useModel, 'anthropic') && drop('effort')) outputConfig.effort = effort;
    if (schema && drop('schema')) outputConfig.format = { type: 'json_schema', schema: stripUnsupportedSchemaKeys(schema) };
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    return body;
  }

  // OpenAI Chat Completions 방언. OpenRouter도 같은 형식이라 한 함수가 둘을 다 만든다.
  //   · system은 별도 필드가 아니라 messages 맨 앞의 한 줄이다
  //   · 상한 필드 이름이 다르다 (추론 모델은 max_tokens를 거부한다)
  //   · 구조화 출력은 response_format.json_schema, strict:true
  //   · 캐시 breakpoint는 Anthropic 모델을 태울 때만 (OpenRouter가 그대로 전달한다)
  #openaiBody({ system, messages, schema, effort, maxTokens, cache, useModel, drop }) {
    const openrouter = this.provider === 'openrouter';
    const wantCache = cache && supportsCacheControl(useModel, this.provider) && drop('cache_control');
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: wantCache ? cacheText(system) : system });
    for (const m of messages || []) msgs.push({ role: m.role, content: flatContent(m.content) });
    if (wantCache) markLastUser(msgs);

    const body = { model: useModel, messages: msgs };
    // 상한 필드 이름: OpenAI 추론 모델은 max_tokens를 거부하고, 구형·중계 종점은 반대로
    // max_completion_tokens를 모른다. 기본값은 업자별로 두고, 400을 맞으면 반대쪽으로 넘어간다.
    const completionField = this.dropped.has('max_tokens')
      || (!openrouter && !this.dropped.has('max_completion_tokens'));
    body[completionField ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;

    if (supportsEffort(useModel, this.provider) && drop('effort')) {
      if (openrouter) body.reasoning = { effort };
      else body.reasoning_effort = effort;
    }
    if (schema && drop('schema')) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'cupid_response', strict: true, schema: stripUnsupportedSchemaKeys(schema) },
      };
    }
    // 실제 청구액을 응답에 실어 준다. 우리 가격표가 모르는 모델이라도 비용이 맞는다.
    if (openrouter) body.usage = { include: true };
    return body;
  }

  #headers() {
    if (providerOf(this.provider).dialect === 'anthropic') {
      return {
        'content-type': 'application/json',
        'x-api-key': this._key,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      };
    }
    const h = { 'content-type': 'application/json', authorization: `Bearer ${this._key}` };
    if (this.provider === 'openrouter') {
      // OpenRouter 순위표에 뜨는 출처 표기. 없어도 호출은 된다.
      h['HTTP-Referer'] = typeof location !== 'undefined' ? location.origin : 'https://github.com/ktrack723/BRS';
      h['X-Title'] = 'Musago 100 Days: CSM Simulator';
    }
    return h;
  }

  // 핵심 진입점. schema를 주면 구조화 JSON, 없으면 텍스트를 반환한다.
  //   cache=true  → system 블록 + **마지막 사용자 메시지**에 캐시 breakpoint를 건다.
  //     대화 에이전트는 턴마다 같은 히스토리 접두사를 다시 보낸다 — 메시지에 breakpoint를
  //     안 걸면 그 접두사가 매 턴 비캐시 입력으로 재과금된다(실측: 판당 비캐시 190k tok).
  //     breakpoint는 굴러가며 따라온다: 이번 턴의 마지막 메시지가 다음 턴의 접두사다.
  //   model       → 이 호출만 다른 모델로 (심판처럼 기계적인 판정을 싸게 돌릴 때)
  async call({ label, system, messages, schema = null, effort = 'low', maxTokens = 4000, cache = false, model = null }) {
    if (!this._key) throw new Error('API 키 없음: 하네스 미가동');
    const prov = providerOf(this.provider);
    const useModel = model || this.model;
    const args = { system, messages, schema, effort, maxTokens, cache, useModel };
    let body = this.#buildBody(args);

    const entry = { label, model: useModel, provider: prov.id, at: Date.now(), request: body, status: 'pending' };
    this.log.push(entry);
    while (this.log.length > this.maxLog) this.log.shift();
    this.#emit(entry);

    const started = now();
    let lastErr = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 400);
      let res;
      try {
        res = await fetch(prov.url, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body) });
      } catch (e) {
        lastErr = new Error(`통신 두절: ${e.message}`);
        continue; // 네트워크 오류는 재시도
      }
      let data = null;
      try { data = await res.json(); } catch { /* 게이트웨이가 비JSON을 뱉는 경우 — 상태코드로 판단 */ }

      // OpenRouter는 상류 오류를 200에 error로 실어 보내기도 한다.
      const errObj = data?.error;
      const errStatus = !res.ok ? res.status : (errObj ? (errObj.code || errObj.status || 400) : 0);
      if (errStatus) {
        const type = errObj?.type || `http_${errStatus}`;
        const msg = errObj?.message || res.statusText || '본문 없음';
        if (errStatus === 429 || errStatus >= 500) { lastErr = new Error(`${type}: ${msg}`); continue; }

        // 이 모델이 못 받는 파라미터를 짚어준 경우 — 그것만 빼고 다시 만들어 보낸다.
        // OpenRouter에는 우리가 모르는 모델이 수백 개다. 목록을 들고 있는 대신 한 번 맞고 배운다.
        const bad = unsupportedParam(`${msg} ${errObj?.param || ''} ${errObj?.code || ''}`);
        if (bad && !this.dropped.has(bad)) {
          this.dropped.add(bad);
          if (bad === 'schema' && schema) args.system = withSchemaInstruction(system, schema);
          body = this.#buildBody(args);
          entry.request = body;
          entry.note = `${bad} 미지원 — 빼고 재시도`;
          this.#emit(entry);
          attempt--;   // 파라미터 협상은 재시도 횟수를 깎지 않는다
          continue;
        }
        entry.status = 'error'; entry.error = `${type}: ${msg}`; entry.ms = now() - started;
        this.#emit(entry);
        if (errStatus === 401 || errStatus === 403) throw new Error(`API 키가 틀렸다. 국방망 인증 실패! (${prov.label})`);
        throw new Error(`${type}: ${msg}`);
      }
      if (!data) { lastErr = new Error('응답 본문 파싱 불가'); continue; }

      // 사용량은 재시도되는 호출까지 전부 집계한다 (실제 과금 기준)
      entry.ms = now() - started;
      entry.response = data;
      this.#account(data, useModel);

      const out = readResponse(data);
      // max_tokens에 잘리면 상한을 키워 재시도
      if (out.stop === 'max_tokens' && args.maxTokens < 32000) {
        args.maxTokens = Math.min(args.maxTokens * 3, 32000);
        body = this.#buildBody(args);
        entry.request = body;
        lastErr = new Error('출력이 잘림 (max_tokens)');
        continue;
      }
      if (out.stop === 'refusal') {
        entry.status = 'refusal'; this.#emit(entry);
        throw new RefusalError(out.refusal);
      }

      if (schema) {
        const parsed = parseJson(out.text);
        if (parsed) { entry.status = 'ok'; this.#emit(entry); return parsed; }
        lastErr = new Error('JSON 파싱 실패'); continue;
      }
      if (!out.text) { lastErr = new Error('빈 응답'); continue; }
      entry.status = 'ok'; this.#emit(entry);
      return out.text;
    }
    entry.status = 'error'; entry.error = lastErr?.message || '원인불명'; entry.ms = now() - started;
    this.#emit(entry);
    throw lastErr || new Error('LLM 호출 실패');
  }

  #account(data, useModel) {
    const u = normalizeUsage(data);
    // 가격표도 접두사로 본다 — 실제 id에는 날짜가 붙는다(claude-haiku-4-5-20251001).
    // 정확 일치로 두면 하이쿠 판이 오퍼스 단가로 계산돼서 비용 보고가 통째로 거짓말이 된다
    // (실측: 하이쿠 12판이 $10.33으로 찍혔다. 실제 단가면 그 1/5쯤이다).
    const p = priceOf(data.model) || priceOf(useModel) || (this.provider === 'anthropic' ? [5, 25] : null);

    this.usage.calls += 1;
    this.usage.inputTokens += u.input;
    this.usage.outputTokens += u.output;
    this.usage.cacheWrite += u.cacheWrite;
    this.usage.cacheRead += u.cacheRead;
    // OpenRouter는 실제 청구액을 실어 준다 — 추정치보다 그게 맞다.
    if (u.cost != null) {
      this.usage.cost += u.cost;
    } else if (p) {
      this.usage.cost += (u.input * p[0] + u.output * p[1]
        + u.cacheWrite * p[0] * CACHE_WRITE_MULT + u.cacheRead * p[0] * CACHE_READ_MULT) / 1e6;
    }
    // 캐시가 없었다면 정가로 냈을 금액과의 차액 (콘솔에 절감액으로 표시)
    if (p) this.usage.saved += (u.cacheRead * p[0] * (1 - CACHE_READ_MULT) - u.cacheWrite * p[0] * (CACHE_WRITE_MULT - 1)) / 1e6;
  }

  // 부팅 시 키 검증용 초소형 호출
  async ping() {
    return this.call({
      label: '국방망 인증',
      system: 'Answer in one word.',
      messages: [{ role: 'user', content: 'Comms check. Reply with 이상무 and nothing else.' }],
      maxTokens: 1000, effort: 'low',
    });
  }
}

// ── 응답 읽기 ─────────────────────────────────────────────
// 두 방언을 { text, stop, refusal } 하나로 눕힌다.
export function readResponse(data) {
  if (Array.isArray(data?.content)) {   // Anthropic
    return {
      text: data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim(),
      stop: data.stop_reason,
      refusal: data.stop_details?.explanation,
    };
  }
  const ch = data?.choices?.[0];        // OpenAI · OpenRouter
  const msg = ch?.message || {};
  const text = String(msg.content ?? '').trim();
  const finish = ch?.finish_reason || ch?.native_finish_reason;
  return {
    text,
    stop: msg.refusal ? 'refusal' : (finish === 'length' ? 'max_tokens' : finish),
    refusal: msg.refusal || undefined,
  };
}

// 사용량도 하나로 눕힌다.
// 주의: Anthropic의 input_tokens는 캐시분을 **빼고** 오고, OpenAI의 prompt_tokens는 **포함**해서 온다.
// 그대로 더하면 OpenAI 쪽 입력 토큰이 캐시 적중분만큼 이중 계상된다.
export function normalizeUsage(data) {
  const u = data?.usage || {};
  if (u.input_tokens != null || u.output_tokens != null) {
    return {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cost: null,
    };
  }
  const cacheRead = u.prompt_tokens_details?.cached_tokens || 0;
  return {
    input: Math.max(0, (u.prompt_tokens || 0) - cacheRead),
    output: u.completion_tokens || 0,
    cacheWrite: 0,                                   // 접두사 캐시는 기록 비용이 없다
    cacheRead,
    cost: typeof u.cost === 'number' ? u.cost : null, // OpenRouter가 실어 주는 실제 청구액
  };
}

// ── 잡동사니 ─────────────────────────────────────────────
// 오류 메시지가 짚어준 '이 모델이 못 받는 파라미터'를 우리 쪽 이름으로 돌려준다.
export function unsupportedParam(message) {
  const m = String(message || '');
  if (!/unsupported|unrecognized|not supported|unknown|invalid[_ ]?(request[_ ]?)?(argument|parameter)|no[t]? permitted/i.test(m)) return null;
  if (/max_completion_tokens/.test(m)) return 'max_completion_tokens';
  if (/max_tokens/.test(m)) return 'max_tokens';
  if (/reasoning(_effort)?|['"]?effort/.test(m)) return 'effort';
  if (/response_format|json_schema|structured output/i.test(m)) return 'schema';
  if (/cache_control/.test(m)) return 'cache_control';
  return null;
}

// 구조화 출력을 못 받는 모델에게는 스키마를 말로 준다. 파싱은 어차피 관대하다.
export function withSchemaInstruction(system, schema) {
  return `${system || ''}\n\n[OUTPUT FORMAT] Reply with a single JSON object and nothing else — no prose, no code fence.\nIt must match this JSON Schema exactly:\n${JSON.stringify(stripUnsupportedSchemaKeys(schema))}`.trim();
}

// 코드펜스에 싸서 오거나 앞뒤로 한마디 붙여 보내는 모델이 있다. 통째로 실패시키지 않는다.
export function parseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const bare = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  for (const cand of [bare, sliceBraces(bare)]) {
    if (!cand) continue;
    try { const v = JSON.parse(cand); if (v && typeof v === 'object') return v; } catch { /* 다음 후보 */ }
  }
  return null;
}
function sliceBraces(s) {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : null;
}

// OpenAI 방언에서의 캐시 breakpoint — 내용을 블록 배열로 만들고 cache_control을 얹는다.
function cacheText(text) { return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]; }
function flatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map(b => (typeof b === 'string' ? b : b?.text || '')).join('');
}
function markLastUser(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user' || typeof msgs[i].content !== 'string') continue;
    msgs[i] = { role: 'user', content: cacheText(msgs[i].content) };
    return;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
