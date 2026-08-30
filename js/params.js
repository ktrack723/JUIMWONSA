// params.js — 코드가 들고 있는 수치 전부. LLM 없이 단독 테스트가 된다.
//
// 구조도에서 검은 칸(⬛ code)에 해당하는 것들이 여기 산다.
//   · 부대 파라미터 5종의 눈금·시작값·드리프트
//   · 사고 판정 롤 공식 (하루 9슬롯마다 한 번)
//   · 병사 등급 추첨 (지능·마초 가중)
//   · 장소-파라미터 대응표 (불시점검이 어느 파라미터를 드러내는가)
//   · 사건 후보 풀과 심각도 티어 (LLM은 장면만 쓴다 — 풀 밖 창작은 없다)
//   · 사고 유형 열둘과 유형별 그림 자리 (사건이 확전하면 유형이 넘어가는 표까지)
//   · 날짜 규칙 (부임일 = 오늘 − 100일 · 계절 · 주말)
//   · 파라미터 → 5단계 밴드 변환 (수치는 프롬프트에 절대 안 나간다)
//
// 눈금은 연애조작단 규칙 그대로 — **0~10, 한 걸음 1칸.** 화면의 숫자가 곧
// 「몇 번 움직였나」다. 심판(E-3·N)이 돌려주는 것은 방향(up/down/same)뿐이고
// 폭은 전부 여기서 정한다.
//
// 수치·확률·가중치의 실값은 TUNING 상수 하나에 모은다. 밸런싱은 이 파일만 만진다.

// ── 눈금 ─────────────────────────────────────────────────
export const SCALE = { min: 0, max: 10 };
const clamp = v => Math.max(SCALE.min, Math.min(SCALE.max, v));

// 파라미터 다섯. difficulty만 static이다 — 부대 프롬프트가 정하고 계절 보정만 받는다.
export const PARAM_KEYS = ['gara', 'happy', 'conflict', 'rep'];
export const PARAM_LABELS = {
  difficulty: '일과 난이도', gara: '가라', happy: '행복도', conflict: '갈등·부조리', rep: '평판',
};

export const TUNING = {
  // 시작값. 부임 첫날의 부대 — 적당히 대충 하고, 그럭저럭 지내고, 서열은 있다.
  start: { gara: 4, happy: 5, conflict: 3, rep: 5 },

  // 사고 판정 롤 (슬롯마다 한 번, LLM 없음) —
  //   작은사건 위험 = 기본치 + 마초 가중 + max(0, 가라+난이도−10)·w + max(0, 가라−지능)·w − 갈등 억제분
  //   큰사건 위험   = (갈등 ≥ big.open 이면) (갈등 − big.open + 1) × big.per
  roll: {
    base: 0.015,          // 아무 일 없어도 군대는 군대다
    machoPer: 0.006,      // 마초 1당
    hardSloppyPer: 0.03,  // 힘든 일을 대충 하면 다친다 — max(0, 가라+난이도−10) 1당
    dumbSloppyPer: 0.02,  // 대충할 머리가 안 됨 — max(0, 가라−지능) 1당
    suppressAt: 5,        // 갈등이 이 이상이면 잔사고가 줄어든다 (군기가 눌러 놓는다)
    suppress: 0.02,       // 억제분
    big: { open: 8, per: 0.02 },  // 8을 넘기면 큰 사고 전용 위험이 열린다
    slotMult: {           // 슬롯 성격 보정 — 일과 슬롯이 제일 위험하고 수면은 조용하다
      work: 1.5, meal: 0.8, rest: 1.0, rollcall: 0.7, sleep: 0.4,
    },
  },

  // 일일 드리프트 — 하루 마감에 적용. 각 파라미터 하루 최대 ±1칸.
  drift: {
    garaHigh: 7, garaLow: 3,      // 가라↑ → 행복 드리프트↑, 가라↓ → 행복 드리프트↓
    hardDay: 8,                   // 난이도 이 이상이면 행복↓·갈등↓ (힘들면 싸울 기력도 없다)
    happyLow: 3, happyHigh: 8,    // 행복↓ → 갈등↑, 행복↑ → 갈등↓
    conflictHigh: 7,              // 갈등↑ → 행복↓
  },

  // 평판 — LLM이 못 건드린다. 개입(면담·점검·공지)마다 −1, 조용한 날 +1 회복.
  rep: { perIntervention: -1, quietDay: +1 },

  // 계절 보정 — 여름 혹서기·겨울 제설이 일과 난이도에 +1. 주말은 일과 없음.
  season: { summerBonus: 1, winterBonus: 1, weekendDifficulty: 1 },

  // 등급 추첨 — 5단계 가중 추첨. 지능이 높으면 등급 상위가, 마초가 높으면
  // 등급·인성 하위가 두꺼워진다. slope는 모집단 수치 1당 가중 기울기.
  grade: { baseWeights: [1, 2, 4, 2, 1], slope: 0.16, floor: 0.05 },

  // 사건 연루자 선정 — 등급이 낮을수록 잘 걸린다.
  involve: { gradeWeights: [5, 3, 2, 1.5, 1] },  // 폐급 → 에이스

  roster: { size: 16 },
  goal: 100,   // 무사고 연속 100일
};

