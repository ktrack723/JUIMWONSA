// params.js — 코드가 들고 있는 수치 전부. LLM 없이 단독 테스트가 된다.
//
// 구조도에서 검은 칸(⬛ code)에 해당하는 것들이 여기 산다.
//   · 부대 파라미터 5종의 눈금·시작값·드리프트
//   · 사고 판정 롤 공식 (하루 9슬롯마다 한 번)
//   · 병사 등급 추첨 (지능·마초 가중)
//   · 장소-파라미터 대응표 (불시점검이 어느 파라미터를 드러내는가)
//   · 사건 후보 풀과 심각도 티어 (LLM은 장면만 쓴다 — 풀 밖 창작은 없다)
//   · 사고 유형 열둘과 유형별 그림 자리 (사건이 확전하면 유형이 넘어가는 표까지)
//   · 부재 규칙 (어느 유형의 사고가 병사를 며칠 빼내는가 — 탈영은 사라지고 부상은 입원한다)
//   · 날짜 규칙 (부임일 = 오늘 − 100일 · 계절 · 주말)
//   · 마지막 씬의 갈래 (행복도가 환송회를 여는가, 아무도 없는가 — 그리고 누가 입을 여는가)
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
    hardSloppyPer: 0.015, // 힘든 일을 대충 하면 다친다 — max(0, 가라+난이도−10) 1당.
                          // 0.03이던 것을 반으로 내렸다: 난이도 8 부대가 하루 0.89건이라
                          // 하루가 7.5콜이 되고 플레이어가 매일 지침을 쓰는 게임이 됐다(실측).
    dumbSloppyPer: 0.02,  // 대충할 머리가 안 됨 — max(0, 가라−지능) 1당
    suppressAt: 5,        // 갈등이 이 이상이면 잔사고가 줄어든다 (군기가 눌러 놓는다)
    suppress: 0.02,       // 억제분
    big: { open: 8, per: 0.02 },  // 8을 넘기면 큰 사고 전용 위험이 열린다
    pullPer: 0.22,        // 성향 1당 그 성향이 당기는 씨앗의 무게 (params.pullWeight)
    slotMult: {           // 슬롯 성격 보정 — 일과 슬롯이 제일 위험하고 수면은 조용하다
      work: 1.5, meal: 0.8, rest: 1.0, rollcall: 0.7, sleep: 0.4,
    },
  },

  // 일일 드리프트 — 하루 마감에 적용. 각 파라미터 하루 최대 ±1칸.
  //
  // 「힘든 날」은 절대 눈금이 아니라 **그 부대의 평소 대비**다. 예전에는 난이도 8 이상을
  // 힘든 날로 봤는데, 난이도가 그만큼 높게 저작된 부대에서는 「오늘 유난히 힘든 날」이
  // 매일이 된다 — 그 부대에 그건 「유난히」가 아니라 「평소」다. 그래서 행복이 매일 −1씩
  // 단조 감소하고, 일주일이면 0에 붙고, 열흘이면 전원 멘탈이 0이 됐다. 되돌릴 레버는
  // 게임에 없었다(면담은 개인 멘탈만, 점검은 행복을 더 깎는다). 부대 데이터와 이 표가
  // 어긋나 있었던 것이다 — 눈금을 상대치로 바꿔서 어느 난이도로 저작하든 성립하게 만든다.
  //
  // 난이도가 행복을 깎는 길은 달력이 아니라 **사고 롤**이다 (roll.hardSloppyPer):
  // 힘든 일을 대충 하면 다치고, 사건이 나고, 그 판정이 행복을 민다. 여기서 또 깎으면
  // 이중 과금이다. 달력이 하는 일은 둘로 줄였다 — 힘든 날은 싸울 기력이 없어 갈등이
  // 내려가고(원래 주석 그대로다), 평소보다 편한 날(주말·비수기)은 숨통이 트인다.
  drift: {
    garaHigh: 7, garaLow: 3,      // 가라↑ → 행복 드리프트↑, 가라↓ → 행복 드리프트↓
    hardOver: 1,                  // 평소보다 이만큼 힘든 날 — 싸울 기력도 없다 (갈등↓)
    easyUnder: 1,                 // 평소보다 이만큼 편한 날 — 숨통이 트인다 (행복↑)
    happyLow: 3, happyHigh: 8,    // 행복↓ → 갈등↑, 행복↑ → 갈등↓
    conflictHigh: 7,              // 갈등↑ → 행복↓
  },

  // 평판 — LLM이 못 건드린다. 개입(면담·점검·공지)마다 −1, 조용한 날 +1 회복.
  rep: { perIntervention: -1, quietDay: +1 },

  // 전우애 — 부대의 완충재. 갈등이 사건·사고로 번지는 것을 흡수한다.
  // 빡센 부대일수록 높다(같이 굴렀으니까). 편한 부대일수록 낮다 — 서로 남이다.
  // 중립은 5. 이보다 높으면 문턱이 올라가고 초과분 가중이 줄고, 낮으면 반대다.
  comrade: {
    neutral: 5,
    openPer: 0.4,     // 전우애 1당 큰사고 문턱(갈등)이 이만큼 움직인다
    bigPer: 0.08,     // 전우애 1당 초과분 가중이 이만큼 (낮을수록 크게 번진다)
    smallPer: 0.005,  // 전우애 1당 작은사건 위험 (낮을수록 잦다). 0.004에서 조금 올렸다 —
                      // 서로 남인 부대에서 작은 마찰이 그대로 사건이 되는 것이 이 축의 값인데,
                      // 그 값이 너무 작아서 편한 부대가 그냥 편하기만 했다(실측: 열엿새 중
                      // 열엿새가 사건 없는 날 → 방치가 최적 전략).
    // 전우애는 **부대 분위기로부터 개인을 지키는 방패**이기도 하다. 문턱을 이만큼 민다:
    // 끈끈한 부대는 분위기가 어지간히 나빠도 사람이 안 무너지고, 조금만 좋아져도 회복한다.
    // 서로 남인 부대는 반대다 — 그게 「틀어지면 아무도 안 말린다」의 기계판이다.
    mentalPer: 0.4,
    // 회복은 **하루에 몇 명인가**로 갈린다. 눈금(문턱)으로 가르면 어느 쪽이든 깨진다:
    // 문턱을 낮추면 열여섯 명이 전부 매일 회복해 큰 사고의 문이 통째로 닫히고(실측: 여드레
    // 만에 전원 만점), 높이면 회복이 0이 되어 멘탈이 갉이기만 하는 한 방향 자원이 된다.
    // 하락은 분위기라서 전원에게 붙지만, 회복은 **누가 누구를 챙기느냐**라서 인원이 있다.
    // 끈끈한 부대는 하루 둘이 돌아오고, 중간은 하나, 서로 남인 부대는 **아무도 안 돌아온다** —
    // 그 부대에서 사람을 돌려놓는 길은 주임원사의 면담 하나뿐이다. 그게 그 부대의 게임이다.
    recoverPer: 0.25,
  },

  // 계절 보정 — 여름 혹서기·겨울 제설이 일과 난이도에 +1. 주말은 일과 없음.
  season: { summerBonus: 1, winterBonus: 1, weekendDifficulty: 1 },

  // 등급 추첨 — 5단계 가중 추첨. 지능이 높으면 등급 상위가, 마초가 높으면
  // 등급·인성 하위가 두꺼워진다. slope는 모집단 수치 1당 가중 기울기.
  grade: { baseWeights: [1, 2, 4, 2, 1], slope: 0.16, floor: 0.05 },

  // 사건 연루자 선정 — 등급이 낮을수록, 멘탈이 낮을수록 잘 걸린다.
  involve: {
    gradeWeights: [5, 3, 2, 1.5, 1],  // 폐급 → 에이스
    mentalPer: 0.2,                   // 멘탈이 기준(6)에서 1 내려갈 때마다 가중 +20%
    mentalBase: 6,
  },

  // 병사별 멘탈 — 부대 파라미터와 달리 **저장되는** 개인 상태다 (0~10).
  // 부대 분위기(행복·갈등)가 매일 쓸어가고, 사건이 깎고, 면담(상담)이 회복시킨다.
  mental: {
    start: { base: 6, jitter: 2 },    // 전입 시 base ± jitter에서 굴린다
    charPenalty: { '최악': -2, '하': -1 },  // 인성 하위는 낮게 시작한다 — 버티는 힘도 인성이다
    // 회복 눈금을 8에서 6으로 내렸다. 8은 **부임 상태(행복 5)에서 닿지 않는 자리**라,
    // 두 부대 모두 「멘탈이 갉이기만 하고 회복은 없는」 죽은 구간에 앉아 있었다(실측: 어느
    // 플레이를 해도 최저 멘탈이 0으로 갔다). 6으로 내리면 전우애가 이 눈금을 갈라 놓는다 —
    // 끈끈한 부대는 평범한 분위기(5)만 돼도 사람이 알아서 회복되고, 서로 남인 부대는
    // 7 이상이라야 회복된다. 그래서 **얕은 부대에서는 면담이 유일한 회복 통로**가 된다.
    driftHappyHigh: 6, driftHappyLow: 3,    // 부대가 밝으면 +1, 어두우면 −1 (전우애가 이 눈금을 민다)
    driftConflictHigh: 7,                   // 눌린 부대는 추가로 −1 (여기도 전우애가 민다)
    startComradePer: 0.2,                   // 전우애 1당 전입 멘탈 굴림의 중심이 이만큼 오른다
    incidentHit: -1,                  // 사건에 연루되면
    escalationHit: -1,                // 그 사건이 사고가 되면 추가로
    counsel: +1,                      // 면담(상담) 한 번에
    dangerAt: 2,                      // 이 이하로 떨어진 병사가 있으면 큰 사고 전용 위험이 열린다
    // 위험 눈금 1칸당. 0.02에서 0.006으로 내렸다 — 이 위험은 **슬롯마다** 굴러서,
    // 한 명이 바닥나면 하루 아홉 번 굴린 것이 중대 사건 0.5건/일이 됐다. 그러면 얕은 부대는
    // 「한 명이 무너짐 → 사건 폭증 → 더 무너짐」의 뒤집을 수 없는 나선에 들어간다(실측:
    // 어떤 플레이를 해도 완주율 0%). 한 사람이 무너지는 것은 하루에 아홉 번 물을 일이 아니다.
    dangerPer: 0.006,
    default: 6,                       // 멘탈 없는 옛 저장분을 읽을 때
  },

  // 불시점검(군기 점검)의 효과 — 순수 코드다. 들이닥치면 일은 각이 잡히고(가라↓)
  // 분위기는 가라앉는다(행복↓). LLM은 점검 소견(장면)만 쓴다.
  inspect: { gara: -1, happy: -1 },

  // 환송회 — 100일을 찍고 부대를 뜨는 마지막 밤. 병사들이 나오느냐 마느냐는
  // **행복도 하나**가 정한다. 눈금은 밴드 경계 그대로다(high는 7부터, low는 3까지) —
  // 계기판에서 「높다/낮다」로 읽히는 자리가 곧 씬이 갈리는 자리여야 한다.
  // speakers는 그 자리에서 입을 여는 인원. 아무도 안 나온 밤은 당연히 0이다.
  farewell: { grand: 7, empty: 3, speakers: { grand: 4, thin: 1, none: 0 } },

  // 가라 내역 — 「가라 4」가 실제로 무엇 넷인가. 적발 확률은 부대 지능이 정한다:
  // 머리 좋은 부대일수록 잘 숨긴다. 공군의 병사간 룰이 이미 그렇게 적혀 있다
  // (「단체 채팅방에서 한 명만 빼고 방을 새로 파는 식이라 표가 안 난다」).
  //
  // 거기에 축 둘이 붙었다 — **등급**과 **난이도**다.
  //   tierHide  — 등급이 높을수록 아는 사람이 적고 조심하니 덜 걸린다. 재판급은 소수의
  //               비밀이다. 그래서 「제일 위험한 것이 제일 안 보인다」가 이 게임의 긴장이다.
  //   overreach — 그 균형을 깨는 자리. 관행마다 **감당에 필요한 지능(need)** 이 있고,
  //               부대 지능이 거기 못 미치면 어설프게 굴러가서 **표가 난다.** 지능 낮은
  //               부대에서 재판급이 돌면 주임원사에게도 검열관에게도 잘 걸린다 —
  //               대신 걸리기 전에 사고부터 난다(overreachRisk).
  gara: {
    spotBase: 1.1, spotIntelPer: 0.07, spotFloor: 0.3, spotCeil: 0.95,
    tierHide: { petty: 0, serious: -0.08, court: -0.20 },
    overreach: 0.35,        // 감당 못 하는 난이도의 관행은 적발 확률이 이만큼 오른다
    overreachRisk: 0.012,   // 그리고 하루 사고 롤의 잔사고 위험이 개당 이만큼 오른다
    tierRisk: 0.008,        // 등급 rank 1당 잔사고 위험 가산 (재판급은 그 자체로 폭탄이다)
  },

  // 검열 — 정기적으로 부대를 헤집는 외부의 눈. 선글라스에 검은 옷이다.
  //
  // 불시점검이 주임원사가 사는 정보라면, 검열은 **사는 게 아니라 당하는 것**이다.
  // 날짜가 미리 뜨고(warn일 전 예고), 그날 검열관들이 일과 슬롯을 따라 부대를 통과하면서
  // 그 자리·그 시간에 돌고 있는 관행을 굴린다. 걸리면 그게 사고다 — 「가라를 많이 치면
  // 여기서 터진다」가 이 게임의 시한폭탄이고, 주임원사가 100일을 어떻게 배분하느냐의 축이다.
  //
  // 검열관은 주임원사보다 세다(base가 높다). 대신 주임원사에게는 그들에게 없는 것이 둘 있다:
  // **미리 안다**는 것과, **어느 자리를 언제 털지 고를 수 있다**는 것.
  censor: {
    days: [17, 38, 61, 85],   // 부임 며칠째(dayNo)에 오는가. 100일에 넷, 갈수록 빡세진다
    labels: ['대대 검열', '연대 검열', '사단 검열', '군단 검열'],
    warn: 3,                  // 며칠 전부터 달력에 뜨는가 — 치울 시간을 준다
    base: 0.78,               // 검열관의 기본 적발력. 주임원사(1.1 − 지능×0.07)보다 세다
    intelPer: 0.045,          // 부대 지능 1당 내려간다 — 머리 좋은 부대는 검열도 넘긴다
    levelPer: 0.05,           // 회차마다 빡세진다 (대대 → 연대 → 사단 → 군단)
    floor: 0.25, ceil: 0.98,
    clean: { rep: +1, happy: +1 },     // 지적 0으로 넘기면 — 이 게임에서 드문 상방이다
    flagged: { happy: -1 },            // 지적이 하나라도 나오면 부대 분위기가 언다
    seriousConflict: 1,                // 징계감 이상이 걸리면 갈등 +1 (누구 때문이냐가 시작된다)
    // 재판급이 걸리면 사람이 실려 나간다 — 헌병대가 그 자리에서 데려간다.
    // 재판급이 여럿 걸려도 사고 기재는 **하루 한 건**이다(검열 하나가 사고 하나다).
    // 데려가는 인원만 건수를 따르고, 그것도 상한이 있다 — 부대가 하루에 통째로 비면 게임이 아니다.
    custody: { kind: 'custody', days: [10, 30] },
    maxTaken: 2,
  },

  // 사고가 사람을 데려간다 — 확전한 사건은 연루자 하나를 부대에서 실제로 빼낸다.
  // 카운터만 0으로 돌리는 사고는 종이 위의 일이었다. 탈영은 그 자리를 비우고,
  // 부상은 병원으로 보낸다 — 남은 열다섯으로 며칠을 버티는 것이 사고의 값이다.
  // days는 [최소, 최대] 복귀일까지의 일수. 굴림은 게임 난수를 쓴다.
  absence: {
    rules: {
      absent:   { kind: 'awol',     days: [4, 14] },  // 군무이탈 — 헌병대가 데려오거나 제 발로 온다
      selfharm: { kind: 'hospital', days: [7, 21] },  // 신상 — 국군병원 보호입원
      injury:   { kind: 'hospital', days: [3, 10] },  // 부상 — 의무대·후송
      vehicle:  { kind: 'hospital', days: [5, 14] },
      blast:    { kind: 'hospital', days: [5, 14] },
      health:   { kind: 'hospital', days: [2, 7] },
    },
    // 사건당 몇 명이 빠지는가. 연루자가 여럿이어도 실려 가는 것은 하나다 —
    // 족구를 같이 했다고 둘 다 입원하지는 않는다.
    perIncident: 1,
  },

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

