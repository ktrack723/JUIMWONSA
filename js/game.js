// game.js — 화면·입력. 게임 규칙은 여기 없다 — engine.js를 손잡이(handlers)로만 만진다.
//
// 화면 셋: 부팅 → 부대 선택 → 하루(브리핑·타임라인·사건·개입).
// 부대 파라미터 다섯과 병사별 멘탈은 **계기판에 상시 노출**된다 — 화면은 숫자를 본다.
// 프롬프트는 여전히 밴드까지만 본다: 노출은 화면의 일이고 차단은 프롬프트의 일이다
// (근거와 전환 이유는 docs/design.md).
//
// 일과 무대(sprites.js)는 연출이다 — 해가 움직이고 병사 판때기들이 장소를 옮겨 다니며
// 말풍선을 띄운다. 그 대사는 **부임 때 한 번 받아 둔 캐시 풀**(ambient.js)에서 나오므로
// 하루의 콜 수를 한 건도 늘리지 않는다. 군가는 units.js의 static 인용이라 아예 공짜다.

import { LlmClient, RefusalError, normalizeUsage } from './llm.js';
import { Engine } from './engine.js';
import { UNITS, UNIT_BY_ID } from './units.js';
import { Roster, staggeredJoinDates, ROSTER_SIZE, rankLine, rankOf, cohortOf } from './roster.js';
import {
  PLACES, PARAM_LABELS, BAND_LABELS, band,
  slotsFor, weekdayOf, dayFraction, effectiveDifficulty, comradeEffect, TUNING,
  GARA_BY_ID, GARA_TIERS, SLOTS, ABSENCE_KINDS,
} from './params.js';
import { AmbientPool } from './ambient.js';
import { Stage } from './sprites.js';
import { sfx, toggleBgm, unlockAudio } from './audio.js';
import * as pace from './pacing.js';
import { $, $$, escapeHtml, sget, sset, toast, withLoading } from './ui.js';
import { initBoot } from './boot.js';

const llm = new LlmClient();

const state = {
  name: '',
  unit: null,
  roster: null,
  engine: null,
  screen: 'boot',
  holdWanted: false,     // ⏸ 눌림 — 다음 슬롯 경계에서 선다
  holdRelease: null,     // 개입 콘솔이 닫힐 때 부르는 손잡이
  interviewHandle: null, // 진행 중인 면담 왕복 손잡이
  stage: null,           // 일과 무대 (three.js). WebGL이 없으면 null인 채로 돈다
};

// 판정 계열(E-3·N·I-2)을 태울 저가 모델. 업자마다 하나씩.
// null로 떨어지면 그 업자는 판정까지 **기본 모델 정가로** 낸다 — OpenRouter가 그랬다.
const CHEAP_MODEL = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  openrouter: 'anthropic/claude-haiku-4.5',
};
function cheapModelOf() { return CHEAP_MODEL[llm.provider] || null; }

// ── 공용 UI ─────────────────────────────────────────────
function show(screen) {
  state.screen = screen;
  $$('.screen').forEach(s => s.classList.toggle('hidden', s.id !== `screen-${screen}`));
  window.scrollTo(0, 0);
}

function errMsg(e) {
  if (e instanceof RefusalError) return '연산 모형이 본 내용의 처리를 거부했다. 표현을 바꿔 재시도하라.';
  return `통신 사고 — ${e.message}`;
}

/** 패널 하나 여닫기. `hidden` 토글이 화면 곳곳에 흩어져 있던 것을 한 자리로 모은다. */
const panel = (sel, open) => $(sel).classList.toggle('hidden', !open);

/**
 * 회선을 타는 일 하나를 감싼다 — 로딩 표시 · 실패 시 토스트 · 결과 반환.
 * 개입 셋과 마지막 밤이 전부 같은 모양이었다: withLoading + try/catch + toast(errMsg).
 * 실패는 null로 떨어진다. 부르는 쪽은 성공했을 때 할 일만 쓴다.
 */
async function attempt(label, fn, { onError = null } = {}) {
  try {
    return await withLoading(label, fn);
  } catch (e) {
    toast(errMsg(e));
    onError?.(e);
    return null;
  }
}

/** 지금 화면이 살고 있는 날짜. 계급 표기가 전부 이걸 본다 — 날이 가면 계급이 오른다. */
const today = () => state.engine.state.date;
/** 병사 하나의 호칭 — 「1324기 일병 추판석」. 기수·계급은 그날 날짜로 계산된다. */
const who = soldier => `${rankLine(state.unit, soldier, today())} ${soldier.name}`;

// ── LLM 콘솔 ────────────────────────────────────────────
llm.onLog((entry, usage) => {
  const box = $('#console-log');
  let el = entry._el;
  if (!el) { el = document.createElement('details'); entry._el = el; box.prepend(el); while (box.children.length > 60) box.lastChild.remove(); }
  const st = { pending: '···', ok: 'OK ', error: 'ERR', refusal: 'REF' }[entry.status] || '  ?';
  const u = entry.response ? normalizeUsage(entry.response) : null;
  const cacheTag = u?.cacheRead ? ` · 캐시 ${u.cacheRead}` : '';
  const via = entry.provider ? `${escapeHtml(entry.provider)}/` : '';
  el.innerHTML = `<summary>${st} <b>${escapeHtml(entry.label)}</b> · ${via}${escapeHtml(entry.model)} · ${entry.ms ? Math.round(entry.ms) + 'ms' : '...'}${u ? ` · ${u.input}→${u.output}tok${cacheTag}` : ''}${entry.note ? ` · ${escapeHtml(entry.note)}` : ''}${entry.error ? ` · ${escapeHtml(entry.error)}` : ''}</summary><pre>${escapeHtml(JSON.stringify({ request: entry.request, response: entry.response ?? null }, null, 1).slice(0, 8000))}</pre>`;
  $('#console-usage').textContent =
    `호출 ${usage.calls} · in ${usage.inputTokens.toLocaleString()} · out ${usage.outputTokens.toLocaleString()} · 캐시적중 ${usage.cacheRead.toLocaleString()} · 약 $${usage.cost.toFixed(3)}${usage.saved > 0 ? ` (캐시 절감 $${usage.saved.toFixed(3)})` : ''}`;
});