// ── 밴드 — 숨은 파라미터는 프롬프트에 수치로 들어가지 않는다 ──────
// 0~10을 5단계로 낮춰서만 건넨다. 라벨은 영어다 — 지시문과 같은 언어로 가야
// 한글 누출 검사(§9)가 지시문만 남겨 걸러낼 수 있다.
export const BAND_LABELS = ['very-low', 'low', 'mid', 'high', 'very-high'];
export function band(v) {
  const x = clamp(Math.round(v));
  if (x <= 1) return 'very-low';
  if (x <= 3) return 'low';
  if (x <= 6) return 'mid';
  if (x <= 8) return 'high';
  return 'very-high';
}

// 평판 → 면담 솔직도 등급. 덜 간섭할수록 병사들이 입을 연다.
const REP_GRADES = {
  honesty: ['hostile-evasive', 'guarded', 'polite-but-careful', 'fairly-open', 'candid'],
  compliance: ['ignored-or-mocked', 'grudging', 'partial', 'mostly-followed', 'followed-to-the-letter'],
};
const repIdx = rep => BAND_LABELS.indexOf(band(rep));
export const honestyOf = rep => REP_GRADES.honesty[repIdx(rep)];
export const complianceOf = rep => REP_GRADES.compliance[repIdx(rep)];

// ── 날짜 규칙 — 현실 날짜 그대로 기입한다 ─────────────────
// 부임일 = 플레이 시작한 현실의 오늘 − 100일. 게임 1턴 = 달력 1일.
// 달력은 언제나 전진하고, 사고가 나면 무사고 카운터만 0이 된다.
export const dateAdd = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const startDateFor = today => dateAdd(today, -TUNING.goal);

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export const weekdayOf = iso => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
export const isWeekend = iso => ['토', '일'].includes(weekdayOf(iso));
export function seasonOf(iso) {
  const m = Number(iso.slice(5, 7));
  if (m >= 6 && m <= 8) return 'summer';
  if (m === 12 || m <= 2) return 'winter';
  return m <= 5 ? 'spring' : 'autumn';
}
// 계절·요일은 날짜에서 계산한다 — 전부 달력이 정하는 static 입력이다.
export function effectiveDifficulty(baseDifficulty, iso) {
  if (isWeekend(iso)) return TUNING.season.weekendDifficulty;   // 주말 일과 없음
  const s = seasonOf(iso);
  const bonus = s === 'summer' ? TUNING.season.summerBonus
    : s === 'winter' ? TUNING.season.winterBonus : 0;
  return clamp(baseDifficulty + bonus);
}
/** 진급 심사일 — 지금부터 무사고로 완주하면 심사를 받는 날. 터뜨릴수록 미래로 밀린다. */
export const reviewDate = (currentDate, streak) => dateAdd(currentDate, TUNING.goal - streak);

