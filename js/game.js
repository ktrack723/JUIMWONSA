// game.js — 화면·입력. 게임 규칙은 여기 없다 — engine.js를 손잡이(handlers)로만 만진다.
//
// 화면 셋: 부팅 → 부대 선택 → 하루(브리핑·타임라인·사건·개입).
// 파라미터 계기판은 없다 — 브리핑의 증상을 읽는 것이 게임이다. 화면에 뜨는 수치는
// 무사고 카운터·날짜·진급 심사일·사고 누계뿐이다.
//
// 일과 무대(sprites.js)는 연출이다 — 해가 움직이고 병사 판때기들이 장소를 옮겨 다니며
// 말풍선을 띄운다. 그 대사는 **부임 때 한 번 받아 둔 캐시 풀**(ambient.js)에서 나오므로
// 하루의 콜 수를 한 건도 늘리지 않는다. 군가는 units.js의 static 인용이라 아예 공짜다.

import { LlmClient, RefusalError, normalizeUsage } from './llm.js';
import { Engine } from './engine.js';
import { UNITS, UNIT_BY_ID } from './units.js';
import { Roster, staggeredJoinDates, ROSTER_SIZE, rankLine, rankOf, cohortOf } from './roster.js';
import { PLACES, slotsFor, weekdayOf, dayFraction } from './params.js';
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
  $('#dayend-panel').classList.add('hidden');
  runOneDay();
}

// ── 상황판 ──────────────────────────────────────────────
function renderHud() {
  const s = state.engine.snapshot();
  $('#hud-date').textContent = `${s.date} (${s.weekday}) · 부임 ${s.day}일차`;
  $('#hud-streak').textContent = `${s.streak}일 / ${s.goal}일`;
  $('#hud-review').textContent = s.reviewDate;
  $('#hud-accidents').textContent = `${s.accidents}건`;
  $('#hud-unit').textContent = `${state.unit.name} · 병력 ${s.roster}명`;
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
  $('#stage-places').innerHTML = Object.values(PLACES)
    .map(pl => `<span class="stage-place" style="left:${(pl.x * 100).toFixed(1)}%">${escapeHtml(pl.label)}</span>`).join('');
}

/** 슬롯 하나로 무대를 옮긴다 — 해·하늘·통근·말풍선. */
function stageTo(slot, chatter = []) {
  const sky = $('#stage-sky');
  const f = dayFraction(slot.time);
  state.stage?.goto(slot);
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
function markIncident(on) {
  const box = $('#stage-bubbles');
  box.querySelector('.incident-mark')?.remove();
  if (!on) return;
  const pos = state.stage?.ok ? state.stage.positions() : [];
  const p = pos.length ? pos[Math.floor(Math.random() * pos.length)] : { x: 0.5 };
  const el = document.createElement('div');
  el.className = 'incident-mark';
  el.textContent = '❗';
  el.style.left = `${(p.x * 100).toFixed(1)}%`;
  box.appendChild(el);
}

/** 말풍선. 스프라이트가 서 있는 자리에 붙는다 — 대사는 캐시 풀에서 왔고 콜은 없다. */
function speak(chatter) {
  const box = $('#stage-bubbles');
  // ❗는 대응이 끝날 때까지 살아 있어야 한다 — 말풍선만 갈아 끼운다.
  box.querySelectorAll('.bubble').forEach(b => b.remove());
  if (!chatter?.length) return;
  const pos = state.stage?.ok ? state.stage.positions() : [];
  chatter.slice(0, 3).forEach((c, i) => {
    const el = document.createElement('div');
    el.className = `bubble ${c.kind}${c.kind === 'song' && c.mode === 'broadcast' ? ' broadcast' : ''}`;
    // 군가는 누가 부르는지가 아니라 어디서 오는지가 다르다 — 목이냐 스피커냐.
    el.textContent = c.kind === 'song'
      ? (c.mode === 'broadcast' ? `📻 ♪ ${c.text}` : `♪ ${c.text}`)
      : c.text;
    if (c.kind === 'song') el.title = c.title;
    const p = pos[(i * 4 + 1) % Math.max(1, pos.length)];
    el.style.left = `${((p ? p.x : 0.2 + i * 0.3) * 100).toFixed(1)}%`;
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
  $('#roster-list').innerHTML = rows.map(({ s, cohort, rank }) =>
    `<details class="roster-row"><summary><span class="rk rk-${rank}">${escapeHtml(rank)}</span> ${escapeHtml(s.name)}
      <span class="dim">${cohort}기 · ${escapeHtml(s.job)} · ${escapeHtml(s.grade)}/${escapeHtml(s.character)}</span></summary>
      <p>${escapeHtml(s.sheet) || '<span class="dim">인사기록 미도착</span>'}</p>
      <p class="dim small">군번 ${escapeHtml(s.serial)} · 전입 ${escapeHtml(s.joined)}</p></details>`).join('')
    || '<p class="dim">병력 없음</p>';
  // 면담 대상 목록도 같은 원장에서 — 부를 때도 기수·계급이 보여야 한다
  $('#interview-who').innerHTML = rows.map(({ s, cohort, rank }) =>
    `<option value="${escapeHtml(s.serial)}">${cohort}기 ${escapeHtml(rank)} ${escapeHtml(s.name)} (${escapeHtml(s.job)})</option>`).join('');
}

function renderNotices() {
  const list = state.engine.state.notices;
  $('#notice-list').innerHTML = list.length
    ? list.map((n, i) => `<li>${escapeHtml(n)} <button class="btn95 tiny" data-del="${i}" type="button">철회</button></li>`).join('')
    : '<li class="dim">게시된 지침 없음</li>';
  $('#notice-list').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    state.engine.removeNotice(Number(b.dataset.del));
    saveCampaign();
    renderNotices();
  }));
}