// ── 캠페인 저장 — 명부는 Roster가, 나머지 상태는 여기서 ────
const campaignKey = unitId => `csm_campaign_${unitId}`;
function saveCampaign() {
  if (!state.engine) return;
  sset('localStorage', campaignKey(state.unit.id), JSON.stringify(state.engine.state));
}
function loadCampaign(unitId) {
  try {
    const raw = sget('localStorage', campaignKey(unitId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function wipeCampaign(unitId) {
  sset('localStorage', campaignKey(unitId), null);
  new Roster(UNIT_BY_ID[unitId]).clear();
  new AmbientPool(UNIT_BY_ID[unitId]).clear();
}

// ── 부대 선택 ───────────────────────────────────────────
function renderUnits() {
  const box = $('#unit-cards');
  box.innerHTML = UNITS.map(u => {
    const saved = loadCampaign(u.id);
    return `<div class="panel95 unit-card" data-title="${escapeHtml(u.branch)}">
      <h3>${escapeHtml(u.name)}</h3>
      <p class="dim">${escapeHtml(u.desc)}</p>
      <p class="unit-stats">지능 ${u.intel.score} — “${escapeHtml(u.intel.desc)}”<br>
        마초 ${u.macho.score} — “${escapeHtml(u.macho.desc)}”<br>
        전우애 ${u.comrade.score} — “${escapeHtml(u.comrade.desc)}”<br>
        일과 난이도 ${u.difficulty} · 복무기간 ${u.serviceMonths}개월 · 정원 ${ROSTER_SIZE}명</p>
      <div class="radio-btns">
        <button class="btn95 big" data-unit="${u.id}" type="button">${saved ? '새로 부임 (기록 삭제)' : '이 부대로 부임'}</button>
        ${saved ? `<button class="btn95 big" data-resume="${u.id}" type="button">이어서 지휘 — 무사고 ${saved.streak}일차</button>` : ''}
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
    sfx.click();
    const id = b.dataset.unit;
    if (loadCampaign(id) && !confirm('기존 부임 기록과 병사 명부가 삭제된다. 새로 부임하겠는가?')) return;
    wipeCampaign(id);
    startCampaign(id, null);
  }));
  box.querySelectorAll('[data-resume]').forEach(b => b.addEventListener('click', () => {
    sfx.click();
    startCampaign(b.dataset.resume, loadCampaign(b.dataset.resume));
  }));
}

async function startCampaign(unitId, savedState) {
  const unit = UNIT_BY_ID[unitId];
  state.unit = unit;
  state.roster = new Roster(unit);
  state.roster.load();
  state.engine = new Engine(llm, {
    unit, roster: state.roster,
    state: savedState || undefined,
    handlers: makeHandlers(),
    cheapModel: cheapModelOf(),
  });

  // 부임 첫날 — 초기 명부 16명. 전입일은 복무기간에 흩뿌린다 (전역이 몰리지 않게).
  if (state.roster.vacancies() > 0) {
    const dates = staggeredJoinDates(unit, state.engine.state.startDate, state.roster.vacancies());
    try {
      // 전입 호출은 병렬로 나간다 — 도착 순서가 뒤죽박죽이라 이름이 아니라 진척만 센다.
      await withLoading('부임 전 인수인계 — 병력 기록 수령 중', () =>
        state.engine.fillRoster(dates, (n, roll, total) => {
          $('#loading-text').textContent = `병력 기록 수령 중 — ${n}/${total || ROSTER_SIZE}명`;
        }));
    } catch (e) {
      toast(errMsg(e));
      return;
    }
  }
  saveCampaign();
  show('day');
  openStage();
  renderHud();
  renderRoster();
  renderNotices();
  $('#day-window').innerHTML = '';
  panel('#dayend-panel', false);
  runOneDay();
}

// ── 상황판 · 계기판 ─────────────────────────────────────
function renderHud() {
  const s = state.engine.snapshot();
  $('#hud-date').textContent = `${s.date} (${s.weekday}) · 부임 ${s.dayNo}일차`;
  $('#hud-streak').textContent = `${s.streak}일 / ${s.goal}일`;
  $('#hud-review').textContent = s.reviewDate;
  $('#hud-accidents').textContent = `${s.accidents}건`;
  // 병력은 오늘 부대에 있는 인원이다. 입원·이탈은 따로 센다 — 그 자리는 채워지지 않는다.
  $('#hud-unit').textContent = `${state.unit.name} · 병력 ${s.roster}/${ROSTER_SIZE}명`
    + (s.away.length ? ` (부재 ${s.away.length})` : '');
  renderGauges();
  renderGara(s);
  renderCensor(s);
}

// ── 검열 — 날짜는 알고 내용은 모른다 ────────────────────
// 예고가 이 게임에서 유일하게 「미래」를 말하는 자리다. 무엇이 걸릴지는 안 알려준다 —
// 그건 여전히 가라 명부의 일이고, 그 명부가 얼마나 낡았는지가 곧 이 예고의 무게다.
function renderCensor(snap) {
  const c = snap.censor;
  const box = $('#hud-censor');
  if (c.today) {
    box.className = 'hud-censor today';
    box.innerHTML = `🕶 <b>${escapeHtml(c.today.label)}</b> — 오늘이다. 검열관들이 부대 안에 있다.`;
  } else if (c.next) {
    box.className = `hud-censor soon d${c.next.in}`;
    box.innerHTML = `🕶 <b>${escapeHtml(c.next.label)}</b> — ${c.next.in}일 뒤 (부임 ${c.next.day}일차). 치울 시간은 지금뿐이다.`;
  } else {
    box.className = 'hud-censor hidden';
    box.innerHTML = '';
  }

  const list = c.history;
  $('#censor-panel').classList.toggle('hidden', !list.length);
  $('#censor-list').innerHTML = [...list].reverse().map(h => {
    const rows = h.findings.map(id => {
      const g = GARA_BY_ID[id]; if (!g) return '';
      const t = GARA_TIERS[g.tier];
      return `<span class="cf tier-${g.tier}">${escapeHtml(t.short)} ${escapeHtml(g.label)}</span>`;
    }).join('');
    return `<li class="${h.clean ? 'clean' : h.blows.length ? 'blown' : 'flagged'}">
      <div class="cl-head"><b>${escapeHtml(h.label)}</b> <span class="dim">${escapeHtml(h.date)} · 부임 ${h.day}일차</span></div>
      ${h.clean
    ? '<div class="cl-body clean">지적사항 없음 — 강평지가 백지로 올라갔다. 평판 +1 · 행복 +1</div>'
    : `<div class="cl-body">${rows}</div>`}
      ${h.blows.length ? `<div class="cl-blow">■ 재판급 적발 — 사고 기재${h.taken.length ? ` · ${h.taken.map(t => escapeHtml(t.name)).join('·')} 구속` : ''}</div>` : ''}
    </li>`;
  }).join('');
}

const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/**
 * 가라 내역 — 계기판이 「몇 개」를 말하고 여기가 「무엇」을 말한다.
 * 화면은 절대 진짜 목록을 못 받는다(snapshot에 active가 없다) — 확인한 것만 그린다.
 * 그래서 이 패널의 제일 중요한 줄은 목록이 아니라 **미확인 몇 건**이다.
 */
/**
 * 명부가 비었을 때 뭐라고 할 것인가. 「없다」로 끝내면 안 된다 —
 * 안 턴 자리가 남았는데 없다고 하면 계기판이 거짓말을 하는 것처럼 읽힌다.
 * 남은 안개의 크기를 그대로 말해 주는 것이 이 한 줄의 일이다.
 */
function garaEmptyLine(g, unknown) {
  const never = Object.keys(PLACES).filter(k => !g.seen[k]).length;
  if (!Object.keys(g.seen).length) return '확인된 것 없음 — 아직 아무 자리도 안 털었다.';
  if (unknown > 0) {
    return never
      ? `확인된 것 없음 — 안 가 본 자리 ${never}곳에 ${unknown}건이 남아 있다.`
      : `확인된 것 없음 — ${unknown}건이 어딘가에서 돌고 있는데 전부 놓쳤다.`;
  }
  return g.running ? '확인된 것 없음 — 방금 턴 자리에는 없었다.' : '아는 한 지금 도는 것은 없다.';
}

/** 시간대 id들을 사람이 읽는 한 줄로. 슬롯 이름은 일과표가 들고 있다. */
const SLOT_LABEL = Object.fromEntries(SLOTS.map(x => [x.key, x.label]));
const whenLine = when => (when || []).map(k => SLOT_LABEL[k] || k).join(' · ');

function renderGara(snap) {
  const g = snap.gara, today = snap.date;
  const knownIds = g.known.map(k => k.id);
  // 명부와 계기판의 어긋남은 둘 중 한 방향으로만 난다. 계기판이 정직하니 플레이어가 어차피
  // 뺄셈으로 알아낼 수 있는 것이고, 그렇다면 흐리게 두지 말고 **이름을 붙여 주는 편이 낫다.**
  //   미확인 — 돌고 있는데 못 본 것 (숨겼거나, 그 자리를 안 털었다)
  //   낡음   — 명부가 계기판보다 많다. 최소 그만큼은 이미 멎었다는 뜻이다
  const unknown = Math.max(0, g.running - knownIds.length);
  const stale = Math.max(0, knownIds.length - g.running);
  const courtKnown = knownIds.filter(id => GARA_BY_ID[id]?.tier === 'court').length;

  $('#gara-tally').innerHTML =
    `<span class="gt-run" title="계기판의 가라 수치 그대로다">돌고 있음 <b>${g.running}</b></span>` +
    `<span class="gt-known" title="들이닥쳐서 확인한 것">확인 <b>${knownIds.length}</b></span>` +
    (stale
      ? `<span class="gt-stale" title="명부가 계기판보다 많다 — 확인한 뒤 조용히 멎은 것이 있다">낡음 <b>≥${stale}</b></span>`
      : `<span class="gt-unknown${unknown ? ' on' : ''}" title="돌고 있는데 아직 못 본 것">미확인 <b>${unknown}</b></span>`) +
    (g.banned.length ? `<span class="gt-ban" title="지침이 서 있는 한 다시 안 생긴다">금지 <b>${g.banned.length}</b> · 천장 ${g.cap}</span>` : '')
    // 확인된 것 중 재판급이 몇인가. 미확인 쪽에 몇이 숨어 있는지는 여전히 아무도 모른다 —
    // 그래서 이 숫자는 「안심해도 된다」가 아니라 「최소한 이만큼은 있다」로 읽혀야 한다.
    + (courtKnown ? `<span class="gt-court on" title="확인된 것 중 재판급. 검열에서 터지는 것은 이것뿐이다">재판급 <b>${courtKnown}</b></span>` : '');

  // 확인된 것 — 오래된 것부터가 아니라 **낡은 것부터** 위로. 다시 가 봐야 할 자리가 먼저 보인다.
  const rows = g.known
    .map(k => ({ ...GARA_BY_ID[k.id], on: k.on, age: daysBetween(k.on, today) }))
    .sort((a, b) => b.age - a.age);
  $('#gara-known').innerHTML = rows.length
    ? rows.map(r => {
      const cls = r.age >= 14 ? 'stale' : r.age >= 4 ? 'aging' : 'fresh';
      const t = GARA_TIERS[r.tier];
      return `<li class="${cls} tier-${r.tier}">
        <span class="gk-grade tier-${r.tier}" title="${escapeHtml(t.note)}">${escapeHtml(t.label)}</span>
        <span class="gk-place">${escapeHtml(PLACES[r.place]?.label || '')}</span>
        <span class="gk-label">${escapeHtml(r.label)}</span>
        <span class="gk-age">${r.age === 0 ? '오늘 확인' : `${r.age}일 전`}</span>
        <span class="gk-when" title="이 시간에만 돈다 — 다른 시간에 그 자리를 털면 없다">${escapeHtml(whenLine(r.when))}</span>
        <span class="gk-desc">${escapeHtml(r.desc)}</span>
        <span class="gk-tell">눈으로 보면 — ${escapeHtml(r.tell)}</span>
        <span class="gk-counter">끊으려면 — ${escapeHtml(r.counter)}</span>
      </li>`;
    }).join('')
    : `<li class="dim empty">${garaEmptyLine(g, unknown)}</li>`;

  const ban = g.banned.map(id => GARA_BY_ID[id]).filter(Boolean);
  $('#gara-banned-box').classList.toggle('hidden', !ban.length);
  $('#gara-banned').innerHTML = ban.map(b =>
    `<li><span class="gk-place">${escapeHtml(PLACES[b.place]?.label || '')}</span>
      <span class="gk-label">${escapeHtml(b.label)}</span></li>`).join('');

  // 자리별 마지막 확인 — 명부가 얼마나 낡았는지의 근거. 「미확인」이 제일 눈에 띄어야 한다.
  $('#gara-seen').innerHTML = Object.entries(PLACES).map(([k, p]) => {
    const on = g.seen[k];
    const age = on ? daysBetween(on, today) : null;
    const cls = on == null ? 'never' : age >= 14 ? 'stale' : age >= 4 ? 'aging' : 'fresh';
    // 언제 봤는지까지 적는다 — 낮에 본 생활관과 점호 때 본 생활관은 같은 자리가 아니다.
    const at = g.seenAt?.[k] ? ` ${SLOT_LABEL[g.seenAt[k]] || ''}` : '';
    return `<span class="gs ${cls}" title="${on == null ? '한 번도 안 털었다' : `마지막으로 본 것은 ${escapeHtml(on)}${escapeHtml(at)}`}">`
      + `${escapeHtml(p.label)} <b>${on == null ? '미확인' : age === 0 ? '오늘' : `${age}일`}</b>`
      + `${at ? `<i class="gs-at">${escapeHtml(at.trim())}</i>` : ''}</span>`;
  }).join('');
}

// 부대 계기판 — 다섯 파라미터 상시 노출. 갈등 바에는 8부터 열리는 위험 구간 눈금을 새긴다.
// 난이도는 오늘의 실효값(계절·주말 보정 후)이다 — static이지만 달력이 만지는 것이 보여야 한다.
const GAUGE_DEFS = [
  { k: 'difficulty', label: '일과 난이도', cls: 'diff', note: '오늘 실효치 — 계절·주말이 정한다' },
  { k: 'gara', label: '가라', cls: 'gara', note: '이 숫자가 곧 지금 돌고 있는 편법의 개수다 — 무엇인지는 아래 내역에서' },
  { k: 'happy', label: '행복도', cls: 'happy', note: '낮으면 싸움이 늘고 멘탈이 쓸려 내려간다' },
  { k: 'conflict', label: '갈등·부조리', cls: 'conflict', danger: 'comrade', note: '이 눈금을 넘으면 탈영·자해급 사고의 문이 열린다 — 자리는 전우애가 정한다' },
  { k: 'rep', label: '평판', cls: 'rep', note: '개입마다 −1 · 조용한 날 +1. 낮으면 지침이 안 먹힌다' },
];
function renderGauges() {
  const p = state.engine.state.params;
  const values = { ...p, difficulty: effectiveDifficulty(state.unit.difficulty, state.engine.state.date) };
  // 큰 사고의 문턱은 부대마다 다르다 — 전우애가 그걸 민다(params.js의 comradeEffect).
  // 눈금을 실제 문턱 자리에 그려야 계기판이 이 부대의 진실을 말한다.
  const open = comradeEffect(state.unit.comrade.score).open;
  $('#gauge-box').innerHTML = GAUGE_DEFS.map(g => {
    const v = values[g.k];
    const mark = g.danger === 'comrade' ? open : g.danger;
    const dangerNow = mark != null && v >= mark;
    return `<div class="pgauge ${g.cls}${dangerNow ? ' danger-now' : ''}" title="${escapeHtml(g.note)}">
      <span class="pg-label">${escapeHtml(g.label)}</span>
      <div class="pg-bar">
        <div class="pg-fill" style="width:${v * 10}%"></div>
        ${mark != null ? `<i class="pg-danger" style="left:${Math.min(100, mark * 10)}%"></i>` : ''}
      </div>
      <span class="pg-num">${v}<small>/10</small></span>
    </div>`;
  }).join('');
  const note = $('#gauge-open-note');
  if (note) note.textContent = `${open.toFixed(1)} (전우애 ${state.unit.comrade.score})`;
}

// 병사 멘탈 미니 게이지 — 명부·면담 선택에 같이 쓴다. 2 이하는 큰 사고의 문이다.
function mentalBadge(m) {
  const v = m ?? TUNING.mental.default;
  const cls = v <= TUNING.mental.dangerAt ? 'mg-danger' : v <= 4 ? 'mg-low' : 'mg-ok';
  return `<span class="mgauge ${cls}" title="멘탈 ${v}/10"><i style="width:${v * 10}%"></i></span><b class="mg-num">${v}</b>`;
}

function renderTimeline(activeIndex = -1) {
  const slots = slotsFor(state.engine.state.date);
  $('#timeline-slots').innerHTML = slots.map((sl, i) =>
    `<li class="${i < activeIndex ? 'done' : i === activeIndex ? 'now' : ''}">${escapeHtml(sl.label)}</li>`).join('');
}

// ── 일과 무대 ───────────────────────────────────────────
// 화면이 열릴 때 한 번 만들고 캠페인 내내 쓴다. WebGL이 안 되면 stage.ok가 false고,
// 그때도 하늘·해·장소 라벨은 CSS라 그대로 뜬다 — 병사 판때기만 없다.
function openStage() {
  if (!state.stage) {
    state.stage = new Stage($('#stage-canvas'), { count: 12 });
    state.stage.start();
    addEventListener('resize', () => state.stage?.resize());
  }
  // 장소 팻말은 params.js의 대응표가 그대로 그린다 — 화면이 자리를 따로 알 필요가 없다.
  // 팻말도 가운데 피벗이라 끝(흡연장 x=0.97)이 잘린다 — 중심을 [6%, 94%]로 죈다.
  const clampP = x => Math.min(0.94, Math.max(0.06, x));
  $('#stage-places').innerHTML = Object.values(PLACES)
    .map(pl => `<span class="stage-place" style="left:${(clampP(pl.x) * 100).toFixed(1)}%">${escapeHtml(pl.label)}</span>`).join('');
}

/** 슬롯 하나로 무대를 옮긴다 — 해·하늘·통근·말풍선. */
function stageTo(slot, chatter = []) {
  const sky = $('#stage-sky');
  const f = dayFraction(slot.time);
  state.stage?.goto(slot);
  // 빠진 인원은 무대에서도 빠진다 — 입원·이탈이 숫자로만 남지 않는다.
  state.stage?.crowd((state.roster?.present.length ?? ROSTER_SIZE) / ROSTER_SIZE);
  const look = state.stage?.ok ? state.stage.look() : { sky: skyFallback(f), sun: sunFallback(f) };
  sky.style.background = `linear-gradient(180deg, ${look.sky.top} 0%, ${look.sky.bot} 100%)`;
  const sun = $('#stage-sun');
  sun.style.left = `${(look.sun.x * 100).toFixed(1)}%`;
  sun.style.bottom = `${(18 + look.sun.y * 62).toFixed(1)}%`;
  sun.classList.toggle('moon', look.sun.night);
  $('#stage-clock').textContent = slot.time;
  $('#stage-slot').textContent = `${slot.label} · ${PLACES[slot.at]?.label || ''}`;
  speak(chatter);
}

// stage가 안 열렸을 때를 위한 최소 폴백. sprites.js의 같은 함수를 안 쓰는 이유는
// 그 모듈이 three.js를 물고 있어서다 — 로드 자체가 실패한 환경도 하늘은 떠야 한다.
const skyFallback = f => (f > 0.28 && f < 0.75 ? { top: '#8fc0ea', bot: '#cfe4f2' } : { top: '#111726', bot: '#1a2130' });
const sunFallback = f => ({ x: Math.max(0, Math.min(1, (f - 0.25) / 0.5)), y: 0.6, night: !(f > 0.25 && f < 0.75) });

/**
 * 사건이 터진 자리에 ❗를 띄운다. 스프라이트 하나를 골라 그 위에 붙는다 —
 * 어느 판때기가 사고를 쳤는지가 눈에 보여야 「달려가는」 그림이 된다.
 * 대응이 끝나면 지운다.
 */
function markIncident(on, cat = null) {
  const box = $('#stage-bubbles');
  box.querySelector('.incident-mark')?.remove();
  if (!on) return;
  const pos = state.stage?.ok ? state.stage.positions() : [];
  const p = pos.length ? pos[Math.floor(Math.random() * pos.length)] : { x: 0.5 };
  const el = document.createElement('div');
  el.className = 'incident-mark';
  // 유형의 글자를 세운다 — 무슨 일이 터졌는지가 무대에서도 한눈에 갈린다.
  el.textContent = cat?.icon || '❗';
  el.title = cat?.label || '사건';
  el.style.left = `${(Math.min(0.9, Math.max(0.1, p.x)) * 100).toFixed(1)}%`;
  box.appendChild(el);
}

/** 말풍선. 스프라이트가 서 있는 자리에 붙는다 — 대사는 캐시 풀에서 왔고 콜은 없다. */
function speak(chatter) {
  const box = $('#stage-bubbles');
  // ❗는 대응이 끝날 때까지 살아 있어야 한다 — 말풍선만 갈아 끼운다.
  box.querySelectorAll('.bubble').forEach(b => b.remove());
  if (!chatter?.length) return;
  const pos = state.stage?.ok ? state.stage.positions() : [];
  // 피벗은 가운데(translateX(-50%))다 — 무대 끝에 선 놈의 말풍선이 잘리지 않으려면
  // 중심이 [반폭, 1−반폭] 안에 있어야 한다. css의 max-width가 48%(반폭 24%)이므로
  // [25%, 75%]로 죈다. 꼬리도 가운데라 어긋나 보이지 않는다 (css).
  const clampX = x => Math.min(0.75, Math.max(0.25, x));
  chatter.slice(0, 3).forEach((c, i) => {
    const el = document.createElement('div');
    el.className = `bubble ${c.kind}${c.kind === 'song' && c.mode === 'broadcast' ? ' broadcast' : ''}`;
    // 군가는 누가 부르는지가 아니라 어디서 오는지가 다르다 — 목이냐 스피커냐.
    el.textContent = c.kind === 'song'
      ? (c.mode === 'broadcast' ? `📻 ♪ ${c.text}` : `♪ ${c.text}`)
      : c.text;
    if (c.kind === 'song') el.title = c.title;
    const p = pos[(i * 4 + 1) % Math.max(1, pos.length)];
    el.style.left = `${(clampX(p ? p.x : 0.2 + i * 0.3) * 100).toFixed(1)}%`;
    el.style.bottom = `${34 + i * 17}%`;
    box.appendChild(el);
  });
}

function renderRoster() {
  const unit = state.unit, today = state.engine.state.date;
  // 기수·계급은 저장돼 있지 않다 — 그날 날짜로 계산해 그린다. 날이 가면 여기 표기가 오른다.
  // 기수 오름차순(= 짬 순)으로 세운다. 명부를 보는 눈이 곧 서열을 보는 눈이다.
  const rows = state.roster.soldiers
    .map(s => ({ s, cohort: cohortOf(unit, s.joined), rank: rankOf(unit, s.joined, today) }))
    .sort((a, b) => a.cohort - b.cohort);
  $('#roster-list').innerHTML = rows.map(({ s, cohort, rank }) => {
    // 부재자는 명부에 남는다 — 제적이 아니다. 다만 어디에 있고 언제 오는지가 같이 찍힌다.
    const away = s.away ? ABSENCE_KINDS[s.away.kind] : null;
    return `<details class="roster-row${away ? ' away' : ''}"><summary><span class="rk rk-${rank}">${escapeHtml(rank)}</span> ${escapeHtml(s.name)}
      ${away ? `<span class="away-tag" title="복귀 예정 ${escapeHtml(s.away.until)}">${away.icon} ${escapeHtml(away.label)}</span>` : mentalBadge(s.mental)}
      <span class="dim">${cohort}기 · ${escapeHtml(s.job)} · ${escapeHtml(s.grade)}/${escapeHtml(s.character)}</span></summary>
      <p>${escapeHtml(s.sheet) || '<span class="dim">인사기록 미도착</span>'}</p>
      ${away ? `<p class="small away-note">${escapeHtml(away.where)} · ${escapeHtml(s.away.since)} 부터 · 복귀 예정 ${escapeHtml(s.away.until)}</p>` : ''}
      <p class="dim small">군번 ${escapeHtml(s.serial)} · 전입 ${escapeHtml(s.joined)} · 멘탈 ${s.mental ?? TUNING.mental.default}/10</p></details>`;
  }).join('') || '<p class="dim">병력 없음</p>';
  // 면담(상담) 대상 목록 — **멘탈 낮은 순**으로 세운다. 누굴 불러야 하는지가 목록 자체다.
  // 부재자는 목록에 없다 — 없는 사람을 주임원사실로 부를 수는 없다.
  const byNeed = rows.filter(r => !r.s.away).sort((a, b) => (a.s.mental ?? 6) - (b.s.mental ?? 6));
  $('#interview-who').innerHTML = byNeed.map(({ s, cohort, rank }) =>
    `<option value="${escapeHtml(s.serial)}">[멘탈 ${s.mental ?? TUNING.mental.default}] ${cohort}기 ${escapeHtml(rank)} ${escapeHtml(s.name)} (${escapeHtml(s.job)})</option>`).join('');
}

function renderNotices() {
  const list = state.engine.state.notices;
  // 지침은 이제 원문 하나가 아니다 — 무엇을 막고 있는지가 같이 붙는다.
  // 철회하면 그 문이 다시 열린다(끊긴 가라가 되살아나지는 않는다 — 문만 열린다).
  $('#notice-list').innerHTML = list.length
    ? list.map((n, i) => {
      const bans = (n.bans || []).map(id => GARA_BY_ID[id]?.label).filter(Boolean);
      return `<li><span class="nt-body">${escapeHtml(n.text)}
        ${bans.length ? `<span class="nt-bans">막는 중 · ${escapeHtml(bans.join(' · '))}</span>` : ''}</span>
        <button class="btn95 tiny" data-del="${i}" type="button">철회</button></li>`;
    }).join('')
    : '<li class="dim">게시된 지침 없음</li>';
  $('#notice-list').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    state.engine.removeNotice(Number(b.dataset.del));
    saveCampaign();
    renderNotices();
    renderHud();   // 막아 뒀던 문이 열린다 — 천장이 도로 올라간다
  }));
}

// ── 동향 기록 창 ────────────────────────────────────────
async function addEntry(kind, text, { typed = true, badge = null } = {}) {
  const win = $('#day-window');
  const div = document.createElement('div');
  div.className = `day-entry ${kind}`;
  win.appendChild(div);
  // 딱지가 붙으면 본문은 자식으로 내려간다 — typeInto가 칸을 통째로 비우기 때문이다.
  let body = div;
  if (badge) {
    div.appendChild(badge);
    body = document.createElement('div');
    body.className = 'entry-body';
    div.appendChild(body);
  }
  const scroll = () => { win.scrollTop = win.scrollHeight; };
  if (typed) await pace.typeInto(body, text, scroll);
  else { body.textContent = text; scroll(); }
  await pace.beat(pace.readMs(text) * 0.4);
}

/**
 * 사고 유형 딱지 — 그림 한 장 + 갈래·이름.
 * 유형은 코드가 정한 열둘 중 하나라(params.js의 `INCIDENT_CATEGORIES`), 지침이 아무리
 * 자유롭고 장면이 아무리 갈라져도 붙을 그림이 반드시 하나 있다.
 * **그림 파일이 없어도 안 깨진다** — 로드에 실패하면 유형의 icon 글자로 떨어진다.
 */
function categoryBadge(cat, note = '') {
  if (!cat) return null;
  const box = document.createElement('div');
  box.className = `cat-badge cat-${cat.class}`;
  const art = document.createElement('img');
  art.className = 'cat-art';
  art.src = cat.art;
  art.alt = cat.label;
  art.addEventListener('error', () => {
    const fb = document.createElement('span');
    fb.className = 'cat-art fallback';
    fb.textContent = cat.icon;
    art.replaceWith(fb);
  }, { once: true });
  const txt = document.createElement('div');
  txt.className = 'cat-text';
  txt.innerHTML = `<b>${escapeHtml(cat.label)}</b><span>${escapeHtml(cat.className)}${note ? ` · ${escapeHtml(note)}` : ''}</span>`;
  box.append(art, txt);
  return box;
}

/**
 * 동향 기록에 하루의 머리를 박는다. 이게 없으면 어제 저녁점호와 오늘 아침 브리핑이
 * 한 줄로 이어 붙어서, 스크롤해 올라간 유저가 어디부터가 오늘인지 못 가른다.
 * 날짜·부임 며칠째·무사고 며칠째를 같이 적는다 — 상황판을 안 봐도 기록만으로 읽힌다.
 */
function dayMark(snap) {
  const win = $('#day-window');
  const el = document.createElement('div');
  el.className = 'day-mark';
  el.innerHTML = `<span>${escapeHtml(snap.date)} (${escapeHtml(snap.weekday)})</span>`
    + `<span>부임 ${snap.dayNo}일차 · 무사고 ${snap.streak}일</span>`;
  win.appendChild(el);
  win.scrollTop = win.scrollHeight;
}

// 오늘 바늘이 어디로 갔는지 한 줄로. 개입도 판정도 드리프트도 조용히 미는 값이라,
// 이 줄이 없으면 유저는 **왜** 행복도가 떨어졌는지 100일 내내 못 배운다.
const MOVE_ORDER = ['gara', 'happy', 'conflict', 'rep'];
function movedLine(moved) {
  const parts = MOVE_ORDER.filter(k => moved[k]).map(k => `${PARAM_LABELS[k]} ${moved[k] > 0 ? '+' : '−'}${Math.abs(moved[k])}`);
  return parts.length ? parts.join(' · ') : '바늘은 그대로다';
}

/**
 * 평판이 지금 무슨 뜻인가 — 「내 지침이 먹히기는 하는가」.
 * 밴드는 params.js가 계산하고(complianceOf), 그 밴드를 프롬프트는 영어로 받는다.
 * 화면에 뜰 한국어는 화면 몫이라 여기 산다. 눈금 다섯이 밴드 다섯과 짝이다.
 */
const STANDING_KO = [
  '씹힌다 — 대놓고 안 듣는다',
  '마지못해 듣는다',
  '절반쯤 먹힌다',
  '대체로 먹힌다',
  '글자 그대로 이행된다',
];
const standingNow = () => {
  const rep = state.engine.state.params.rep;
  return `${STANDING_KO[BAND_LABELS.indexOf(band(rep))]} (평판 ${rep}/10)`;
};

// ── 엔진 손잡이 — 하루의 전부가 여기로 들어온다 ─────────
function makeHandlers() {
  return {
    briefing: async ({ date, briefing, arrivals, departures, returns }) => {
      renderHud(); renderRoster(); renderTimeline(-1);
      stageTo(slotsFor(date)[0], []);
      dayMark(state.engine.snapshot());
      await addEntry('briefing', `[아침 브리핑 · ${date}]\n${briefing}`);
      // 복귀 — 병원에서든 부대 밖에서든, 오늘 아침 인원이 채워졌다.
      for (const r of returns || []) {
        const kind = ABSENCE_KINDS[r.away?.kind];
        await addEntry('sys', `${rankLine(state.unit, r, date)} ${kind ? kind.back(r.name) : `${r.name} 복귀.`}`, { typed: false });
      }
      for (const d of departures || []) await addEntry('sys', `${who(d)} 전역 신고. 위병소 밖은 그의 소관이 아니다.`, { typed: false });
      for (const a of arrivals || []) await addEntry('sys', `${who(a)} 전입 신고 — ${a.job}, 군번 ${a.serial}.`, { typed: false });
    },
    // 검열관 입장. 콜은 안 나간다 — 정해진 사람들이 정해진 모습으로 들어온다.
    censorOpen: async ({ label, date }) => {
      sfx.bad();
      $('#screen-day').classList.add('censor-day');
      await addEntry('censor', `🕶 ${label} · ${date}\n연병장에 승합차 두 대가 섰다. 선글라스에 검은 야상, 명찰 없음. `
        + '인사도 없이 클립보드를 펴 들고 부대 안으로 흩어진다 — 오늘 하루, 이 부대의 모든 문은 그들 것이다.',
      { typed: false });
      renderHud();
    },
    // 슬롯마다 어디를 뒤졌고 무엇이 걸렸는가. 안 걸린 자리도 「거기까지 갔다」는 말은 해 준다 —
    // 아무 말이 없으면 유저는 그 자리가 안전한 건지 안 뒤진 건지 알 수가 없다.
    censorSlot: async ({ slot, places, found }) => {
      const where = places.length ? places.join(' · ') : '부대 곳곳';
      if (!found.length) {
        return await addEntry('censor', `🕶 [${slot.label}] ${where} — 서랍을 열고, 닫고, 다음 자리로 갔다.`, { typed: false });
      }
      sfx.bad();
      const rows = found.map(f => `· [${f.grade.label}] ${f.label} — ${f.tell}`).join('\n');
      await addEntry('censor', `🕶 [${slot.label}] ${where}\n${rows}`, { typed: false });
    },
    censorReport: async (out) => {
      $('#screen-day').classList.remove('censor-day');
      await addEntry('censor', `🕶 ${out.label} 강평\n${out.review}`);
      if (out.clean) {
        sfx.love();
        await addEntry('stamp', '□ 지적사항 없음 — 강평지가 백지로 올라갔다. 평판 +1 · 행복 +1', { typed: false });
      } else {
        const line = out.sheet.map(g => `[${g.grade.label}] ${g.label}`).join(' · ');
        await addEntry('stamp', `▣ 적발 ${out.findings.length}건 — ${line}\n걸린 것은 그 자리에서 멎는다 (가라 −${out.findings.length}).`, { typed: false });
      }
      if (out.blows.length) {
        sfx.trombone();
        await addEntry('stamp', `■ 재판급 적발 — ${out.blows.map(id => GARA_BY_ID[id]?.label).filter(Boolean).join(' · ')}. `
          + '사고 대장에 기재된다. 무사고 기록 0일로 회귀.', { typed: false });
        for (const a of out.absences || []) {
          const kind = ABSENCE_KINDS[a.kind];
          if (kind) await addEntry('stamp', `${kind.icon} ${kind.line(a.soldier.name, a.until)}`, { typed: false });
        }
        renderRoster();
      }
      renderHud();
      saveCampaign();
    },
    slot: async ({ index, slot, line, chatter }) => {
      renderTimeline(index);
      stageTo(slot, chatter);
      if (line) await addEntry('slot', `[${slot.label}] ${line}`);
      else await addEntry('slot', `[${slot.label}]`, { typed: false });
      await holdGate();   // ⏸가 눌려 있으면 여기서 선다
    },
    incident: async ({ scene, place, slot, tier, category }) => {
      sfx.bad();
      markIncident(true, category);
      await addEntry('incident', `❗ ${slot.label} · ${place}\n${scene}`, {
        badge: categoryBadge(category, `${slot.label} · ${place} · ${tier === 'major' ? '중대' : '경미'}`),
      });
      return await askDirective();
    },
    outcome: async ({ scene }) => {
      markIncident(false);
      await addEntry('outcome', scene);
    },
    verdict: async ({ escalated, tier, category, absences }) => {
      if (escalated) {
        sfx.trombone();
        // 확전하면 유형이 넘어갈 수 있다 — 사고 대장에 찍히는 것은 「무엇이 되었는가」다.
        await addEntry('stamp', `■ 사고 확정 (${tier === 'major' ? '중대' : '경미'}) — 무사고 기록 0일로 회귀. 날짜는 돌아가지 않는다.`,
          { typed: false, badge: categoryBadge(category, '사고 대장 기재') });
        // 사고가 사람을 데려갔다 — 이 자리는 복귀일까지 비어 있다. 충원은 없다.
        for (const a of absences || []) {
          const kind = ABSENCE_KINDS[a.kind];
          if (!kind) continue;
          await addEntry('stamp', `${kind.icon} ${kind.line(a.soldier.name, a.until)} 자리는 채워지지 않는다 — 복귀할 때까지 ${state.roster.present.length}명으로 간다.`, { typed: false });
        }
        renderRoster();
      } else {
        sfx.love();
        await addEntry('stamp', '□ 수습 — 사건은 사고가 되지 않았다. 무사고 기록 유지.', { typed: false });
      }
      renderHud();
    },
    dayEnd: async (snap) => {
      renderHud(); renderTimeline(9); renderNotices();
      saveCampaign();
      if (snap.promoted) return await showPromotion(snap);
      const t = snap.today || { incidents: 0, accidents: 0, interventions: 0, moved: {} };
      // 「조용한 날」은 평판이 회복되는 날의 이름이다 — 개입까지 없어야 조용한 날이다.
      const events = t.incidents
        ? `사건 ${t.incidents}건 — ${t.accidents ? `그중 <b>사고 ${t.accidents}건</b>` : '전부 사고 전에 멈췄다'}.`
        : t.interventions ? '사건 없음.' : '사건 없음. <b>조용한 날</b>이라 평판이 회복된다.';
      $('#dayend-text').innerHTML =
        `저녁점호 이상 무. <b>무사고 ${snap.streak}일차</b>로 하루를 닫는다.<br>` +
        `${events} 개입 ${t.interventions}회.<br>` +
        `<b>오늘 움직인 바늘:</b> ${escapeHtml(movedLine(t.moved))}<br>` +
        `다음 날: ${escapeHtml(snap.date)} (${escapeHtml(weekdayOf(snap.date))}) · 진급 심사일 ${escapeHtml(snap.reviewDate)}`;
      panel('#dayend-panel', true);
    },
  };
}

async function runOneDay() {
  panel('#dayend-panel', false);
  try {
    await state.engine.runDay();
  } catch (e) {
    toast(`${errMsg(e)} — 브리핑부터 다시 연다.`);
    $('#dayend-text').textContent = '회선이 끊겨 하루가 열리지 못했다. 다시 시도하라.';
    $('#btn-next-day').textContent = '재시도 — 아침점호 ▶';
    panel('#dayend-panel', true);
    return;
  }
  $('#btn-next-day').textContent = '다음 날 아침점호 ▶';
}

async function showPromotion(snap) {
  const acc = snap.accidents;
  $('#promo-text').innerHTML =
    `<b>무사고 연속 ${snap.goal}일. ${escapeHtml(snap.date)} 부로 원사 진급 상신이 통과됐다.</b><br>` +
    (acc ? `그동안 사고 ${acc}건을 딛고 온 길이다. 병사들은 아무도 축하한다는 말을 안 했지만, 오늘 배식줄이 이상하게 조용했다.`
      : `부임 후 단 한 건도 터뜨리지 않았다. 완벽한 100일 — 심사장에서 아무도 그 말을 믿지 않았다.`) +
    `<br>진급은 이 부대를 뜬다는 뜻이다. <b>오늘이 마지막 밤이다.</b>`;
  panel('#promo-panel', true);
  sfx.fanfare();
  await runFarewell();
}

// ── 마지막 씬 — 환송회 ─────────────────────────────────
// 거하게 차려지느냐 아무도 없느냐는 **행복도**가 정한다(engine.farewell → params.farewellTone).
// 화면은 그 갈래를 고르지 않는다 — 무대를 어디로 옮기고 어떤 소리를 낼지만 안다.
// 무대는 **병사들이 어디 있느냐**를 그린다 — 판때기가 어디로 모이는지가 곧 그 밤의 답이다.
// 아무도 안 온 밤에 무대를 식당으로 옮기면 빈 식당에 열두 명이 서 있게 된다.
// 그 밤의 판때기는 생활관에 그대로 있다: 아무도 안 나온 것이지 아무도 없는 게 아니다.
const FAREWELL_SCENES = {
  grand: {
    title: '환송회', head: '식당 · 소등 시간이 한참 지났다',
    slot: { key: 'farewell', label: '환송회', kind: 'meal', time: '20:30', at: 'messhall' },
    note: '병사들이 거하게 차려 놓고 기다리고 있었다. 행복한 부대는 사람을 그냥 안 보낸다.',
    sound: () => sfx.love(),
  },
  thin: {
    title: '배웅', head: '식당 · 불은 반만 켜져 있다',
    slot: { key: 'farewell', label: '배웅', kind: 'rest', time: '21:30', at: 'messhall' },
    note: '몇 명이 남아 있었다. 차린 것은 없었지만, 그래도 누군가는 남아 있었다.',
    sound: () => sfx.click(),
  },
  none: {
    title: '전출', head: '식당은 비었고, 불은 생활관에만 켜져 있다',
    slot: { key: 'farewell', label: '전출', kind: 'sleep', time: '21:30', at: 'barracks' },
    note: '아무도 나오지 않았다. 100일을 버틴 것은 당신이고, 그 100일을 견딘 것은 그들이다.',
    sound: () => sfx.trombone(),
  },
};

async function runFarewell() {
  for (const sel of ['#farewell-panel', '#btn-farewell-retry', '#btn-farewell-end']) panel(sel, false);

  const out = await attempt('마지막 밤 — 부대로 돌아가는 중', () => state.engine.farewell(), {
    onError: () => {
      $('#farewell-text').textContent = '회선이 끊겨 마지막 밤이 열리지 못했다. 다시 시도하라.';
      panel('#btn-farewell-retry', true);
      panel('#farewell-panel', true);
    },
  });
  if (!out) return;
  saveCampaign();

  const sc = FAREWELL_SCENES[out.tone] || FAREWELL_SCENES.thin;
  markIncident(false);
  renderTimeline(9);
  stageTo(sc.slot, []);
  sc.sound();
  await addEntry('farewell', `[${sc.title} · ${sc.head}]\n${out.scene}`);
  // 입을 여는 놈은 코드가 고른 그 몇 명뿐이다 — 엔진이 명부 밖 이름을 이미 걸러 놓았다.
  for (const l of out.lines) {
    const man = state.roster.bySerial(l.serial);
    await addEntry('sendoff', `${man ? who(man) : l.name}: ${l.text}`);
  }
  if (out.closing) await addEntry('closing', out.closing);

  $('#farewell-text').innerHTML = `<b>${escapeHtml(sc.note)}</b><br>` +
    `${escapeHtml(state.unit.name)} 근무 끝. 무사고 ${TUNING.goal}일 · 사고 누계 ${state.engine.snapshot().accidents}건.`;
  panel('#btn-farewell-end', true);
  panel('#farewell-panel', true);
  // 게임의 마지막 버튼이다 — 접혀 있는 자리에서 끝나지 않게 화면으로 끌어온다.
  $('#farewell-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── 사건 대응 입력 ──────────────────────────────────────
function askDirective() {
  return new Promise(resolve => {
    const input = $('#incident-input');
    input.value = '';
    // 지침을 쓰기 **전에** 그 지침이 먹힐지를 알려준다. 평판은 계기판에 떠 있지만
    // 숫자 5가 「현장에서 절반쯤 먹힌다」라는 뜻인 줄은 화면이 말해 줘야 안다 —
    // 이 한 줄이 없으면 유저는 말이 안 서는 줄도 모르고 지침을 쓴다.
    $('#incident-standing').textContent = `지금 당신의 말: ${standingNow()}`;
    panel('#incident-panel', true);
    // 사건이 열리면 손이 갈 자리가 화면 밖에 있으면 안 된다 — 입력칸을 끌어온다.
    $('#incident-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    input.focus();
    const done = v => {
      panel('#incident-panel', false);
      sendBtn.removeEventListener('click', onSend);
      skipBtn.removeEventListener('click', onSkip);
      resolve(v);
    };
    const sendBtn = $('#btn-incident-send'), skipBtn = $('#btn-incident-skip');
    const onSend = () => { sfx.send(); const v = input.value.trim(); done(v || null); };
    const onSkip = () => { sfx.click(); done(null); };
    sendBtn.addEventListener('click', onSend);
    skipBtn.addEventListener('click', onSkip);
  });
}

// ── ⏸ 개입 게이트 ──────────────────────────────────────
function holdGate() {
  if (!state.holdWanted) return Promise.resolve();
  state.holdWanted = false;
  $('#btn-hold').classList.remove('armed');
  panel('#intervene-panel', true);
  renderInspectClock();
  showIvTab('interview');
  return new Promise(resolve => { state.holdRelease = resolve; });
}
function releaseHold() {
  panel('#intervene-panel', false);
  closeInterview();
  const f = state.holdRelease; state.holdRelease = null;
  if (f) f();
}
function showIvTab(tab) {
  for (const t of ['interview', 'inspect', 'notice']) panel(`#iv-${t}`, t === tab);
  $$('.iv-tab').forEach(b => b.classList.toggle('danger', b.dataset.tab === tab));
  if (tab === 'inspect') renderInspectClock();
}

/**
 * 지금 몇 시인가 — 점검 탭의 제일 중요한 한 줄이다.
 * 자리는 유저가 고르지만 시간은 못 고른다: 일과를 세운 그 시각이 곧 급습 시각이다.
 * 그래서 「생활관을 언제 털 것인가」가 하루를 어느 슬롯에서 세우느냐의 문제가 된다.
 *
 * **무엇이 도는지는 여기서도 안 알려준다.** 알려주는 것은 시각 하나뿐이고, 그 시각에 무엇이
 * 도는가는 명부를 읽어서 아는 것이다 — 명부의 「이 시간에만 돈다」 줄이 그래서 거기 있다.
 */
function renderInspectClock() {
  const slot = state.engine?.slotNow;
  const el = $('#inspect-when');
  if (!el) return;
  el.innerHTML = slot
    ? `지금은 <b>${escapeHtml(slot.label)} ${escapeHtml(slot.time)}</b>다. `
      + '이 시각에 그 자리에서 도는 것만 잡힌다 — 시간이 어긋나면 방은 깨끗하다.'
    : '일과 밖이다 — 시간을 안 따진다.';
}

// ── 개입 셋 ─────────────────────────────────────────────
function closeInterview() {
  state.interviewHandle = null;
  $('#interview-log').innerHTML = '';
  panel('#interview-more', false);
  $('#btn-interview-send').disabled = false;
}

async function doInterview() {
  const serial = $('#interview-who').value;
  const q = $('#interview-q').value.trim();
  if (!serial || !q) return toast('병사와 질문을 정하라.');
  $('#btn-interview-send').disabled = true;
  const h = await attempt('병사 호출 중', () => state.engine.interview(serial, q),
    { onError: () => { $('#btn-interview-send').disabled = false; } });
  if (!h) return;
  state.interviewHandle = h;
  $('#interview-log').innerHTML += `<p class="iv-q">나: ${escapeHtml(q)}</p><p class="iv-a">${escapeHtml(who(h.soldier))}: ${escapeHtml(h.reply)}</p>`
    + `<p class="iv-heal">멘탈 ${h.mental.before} → <b>${h.mental.after}</b> — 들어준 만큼은 남는다</p>`;
  panel('#interview-more', true);
  renderHud(); renderRoster();
  saveCampaign();
}

async function doInterviewMore() {
  const h = state.interviewHandle;
  const q = $('#interview-q2').value.trim();
  if (!h || !q) return;
  $('#interview-q2').value = '';
  const out = await attempt('면담 중', () => h.ask(q));
  if (out == null) return;
  $('#interview-log').innerHTML += `<p class="iv-q">나: ${escapeHtml(q)}</p><p class="iv-a">${escapeHtml(who(h.soldier))}: ${escapeHtml(out)}</p>`;
}

async function doInspect() {
  const key = $('#inspect-where').value;
  const out = await attempt('군기 점검 중', () => state.engine.inspect(key));
  if (!out) return;
  // 적발 목록은 소견 아래에 **따로** 박아 준다. 산문에 묻히면 명부에 뭐가 올랐는지 모른다.
  const caught = out.spotted.length
    ? `\n적발 — ${out.spotted.map(g => `[${g.grade.label}] ${g.label}`).join(' · ')} (명부에 올렸다)`
    : '\n적발 없음 — 제때 치웠거나, 지금 이 시간 여기서는 아무것도 안 돌고 있었다.';
  // 재판급은 정체만 사고 나오는 것이 아니다. 그 자리에서 끊긴다.
  const pulled = out.pulled.length
    ? `\n■ 재판급이라 그 자리에서 끊었다 — ${out.pulled.map(g => g.label).join(' · ')} (가라 추가 −${out.pulled.length})`
    : '';
  const when = out.slot ? ` · ${out.slot.label} ${out.slot.time}` : '';
  await addEntry('inspect', `🔦 군기 점검 · ${out.place}${when}\n${out.findings}${caught}${pulled}`, { typed: false });
  renderHud();
  saveCampaign();
  if (out.pulled.length) sfx.trombone();
  toast(out.spotted.length
    ? `${out.spotted.length}건 적발 — 가라 −${1 + out.pulled.length} · 행복 −1 · 평판 −1`
    : '각은 잡혔지만 잡은 건 없다 — 가라 −1 · 행복 −1 · 평판 −1');
}

async function doNotice() {
  const text = $('#notice-input').value.trim();
  if (!text) return toast('빈 공지는 게시할 수 없다.');
  const out = await attempt('공지 게시 중', () => state.engine.postNotice(text));
  if (!out) return;
  $('#notice-input').value = '';
  renderNotices();
  renderHud();
  saveCampaign();
  // 막은 것과 실제로 끊긴 것은 다르다 — 안 돌던 것을 막으면 문만 닫히고 가라는 안 내려간다.
  const shut = out.banned.length ? `\n지침이 닫은 문 — ${out.banned.map(g => g.label).join(' · ')}` : '';
  const cut = out.cut.length ? `\n실제로 끊긴 것 — ${out.cut.map(g => g.label).join(' · ')} (가라 −${out.cut.length})` : '';
  await addEntry('sys', `📢 공지 게시. 어디선가 한마디 — "${out.reaction}"${shut}${cut}`, { typed: false });
}

// ── 배선 ────────────────────────────────────────────────
function wire() {
  initBoot({
    llm,
    onBooted: name => { state.name = name; renderUnits(); show('unit'); },
    onFailed: () => show('boot'),
    errMsg,
  });

  // 재생 속도 + 눌러서 건너뛰기
  const paceBox = $('#pace-buttons');
  paceBox.innerHTML = pace.PACE_STEPS.map(s => `<button class="btn95 tiny" data-pace="${s.key}" type="button">${s.label}</button>`).join('');
  const syncPace = () => paceBox.querySelectorAll('button').forEach(b => b.classList.toggle('danger', b.dataset.pace === pace.getPace()));
  paceBox.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { pace.setPace(b.dataset.pace); syncPace(); }));
  syncPace();
  pace.attachSkip($('#screen-day'));
  pace.onWaitChange(v => $('#day-advance').classList.toggle('on', v));

  $('#btn-hold').addEventListener('click', () => {
    sfx.click();
    state.holdWanted = !state.holdWanted;
    $('#btn-hold').classList.toggle('armed', state.holdWanted);
    toast(state.holdWanted ? '다음 슬롯 경계에서 일과가 선다.' : '세우기 취소.');
  });
  $$('.iv-tab').forEach(b => b.addEventListener('click', () => { sfx.click(); showIvTab(b.dataset.tab); }));
  $('#btn-intervene-close').addEventListener('click', () => { sfx.click(); releaseHold(); });
  $('#btn-interview-send').addEventListener('click', doInterview);
  $('#btn-interview-more').addEventListener('click', doInterviewMore);
  $('#btn-interview-close').addEventListener('click', () => { closeInterview(); $('#interview-q').value = ''; });
  // 장소마다 드러나는 것이 다르다 — 대응표가 코드에 있는데 화면에 없으면
  // 유저는 여덟 개 중 무엇을 골라야 하는지 알 길이 없다. 표를 그대로 옵션에 싣는다.
  // 조사는 안 붙인다: 「가라가」와 「평판이」를 가르려면 받침을 봐야 하는데,
  // 그 규칙을 이 한 줄 때문에 들여올 값은 안 된다.
  $('#inspect-where').innerHTML = Object.entries(PLACES).map(([k, p]) =>
    `<option value="${k}">${escapeHtml(p.label)} — ${escapeHtml(p.reveals.map(r => PARAM_LABELS[r]).join(' · '))}</option>`).join('');
  $('#btn-inspect-go').addEventListener('click', doInspect);
  $('#btn-notice-post').addEventListener('click', doNotice);
  $('#btn-next-day').addEventListener('click', () => { sfx.click(); runOneDay(); });
  $('#btn-farewell-retry').addEventListener('click', () => { sfx.click(); runFarewell(); });
  $('#btn-farewell-end').addEventListener('click', () => {
    sfx.click();
    panel('#farewell-panel', false);
    renderUnits();
    show('unit');
  });

  const toggleConsole = () => $('#console-panel').classList.toggle('hidden');
  $('#console-toggle').addEventListener('click', toggleConsole);
  $('#btn-console').addEventListener('click', toggleConsole);
  $('#btn-bgm').addEventListener('click', () => { $('#btn-bgm').textContent = toggleBgm() ? '음향 ON' : '음향 OFF'; unlockAudio(); });
}

wire();