// ── 일과 타임라인 — 슬롯 아홉 ─────────────────────────────
// kind는 사고 롤 보정(roll.slotMult)의 열쇠다. 주말에는 일과 슬롯이 개인정비로 바뀐다.
// time·at은 화면 몫이다 — 해가 뜨는 높이와 병사 스프라이트가 모이는 자리를 정한다.
// 시각은 실제 병영 일과표를 압축한 것이다 (docs/research.md §6):
//   06:30 기상 · 07:00 아침점호 · 07:30 아침식사 · 09:00 오전일과 · 11:45 점심
//   13:00 오후일과 · 16:30 체력단련 · 17:30 저녁식사 · 19:00 개인정비 · 21:30 저녁점호 · 22:00 취침
export const SLOTS = [
  { key: 'reveille', label: '아침점호', kind: 'rollcall', time: '06:40', at: 'barracks' },
  { key: 'breakfast', label: '아침식사', kind: 'meal', time: '07:30', at: 'messhall' },
  { key: 'amwork', label: '오전일과', kind: 'work', time: '09:00', at: 'worksite', weekendLabel: '오전 개인정비', weekendKind: 'rest', weekendAt: 'barracks' },
  { key: 'lunch', label: '점심식사', kind: 'meal', time: '11:45', at: 'messhall' },
  { key: 'pmwork', label: '오후일과', kind: 'work', time: '13:00', at: 'worksite', weekendLabel: '오후 개인정비', weekendKind: 'rest', weekendAt: 'smoking' },
  { key: 'dinner', label: '저녁식사', kind: 'meal', time: '17:30', at: 'messhall' },
  { key: 'rest', label: '하번 후 휴식', kind: 'rest', time: '19:00', at: 'smoking' },
  { key: 'taps', label: '저녁점호', kind: 'rollcall', time: '21:30', at: 'barracks' },
  { key: 'sleep', label: '수면', kind: 'sleep', time: '22:30', at: 'barracks' },
];
export const SLOT_KEYS = SLOTS.map(s => s.key);

export function slotsFor(iso) {
  const weekend = isWeekend(iso);
  return SLOTS.map(s => ({
    key: s.key,
    label: weekend && s.weekendLabel ? s.weekendLabel : s.label,
    kind: weekend && s.weekendKind ? s.weekendKind : s.kind,
    time: s.time,
    at: weekend && s.weekendAt ? s.weekendAt : s.at,
  }));
}

/** 시각 문자열 → 하루의 몇 할이 지났는가 (0..1). 해의 높이와 하늘색이 이걸 본다. */
export function dayFraction(time) {
  const [h, m] = String(time || '12:00').split(':').map(Number);
  return ((h || 0) * 60 + (m || 0)) / 1440;
}

// ── 장소-파라미터 대응표 — 불시점검이 드러내는 것 ─────────
// 생활관은 갈등을, 작업장은 가라를 드러낸다. 장소마다 보이는 파라미터가 다르다 —
// 점검 소견(I-2)에는 그 장소가 드러내는 밴드만 실린다.
// x는 무대 위의 가로 자리(0..1)다 — 스프라이트가 슬롯을 따라 이 자리들 사이를 통근한다.
// 드러내는 파라미터와 무대 자리는 같은 표에 산다: 생활관은 갈등을 드러내고, 무대 왼쪽 끝에 있다.
export const PLACES = {
  guardpost: { label: '위병소', reveals: ['gara'], x: 0.03 },
  barracks: { label: '생활관', reveals: ['conflict'], x: 0.16 },
  messhall: { label: '식당', reveals: ['happy'], x: 0.33 },
  office: { label: '행정반', reveals: ['gara'], x: 0.48 },
  worksite: { label: '작업장', reveals: ['gara'], x: 0.64 },
  armory: { label: '탄약고', reveals: ['gara'], x: 0.78 },
  storage: { label: '창고', reveals: ['gara', 'conflict'], x: 0.89 },
  smoking: { label: '흡연장', reveals: ['happy', 'conflict'], x: 0.98 },
};

