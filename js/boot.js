// boot.js — 단말 개방 화면. 주임원사명과 인증키를 받아 회선을 여는 데까지가 전부다.
//
// 업자 선택란은 없다. **키 접두사가 곧 업자다** (llm.js의 detectProvider) —
// 판별되는 순간 회선 표시와 모형 목록이 그 업자 것으로 갈린다.
// 키는 이 단말 밖으로 나가지 않는다. 중계 서버가 없기 때문이다.

import { detectProvider, providerOf, defaultModelOf, modelFitsProvider, DEFAULT_PROVIDER } from './llm.js';
import { $, escapeHtml, sget, sset, withLoading } from './ui.js';
import { sfx, startBgm, unlockAudio } from './audio.js';

const CUSTOM_MODEL = '__custom';
let bootProvider = null;

const modelKey = id => `csm_model_${id}`;
function savedModelFor(id) {
  const mine = sget('localStorage', modelKey(id));
  return mine && modelFitsProvider(mine, id) ? mine : null;
}

function fillModels(id) {
  const p = providerOf(id);
  const sel = $('#model-select');
  sel.innerHTML = p.models.map(([m, note]) => `<option value="${escapeHtml(m)}">${escapeHtml(m)} (${escapeHtml(note)})</option>`).join('')
    + (p.freeModel ? `<option value="${CUSTOM_MODEL}">직접 입력…</option>` : '');
  const want = savedModelFor(id) || defaultModelOf(id);
  if (p.models.some(([m]) => m === want)) {
    sel.value = want;
  } else if (p.freeModel) {
    sel.value = CUSTOM_MODEL;
    $('#model-custom').value = want;
  }
  syncCustomModel();
}

function renderProvider(key, { force = false } = {}) {
  const id = detectProvider(key);
  const badge = $('#key-provider');
  if (!id) {
    bootProvider = null;
    badge.textContent = key
      ? '판별 실패 — sk-ant- / sk- / sk-or- 로 시작하는 키가 아니다'
      : '회선 미지정 — 키를 붙여넣으면 발급 업자를 판별한다';
    badge.className = `key-provider ${key ? 'bad' : 'dim'}`;
    if (!$('#model-select').options.length) fillModels(DEFAULT_PROVIDER);
    return null;
  }
  const p = providerOf(id);
  badge.textContent = `회선 판별: ${p.label} — ${p.host} 로 직접 송신`;
  badge.className = 'key-provider ok';
  if (id === bootProvider && !force) return id;
  bootProvider = id;
  fillModels(id);
  return id;
}
function syncCustomModel() {
  $('#model-custom-row').classList.toggle('hidden', $('#model-select').value !== CUSTOM_MODEL);
}
function chosenModel() {
  const v = $('#model-select').value;
  return v === CUSTOM_MODEL ? $('#model-custom').value.trim() : v;
}

/**
 * 화면을 매단다. 게임 쪽에서 넘겨주는 것은 셋뿐이다 —
 *   llm      : 키·모형이 실제로 꽂히는 곳
 *   onBooted : 인증이 통과했을 때 갈 곳 (주임원사명을 들려 보낸다)
 *   onFailed : 인증이 깨졌을 때 화면을 되돌리는 법
 */
export function initBoot({ llm, onBooted, onFailed, errMsg }) {
  const saved = sget('localStorage', 'csm_key') || sget('sessionStorage', 'csm_key');
  if (saved) $('#key-input').value = saved;
  $('#agent-name').value = sget('localStorage', 'csm_name') || '';
  renderProvider($('#key-input').value.trim());

  $('#key-input').addEventListener('input', e => renderProvider(e.target.value.trim()));
  $('#model-select').addEventListener('change', syncCustomModel);

  $('#btn-boot').addEventListener('click', async () => {
    unlockAudio(); sfx.click();
    const name = $('#agent-name').value.trim();
    if (!name) return bootError('성명 없이는 부임 명령지를 못 만든다. 아무거나 적어라.');
    const key = $('#key-input').value.trim();
    const provider = renderProvider(key);
    if (!provider) return bootError('그건 API 키가 아니라 그냥 문자열이다. Anthropic(sk-ant-...) · OpenAI(sk-...) · OpenRouter(sk-or-v1-...) 중 하나를 내놔라.');
    const model = chosenModel();
    if (!model) return bootError('모형 id를 비워 두면 아무 데도 못 보낸다. 업자 문서에 적힌 id를 적어라.');

    sset('localStorage', 'csm_name', name);

    llm.apiKey = key;        // 업자는 이 한 줄에서 정해진다
    llm.model = model;
    sset('localStorage', modelKey(provider), model);
    sset('sessionStorage', 'csm_key', key);
    sset('localStorage', 'csm_key', $('#remember-key').checked ? key : null);
    try {
      await withLoading(`국방망 회선 연결 중... (${providerOf(provider).label} 키 인증)`, () => llm.ping());
      startBgm();
      onBooted(name);
    } catch (e) {
      onFailed?.();
      bootError(errMsg(e));
    }
  });
  for (const sel of ['#key-input', '#agent-name', '#model-custom']) {
    $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-boot').click(); });
  }
}
function bootError(msg) {
  const el = $('#boot-error');
  el.textContent = msg; el.classList.remove('hidden');
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  sfx.bad();
}
