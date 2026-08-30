// pacing.js — 대화를 '사람이 읽는 속도'로 붙잡아 두는 층.
//
// 여기가 생기기 전에는 LLM 응답이 도착하는 즉시 말풍선이 꽂혔다. 한 턴 안에서 타겟 응답과
// 판정이 동시에 발사되니(engine.js) 두 줄이 거의 같은 순간에 튀어나오고, 읽는 사람은
// 스크롤이 올라간 뒤에야 뭔가 지나갔다는 걸 알았다. 재생 속도가 아니라 도착 속도였던 것이다.
//
// 그래서 engine이 bubble/judge 핸들러를 await 하게 하고, 실제로 얼마나 붙잡을지는 전부 여기서 정한다.
// 게임 로직도 LLM도 이 파일을 모른다. DOM도 attach/typeInto를 부를 때만 만진다.
//
// 기준: 한국어 묵독은 성인 기준 대략 분당 500~700자다. 채팅체는 그보다 빨리 읽히고
// 화면에는 이름표·판정줄이 같이 있으니, '보통'을 초당 11자(분당 660자)로 잡고
// 새 말풍선으로 눈이 옮겨가는 시간(약 0.6초)을 앞에 얹었다.
// 그래도 사람마다 다르다 — 그래서 속도 4단계와 '눌러서 건너뛰기'가 같이 있다.

const READ_BASE_MS = 600;     // 눈이 새 말풍선으로 옮겨가는 시간
const READ_PER_CHAR = 90;     // 초당 약 11자
const READ_MIN_MS = 1100;     // 한 글자짜리라도 이만큼은 머문다
const READ_MAX_MS = 9000;     // 아무리 길어도 여기서 끊는다 (건너뛰기가 있으니까)
const TYPE_CPS = 26;          // 타자 연출 속도. 읽는 속도보다 빨라야 눈이 글자를 기다리지 않는다
const MIN_BEAT_MS = 400;      // 타자가 끝난 뒤 최소한의 숨
const JUDGE_MAX_MS = 3500;    // 판정줄은 훑어보는 것이라 상한을 낮게

export const PACE_STEPS = [
  { key: 'slow', label: '느긋', mult: 1.6 },
  { key: 'normal', label: '보통', mult: 1 },
  { key: 'fast', label: '빠르게', mult: 0.6 },
  { key: 'instant', label: '즉시', mult: 0 },
];
export const DEFAULT_PACE = 'normal';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const stepOf = key => PACE_STEPS.find(s => s.key === key) || PACE_STEPS.find(s => s.key === DEFAULT_PACE);

// ── 순수 계산부 (DOM 없이 테스트된다) ─────────────────────
// 글 하나를 화면에 붙잡아 둘 총 시간. 타자 연출도 이 시간 안에서 이뤄진다.
export function readMs(text, mult = paceMult()) {
  const len = String(text || '').length;
  if (mult <= 0) return 0;
  return Math.round(clamp(READ_BASE_MS + len * READ_PER_CHAR, READ_MIN_MS, READ_MAX_MS) * mult);
}

// 말풍선 하나의 재생 계획. 타자로 흐르는 동안 이미 읽히므로, 남은 만큼만 더 기다린다.
export function bubblePlan(text, mult = paceMult()) {
  const total = readMs(text, mult);
  if (total <= 0) return { total: 0, typeMs: 0, beatMs: 0 };
  const typeMs = Math.round(String(text || '').length / (TYPE_CPS / mult) * 1000);
  return { total, typeMs, beatMs: Math.max(MIN_BEAT_MS, total - typeMs) };
}

// 판정줄은 숫자와 한 줄 사유가 전부다. 말풍선만큼 붙잡으면 지루해진다.
export function judgeMs(reason, mult = paceMult()) {
  if (mult <= 0) return 0;
  return Math.min(readMs(reason, mult), Math.round(JUDGE_MAX_MS * mult));
}

// ── 속도 설정 ────────────────────────────────────────────
// URL의 ?pace=가 최우선(테스트·시연용), 그다음이 저장된 값이다.
let current = null;
const listeners = new Set();

function readStored() {
  try {
    const q = new URLSearchParams(location.search).get('pace');
    if (q && PACE_STEPS.some(s => s.key === q)) return q;
  } catch { /* location이 없는 환경 */ }
  try {
    const v = localStorage.getItem('csm_pace');
    if (v && PACE_STEPS.some(s => s.key === v)) return v;
  } catch { /* 스토리지 차단 */ }
  return DEFAULT_PACE;
}

export function getPace() { return current ?? (current = readStored()); }
export function paceMult() { return stepOf(getPace()).mult; }

export function setPace(key) {
  if (!PACE_STEPS.some(s => s.key === key)) return getPace();
  current = key;
  try { localStorage.setItem('csm_pace', key); } catch { /* 스토리지 차단 */ }
  for (const fn of listeners) { try { fn(key); } catch { /* 리스너 실패는 무시 */ } }
  skipNow();   // 느려지든 빨라지든, 지금 기다리는 줄은 바로 풀어준다
  return key;
}

export function onPaceChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── 대기와 건너뛰기 ──────────────────────────────────────
// 화면을 한 번 누르면 지금 기다리는 것 하나가 끝난다. 타자 중이면 남은 글자가 즉시 채워지고,
// 숨 고르는 중이면 바로 다음 줄로 간다. 한 번에 한 칸씩만 — 실수로 끝까지 날아가지 않는다.
let wake = null;
let skipSeq = 0;
let waiting = false;
const waitListeners = new Set();