// ── 사고 유형 — 이미지가 붙는 자리 ────────────────────────
// 큰 갈래는 지어낸 것이 아니라 군이 실제로 쓰는 구분이다 (docs/research.md §14):
//   · 안전사고(safety)  — 고의 없는 불안전한 행동·상태가 사망·부상·물자 피해를 낸 것
//   · 군기사고(discipline) — 법규를 고의·과실로 어겨 징계·형사처벌 대상이 되는 것
//   · 신상(personnel)   — 자해·자살 시도. 군 사망사고 지표가 위 둘과 따로 세는 자리다
//
// 이 표가 곧 **이미지 대장**이다. 유형 하나에 그림 한 장(`assets/incidents/<id>.svg`)이고,
// 그림이 없으면 icon 글자가 대신 뜬다 — 그림을 갈아 끼우는 데 코드를 안 고쳐도 된다.
// en은 프롬프트로 나가는 표기다(지시문은 영어다 — §9.4). label은 화면 몫이다.
export const INCIDENT_CATEGORIES = {
  injury:    { label: '부상·안전사고', class: 'safety',     icon: '🩹', en: 'injury during work, sport or training' },
  blast:     { label: '화재·폭발',     class: 'safety',     icon: '💥', en: 'fire or explosion — ammunition, fuel, kitchen' },
  vehicle:   { label: '차량·중장비',   class: 'safety',     icon: '🚛', en: 'vehicle or heavy-equipment accident' },
  health:    { label: '보건·환자',     class: 'safety',     icon: '🤒', en: 'mass illness, heat or cold casualty' },
  firearm:   { label: '총기·탄약',     class: 'discipline', icon: '🎯', en: 'firearm or live ammunition mishandled' },
  guard:     { label: '경계·근무 실패', class: 'discipline', icon: '🔭', en: 'guard duty or watch failing' },
  violation: { label: '규정위반 검거',  class: 'discipline', icon: '📱', en: 'caught breaking regulations — phone, gambling, drink' },
  abuse:     { label: '가혹행위·부조리', class: 'discipline', icon: '👊', en: 'abuse, hazing or bullying between soldiers' },
  absent:    { label: '인원이탈',      class: 'discipline', icon: '🚪', en: 'a soldier missing — absent without leave' },
  supply:    { label: '보급·물자',     class: 'discipline', icon: '📦', en: 'supplies or equipment missing or misused' },
  outside:   { label: '대외·민간',     class: 'discipline', icon: '📰', en: 'it reached outside the fence — civilians, press, social media' },
  selfharm:  { label: '자해·신상',     class: 'personnel',  icon: '🕯', en: 'a soldier at risk of harming himself' },
};
export const CATEGORY_KEYS = Object.keys(INCIDENT_CATEGORIES);
export const CATEGORY_CLASSES = { safety: '안전사고', discipline: '군기사고', personnel: '신상사고' };

/** 유형 하나의 그림 자리. 파일이 없으면 화면이 icon으로 떨어진다. */
export const artFor = catId => `assets/incidents/${catId}.svg`;

/**
 * 이 사건을 어느 유형으로 그릴 것인가. 확전한 사건은 `becomes`를 따라 유형이 바뀐다 —
 * 「취침 중 누가 운다」(가혹행위)가 사고가 되면 자해로 넘어가는 식이다. 전부 static 표라
 * **판정 호출이 늘지 않는다.**
 */
export function categoryFor(event, escalated = false) {
  const id = (escalated && event?.becomes) || event?.cat;
  const cat = INCIDENT_CATEGORIES[id];
  if (!cat) return null;
  return { id, ...cat, art: artFor(id), className: CATEGORY_CLASSES[cat.class] };
}