// ── 동향 기록 창 ────────────────────────────────────────
async function addEntry(kind, text, { typed = true } = {}) {
  const win = $('#day-window');
  const div = document.createElement('div');
  div.className = `day-entry ${kind}`;
  win.appendChild(div);
  const scroll = () => { win.scrollTop = win.scrollHeight; };
  if (typed) await pace.typeInto(div, text, scroll);
  else { div.textContent = text; scroll(); }
  await pace.beat(pace.readMs(text) * 0.4);
}

// ── 엔진 손잡이 — 하루의 전부가 여기로 들어온다 ─────────
function makeHandlers() {
  return {
    briefing: async ({ date, briefing, arrivals, departures }) => {
      renderHud(); renderRoster(); renderTimeline(-1);
      stageTo(slotsFor(date)[0], []);
      await addEntry('briefing', `[아침 브리핑 · ${date}]\n${briefing}`);
      const st = x => rankLine(state.unit, x, date);
      for (const d of departures || []) await addEntry('sys', `${st(d)} ${d.name} 전역 신고. 위병소 밖은 그의 소관이 아니다.`, { typed: false });
      for (const a of arrivals || []) await addEntry('sys', `${st(a)} ${a.name} 전입 신고 — ${a.job}, 군번 ${a.serial}.`, { typed: false });
    },
    slot: async ({ index, slot, line, chatter }) => {
      renderTimeline(index);
      stageTo(slot, chatter);
      if (line) await addEntry('slot', `[${slot.label}] ${line}`);
      else await addEntry('slot', `[${slot.label}]`, { typed: false });
      await holdGate();   // ⏸가 눌려 있으면 여기서 선다
    },
    incident: async ({ scene, place, slot }) => {
      sfx.bad();
      markIncident(true);
      await addEntry('incident', `❗ ${slot.label} · ${place}\n${scene}`);
      return await askDirective();
    },
    outcome: async ({ scene }) => {
      markIncident(false);
      await addEntry('outcome', scene);
    },
    verdict: async ({ escalated, tier }) => {
      if (escalated) {
        sfx.trombone();
        await addEntry('stamp', `■ 사고 확정 (${tier === 'major' ? '중대' : '경미'}) — 무사고 기록 0일로 회귀. 날짜는 돌아가지 않는다.`, { typed: false });
      } else {
        sfx.love();
        await addEntry('stamp', '□ 수습 — 사건은 사고가 되지 않았다. 무사고 기록 유지.', { typed: false });
      }
      renderHud();
    },
    dayEnd: async (snap) => {
      renderHud(); renderTimeline(9); renderNotices();
      saveCampaign();
      if (snap.promoted) return showPromotion(snap);
      $('#dayend-text').innerHTML =
        `저녁점호 이상 무. <b>무사고 ${snap.streak}일차</b>로 하루를 닫는다.<br>` +
        `다음 날: ${escapeHtml(snap.date)} (${escapeHtml(weekdayOf(snap.date))}) · 진급 심사일 ${escapeHtml(snap.reviewDate)}`;
      $('#dayend-panel').classList.remove('hidden');
    },
  };
}

async function runOneDay() {
  $('#dayend-panel').classList.add('hidden');
  try {
    await state.engine.runDay();
  } catch (e) {
    toast(`${errMsg(e)} — 브리핑부터 다시 연다.`);
    $('#dayend-text').textContent = '회선이 끊겨 하루가 열리지 못했다. 다시 시도하라.';
    $('#btn-next-day').textContent = '재시도 — 아침점호 ▶';
    $('#dayend-panel').classList.remove('hidden');
    return;
  }
  $('#btn-next-day').textContent = '다음 날 아침점호 ▶';
}