// ── 가라 내역 — 「가라 4」가 실제로 무엇 넷인가 ─────────────
// 가라는 오래도록 게이지 눈금 하나였다. 그 눈금에 **내용물**을 붙인 것이 이 표다:
// 부대에서 지금 돌아가고 있는 편법 관행의 목록이고, 게이지의 수치는 곧 그 목록의 길이다.
//
//   가라 4  =  이 표의 항목 넷이 지금 돌고 있다
//
// 그래서 계기판은 「몇 개인가」를 말하고, 내역은 「무엇인가」를 말한다. 그 사이의 틈이
// 이 게임에 남은 마지막 안개다 — 플레이어는 개수를 알지만 정체는 모르고, 그걸 사는 것이
// 불시점검이다. 확인한 것은 명부에 오르고, 명부는 **확인한 그날의 사실**이지 지금의 사실이
// 아니다. 그래서 낡는다.
//
// 필드가 한국어(화면)와 영어(프롬프트)로 갈려 있는 이유는 §9.4 때문이다 — 지시문은 영어로
// 간다. label·desc는 화면 몫이고, en은 공지 판정(N)과 점검 소견(I-2)·사건 장면(E-1)에 실린다.
// ── 가라의 네 요소 ────────────────────────────────────────
// 눈금에 내용물을 붙인 뒤로 관행 하나가 들고 있는 것은 넷이다. 넷 다 게임의 축이다:
//
//   ① 등급(tier)  — 가벼운 가라냐, 징계감이냐, 재판급이냐. 검열에서 **터지는 것은 재판급뿐**이고
//                   나머지는 지적사항으로 끝난다. 주임원사가 무엇을 먼저 끊어야 하는가의 축
//   ② 자리와 시간(place·when) — **둘 다 맞아야 급습에서 잡힌다.** 대리 점호는 생활관에서
//                   점호 시간에만 돈다 — 오후에 생활관을 털면 아무것도 없다
//   ③ 난이도(need) — 이 관행을 제대로 굴리는 데 필요한 부대 지능. 모자라면 어설퍼서
//                   **표가 나고**(적발↑) **사고부터 난다**(위험↑). 머리 나쁜 부대가 큰 가라를
//                   치면 그게 그 부대의 사망 원인이 된다
//   ④ 내용(desc·en·tell·counter) — 무엇을 어떻게 잘라먹는가. 어떤 지침을 내려야 끊기는지가
//                   여기 있고, 검열관 앞에서 무엇이 증거로 남는지도 여기 있다
//
//   place   — 어느 자리에 들이닥쳐야 보이는가 (PLACES의 열쇠)
//   when    — 어느 슬롯에 실제로 돌아가는가 (SLOT_KEYS). 그 시간이 아니면 그 자리에 가도 없다
//   tier    — 등급 (GARA_TIERS의 열쇠)
//   need    — 감당에 필요한 부대 지능 0~10. 부대 지능이 이보다 낮으면 어설프다
//   cat     — 이것이 터지면 어느 사고 유형으로 기재되는가 (INCIDENT_CATEGORIES의 열쇠)
//   weight  — 새 가라가 생길 때의 추첨 가중. 흔한 것일수록 크다
//   tell    — 화면 몫. 적발한 뒤 「무엇을 보면 아는가」 한 줄
//   counter — 화면 몫. 이걸 끊으려면 공지가 무엇을 콕 집어야 하는가