export function onWaitChange(fn) { waitListeners.add(fn); return () => waitListeners.delete(fn); }
function setWaiting(v) {
  if (waiting === v) return;
  waiting = v;
  for (const fn of waitListeners) { try { fn(v); } catch { /* 리스너 실패는 무시 */ } }
}
export function isWaiting() { return waiting; }

export function skipNow() {
  skipSeq++;
  const f = wake; wake = null;
  if (f) f();
}

export function beat(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (wake === finish) wake = null;
      setWaiting(false);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (wake) wake();       // 앞의 대기가 남아 있으면 정리하고 자리를 넘겨받는다
    wake = finish;
    setWaiting(true);
  });
}

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// 글자를 흘려 넣는다. onTick은 스크롤을 따라 내리라고 있는 것이다.
export async function typeInto(el, text, onTick, opts = {}) {
  const s = String(text || '');
  const mult = opts.mult ?? paceMult();
  const ms = opts.typeMs ?? bubblePlan(s, mult).typeMs;
  if (!s || ms <= 0 || mult <= 0 || reducedMotion()) {
    el.textContent = s; onTick?.();
    return;
  }
  const step = Math.max(1, Math.ceil(s.length / 200));   // 긴 글은 뭉텅이로 — 프레임을 갉아먹지 않게
  const chunks = Math.ceil(s.length / step);
  const per = Math.max(12, ms / chunks);
  const seq = skipSeq;
  el.textContent = '';
  for (let i = 0; i < s.length; i += step) {
    el.textContent = s.slice(0, i + step);
    onTick?.(i);
    await beat(per);
    if (skipSeq !== seq) break;   // 누르면 나머지는 한꺼번에
  }
  el.textContent = s;
  onTick?.();
}

// ── 입력 연결 ────────────────────────────────────────────
// 버튼·입력칸 위에서 누른 것은 건너뛰기로 치지 않는다. 조작하려다 대사가 날아가면 안 된다.
const IGNORE = 'input, textarea, select, button, a, [contenteditable]';

export function attachSkip(root, doc = document) {
  if (!root) return () => {};
  // 키보드는 문서 전체에서 받되, 그 화면이 떠 있을 때만 가로챈다.
  // 다른 화면에서 스페이스로 스크롤하던 것까지 막으면 그건 그냥 고장이다.
  const live = () => !root.classList.contains('hidden');
  const onPointer = e => { if (!e.target?.closest?.(IGNORE)) skipNow(); };
  const onKey = e => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    if (!live() || e.target?.closest?.(IGNORE)) return;
    e.preventDefault();
    skipNow();
  };
  root.addEventListener('pointerup', onPointer);
  doc.addEventListener('keydown', onKey);
  return () => { root.removeEventListener('pointerup', onPointer); doc.removeEventListener('keydown', onKey); };
}

// ── 일과 세우기 / 재개 ───────────────────────────────────
//
// ⏸ 버튼은 오래도록 **예약 토글**이기만 했다: 누르면 「다음 슬롯 경계에서 선다」가 켜지고,
// 다시 누르면 그 예약이 꺼진다. 그런데 사람은 이 버튼을 **재생/일시정지**로 읽는다 —
// 멈춘 뒤에 다시 누르면 재개될 거라고 생각한다. 실제로는 아무 일도 안 일어났고,
// 재개는 개입 콘솔 **안쪽**의 「콘솔 닫기」 버튼에만 있었다.
//
// 더 나빴던 것은 그 헛누름이 조용하지 않았다는 점이다. 멈춘 상태에서 ⏸를 누르면
// 「다음 슬롯 세우기」가 다시 예약돼서, 콘솔을 닫아 재개하는 순간 **한 칸 가고 또 섰다.**
// 브라우저로 재현한 순서가 이랬다: ⏸(멈춤) → ⏸(아무 일 없음) → 재개(한 칸 가고 콘솔이
// 도로 열림). 눌러도 안 되고 풀어도 도로 서니 통째로 고장 난 것으로 보인다.
//
// 그래서 상태를 셋으로 못박고 버튼 하나가 셋을 다 맡는다. 화면(game.js)은 DOM만 만지고
// 규칙은 여기 있다 — 이 갈래가 코드에 흩어져 있어서 「멈춰 있을 때 누르면」 칸이 빈 것이다.
export const HOLD = { idle: 'idle', armed: 'armed', held: 'held' };

/** 지금 상태에서 ⏸를 누르면 무엇이 되는가. act는 화면이 실제로 할 일이다. */
export function holdPress(state) {
  if (state === HOLD.held) return { state: HOLD.idle, act: 'resume' };
  if (state === HOLD.armed) return { state: HOLD.idle, act: 'disarm' };
  return { state: HOLD.armed, act: 'arm' };
}

/** 버튼에 뭐라고 쓸 것인가. 상태가 글자에 안 나오면 누르기 전에는 알 수가 없다. */
export function holdLabel(state) {
  if (state === HOLD.held) return '▶ 일과 재개';
  if (state === HOLD.armed) return '⏸ 세우는 중…';
  return '⏸ 일과 세우기';
}

/** 눌렀을 때 띄울 말. 재개는 화면이 통째로 바뀌므로 말이 필요 없다. */
export function holdToast(act) {
  if (act === 'arm') return '다음 슬롯 경계에서 일과가 선다.';
  if (act === 'disarm') return '세우기 취소.';
  return null;
}