// ── 사건 풀 — 후보와 심각도는 코드가 뽑고, LLM은 장면만 쓴다 ──
// tier: minor(작은사건 롤) / major(큰사건 롤 — 갈등 8 초과에서만 열린다).
// slots: 이 사건이 날 수 있는 슬롯 kind. place: 사건 화면과 E-1 프롬프트에 실린다.
// cat: 유형(위 표) — 이미지와 기록이 이걸 본다. becomes: 확전하면 넘어가는 유형.
// weight: 같은 tier·슬롯에서 뽑힐 무게. 흔한 일이 흔하게 나와야 한다 (기본 1).
//
// **지침은 자유롭게 쓰지만 씨앗은 이 풀 밖으로 안 나간다** — 그래서 무한한 장면에도
// 유형은 언제나 열둘 중 하나로 떨어지고, 그림 한 장이 반드시 대응된다.
// 항목마다의 근거는 docs/research.md §14.
export const EVENT_POOL = [
  // 부상·안전사고 — 제일 흔한 자리
  { id: 'sports-injury', tier: 'minor', cat: 'injury', kinds: ['rest'], place: 'worksite', involved: 2, weight: 3, desc: '족구·축구 중 부상 정황' },
  { id: 'work-accident', tier: 'minor', cat: 'injury', kinds: ['work'], place: 'worksite', involved: 1, weight: 3, desc: '작업 중 안전사고 직전 상황' },
  { id: 'mess-burn', tier: 'minor', cat: 'injury', kinds: ['meal'], place: 'messhall', involved: 1, weight: 2, desc: '취사장 화상·배식 사고 정황' },
  // 차량·중장비
  { id: 'truck-backing', tier: 'minor', cat: 'vehicle', kinds: ['work'], place: 'worksite', involved: 2, weight: 2, desc: '후진하는 차량 뒤로 사람이 지나간다 — 유도자가 없다' },
  { id: 'load-swing', tier: 'minor', cat: 'vehicle', kinds: ['work'], place: 'storage', involved: 1, weight: 1, desc: '하역 중 적재물이 흔들린다 — 결박이 덜 됐다' },
  // 화재·폭발
  { id: 'fuel-smoke', tier: 'minor', cat: 'blast', kinds: ['work', 'rest'], place: 'armory', involved: 1, weight: 1, desc: '탄약고·유류고 인근 흡연 정황' },
  { id: 'kitchen-gas', tier: 'minor', cat: 'blast', kinds: ['meal'], place: 'messhall', involved: 1, weight: 1, desc: '취사장 가스·튀김유 과열 — 연기가 올라온다' },
  // 총기·탄약
  { id: 'ammo-count', tier: 'minor', cat: 'firearm', kinds: ['work', 'rollcall'], place: 'armory', involved: 1, weight: 1, desc: '탄약 수불부와 실물 수량이 안 맞는다' },
  { id: 'muzzle-play', tier: 'minor', cat: 'firearm', kinds: ['work', 'rest'], place: 'armory', involved: 2, weight: 1, desc: '총기 수입 중 장난 — 총구가 사람을 향했다' },
  // 경계·근무 실패
  { id: 'post-empty', tier: 'minor', cat: 'guard', kinds: ['rollcall', 'sleep'], place: 'guardpost', involved: 1, weight: 2, desc: '근무자가 초소에 없다 — 교대 기록도 비었다' },
  { id: 'perimeter-gap', tier: 'minor', cat: 'guard', kinds: ['work', 'rollcall'], place: 'guardpost', involved: 1, weight: 1, desc: '외곽 순찰 기록에 공백 — 철조망 쪽에 흔적이 있다' },
  { id: 'hiding-sleep', tier: 'minor', cat: 'guard', becomes: 'violation', kinds: ['work'], place: 'storage', involved: 1, weight: 2, desc: '미상번 후 구석에 짱박혀 수면' },
  // 규정위반 검거
  { id: 'phone-after-hours', tier: 'minor', cat: 'violation', kinds: ['sleep', 'rollcall'], place: 'barracks', involved: 1, weight: 3, desc: '반납했어야 할 휴대폰이 취침 후에도 돌아다닌다' },
  { id: 'phone-gambling', tier: 'minor', cat: 'violation', becomes: 'outside', kinds: ['rest'], place: 'smoking', involved: 2, weight: 2, desc: '휴대폰 도박·금전거래 정황 — 계좌 얘기가 돈다' },
  { id: 'contraband-drink', tier: 'minor', cat: 'violation', kinds: ['rest', 'sleep'], place: 'storage', involved: 2, weight: 1, desc: '외부 반입 주류 정황 — 관물대에서 냄새가 난다' },
  // 가혹행위·부조리
  { id: 'quarrel', tier: 'minor', cat: 'abuse', kinds: ['meal', 'rest'], place: 'barracks', involved: 2, weight: 3, desc: '병사 간 언쟁이 몸싸움 직전까지 감' },
  { id: 'night-noise', tier: 'minor', cat: 'abuse', becomes: 'selfharm', kinds: ['sleep'], place: 'barracks', involved: 2, weight: 2, desc: '취침 시간 소란 — 누군가 울거나 싸운다' },
  // 인원이탈
  { id: 'rollcall-miss', tier: 'minor', cat: 'absent', kinds: ['rollcall'], place: 'barracks', involved: 1, weight: 2, desc: '점호 인원 미달 — 한 명이 안 보인다' },
  { id: 'leave-overdue', tier: 'minor', cat: 'absent', kinds: ['rollcall'], place: 'guardpost', involved: 1, weight: 2, desc: '휴가 복귀 시간이 지났는데 연락이 안 된다' },
  // 보급·물자
  { id: 'gear-missing', tier: 'minor', cat: 'supply', kinds: ['work', 'rollcall'], place: 'storage', involved: 1, weight: 2, desc: '보급품·장비 수량 불일치 발견' },
  // 보건·환자
  { id: 'food-illness', tier: 'minor', cat: 'health', kinds: ['meal'], place: 'messhall', involved: 2, weight: 2, desc: '같은 식탁에서 여럿이 복통을 호소한다' },
  { id: 'heat-casualty', tier: 'minor', cat: 'health', kinds: ['work'], place: 'worksite', involved: 1, weight: 2, desc: '작업 중 한 명의 얼굴이 하얗다 — 온열·한랭 손상 정황' },
  // 대외·민간
  { id: 'sns-leak', tier: 'minor', cat: 'outside', kinds: ['rest', 'sleep'], place: 'smoking', involved: 1, weight: 1, desc: '부대 사진이 SNS에 올라갔다 — 배경에 초소가 찍혔다' },
  { id: 'civil-damage', tier: 'minor', cat: 'outside', kinds: ['work'], place: 'worksite', involved: 2, weight: 1, desc: '작업 중 민간 담장·차량을 건드렸다는 민원' },

  // ── 큰 사건 — 갈등이 8을 넘겨야 열린다 ──
  { id: 'desertion-sign', tier: 'major', cat: 'absent', kinds: ['rollcall', 'work'], place: 'barracks', involved: 1, weight: 2, desc: '탈영 의심 — 관물대가 비어 있다' },
  { id: 'selfharm-sign', tier: 'major', cat: 'selfharm', kinds: ['rest', 'sleep'], place: 'barracks', involved: 1, weight: 2, desc: '자해 정황 — 혼자 있으려는 병사' },
  { id: 'group-abuse', tier: 'major', cat: 'abuse', kinds: ['rest', 'sleep', 'meal'], place: 'barracks', involved: 2, weight: 2, desc: '집단 따돌림·구타 정황이 드러남' },
  { id: 'unauthorized-drill', tier: 'major', cat: 'abuse', kinds: ['work', 'rest'], place: 'worksite', involved: 2, weight: 1, desc: '규정 밖 얼차려 — 완전군장으로 세워 놨다' },
  { id: 'weapon-taken', tier: 'major', cat: 'firearm', kinds: ['work', 'rollcall', 'sleep'], place: 'armory', involved: 1, weight: 1, desc: '총기·실탄 무단 반출 정황 — 수불부만 멀쩡하다' },
];