// 등급 셋. rank가 곧 무게고, 이 표가 검열의 결과를 가른다.
//
// hide가 등급이 오를수록 **내려가는** 것이 이 표의 핵심이다 — 재판급은 아는 사람이 셋뿐이고
// 그 셋은 조심한다. 「제일 위험한 것이 제일 안 보인다」가 이 게임의 긴장이고, 그걸 깨는 것이
// 난이도(need)다: 감당 못 하는 부대가 손대면 그 순간부터 표가 난다.
export const GARA_TIERS = {
  petty: {
    rank: 0, label: '가벼운 가라', short: '경',
    en: 'petty — the everyday shortcut nobody writes up',
    blows: false, finding: '지적사항',
    note: '검열에서 걸려도 지적으로 끝난다. 대신 이게 부대를 굴러가게 하는 기름이다',
  },
  serious: {
    rank: 1, label: '징계감', short: '중',
    en: 'serious — a disciplinary matter the moment it surfaces',
    blows: false, finding: '중지적',
    note: '걸리면 강평에 남고 부대가 갈린다 — 누구 때문이냐가 시작된다',
  },
  court: {
    rank: 2, label: '재판급', short: '재',
    en: 'court-martial grade — the kind that ends in a trial',
    blows: true, finding: '수사 의뢰',
    note: '검열에서 걸리면 그 자리에서 사고다. 헌병대가 사람을 데려간다',
  },
};
export const GARA_TIER_KEYS = Object.keys(GARA_TIERS);

export const GARA_POOL = [
  {
    id: 'proxy-rollcall', place: 'barracks', when: ['reveille', 'taps'], tier: 'petty', need: 2,
    cat: 'guard', weight: 3,
    label: '대리 점호', desc: '없는 놈 몫까지 번호를 대신 외친다 — 인원은 언제나 맞는다',
    tell: '번호가 한 박자 빠르고, 목소리 하나가 둘을 낸다',
    counter: '점호에서 인원을 눈으로 세겠다고 못박는 공지',
    en: 'shouting the count for a man who is not there, so the roll call always comes out right',
  },
  {
    id: 'phone-box-dodge', place: 'barracks', when: ['taps', 'sleep'], tier: 'petty', need: 3,
    cat: 'violation', weight: 3,
    label: '폰통 미투입', desc: '수거함에는 넣은 척만 하고 진짜 폰은 관물대 뒤에 둔다',
    tell: '수거함 개수는 맞는데 그중 몇 대가 공기계다',
    counter: '휴대폰을 수거함에 넣게 하고 개수를 직접 세겠다는 공지',
    en: 'keeping a phone back instead of putting it in the collection box at lights-out',
  },
  {
    id: 'night-duty-swap', place: 'barracks', when: ['taps', 'sleep'], tier: 'serious', need: 3,
    cat: 'abuse', weight: 2,
    label: '불침번 몰아주기', desc: '새벽 시간대를 짬 안 되는 놈들에게만 몰아서 짠다',
    tell: '근무표의 02시~04시 칸에 같은 기수만 적혀 있다',
    counter: '불침번 편성을 기수 무관하게 짜라고 콕 집는 공지',
    en: 'stacking the worst night-watch shifts onto the most junior men',
  },
  {
    id: 'sick-call-block', place: 'barracks', when: ['reveille', 'amwork'], tier: 'serious', need: 2,
    cat: 'health', weight: 1,
    label: '환자 열외 막기', desc: '의무대 보내면 인원이 빈다고 아픈 놈을 그냥 세운다',
    tell: '열외자 명단은 비었는데 아침점호에 서 있는 놈 하나가 회색이다',
    counter: '의무대 열외를 간부가 막지 못하게 하는 공지',
    en: 'keeping a sick man on duty because sending him to the aid station would leave a slot empty',
  },
  {
    id: 'bank-book-hold', place: 'barracks', when: ['rest', 'taps'], tier: 'serious', need: 4,
    cat: 'abuse', weight: 1,
    label: '후임 카드 관리', desc: '선임이 후임 체크카드를 「관리해 준다」며 들고 있다',
    tell: '관물대 하나에 제 것이 아닌 카드가 두 장 더 있다',
    counter: '금전·카드 위탁을 이름 붙여 금지하는 공지',
    en: 'a senior soldier holding a junior\'s bank card "for safekeeping"',
  },
  {
    id: 'borrowed-bodies', place: 'office', when: ['amwork', 'pmwork'], tier: 'serious', need: 5,
    cat: 'guard', weight: 2,
    label: '인원 대여', desc: '검열 날에 옆 부대에서 사람을 빌려와 머릿수를 맞춘다',
    tell: '처음 보는 얼굴이 우리 부대 명찰을 달고 서 있다',
    counter: '타 부대 인원의 일시 편입을 금지하는 공지',
    en: 'borrowing men from a neighbouring unit on inspection day to make the headcount',
  },
  {
    id: 'ghost-logbook', place: 'office', when: ['pmwork', 'rest'], tier: 'petty', need: 3,
    cat: 'guard', weight: 3,
    label: '근무일지 선작성', desc: '근무를 서기도 전에 일지를 한 주치 미리 다 써 둔다',
    tell: '아직 오지 않은 날짜 칸에 이미 서명이 있다',
    counter: '일지를 근무 종료 직후에만 쓰라고 못박는 공지',
    en: 'filling in the duty logbook in advance, before the shifts have been stood',
  },
  {
    id: 'gate-log-blank', place: 'office', when: ['amwork', 'pmwork'], tier: 'petty', need: 2,
    cat: 'guard', weight: 2,
    label: '출입 기록 공란', desc: '출입 기록을 그때그때 안 쓰고 나중에 몰아서 채운다',
    tell: '한 주치 필적이 똑같은 펜, 똑같은 기울기다',
    counter: '출입 기록을 그 자리에서 쓰게 하는 공지',
    en: 'leaving the gate log blank and filling a week of entries in one sitting afterwards',
  },
  {
    id: 'duty-swap-cash', place: 'office', when: ['pmwork', 'rest'], tier: 'serious', need: 5,
    cat: 'guard', weight: 1,
    label: '근무 대타 매매', desc: '주말 근무를 돈이나 물건 받고 대신 서 준다',
    tell: '근무표의 교체 흔적이 유독 한 사람 쪽으로만 흐른다',
    counter: '근무 교대를 대가와 함께 주고받는 것을 금지하는 공지',
    en: 'selling and buying weekend duty shifts for cash or goods',
  },
  {
    id: 'leave-pass-forge', place: 'office', when: ['amwork', 'pmwork'], tier: 'court', need: 7,
    cat: 'absent', weight: 1,
    label: '휴가 위조', desc: '휴가증과 외출증을 손봐서 안 나온 날짜를 나온 것으로 만든다',
    tell: '휴가 명령 대장과 실제 나간 날짜가 하루씩 어긋난다',
    counter: '휴가·외출 증서의 발급과 대장 대조를 콕 집는 공지',
    en: 'forging leave passes so days off the books look like days on them',
  },
  {
    id: 'fake-inventory', place: 'storage', when: ['pmwork', 'rest'], tier: 'serious', need: 4,
    cat: 'supply', weight: 3,
    label: '재고 맞추기', desc: '없어진 보급품을 장부에서만 맞춰 놓는다',
    tell: '장부의 숫자는 맞는데 선반 위 상자가 비어 있다',
    counter: '보급 장부와 실물 대조를 명시한 공지',
    en: 'balancing the supply ledger on paper for stock that is not on the shelf',
  },
  {
    id: 'stash-corner', place: 'storage', when: ['rest', 'taps', 'sleep'], tier: 'petty', need: 2,
    cat: 'violation', weight: 2,
    label: '창고 사제 반입', desc: '창고 구석에 사제 물품과 먹을 것을 쟁여 둔다',
    tell: '적재함 뒤쪽에 라면 박스와 담요가 한 채 서 있다',
    counter: '창고 내 사제 물품 보관을 금지하는 공지',
    en: 'keeping contraband snacks and unauthorised gear stashed in a corner of the store room',
  },
  {
    id: 'fuel-siphon', place: 'storage', when: ['pmwork', 'taps'], tier: 'court', need: 6,
    cat: 'supply', weight: 1,
    label: '유류 빼돌리기', desc: '차량 유류를 조금씩 덜어 따로 통에 받아 둔다',
    tell: '주유 대장의 소모량이 주행거리와 안 맞는다',
    counter: '유류 수불을 계기판 주행거리와 대조하라고 못박는 공지',
    en: 'siphoning vehicle fuel a little at a time into cans of their own',
  },
  {
    id: 'meal-count-pad', place: 'messhall', when: ['breakfast', 'lunch', 'dinner'], tier: 'petty', need: 2,
    cat: 'supply', weight: 2,
    label: '식수 인원 부풀리기', desc: '식수 인원을 넉넉히 올려 남는 것을 따로 챙긴다',
    tell: '식수 인원이 병력보다 꾸준히 몇 명 많다',
    counter: '식수 인원을 그날 병력과 맞추라고 콕 집는 공지',
    en: 'padding the headcount for meals so there is extra food to put aside',
  },
  {
    id: 'safety-gear-off', place: 'worksite', when: ['amwork', 'pmwork'], tier: 'serious', need: 1,
    cat: 'injury', weight: 3,
    label: '안전장구 미착용', desc: '덥다고 안전모·귀마개를 벗고 작업한다',
    tell: '안전모가 전부 한자리에 얌전히 쌓여 있다',
    counter: '작업 중 안전장구 착용을 콕 집어 강제하는 공지',
    en: 'working without the hard hat and ear protection because it is too hot to wear them',
  },
  {
    id: 'training-skip', place: 'worksite', when: ['amwork', 'pmwork'], tier: 'petty', need: 3,
    cat: 'guard', weight: 2,
    label: '훈련 서류상 이수', desc: '체력단련과 정신교육을 서류로만 돌린다',
    tell: '이수 서명이 열여섯 장인데 필적이 두 종류다',
    counter: '교육·훈련의 실시와 서명을 같은 날에 묶는 공지',
    en: 'signing off physical training and safety education that nobody actually held',
  },
  {
    id: 'smoke-on-duty', place: 'smoking', when: ['rest', 'taps', 'sleep'], tier: 'petty', need: 2,
    cat: 'guard', weight: 3,
    label: '근무 중 이탈', desc: '근무자가 자리를 비우고 흡연장에 잠깐 다녀온다',
    tell: '재떨이에 근무 시간대에만 생기는 꽁초가 쌓인다',
    counter: '근무 중 자리 이탈을 시간과 함께 금지하는 공지',
    en: 'a man on watch slipping off his post for a smoke and coming back',
  },
  {
    id: 'ammo-count-later', place: 'armory', when: ['amwork', 'pmwork'], tier: 'serious', need: 4,
    cat: 'firearm', weight: 2,
    label: '탄약 수불 나중에', desc: '실탄 수불을 그 자리에서 안 적고 나중에 장부를 맞춘다',
    tell: '수불 대장의 시각이 전부 일과 종료 직후로 몰려 있다',
    counter: '탄약 수불을 불출대에서 즉시 기재하게 하는 공지',
    en: 'signing live ammunition out and back in on paper afterwards instead of at the counter',
  },
  {
    id: 'ammo-carry-out', place: 'armory', when: ['pmwork', 'rest'], tier: 'court', need: 8,
    cat: 'firearm', weight: 1,
    label: '실탄 반출', desc: '사격 잔탄을 반납 안 하고 몇 발 들고 나온다',
    tell: '탄약고 대장의 잔탄이 매번 딱 떨어진다 — 너무 딱 떨어진다',
    counter: '사격 후 잔탄 회수와 실물 재검수를 콕 집는 공지',
    en: 'walking live rounds out of the range instead of turning them back in',
  },
  {
    id: 'gate-pass-wave', place: 'guardpost', when: ['breakfast', 'amwork', 'pmwork', 'dinner'], tier: 'petty', need: 1,
    cat: 'guard', weight: 2,
    label: '얼굴 보고 통과', desc: '아는 얼굴은 신분 확인 없이 그냥 들여보낸다',
    tell: '출입 대장에 기재 없이 지나간 시간대가 뭉텅이로 비어 있다',
    counter: '예외 없는 신분 확인을 못박는 공지',
    en: 'waving a familiar face through the gate without checking his pass',
  },
  {
    id: 'off-post-run', place: 'guardpost', when: ['taps', 'sleep'], tier: 'court', need: 5,
    cat: 'absent', weight: 1,
    label: '야간 무단 외출', desc: '점호 끝나고 위병소 옆 철조망으로 나갔다 새벽에 들어온다',
    tell: '뒤편 철조망 아래 풀이 한 줄로 누워 있다',
    counter: '야간 부대 이탈과 그 통로를 콕 집어 막는 공지',
    en: 'slipping out through the fence after lights-out and back before dawn',
  },
];