function showPromotion(snap) {
  const acc = snap.accidents;
  $('#promo-text').innerHTML =
    `<b>무사고 연속 ${snap.goal}일. ${escapeHtml(snap.date)} 부로 원사 진급 상신이 통과됐다.</b><br>` +
    (acc ? `그동안 사고 ${acc}건을 딛고 온 길이다. 병사들은 아무도 축하한다는 말을 안 했지만, 오늘 배식줄이 이상하게 조용했다.`
      : `부임 후 단 한 건도 터뜨리지 않았다. 완벽한 100일 — 심사장에서 아무도 그 말을 믿지 않았다.`);
  $('#promo-panel').classList.remove('hidden');
  sfx.fanfare();
}

// ── 사건 대응 입력 ──────────────────────────────────────
function askDirective() {
  return new Promise(resolve => {
    const panel = $('#incident-panel');
    const input = $('#incident-input');
    input.value = '';
    panel.classList.remove('hidden');
    input.focus();
    const done = v => {
      panel.classList.add('hidden');
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
  $('#intervene-panel').classList.remove('hidden');
  showIvTab('interview');
  return new Promise(resolve => { state.holdRelease = resolve; });
}
function releaseHold() {
  $('#intervene-panel').classList.add('hidden');
  closeInterview();
  const f = state.holdRelease; state.holdRelease = null;
  if (f) f();
}
function showIvTab(tab) {
  for (const t of ['interview', 'inspect', 'notice']) {
    $(`#iv-${t}`).classList.toggle('hidden', t !== tab);
  }
  $$('.iv-tab').forEach(b => b.classList.toggle('danger', b.dataset.tab === tab));
}

// ── 개입 셋 ─────────────────────────────────────────────
function closeInterview() {
  state.interviewHandle = null;
  $('#interview-log').innerHTML = '';
  $('#interview-more').classList.add('hidden');
  $('#btn-interview-send').disabled = false;
}

async function doInterview() {
  const serial = $('#interview-who').value;
  const q = $('#interview-q').value.trim();
  if (!serial || !q) return toast('병사와 질문을 정하라.');
  $('#btn-interview-send').disabled = true;
  try {
    const h = await withLoading('병사 호출 중', () => state.engine.interview(serial, q));
    state.interviewHandle = h;
    const who = `${rankLine(state.unit, h.soldier, state.engine.state.date)} ${h.soldier.name}`;
    $('#interview-log').innerHTML += `<p class="iv-q">나: ${escapeHtml(q)}</p><p class="iv-a">${escapeHtml(who)}: ${escapeHtml(h.reply)}</p>`;
    $('#interview-more').classList.remove('hidden');
    saveCampaign();
  } catch (e) {
    toast(errMsg(e));
    $('#btn-interview-send').disabled = false;
  }
}

async function doInterviewMore() {
  const h = state.interviewHandle;
  const q = $('#interview-q2').value.trim();
  if (!h || !q) return;
  $('#interview-q2').value = '';
  try {
    const out = await withLoading('면담 중', () => h.ask(q));
    const who = `${rankLine(state.unit, h.soldier, state.engine.state.date)} ${h.soldier.name}`;
    $('#interview-log').innerHTML += `<p class="iv-q">나: ${escapeHtml(q)}</p><p class="iv-a">${escapeHtml(who)}: ${escapeHtml(out)}</p>`;
  } catch (e) { toast(errMsg(e)); }
}

async function doInspect() {
  const key = $('#inspect-where').value;
  try {
    const out = await withLoading('불시점검 중', () => state.engine.inspect(key));
    await addEntry('inspect', `🔦 불시점검 · ${out.place}\n${out.findings}`, { typed: false });
    saveCampaign();
    toast('점검 소견이 동향 기록에 붙었다. (평판 −1)');
  } catch (e) { toast(errMsg(e)); }
}

async function doNotice() {
  const text = $('#notice-input').value.trim();
  if (!text) return toast('빈 공지는 게시할 수 없다.');
  try {
    const out = await withLoading('공지 게시 중', () => state.engine.postNotice(text));
    $('#notice-input').value = '';
    renderNotices();
    saveCampaign();
    await addEntry('sys', `📢 공지 게시. 어디선가 한마디 — "${out.reaction}"`, { typed: false });
  } catch (e) { toast(errMsg(e)); }
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
  $('#inspect-where').innerHTML = Object.entries(PLACES).map(([k, p]) => `<option value="${k}">${escapeHtml(p.label)}</option>`).join('');
  $('#btn-inspect-go').addEventListener('click', doInspect);
  $('#btn-notice-post').addEventListener('click', doNotice);
  $('#btn-next-day').addEventListener('click', () => { sfx.click(); runOneDay(); });

  const toggleConsole = () => $('#console-panel').classList.toggle('hidden');
  $('#console-toggle').addEventListener('click', toggleConsole);
  $('#btn-console').addEventListener('click', toggleConsole);
  $('#btn-bgm').addEventListener('click', () => { $('#btn-bgm').textContent = toggleBgm() ? '음향 ON' : '음향 OFF'; unlockAudio(); });
}

wire();