// ── 사고 판정 롤 (LLM 없음) ───────────────────────────────
// 하루 9개 일과 슬롯마다 한 번씩 굴린다. rng는 주입식이다 — 테스트가 결정적으로 돈다.
export function incidentRisk({ gara, conflict }, { intel, macho, difficulty }) {
  const R = TUNING.roll;
  const small = Math.max(0,
    R.base
    + macho * R.machoPer
    + Math.max(0, gara + difficulty - 10) * R.hardSloppyPer
    + Math.max(0, gara - intel) * R.dumbSloppyPer
    - (conflict >= R.suppressAt ? R.suppress : 0));
  const big = conflict >= R.big.open ? (conflict - R.big.open + 1) * R.big.per : 0;
  return { small, big };
}

/** 슬롯 하나의 롤. 성공하면 { tier } — 사건 발생. 사건은 아직 사고가 아니다. */
export function rollSlot(params, unitStats, slotKind, rng = Math.random) {
  const { small, big } = incidentRisk(params, unitStats);
  const mult = TUNING.roll.slotMult[slotKind] ?? 1;
  if (big > 0 && rng() < big * mult) return { tier: 'major' };
  if (rng() < small * mult) return { tier: 'minor' };
  return null;
}

/**
 * 롤이 성공한 슬롯의 사건 후보 뽑기. 풀 밖 창작은 없다.
 * 무게 추첨이다 — 족구 부상이 탄약고 흡연보다 흔해야 한다.
 */
export function pickEvent(tier, slotKind, rng = Math.random) {
  const pool = EVENT_POOL.filter(e => e.tier === tier && e.kinds.includes(slotKind));
  const any = pool.length ? pool : EVENT_POOL.filter(e => e.tier === tier);
  return any[weightedPick(any.map(e => e.weight ?? 1), rng)];
}

// ── 등급 추첨 — 코드가 굴린다. LLM은 굴려진 등급에 맞는 인물을 쓸 뿐이다 ──
export const GRADES = ['폐급', 'C', 'B', 'A', '에이스'];
export const CHARACTERS = ['최악', '하', '중', '상', '모범'];