export const GARA_IDS = GARA_POOL.map(g => g.id);
export const GARA_BY_ID = Object.fromEntries(GARA_POOL.map(g => [g.id, g]));

// 표 검증 — 새 항목을 아무렇게나 못 붙이게. 자리가 대응표 밖이면 점검으로 영원히 못 보고,
// 시간이 슬롯 밖이면 **어느 시각에 들이닥쳐도 안 걸린다**. 둘 다 조용히 죽는 버그라 여기서 죽인다.
for (const g of GARA_POOL) {
  if (!PLACES[g.place]) throw new Error(`params.js: 가라 「${g.id}」의 장소가 대응표에 없다 — ${g.place}`);
  if (!Array.isArray(g.when) || !g.when.length) throw new Error(`params.js: 가라 「${g.id}」에 시간대가 없다 — 영원히 안 걸린다`);
  for (const w of g.when) if (!SLOT_KEYS.includes(w)) throw new Error(`params.js: 가라 「${g.id}」의 시간대가 일과표 밖이다 — ${w}`);
  if (!GARA_TIERS[g.tier]) throw new Error(`params.js: 가라 「${g.id}」의 등급이 표에 없다 — ${g.tier}`);
  if (!INCIDENT_CATEGORIES[g.cat]) throw new Error(`params.js: 가라 「${g.id}」가 터졌을 때의 유형이 없다 — ${g.cat}`);
  if (!(g.need >= 0 && g.need <= 10)) throw new Error(`params.js: 가라 「${g.id}」의 난이도가 눈금 밖이다`);
  if (!(g.weight > 0)) throw new Error(`params.js: 가라 「${g.id}」의 가중이 없다`);
  if (!g.label || !g.desc || !g.en || !g.tell || !g.counter) throw new Error(`params.js: 가라 「${g.id}」의 표기가 부실하다`);
}
if (new Set(GARA_IDS).size !== GARA_IDS.length) throw new Error('params.js: 가라 id 중복');
// 자리 여덟과 슬롯 아홉 어디에도 죽은 칸이 없어야 한다 — 급습의 두 축이 자리와 시간이라
// 어느 한 칸이 비면 플레이어가 그 칸을 고르는 것이 언제나 헛수고가 된다.
for (const k of Object.keys(PLACES)) {
  if (!GARA_POOL.some(g => g.place === k)) throw new Error(`params.js: 「${k}」에 깔린 가라가 하나도 없다`);
}
for (const k of SLOT_KEYS) {
  if (!GARA_POOL.some(g => g.when.includes(k))) throw new Error(`params.js: 「${k}」 시간대에 도는 가라가 하나도 없다`);
}
if (!GARA_POOL.some(g => g.tier === 'court')) throw new Error('params.js: 재판급 가라가 하나도 없다 — 검열이 터질 자리가 없다');

/** 지침이 막아 놓은 것을 뺀 가라 정원. 금지가 늘수록 가라가 오를 수 있는 천장이 내려간다. */
export const garaCap = (banned = []) => GARA_IDS.filter(id => !banned.includes(id)).length;

/**
 * 목록을 수치에 맞춘다. **수치가 원본이고 목록이 따라간다** — 단 하나의 예외가 지침 금지로,
 * 그때는 목록이 먼저 줄고 수치가 따라온다(engine의 postNotice).
 *   active  — 지금 돌고 있는 id들
 *   target  — 맞춰야 할 개수(= params.gara)
 *   banned  — 지침으로 막힌 id들. 여기 있으면 돌지도, 새로 생기지도 않는다
 * 순수 함수다 — 새 배열을 돌려주고 원본은 안 건드린다.
 *
 * ── 줄일 때 왜 무작위인가 (한 번 물리고 고친 자리) ──────
 * 「불시점검에서 적발된 것부터 멎게 한다」를 먼저 넣었다가 재 보고 물렸다. 가라 4에서 한 자리에
 * 도는 관행은 평균 한 건이라, 적발한 그 한 건이 점검의 −1에 그대로 먹혀서 **털고 나면 명부가
 * 언제나 비었다**(브라우저 실측 3회 연속 「확인 0」). 평판 −1을 치르고 산 정보가 같은 개입의
 * 부수효과에 지워지는 구조였다.
 * 그래서 역할을 갈랐다: **점검은 정체를 사고, 지침은 관행을 끊는다.** 점검의 −1은 「각이
 * 잡혔다」는 일반 효과로 남아 아무거나 하나를 멎게 한다 — 그게 방금 확인한 것이면 명부는
 * 그 자리에서 낡기 시작한다. 그것도 안개의 일부고, 특수 처리 없이 저절로 그렇게 된다.
 */
export function syncGaraList(active, target, { banned = [], rng = Math.random } = {}) {
  let list = active.filter(id => GARA_BY_ID[id] && !banned.includes(id));
  const want = Math.max(0, Math.min(target, garaCap(banned)));

  while (list.length > want) list.splice(Math.floor(rng() * list.length), 1);
  // 늘릴 때 — 안 돌고 안 막힌 것 중에서 가중 추첨. 플레이어에게는 아무 통보도 없다.
  while (list.length < want) {
    const pool = GARA_POOL.filter(g => !list.includes(g.id) && !banned.includes(g.id));
    if (!pool.length) break;
    list.push(pool[weightedPick(pool.map(g => g.weight), rng)].id);
  }
  return list;
}

/**
 * 들이닥쳤을 때 하나를 실제로 잡아낼 확률. **부대 지능이 정한다** — 머리가 좋을수록 잘 숨긴다.
 * 그래서 확인된 내역은 부대마다 다른 방식으로 틀린다: 둔한 부대는 다 보이고,
 * 영리한 부대는 절반쯤만 보인다.
 *
 * 여기에 관행 자신의 두 축이 얹힌다 (id를 주면):
 *   · 등급이 높을수록 **덜** 걸린다 — 재판급은 아는 사람이 셋이고 그 셋은 조심한다.
 *   · 그 관행의 난이도(need)가 부대 지능을 넘으면 **크게** 걸린다 — 감당 못 하는 짓은
 *     어설프게 굴러가서 표가 난다. 이 항이 「제일 위험한 것이 제일 안 보인다」를 깨는 자리고,
 *     지능 낮은 부대가 재판급에 손대면 그게 그 부대의 사망 원인이 되는 이유다.
 * id를 안 주면 옛 계산 그대로다 — 등급도 난이도도 모르는 일반 굴림.
 */
export function spotChance(intel, id = null) {
  const G = TUNING.gara;
  const g = id ? GARA_BY_ID[id] : null;
  const hide = g ? (G.tierHide[g.tier] ?? 0) : 0;
  const clumsy = g && g.need > intel ? G.overreach : 0;
  return Math.max(G.spotFloor, Math.min(G.spotCeil, G.spotBase - intel * G.spotIntelPer + hide + clumsy));
}

/**
 * 그 자리에서 **그 시간에** 돌고 있는 가라들. 슬롯을 안 주면 시간을 안 따진다(그 자리 전부).
 *
 * 급습이 잡으려면 자리와 시간이 **둘 다** 맞아야 한다. 대리 점호는 생활관에서 점호 때만
 * 돌기 때문에, 오후에 생활관을 털면 거기 있는 것은 아무것도 없다 — 없어서가 아니라
 * 지금이 아니라서다. 그 차이를 코드가 알고 화면은 모른다.
 */
export const garaAt = (active, placeKey, slotKey = null) => active.filter(id => {
  const g = GARA_BY_ID[id];
  return g?.place === placeKey && (!slotKey || g.when.includes(slotKey));
});

/** 등급표를 하나 꺼낸다. 모르는 id면 제일 가벼운 것으로 떨어진다. */
export const garaTierOf = id => GARA_TIERS[GARA_BY_ID[id]?.tier] || GARA_TIERS.petty;

/** 돌고 있는 것 중 재판급만. 검열이 터지는 자리이고, 주임원사가 제일 먼저 끊어야 할 것들이다. */
export const garaCourt = active => active.filter(id => GARA_BY_ID[id]?.tier === 'court');

/**
 * 지금 돌고 있는 것들의 **무게 합** — 개수가 아니라 등급으로 잰 위험이다.
 * 계기판의 「가라 N」은 개수만 말한다. 같은 4라도 전부 가벼운 4와 재판급이 낀 4는
 * 다른 부대이고, 그 차이를 드는 것이 이 값이다.
 */
export const garaWeight = active => active.reduce((n, id) => n + (garaTierOf(id).rank || 0), 0);

/**
 * 이 부대가 **감당 못 하는** 관행의 개수. 난이도(need)가 부대 지능보다 높은 것들이다.
 * 사고 롤이 쓰던 `max(0, 가라 − 지능)`의 정확한 실물이다 — 그 근사치는 「개수가 머리보다
 * 많으면 어설프다」였고, 이제는 어느 관행이 어떻게 어설픈지를 표가 안다.
 */
export const garaOverreach = (active, intel) => active.filter(id => (GARA_BY_ID[id]?.need ?? 0) > intel).length;

/**
 * 들이닥친 결과가 **확인 명부**를 어떻게 고치는가. 순수 함수다.
 *
 * 세 가지가 한꺼번에 일어난다:
 *   1. 그 자리에서 **없어진 것은 지워진다** — 들어가 봤으니 안다.
 *   2. 그 자리에서 **잡힌 것은 오늘 날짜로 오른다** — 이미 알던 것이면 날짜만 새로 찍힌다.
 *   3. 그 자리에서 **숨긴 것은 안 보인다** — 이미 알고 있었다면 그 믿음은 그대로 남는다.
 *
 * 그래서 명부는 두 방향으로 틀릴 수 있다. 낡아서 틀리고(안 가 본 자리는 그날의 사실이 남는다),
 * 못 봐서 빈다(지능 높은 부대는 절반쯤 숨긴다). 그게 이 게임에 남은 마지막 안개다.
 */
export function inspectGara({ active, known = [], placeKey, slotKey = null, intel, on, rng = Math.random }) {
  // 자리와 시간이 **둘 다** 맞는 것만 눈에 들어온다. 같은 생활관이라도 점호 때가 아니면
  // 대리 점호는 거기 없다 — 멎어서가 아니라 지금이 그 시간이 아니라서다.
  const here = garaAt(active, placeKey, slotKey);
  const spotted = here.filter(id => rng() < spotChance(intel, id));
  // 명부 정리 — 「들어가 봤으니 안다」는 **볼 수 있었던 것에만** 성립한다.
  // 이 자리 것이라도 지금 시간대에 안 도는 것은 있는지 없는지 알 수가 없으므로 그대로 둔다.
  // 이 한 줄이 없으면 아무 때나 들이닥치는 것만으로 명부가 저절로 정리돼서, 시간을 맞추는
  // 일이 게임에서 사라진다.
  const kept = known.filter(k => {
    const g = GARA_BY_ID[k.id];
    if (!g || g.place !== placeKey) return true;
    if (slotKey && !g.when.includes(slotKey)) return true;
    return here.includes(k.id);
  });
  const next = kept.filter(k => !spotted.includes(k.id));
  for (const id of spotted) next.push({ id, on });
  return { spotted, missed: here.filter(id => !spotted.includes(id)), known: next };
}

// ── 검열 — 정기적으로 부대를 헤집는 외부의 눈 ─────────────
//
// 불시점검이 주임원사가 **사는** 정보라면, 검열은 **당하는** 것이다. 선글라스에 검은 옷을 입은
// 검열관들이 일과 슬롯을 따라 부대를 통과하면서, 그 자리·그 시간에 돌고 있는 관행을 굴린다.
// 걸리면 그게 사고다 — 재판급이 걸린 날 무사고 기록이 깨지고 헌병대가 사람을 데려간다.
//
// 주임원사에게 있는 것은 검열관에게 없는 둘이다: **미리 안다**는 것(warn일 전 예고)과,
// **어느 자리를 언제 털지 고른다**는 것. 검열관은 그냥 일과표를 따라 걸어 들어온다.

/** 이 부임일차가 검열일인가. 맞으면 회차(0부터)와 이름을 준다. */
export function censorOn(dayNo) {
  const C = TUNING.censor;
  const level = C.days.indexOf(dayNo);
  if (level < 0) return null;
  return { level, label: C.labels[level] || C.labels.at(-1), day: dayNo };
}

/** 다음 검열이 며칠 남았는가. 예고 기간(warn) 안에 들어와야 알려준다 — 그전에는 안 보인다. */
export function censorAhead(dayNo) {
  const C = TUNING.censor;
  for (let i = 0; i < C.days.length; i++) {
    const gap = C.days[i] - dayNo;
    if (gap > 0 && gap <= C.warn) return { level: i, label: C.labels[i] || C.labels.at(-1), in: gap, day: C.days[i] };
  }
  return null;
}

/**
 * 검열관 하나가 관행 하나를 잡아낼 확률. 주임원사의 굴림(spotChance)과 같은 모양이되
 * 기본치가 세고 회차마다 더 세진다. 등급과 난이도는 여기서도 똑같이 작용한다 —
 * 재판급은 검열관 앞에서도 잘 숨고, 감당 못 하는 짓은 검열관 앞에서 특히 표가 난다.
 */
export function censorChance(intel, level = 0, id = null) {
  const C = TUNING.censor, G = TUNING.gara;
  const g = id ? GARA_BY_ID[id] : null;
  const hide = g ? (G.tierHide[g.tier] ?? 0) : 0;
  const clumsy = g && g.need > intel ? G.overreach : 0;
  return Math.max(C.floor, Math.min(C.ceil,
    C.base - intel * C.intelPer + level * C.levelPer + hide + clumsy));
}

/**
 * 검열관이 슬롯 하나 동안 부대를 훑는다. **자리를 안 고른다** — 그게 주임원사와 다른 점이다.
 * 주임원사는 하루에 한 자리를 골라 들이닥치고, 검열관들은 흩어져서 전부 뒤진다.
 *
 * 그래서 여기서 자리는 걸러내는 축이 아니라 「어디서 나왔는가」일 뿐이고, 거르는 축은
 * **시간 하나**다: 지금 이 시간에 실제로 돌고 있는 것만 현장이 있다.
 *
 * `done`은 오늘 이미 굴린 것들이다. 관행 하나는 **검열일 하루에 정확히 한 번** 굴려진다 —
 * 시간대가 셋인 관행이 세 번 굴려지면 넓게 도는 것일수록 자동으로 걸리고, 그러면 등급도
 * 난이도도 안 보고 「자주 도는 것부터」 걸리는 판이 된다. 굴림은 관행마다 한 번이다.
 *   checked — 이번 슬롯에 굴려진 것들 (걸렸든 안 걸렸든 — 오늘은 다시 안 굴린다)
 *   caught  — 그중 실제로 걸린 것들
 */
export function censorSweep({ active, slotKey, intel, level = 0, rng = Math.random, done = [] }) {
  const checked = active.filter(id => !done.includes(id) && GARA_BY_ID[id]?.when.includes(slotKey));
  return { checked, caught: checked.filter(id => rng() < censorChance(intel, level, id)) };
}

/**
 * 검열 하루치를 마감한다 — 걸린 것 전부를 놓고 강평이 무엇이 되는가. 순수 함수다.
 *   findings — 등급 순으로 정렬한 적발 목록 (무거운 것이 위)
 *   blows    — 재판급. 하나라도 있으면 **사고**다
 *   effect   — 파라미터 확정 이동 (LLM이 폭을 정하는 자리는 여기에도 없다)
 * 지적이 하나도 없으면 이 게임에 몇 안 되는 상방이 열린다 — 평판 +1 · 행복 +1.
 * 그래서 검열은 벌칙이기만 한 것이 아니라 **잘 치운 100일에 값을 쳐 주는 자리**이기도 하다.
 */
export function censorReport(caught = []) {
  const C = TUNING.censor;
  const findings = [...new Set(caught)].filter(id => GARA_BY_ID[id])
    .sort((a, b) => garaTierOf(b).rank - garaTierOf(a).rank);
  const blows = findings.filter(id => garaTierOf(id).blows);
  const serious = findings.filter(id => garaTierOf(id).rank >= 1);
  const effect = findings.length
    ? { ...C.flagged, ...(serious.length ? { conflict: C.seriousConflict } : {}) }
    : { ...C.clean };
  return { findings, blows, serious, clean: !findings.length, effect };
}

/** 검열이 데려가는 사람의 부재 — 유형이 아니라 검열 자신이 정한다. 헌병대가 그 자리에서 데려간다. */
export function custodyFor(rng = Math.random) {
  const [lo, hi] = TUNING.censor.custody.days;
  return { kind: TUNING.censor.custody.kind, days: lo + Math.floor(rng() * (hi - lo + 1)) };
}