// shift > 0 이면 상위가 두꺼워진다. 지능은 등급을 올리고, 마초는 등급·인성을 내린다.
export function gradeWeights(shift) {
  const { baseWeights, slope, floor } = TUNING.grade;
  return baseWeights.map((w, i) => Math.max(floor, w * (1 + slope * (i - 2) * shift)));
}
function weightedPick(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) return i; }
  return weights.length - 1;
}
/** 병사 하나의 등급 굴림. 지능이 높으면 에이스가, 마초가 높으면 폐급·인성 하위가 잦다. */
export function rollGrades(unit, rng = Math.random) {
  const intel = unit.intel.score, macho = unit.macho.score;
  const grade = GRADES[weightedPick(gradeWeights((intel - 5) - (macho - 5) * 0.5), rng)];
  const character = CHARACTERS[weightedPick(gradeWeights(-(macho - 5)), rng)];
  return { grade, character };
}

/** 사건 연루 병사 선정 — 등급이 낮을수록 잘 걸린다. n명, 중복 없음. */
export function pickInvolved(roster, n, rng = Math.random) {
  const pool = roster.slice();
  const picked = [];
  while (picked.length < n && pool.length) {
    const weights = pool.map(s => TUNING.involve.gradeWeights[Math.max(0, GRADES.indexOf(s.grade))]);
    const i = weightedPick(weights, rng);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

// ── 파라미터 상태 ─────────────────────────────────────────
export function initialParams() {
  return { ...TUNING.start };
}

/** up / down / same → +1 / -1 / 0. 모르는 값은 same으로 떨어진다. */
export const direction = v => (v === 'up' ? 1 : v === 'down' ? -1 : 0);

/**
 * 심판(E-3·N)의 방향 판정을 반영한다. verdict = { gara, happy, conflict } (up/down/same).
 * 평판은 여기 없다 — 어떤 LLM 판정도 평판을 못 움직인다.
 * 순수 함수다 — 새 상태를 돌려주고 원본은 건드리지 않는다.
 */
export function applyDirections(params, verdict) {
  return {
    ...params,
    gara: clamp(params.gara + direction(verdict?.gara)),
    happy: clamp(params.happy + direction(verdict?.happy)),
    conflict: clamp(params.conflict + direction(verdict?.conflict)),
  };
}

/** 개입 하나(면담·점검·공지)의 평판 비용. 순수 코드 — 개입 횟수가 곧 평판이다. */
export function applyIntervention(params) {
  return { ...params, rep: clamp(params.rep + TUNING.rep.perIntervention) };
}

/**
 * 하루 마감 드리프트. 파라미터끼리 얽히는 공식 전부 — §4의 표 그대로다.
 * 각 파라미터 하루 최대 ±1칸. difficulty는 계절 보정을 거친 값이다.
 */
export function applyDrift(params, difficulty, { interventions = 0 } = {}) {
  const D = TUNING.drift;
  let dHappy = 0, dConflict = 0;

  if (params.gara >= D.garaHigh) dHappy += 1;          // 편하니까
  if (params.gara <= D.garaLow) dHappy -= 1;           // FM대로 굴리면 힘들다
  if (difficulty >= D.hardDay) { dHappy -= 1; dConflict -= 1; }  // 힘들면 싸울 기력도 없다
  if (params.conflict >= D.conflictHigh) dHappy -= 1;  // 눌린 부대는 어둡다
  if (params.happy <= D.happyLow) dConflict += 1;      // 불행하면 싸운다
  if (params.happy >= D.happyHigh) dConflict -= 1;     // 행복하면 덜 싸운다

  const step = v => Math.max(-1, Math.min(1, v));
  return {
    ...params,
    happy: clamp(params.happy + step(dHappy)),
    conflict: clamp(params.conflict + step(dConflict)),
    rep: clamp(params.rep + (interventions === 0 ? TUNING.rep.quietDay : 0)),
  };
}

/**
 * 하루 마감 카운터. 사고(확전)가 있었던 날은 0으로 회귀한 채 끝난다 —
 * 날짜는 언제나 전진하고, 병사·파라미터는 그대로 남는다.
 */
export function endOfDayStreak(streak, accidentToday) {
  return accidentToday ? 0 : streak + 1;
}

export const isPromoted = streak => streak >= TUNING.goal;

/** 게이지 하나를 화면에 그릴 때 쓰는 값 (평판 등 노출용). */
export function gauge(value, max = SCALE.max) {
  const v = clamp(value);
  return { value: Math.round(v), max, pct: Math.round(v / max * 100) };
}