// ── 부재 — 사고가 데려간 사람이 어디에 있는가 ──────────────
// 유형 열둘 중 여섯만 사람을 빼낸다(TUNING.absence.rules). 나머지는 징계·행정이라
// 부대 안에서 끝난다 — 폰 걸린 놈이 사라지지는 않는다.
// en은 프롬프트로 나가는 표기다(브리핑에 「지금 없는 사람」으로 실린다 — §9.4).
export const ABSENCE_KINDS = {
  hospital: {
    label: '입원', icon: '🏥', where: '국군병원',
    en: 'in a military hospital after the accident',
    line: (name, until) => `${name}은(는) 국군병원으로 후송됐다. 복귀 예정 ${until}.`,
    back: name => `${name} 퇴원 복귀 신고. 명부에 다시 오른다.`,
  },
  awol: {
    label: '이탈', icon: '🚪', where: '부대 밖',
    en: 'absent without leave — gone from the unit',
    line: (name, until) => `${name}은(는) 부대에 없다. 군무이탈 보고가 올라갔다 — 복귀 예정 ${until}.`,
    back: name => `${name} 복귀. 조사는 조사대로 남지만, 우선 인원은 채워졌다.`,
  },
  // 검열이 재판급을 잡아낸 날 생기는 부재. 사고가 데려가는 것이 아니라 **헌병대가 데려간다** —
  // 조사받고 돌아오거나, 재판 결과에 따라 그대로 안 돌아오기도 하는 자리다.
  custody: {
    label: '구속', icon: '⛓', where: '군사경찰대',
    en: 'in military police custody pending investigation',
    line: (name, until) => `${name}은(는) 군사경찰대가 그 자리에서 데려갔다. 조사 종료 예정 ${until}.`,
    back: name => `${name} 조사 종료 복귀. 처분은 처분대로 남는다.`,
  },
};

/**
 * 이 사고가 사람을 빼내는가. 빼낸다면 며칠인가.
 * 유형(열둘 중 하나)만 보고 정한다 — 판정 호출은 늘지 않는다. 폭은 언제나 코드다.
 */
export function absenceFor(categoryId, rng = Math.random) {
  const rule = TUNING.absence.rules[categoryId];
  if (!rule) return null;
  const [lo, hi] = rule.days;
  return { kind: rule.kind, days: lo + Math.floor(rng() * (hi - lo + 1)) };
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
  { id: 'sports-injury', tier: 'minor', cat: 'injury', kinds: ['rest'], place: 'worksite', involved: 2, weight: 3, pull: 'macho', desc: '족구·축구 중 부상 정황' },
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
  { id: 'muzzle-play', tier: 'minor', cat: 'firearm', kinds: ['work', 'rest'], place: 'armory', involved: 2, weight: 1, pull: 'macho', desc: '총기 수입 중 장난 — 총구가 사람을 향했다' },
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
  // ── 증명하려고 하는 짓 — 아무도 안 시켰다 ──────────────
  // 마초가 높은 부대에서 사내다움은 증명해야 하는 것이고, 증명은 몸으로 한다.
  // 유형은 기존 열둘 안에 그대로 떨어진다(부상·보건) — 새 그림이 필요 없다.
  { id: 'macho-dare', tier: 'minor', cat: 'injury', kinds: ['rest', 'work'], place: 'worksite', involved: 2, weight: 3, pull: 'macho', desc: '내기가 붙었다 — 아무도 안 시킨 짓을 하고 있다' },
  { id: 'cold-plunge', tier: 'minor', cat: 'health', kinds: ['rest'], place: 'guardpost', involved: 2, weight: 2, pull: 'macho', desc: '한겨울에 웃통을 벗고 있다. 말리는 놈이 없다' },
  { id: 'hide-injury', tier: 'minor', cat: 'injury', kinds: ['work', 'rollcall'], place: 'barracks', involved: 1, weight: 3, pull: 'macho', desc: '다친 걸 숨기고 있다 — 의무대 가는 걸 지는 걸로 안다' },
  { id: 'bare-hands', tier: 'minor', cat: 'injury', kinds: ['work'], place: 'storage', involved: 2, weight: 2, pull: 'macho', desc: '장비를 맨손으로 든다. 보호구는 옆에 놓여 있다' },
  // ── 조용해지는 것 — 소리가 안 나서 늦게 안다 ────────────
  // 전우애가 얕은 부대에서 사람은 큰 소리가 아니라 조용히 무너진다.
  { id: 'quiet-one', tier: 'minor', cat: 'abuse', becomes: 'selfharm', kinds: ['meal', 'rest'], place: 'messhall', involved: 1, weight: 3, pull: 'lonely', desc: '한 명이 며칠째 아무하고도 말을 안 한다' },
  { id: 'chat-room', tier: 'minor', cat: 'abuse', kinds: ['rest', 'sleep'], place: 'barracks', involved: 2, weight: 3, pull: 'lonely', desc: '단체방이 하나 더 파였다 — 한 명만 빼고' },
  { id: 'no-sleep', tier: 'minor', cat: 'health', becomes: 'selfharm', kinds: ['sleep', 'rollcall'], place: 'barracks', involved: 1, weight: 2, pull: 'lonely', desc: '며칠째 잠을 안 잔 놈이 있다. 사지방 불이 새벽까지 켜져 있다' },
  { id: 'polite-cut', tier: 'minor', cat: 'abuse', kinds: ['work', 'meal'], place: 'office', involved: 2, weight: 2, pull: 'lonely', desc: '정중한 말로 한 사람을 잘라냈다 — 아무도 목소리를 안 높였다' },
  // 보건·환자
  { id: 'food-illness', tier: 'minor', cat: 'health', kinds: ['meal'], place: 'messhall', involved: 2, weight: 2, desc: '같은 식탁에서 여럿이 복통을 호소한다' },
  { id: 'heat-casualty', tier: 'minor', cat: 'health', kinds: ['work'], place: 'worksite', involved: 1, weight: 2, desc: '작업 중 한 명의 얼굴이 하얗다 — 온열·한랭 손상 정황' },
  // 대외·민간
  { id: 'sns-leak', tier: 'minor', cat: 'outside', kinds: ['rest', 'sleep'], place: 'smoking', involved: 1, weight: 1, desc: '부대 사진이 SNS에 올라갔다 — 배경에 초소가 찍혔다' },
  { id: 'civil-damage', tier: 'minor', cat: 'outside', kinds: ['work'], place: 'worksite', involved: 2, weight: 1, desc: '작업 중 민간 담장·차량을 건드렸다는 민원' },

  // ── 큰 사건 — 갈등이 8을 넘겨야 열린다 ──
  { id: 'desertion-sign', tier: 'major', cat: 'absent', kinds: ['rollcall', 'work'], place: 'barracks', involved: 1, weight: 2, pull: 'lonely', desc: '탈영 의심 — 관물대가 비어 있다' },
  { id: 'selfharm-sign', tier: 'major', cat: 'selfharm', kinds: ['rest', 'sleep'], place: 'barracks', involved: 1, weight: 2, pull: 'lonely', desc: '자해 정황 — 혼자 있으려는 병사' },
  { id: 'group-abuse', tier: 'major', cat: 'abuse', kinds: ['rest', 'sleep', 'meal'], place: 'barracks', involved: 2, weight: 2, pull: 'lonely', desc: '집단 따돌림·구타 정황이 드러남' },
  { id: 'unauthorized-drill', tier: 'major', cat: 'abuse', kinds: ['work', 'rest'], place: 'worksite', involved: 2, weight: 1, pull: 'macho', desc: '규정 밖 얼차려 — 완전군장으로 세워 놨다' },
  { id: 'weapon-taken', tier: 'major', cat: 'firearm', kinds: ['work', 'rollcall', 'sleep'], place: 'armory', involved: 1, weight: 1, desc: '총기·실탄 무단 반출 정황 — 수불부만 멀쩡하다' },
];

// ── 사고 판정 롤 (LLM 없음) ───────────────────────────────
// 하루 9개 일과 슬롯마다 한 번씩 굴린다. rng는 주입식이다 — 테스트가 결정적으로 돈다.
// minMental은 명부에서 제일 낮은 멘탈이다. 갈등이 부대 단위로 여는 큰 사고와 별개로,
// **한 명이 무너지는 것**도 큰 사고(자해·탈영)를 연다 — 그 한 명이 누구인지가 보이는 게임이라
// 상담으로 미리 막을 수 있고, 그게 면담의 존재 이유다.
/**
 * 전우애가 만드는 완충. 부대 static 축이라 부임 내내 안 변한다.
 *   open  — 큰 사고가 열리는 갈등 문턱. 전우애가 높을수록 뒤로 밀린다
 *   scale — 문턱 초과분의 가중 배수. 전우애가 낮을수록 크게 번진다
 *   small — 작은 사건 위험 가산. 전우애가 낮을수록 잔갈등이 사건이 된다
 * 전우애를 안 주면(옛 부대 데이터) 중립으로 떨어져 예전 수치가 그대로 나온다.
 */
export function comradeEffect(comrade) {
  const C = TUNING.comrade, R = TUNING.roll;
  const gap = C.neutral - (comrade ?? C.neutral);   // 중립보다 얼마나 부족한가
  return {
    open: R.big.open - gap * C.openPer,
    scale: Math.max(0, 1 + gap * C.bigPer),
    small: gap * C.smallPer,
  };
}

/**
 * overreach·heat는 **가라 목록이 있을 때만** 들어온다.
 *   overreach — 이 부대가 감당 못 하는 관행의 개수(garaOverreach). 주면 `max(0, 가라 − 지능)`
 *               자리를 대신한다 — 그 항은 목록이 없던 시절의 근사치였고, 이제 실물이 있다.
 *               두 개를 같이 세면 같은 것을 두 번 세는 것이라 대체다.
 *   heat      — 돌고 있는 것들의 등급 무게 합(garaWeight). 재판급은 개수 하나라도
 *               그 자체로 폭탄이라, 개수만 보는 눈금이 못 잡는 위험을 이 항이 든다.
 * 둘 다 안 주면(테스트·옛 호출) 예전 수식이 한 글자도 안 바뀐 채 그대로 나온다.
 */
export function incidentRisk({ gara, conflict, minMental = 10, overreach = null, heat = 0 }, { intel, macho, difficulty, comrade }) {
  const R = TUNING.roll, M = TUNING.mental, G = TUNING.gara;
  const C = comradeEffect(comrade);
  const clumsy = overreach == null ? Math.max(0, gara - intel) * R.dumbSloppyPer : overreach * G.overreachRisk;
  const small = Math.max(0,
    R.base
    + macho * R.machoPer
    + Math.max(0, gara + difficulty - 10) * R.hardSloppyPer
    + clumsy
    + heat * G.tierRisk                             // 등급이 무거우면 개수와 무관하게 위험하다
    + C.small                                       // 전우애가 얕으면 잔갈등이 사건이 된다
    - (conflict >= R.suppressAt ? R.suppress : 0));
  // 전우애가 문턱을 밀고, 넘어선 뒤의 번짐 폭도 정한다 —
  // 같은 갈등 8이라도 끈끈한 부대에서는 아직 안 열리고, 서로 남인 부대에서는 이미 열려 있다.
  const fromConflict = conflict >= C.open ? (conflict - C.open + 1) * R.big.per * C.scale : 0;
  const fromMental = minMental <= M.dangerAt ? (M.dangerAt - minMental + 1) * M.dangerPer : 0;
  return { small, big: fromConflict + fromMental, bigCause: fromMental > fromConflict ? 'mental' : 'conflict' };
}

/**
 * 슬롯 하나의 롤. 성공하면 사건 발생 — { tier, cause? }. 사건은 아직 사고가 아니다.
 * cause는 큰 사건이 어디서 열렸는가다: 'conflict'(부대가 눌렸다) | 'mental'(한 명이 무너졌다).
 * 엔진이 이걸 보고 연루자를 고른다 — 무너진 놈의 사고는 그 놈에게 간다.
 */
export function rollSlot(params, unitStats, slotKind, rng = Math.random) {
  const { small, big, bigCause } = incidentRisk(params, unitStats);
  const mult = TUNING.roll.slotMult[slotKind] ?? 1;
  if (big > 0 && rng() < big * mult) return { tier: 'major', cause: bigCause };
  if (rng() < small * mult) return { tier: 'minor' };
  return null;
}

/**
 * 롤이 성공한 슬롯의 사건 후보 뽑기. 풀 밖 창작은 없다.
 * 무게 추첨이다 — 족구 부상이 탄약고 흡연보다 흔해야 한다.
 */
/**
 * 씨앗 하나의 당김. `pull`은 **부대 성향의 이름**이지 부대 id가 아니다 —
 * 성향 수치를 보는 가중이라 셋째 군을 넣어도 이 함수는 그대로다.
 *   macho  — 사내다움을 증명하려는 짓. 마초가 높을수록 자주 난다
 *   lonely — 아무도 안 들어가서 커지는 일. **전우애가 낮을수록** 자주 난다
 * 성향을 안 주면(테스트·기본값) 전부 중립이라 무게가 그대로다.
 */
export function pullWeight(event, traits = {}) {
  const w = event.weight ?? 1;
  if (!event.pull) return w;
  const N = TUNING.comrade.neutral, per = TUNING.roll.pullPer;
  const gap = event.pull === 'lonely'
    ? N - (traits.comrade ?? N)
    : (traits[event.pull] ?? N) - N;
  return Math.max(0.1, w * (1 + gap * per));
}

export function pickEvent(tier, slotKind, rng = Math.random, traits = {}) {
  const pool = EVENT_POOL.filter(e => e.tier === tier && e.kinds.includes(slotKind));
  const any = pool.length ? pool : EVENT_POOL.filter(e => e.tier === tier);
  return any[weightedPick(any.map(e => pullWeight(e, traits)), rng)];
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

/** 병사 하나의 연루 가중 — 등급이 낮을수록, 멘탈이 낮을수록 크다. 테스트가 단조성을 잰다. */
export function involveWeight(s) {
  const I = TUNING.involve;
  const grade = I.gradeWeights[Math.max(0, GRADES.indexOf(s.grade))];
  const mental = 1 + Math.max(0, I.mentalBase - (s.mental ?? I.mentalBase)) * I.mentalPer;
  return grade * mental;
}

/** 사건 연루 병사 선정. n명, 중복 없음. */
export function pickInvolved(roster, n, rng = Math.random) {
  const pool = roster.slice();
  const picked = [];
  while (picked.length < n && pool.length) {
    const i = weightedPick(pool.map(involveWeight), rng);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

// ── 멘탈 — 병사별 저장 상태. 굴림·드리프트·상담 전부 코드다 ──
/** 전입 시 멘탈 굴림. 인성 하위는 낮게 시작한다. */
export function rollMental(character, rng = Math.random, comrade = TUNING.comrade.neutral) {
  const M = TUNING.mental;
  const jitter = Math.floor(rng() * (M.start.jitter * 2 + 1)) - M.start.jitter;
  // 끈끈한 부대는 신병도 덜 흔들린다 — 서로 남인 부대에서는 처음부터 혼자다.
  // 이게 없으면 마초가 높은 부대(인성 하위가 두껍다)는 부임 첫날에 멘탈 2 이하를
  // 안고 시작할 확률이 절반을 넘었다(실측 52%). 큰 사고의 문이 플레이 전에 열려 있었다.
  const bond = (comrade - TUNING.comrade.neutral) * M.startComradePer;
  return clamp(Math.round(M.start.base + bond) + jitter + (M.charPenalty[character] || 0));
}

/**
 * 하루 마감의 멘탈 드리프트 — 부대 분위기가 전원을 같은 방향으로 쓸어간다.
 * 개인차는 여기가 아니라 사건 연루(−)와 상담(+)이 만든다.
 */
export function mentalDrift(mental, params, comrade = TUNING.comrade.neutral) {
  const M = TUNING.mental;
  // 전우애가 세 눈금을 전부 민다. 끈끈한 부대(전우애 10)는 행복 1 이하라야 사람이 무너지고
  // 행복 6이면 벌써 회복하는데, 서로 남인 부대(전우애 2)는 행복 4에 이미 무너지고
  // 9는 돼야 회복한다. 같은 분위기가 부대마다 다른 무게로 사람에게 닿는다.
  // 전우애는 **방패지 저주가 아니다.** 중립 위쪽으로만 문턱을 민다:
  // 끈끈한 부대는 분위기가 바닥을 쳐야 사람이 무너지고(행복 ≤1), 얕은 부대는 방패가
  // 없을 뿐 기본 눈금(행복 ≤3) 그대로다.
  //
  // 아래로도 밀게 두면 얕은 부대의 문턱이 4.2가 되는데, **사건 한 건이면 그날 행복이
  // 정확히 4가 된다**(판정은 하루 한 칸까지만 민다). 즉 사건 한 건에 열여섯 명이 전부
  // −1을 맞고, 그 하락은 하루 마감 드리프트가 행복을 제자리로 되돌려 놓아 계기판에도
  // 안 보인다. 실측 궤적: 멘탈 합이 83 → 65 → 49 → 30 → 8 → 0으로 계단처럼 떨어졌고,
  // 매일 면담을 해도 못 막았다(회복 0.5명 대 하락 16명).
  // 얕은 부대의 페널티는 **회복 인원이 없다는 것**이지 더 잘 무너진다는 것이 아니다.
  const bond = Math.max(0, comrade - TUNING.comrade.neutral) * TUNING.comrade.mentalPer;
  // 여기는 **하락만** 본다. 분위기가 나쁘면 전원이 같이 나빠지기 때문이다.
  // 회복은 인원이 정해져 있어서 개인 함수가 아니라 명부 전체를 보는 mentalPass의 몫이다.
  let d = 0;
  if (params.happy <= M.driftHappyLow - bond) d -= 1;
  if (params.conflict >= M.driftConflictHigh + bond) d -= 1;
  return clamp(mental + Math.max(-1, Math.min(1, d)));
}

/**
 * 부대가 평소 이상일 때 하루에 저절로 돌아오는 인원. 전우애가 정한다.
 * **소수부는 확률이다** — 전우애 2면 기대값 0.5명, 즉 이틀에 한 명꼴이다.
 * 정수로 끊으면 얕은 부대의 회복이 통째로 0이 되어 멘탈이 한 방향으로만 흐르고,
 * 그러면 그 부대는 평판이 허락하는 하루 한 번의 면담으로 정확히 본전을 치는 게임이 된다 —
 * 여유가 한 칸도 없어서 사고가 한 번 나면 그대로 나선이다(실측: 완주율 0%).
 */
export function recoverCount(comrade, rng = Math.random) {
  const n = Math.max(0, (comrade ?? TUNING.comrade.neutral) * TUNING.comrade.recoverPer);
  return Math.floor(n) + (rng() < n % 1 ? 1 : 0);
}

/**
 * 하루 마감의 멘탈 처리 전부. 명부를 받아 새 멘탈 배열을 돌려준다(원본은 안 건드린다).
 *   하락 — 분위기가 나쁘면 **전원**이 같이 (mentalDrift)
 *   회복 — 부대가 평소 이상이면 **제일 힘든 몇 명**만, 평상 상태까지. 인원은 전우애가 정한다
 * 하락이 전원이고 회복이 몇 명인 비대칭이 이 게임의 멘탈 경제다 — 그래서 얕은 부대에서는
 * 사람이 쌓이듯 무너지고, 주임원사가 하루 한 명씩 붙잡는 것 말고는 되돌릴 길이 없다.
 */
export function mentalPass(soldiers, params, comrade = TUNING.comrade.neutral, rng = Math.random) {
  const M = TUNING.mental;
  const out = soldiers.map(s => mentalDrift(s.mental ?? M.default, params, comrade));
  if (params.happy < TUNING.start.happy) return out;
  const n = recoverCount(comrade, rng);
  if (!n) return out;
  // 제일 힘든 놈부터. 이미 평상 상태인 사람은 회복할 것이 없다.
  const order = out.map((m, i) => [m, i]).filter(([m]) => m < M.start.base).sort((a, b) => a[0] - b[0]);
  for (const [, i] of order.slice(0, n)) out[i] = clamp(out[i] + 1);
  return out;
}

/** 면담(상담) 한 번의 회복. */
export const counselMental = mental => clamp(mental + TUNING.mental.counsel);
/** 사건 연루 한 번의 타격. escalated면 더 깎인다. */
export const incidentMental = (mental, escalated) =>
  clamp(mental + TUNING.mental.incidentHit + (escalated ? TUNING.mental.escalationHit : 0));

/** 명부에서 제일 낮은 멘탈 — 큰 사고 위험의 입력이다. 빈 명부면 안전값. */
export const minMentalOf = roster =>
  roster.length ? Math.min(...roster.map(s => s.mental ?? TUNING.mental.default)) : 10;

// ── 불시점검(군기 점검) — 순수 코드 효과 ─────────────────
/**
 * 검열 결과를 파라미터에 꽂는다 — censorReport의 effect를 그대로 받는다.
 * 개입과 같은 부류의 **확정 이동**이라 하루 한 칸 제한(capDay)을 안 받는다.
 * 검열은 주임원사가 부른 것이 아니므로 평판을 개입으로 깎지 않는다 —
 * 대신 무결점으로 넘기면 평판이 오른다(TUNING.censor.clean).
 */
export function applyCensor(params, effect = {}) {
  const out = { ...params };
  for (const k of PARAM_KEYS) if (effect[k]) out[k] = clamp(out[k] + effect[k]);
  return out;
}

export function applyInspection(params) {
  return {
    ...params,
    gara: clamp(params.gara + TUNING.inspect.gara),
    happy: clamp(params.happy + TUNING.inspect.happy),
  };
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

/**
 * 하루의 이동량 상한. 드리프트는 처음부터 하루 ±1로 묶여 있었는데 **판정은 안 묶여 있었다** —
 * 같은 눈금에 속도 제한이 둘이었던 셈이다. 사건이 하루 다섯 건 나는 날(난이도가 높게
 * 저작된 부대에서는 흔하다) 가라가 하루에 +5까지 뛰었고, 가라가 오르면 사고 롤이 커져 사건이
 * 더 나는 되먹임이 붙어 부임 일주일이면 가라가 천장에 붙었다(실측: 100%가 그렇게 됐다).
 *
 * dawn은 그날 새벽의 파라미터다. 사건이 몇 건이 나든 하루의 총 이동은 축마다 한 칸이다 —
 * 「어제와 오늘 사이에 부대가 한 걸음 움직인다」는 규칙이 이제 판정에도 걸린다.
 */
export function capDay(params, dawn) {
  const out = { ...params };
  for (const k of PARAM_KEYS) {
    if (dawn[k] == null) continue;
    out[k] = clamp(dawn[k] + Math.max(-1, Math.min(1, params[k] - dawn[k])));
  }
  return out;
}

/** 개입 하나(면담·점검·공지)의 평판 비용. 순수 코드 — 개입 횟수가 곧 평판이다. */
export function applyIntervention(params) {
  return { ...params, rep: clamp(params.rep + TUNING.rep.perIntervention) };
}

/**
 * 하루 마감 드리프트. 파라미터끼리 얽히는 공식 전부 — §4의 표 그대로다.
 * 각 파라미터 하루 최대 ±1칸.
 *
 * difficulty는 계절·주말 보정을 거친 **오늘의** 실효 난이도고, baseline은 **그 부대의
 * 평소치**다(부대 프롬프트가 정한 static 값). 둘의 차이가 「오늘이 평소보다 힘든가」다 —
 * 절대 눈금으로 보면 빡센 부대는 매일이 힘든 날이 되어 행복이 단조 감소한다(TUNING.drift 주석).
 * baseline을 안 주면 오늘이 곧 평소다 — 힘들지도 편하지도 않은 날로 떨어진다.
 *
 * 아무 사유도 안 걸린 날은 **제자리로 한 칸 돌아온다.** 평판의 「개입 없는 조용한 날은
 * +1 회복」과 같은 자리다: 방치한 부대는 나빠지는 게 아니라 평범해진다. 이게 없으면
 * 어느 방향이든 한 번 밀린 값이 벽까지 가서 눌러앉는다(행복↓ → 갈등↑ → 행복↓의 되먹임).
 */
export function applyDrift(params, difficulty, { interventions = 0, baseline = difficulty } = {}) {
  const D = TUNING.drift;
  const load = difficulty - baseline;   // 오늘이 이 부대의 평소보다 얼마나 힘든가
  let dHappy = 0, dConflict = 0;

  if (params.gara >= D.garaHigh) dHappy += 1;          // 편하니까
  if (params.gara <= D.garaLow) dHappy -= 1;           // FM대로 굴리면 힘들다
  // 달력은 **제자리로 되돌리는 힘이지 제자리를 넘기는 힘이 아니다.** 힘든 날은 갈등을
  // 평소까지 눌러 주고, 편한 날은 행복을 평소까지 올려 준다 — 그 너머로 미는 것은
  // 사건과 개입의 몫이다. 이 단서가 없으면 계절이 한 방향으로만 작동한다: 여름 평일마다
  // 갈등 −1이 붙어서 부임 열흘이면 갈등이 0에 붙고 여름 내내 거기 눌러앉았다(실측).
  // 그러면 갈등 축이 통째로 죽고, 큰 사고의 문이 영영 안 열린다.
  if (load >= D.hardOver) { if (params.conflict > TUNING.start.conflict) dConflict -= 1; }
  else if (load <= -D.easyUnder) { if (params.happy < TUNING.start.happy) dHappy += 1; }
  if (params.conflict >= D.conflictHigh) dHappy -= 1;  // 눌린 부대는 어둡다
  if (params.happy <= D.happyLow) dConflict += 1;      // 불행하면 싸운다
  if (params.happy >= D.happyHigh) dConflict -= 1;     // 행복하면 덜 싸운다

  // 아무것도 안 민 축은 제자리로 — 부임 첫날의 부대가 이 부대의 「평소」다.
  //
  // 이 회복을 「사건이 없었던 날에만」으로 묶어 봤다가 물렸다. 그러면 사건이 잦은 부대는
  // 절반의 날에 회복을 못 받고, 판정의 down 편향이 그대로 쌓여 행복 0·갈등 10으로 간다.
  // 매일 붙이면 반대로 사건 하나가 민 한 칸을 다음 날 정확히 도로 당겨서 잘 안 쌓인다 —
  // 그 대신 무사고 100일이 원래 드문 일이 된다(무개입 완주율 8~17%). 후자를 골랐다:
  // 이 게임의 실패는 「매일 조금씩 나빠지다 어느 날 무너지는 것」이 아니라
  // 「대체로 굴러가다 한 번 크게 터지는 것」이다.
  if (dHappy === 0) dHappy = Math.sign(TUNING.start.happy - params.happy);
  if (dConflict === 0) dConflict = Math.sign(TUNING.start.conflict - params.conflict);

  // 가라도 제자리로 돌아온다. **여기가 마지막으로 뚫려 있던 구멍이었다** — 가라만 드리프트
  // 항이 하나도 없어서, 판정이 up 쪽으로 조금만 기울어도 천장까지 걸어 올라갔고(실측:
  // 100%가 그랬다) 거기 붙으면 나머지 축까지 끌고 갔다(가라 ≥7 → 행복 매일 +1 → 갈등 0).
  // 대신 이 축은 **유지에 비용이 드는 축**이 된다: 점검으로 내려 놓은 가라는 그냥 두면
  // 도로 올라온다. 관행은 원래 그렇다 — 한 번 잡는 게 아니라 계속 잡는 것이다.
  const dGara = Math.sign(TUNING.start.gara - params.gara);

  const step = v => Math.max(-1, Math.min(1, v));
  return {
    ...params,
    gara: clamp(params.gara + step(dGara)),
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

// ── 마지막 씬 — 환송회 ────────────────────────────────────
// 100일을 찍으면 원사 진급이고, 진급은 이 부대를 뜬다는 뜻이다. 그 마지막 밤이
// 어떤 모습이냐를 정하는 것은 무사고 기록도 평판도 아니라 **행복도**다:
// 기록은 주임원사가 가져가는 것이고, 밥상은 병사들이 차리는 것이라서다.
export const FAREWELL_TONES = ['grand', 'thin', 'none'];

/**
 * 마지막 씬의 결. 행복도 하나가 정한다 — LLM은 이 갈래를 못 고른다.
 *   grand — 거하게 차린다. 병사들이 앞에 나와 인사한다
 *   thin  — 몇 명만 어정쩡하게 남는다
 *   none  — 아무도 없다. 위병소까지 혼자 걸어 나간다
 */
export function farewellTone(happy) {
  const h = clamp(happy);
  if (h >= TUNING.farewell.grand) return 'grand';
  if (h <= TUNING.farewell.empty) return 'none';
  return 'thin';
}

/** 그 자리에서 입을 여는 인원. 결마다 다르고, 아무도 없는 밤은 0이다. */
export const sendoffSize = tone => TUNING.farewell.speakers[tone] || 0;

/**
 * 환송회에서 입을 여는 놈들 — **잘 버틴 순**(멘탈 내림차순)이고, 같으면 짬 순이다.
 * 사건 연루자 선정(pickInvolved)의 정확한 반대편이다: 사고는 무너진 놈들에게서 나고,
 * 인사는 버틴 놈들이 한다. 난수를 안 쓴다 — 마지막 밤은 굴리는 자리가 아니다.
 */
export function pickSendoff(roster, tone) {
  const n = sendoffSize(tone);
  if (!n) return [];
  const m = s => s.mental ?? TUNING.mental.default;
  return roster.slice()
    .sort((a, b) => m(b) - m(a) || String(a.joined).localeCompare(String(b.joined)))
    .slice(0, n);
}

/** 게이지 하나를 화면에 그릴 때 쓰는 값 (평판 등 노출용). */
export function gauge(value, max = SCALE.max) {
  const v = clamp(value);
  return { value: Math.round(v), max, pct: Math.round(v / max * 100) };
}
