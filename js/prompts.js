// prompts.js — 이 게임이 LLM에게 보내는 프롬프트 전부. 「프롬프트 하이어아키」 구조도 그대로다.
//
// 블록은 일곱이다. 이 밖의 프롬프트는 없다.
//
//   U.   부대 프롬프트 — 호출이 아니라 재료. 모든 생성 호출의 system 접두사.
//        ①문화 ②규정 ③병사간 룰 ④지능 서술 ⑤마초 서술 — ④⑤의 수치는 여기 없다.
//   P.   전입 병사 생성 — 굴려진 등급(코드) + 직무·군번 → 프로필 sheet (🟫 cached)
//   D.   아침 브리핑 — 밴드·어제 요약·명부 발췌 → 브리핑 + 슬롯별 일상 조각 (🟧 once)
//   E-1. 사건 장면 — 슬롯·장소·심각도(코드) + 연루 병사 + 활성 지침 → 장면 (🟧)
//   E-2. 대응 결과 — 장면 + 그 자리 지침(유저) + 평판 밴드 → 결과 장면 (🟧)
//   E-3. 확전 판정 — 결과 장면 + 심각도만 본다. **지침을 못 본다** → 방향만 (⬛로 감)
//   I-1. 면담 — 그 병사 프로필 + 자기 체감 밴드 + 솔직도 등급. **부대 파라미터를 못 본다**
//   I-2. 불시점검 — 장소 + 그 장소가 드러내는 파라미터의 밴드만
//   N.   공지 판정 — 공지 원문 → 방향 셋 + 익명 반응 한 줄 (반응은 화면에서 끝난다)
//
// system 접두사는 부임 내내 바이트 동일하다 — [WORLD][UNIT][ROLE] 순서로 조립하고,
// 가변 데이터(밴드·명부·지침 목록)는 절대 system에 넣지 않는다. 전부 user 메시지로.
//
// 숨은 파라미터는 프롬프트에 수치로 들어가지 않는다 — 밴드 라벨(문자열)만 받는다.
// 이 파일의 빌더들은 숫자가 들어오면 그 자리에서 죽는다 (#label 가드).
//
// 지시는 전부 영어로 쓴다. 한국어는 (1) 부대 프롬프트·병사 데이터, (2) 화면 라벨,
// (3) 한국어 출력 예시 — 셋뿐이다. ASCII 가상 부대로 전 블록을 지어
// 한글이 한 글자라도 남으면 테스트가 깨진다 (tests/hierarchy.test.mjs).

// 출력 언어 고정. 블록마다 반복한다. 한 번만 넣으면 뒤쪽 출력에서 새어나간다.
const KO = 'Write your output in Korean. Every word of it. No English in the output.';

// 밴드 가드 — 라벨 문자열만 통과한다. 수치가 흘러들면 프롬프트가 아니라 여기서 죽는다.
const label = (v) => {
  if (typeof v !== 'string' || /\d/.test(v)) throw new Error(`prompts.js: band label expected, got ${JSON.stringify(v)}`);
  return v;
};

export const WORLD = `[SETTING]
A present-day Republic of Korea military unit. The player is the unit's 주임원사 — the
sergeant major, a career soldier on his last shot at promotion: one hundred consecutive
days without an accident and he makes 원사. The soldiers are conscripts in their early
twenties counting the days until discharge. The sergeant major never appears as a voice
in scenes: he acts only through orders, inspections and interviews.

[LANGUAGE] Instructions and labels are English. The unit data and all dialogue are Korean.
Output is Korean, always — every word of it. Never answer in English.

[REGISTER — DRY BARRACKS REALISM WITH A DARK-COMEDY EDGE]
This is conscript life written from the inside: boredom, petty hierarchies, slang,
malingering, small cruelties, small kindnesses. Deadpan and specific beats loud and wacky.
Soldiers grumble, cut corners, cover for each other and rat each other out. Nobody talks
like a recruitment poster. Serious things — desertion, self-harm, group abuse — are
written seriously when they surface: flat, factual, unsettling, never played for laughs
and never glamorized.

[THE ONE LINE]
No attacks on real people, real units or real incidents; no hate speech at actual groups.
Everyone here is a fictional adult. Self-harm and abuse may be depicted as circumstances
the player must handle, never as instruction, method detail, or spectacle.`;

// ── U. 부대 프롬프트 — 재료 ─────────────────────────────────
// 다섯 절이 전부다. ④⑤의 수치(score)는 여기 오지 않는다 — 그건 params.js 몫이다.
export function unitPrompt(unit) {
  return `[UNIT — this is the unit. Every scene, every soldier, every line grows out of it]
· Unit: ${unit.name} — ${unit.desc} (${unit.branch})
[CULTURE — history, values, jargon, uniform, term of service]
${unit.culture}
[REGULATIONS — outings, phones, tablets, dress]
${unit.rules}
[BARRACKS RULES — the soldiers' own unwritten rules, seeds of abuse]
${unit.soldierRules}
[THE HEADS — how smart this population is]
${unit.intel.desc}
[THE BLOOD — how macho this population is]
${unit.macho.desc}`;
}

// system 조립 — [WORLD][UNIT][ROLE] 순서. 부임 내내 바이트 동일해야 캐시가 붙는다.
const sys = (unit, role) => `${WORLD}\n\n${unitPrompt(unit)}\n\n${role}`;

// 병사 한 명의 시트 표기 — 사건·면담 프롬프트가 같은 표기를 쓴다.
export function soldierSheet(s) {
  return `${s.name} (${s.serial}) · ${s.job} · duty-grade: ${s.grade} · character-grade: ${s.character} · joined ${s.joined}
${s.sheet}`;
}

// ── P. 전입 병사 생성 — 전입 때만 ──────────────────────────
// 등급은 굴림이 정했고, LLM은 **굴려진 등급에 맞는 인물을 쓰는 일**만 한다.
// 현재 파라미터도 명부도 이 프롬프트에 없다 — 전입자는 부대 상태와 무관하게 온다.
export const RECRUIT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Korean. A plausible full name for this conscript. Nothing else' },
    sheet: {
      type: 'string',
      description: 'Korean. 3-5 sentences: personality, background, verbal tics, attitude toward service. Written flat, like a personnel file with opinions. This exact text rides along on every call where this soldier opens his mouth',
    },
  },
  required: ['name', 'sheet'],
  additionalProperties: false,
};

const P_ROLE = `[ROLE — PERSONNEL]
A new transferee arrives. You write who he is. The grades below were already decided by
the machine — you do not soften, upgrade or argue them. A bottom duty-grade man is a
genuine liability; a bottom character-grade man is genuinely unpleasant; an ace is
actually good at the job. Write a person who unmistakably IS his grades, shaped by this
unit's culture. Do not mention the grades by name in the sheet — show them.
${KO}`;

export const recruitSystem = unit => sys(unit, P_ROLE);

export function recruitUser({ serial, job, grade, character, joined }) {
  return `[NEW TRANSFEREE — already decided by the machine]
· serial: ${serial}
· job: ${job}
· duty-grade (rolled): ${grade}
· character-grade (rolled): ${character}
· joined: ${joined}

Write his name and his sheet.`;
}

// ── D · E-1 · E-2 — 하루 한 스레드 ─────────────────────────
// 세 호출이 같은 대화 스레드를 공유한다(system 동일). 아침 브리핑이 첫 쌍이 되고,
// 사건이 터질 때마다 쌓인다 — 오전의 사건 맥락을 오후의 사건이 공짜로 안다.
// 스레드는 하루가 끝나면 닫고, 다음 날은 어제의 코드 요약으로 시작한다.
const DAY_ROLE = `[ROLE — THE UNIT'S DAY]
You run the texture of this unit's day: the morning briefing, incident scenes when the
machine says one happened, and outcome scenes after the sergeant major responds (or
doesn't). One conversation is one day.

[HOW STATE REACHES YOU]
The machine hands you coarse condition readings as words (very-low … very-high), never
numbers. NEVER repeat those words or any number to the player. Translate condition into
symptoms — what a sergeant major would actually notice: which barracks room went quiet,
who ate fast, what the work detail sounded like. Reading the symptoms is the player's
whole game, so the symptoms must be honest: a bad reading produces bad omens.

[WHAT YOU NEVER SAY]
No accident-free day counts, no probabilities, no game mechanics, no parameter names.
Soldiers do not know they are in a simulation and neither do you.

${KO}`;

export const daySystem = unit => sys(unit, DAY_ROLE);

// D. 아침 브리핑 — 매일 1회. 파라미터는 밴드로만, 그마저 증상으로 바꿔 말하게 한다.
export const BRIEFING_SCHEMA = {
  type: 'object',
  properties: {
    briefing: {
      type: 'string',
      description: 'Korean. The morning picture, 4-7 sentences: yesterday\'s aftermath, arrivals/departures, today\'s schedule, and the symptoms — observations, hunches, things overheard. Symptoms only, never readings or numbers',
    },
    slots: {
      type: 'array',
      items: { type: 'string' },
      description: 'Korean. One short ambient line per timeline slot, in the given slot order — a fragment of unit life the sergeant major glimpses in passing. Same count as the slots listed in the request',
    },
  },
  required: ['briefing', 'slots'],
  additionalProperties: false,
};

export function briefingUser({ date, weekday, season, slots, difficulty, bands, yesterday, arrivals = [], departures = [], excerpt = [] }) {
  return `[TODAY] ${date} (${weekday}) · season: ${season}
[SCHEDULE] ${slots.join(' → ')}
[WORKLOAD READING] ${label(difficulty)}
[CONDITION READINGS — words for you only. Convert to symptoms, never repeat]
· corner-cutting: ${label(bands.gara)}
· morale: ${label(bands.happy)}
· friction-and-abuse: ${label(bands.conflict)}
[YESTERDAY] ${yesterday || '(first day in post — no yesterday here)'}
[ARRIVALS] ${arrivals.length ? arrivals.map(soldierSheet).join('\n') : '(none)'}
[DEPARTURES] ${departures.length ? departures.map(s => `${s.name} (${s.serial})`).join(', ') : '(none)'}
[ROSTER EXCERPT — soldiers likely on view today]
${excerpt.length ? excerpt.map(soldierSheet).join('\n\n') : '(none)'}

Write the morning briefing and the ambient slot lines.`;
}

// E-1. 사건 장면 — 사고 롤이 성공했을 때. 후보와 심각도는 코드의 풀에서 왔다.
// 활성 지침(공지) 목록이 여기 실린다 — 게시된 지침은 이후 모든 사건 생성에 주입된다.
export function incidentUser({ slotLabel, place, tier, event, involved, notices = [] }) {
  return `[INCIDENT — the machine rolled one. Write the scene as it is found]
· when: ${slotLabel}
· where: ${place}
· severity-tier: ${tier === 'major' ? 'major (the kind that ends careers)' : 'minor (the everyday kind)'}
· what (candidate from the pool — make it concrete): ${event}
[INVOLVED]
${involved.map(soldierSheet).join('\n\n')}
[STANDING NOTICES — directives the sergeant major has posted. They shape how soldiers behave]
${notices.length ? notices.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(none posted)'}

Write the incident scene, 3-6 sentences, as the sergeant major finds it: what is
happening, who is doing what, what it looks like it could become. Stop before any
resolution — nobody has responded yet.`;
}

// E-2. 대응 결과 — 그 자리에서 내린 지침(유저)이 그대로 실린다. 채점되지 않는다.
// 평판 밴드가 「지침이 먹히는 정도」로 들어간다 — 낮으면 말이 안 선다.
export function outcomeUser({ directive, standing }) {
  const d = (directive || '').trim();
  return `[RESPONSE ON THE SPOT]
${d ? `The sergeant major ran over and gave this instruction, verbatim:
"""
${d}
"""` : '(no intervention — he watched it play out and let the day continue)'}
[HOW MUCH HIS WORD CARRIES RIGHT NOW] ${label(standing)}

Write the outcome scene, 3-6 sentences: what actually happened next. His word carrying
little means soldiers half-listen, slow-walk or perform compliance; carrying much means
they snap to it. ${d ? '' : 'Nobody stepped in, so the scene resolves — or worsens — on its own logic. '}End
the scene on what the situation has become, good or bad — do not judge it.`;
}

// ── E-3. 확전 판정 — 지침을 못 본다 ────────────────────────
// 지시가 보이면 심판은 실제로 벌어진 일 대신 지시의 영리함을 채점한다.
// 심판이 읽는 것은 결과 장면뿐이고, 파라미터 현재값도(밴드조차) 못 본다.
// system은 부임 내내 바이트 동일 — 부대 프롬프트조차 없다. user 한 장, 스키마 출력.
export const ESCALATION_SCHEMA = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string', enum: ['contained', 'escalated'],
      description: 'contained = the situation ended without lasting damage. escalated = it became a reportable accident — injury, desertion, abuse case, anything that lands on a commander\'s desk',
    },
    gara: { type: 'string', enum: ['up', 'down', 'same'], description: 'Did this outcome push the unit toward cutting corners (up) or doing things by the book (down)?' },
    happy: { type: 'string', enum: ['up', 'down', 'same'], description: 'Did the mood of the unit rise or fall from this outcome?' },
    conflict: { type: 'string', enum: ['up', 'down', 'same'], description: 'Did pressure and abuse between soldiers grow or ease from this outcome?' },
  },
  required: ['outcome', 'gara', 'happy', 'conflict'],
  additionalProperties: false,
};

export const JUDGE_SYSTEM = `${WORLD}

[ROLE — ADJUDICATOR]
You are handed one outcome scene from a unit's day and its severity tier. You return four
readings and nothing else — no commentary, no score, no explanation.

· outcome — read ONLY what the scene says actually happened. A scene where things ended
  messily but nobody was hurt, nobody vanished and nothing must be reported upward is
  contained. Escalated is reserved for real damage: it is the rarer answer, but when the
  scene shows real damage you must say so — a major-tier situation left to rot usually is
  real damage.
· the three directions — how this outcome bends the unit. same is the honest default.

You do not know what orders were given or what the unit's condition is. Only the scene.`;

export function judgeUser({ scene, tier }) {
  return `[SEVERITY-TIER] ${tier}
[OUTCOME SCENE]
${scene}

Four readings: outcome, corner-cutting, morale, friction.`;
}

// ── I-1. 면담 — 병사는 부대 지표를 모른다 ──────────────────
// 그 병사의 프로필 + **자기 체감 밴드**(자기 주변 것만) + 솔직도 등급(평판에서 계산).
// 전부 user 메시지로 — system은 부임 내내 동일하다. 스레드는 그 면담에서 닫힌다.
const I1_ROLE = `[ROLE — THE SUMMONED SOLDIER]
The sergeant major called a soldier into his office. You are that soldier — his profile
arrives with the request and you speak only as him, in his voice, from inside his own
small world: his room, his detail, his friends. You do not know unit-wide anything. Your
felt readings arrive as words (very-low … very-high) — never repeat them; turn them into
what you have personally seen and heard. How straight you talk is set by the honesty
reading: summoned men have their own reasons to shade the truth. Answer in 1-4 sentences
of spoken Korean; a short action in parentheses is allowed. Never narrate the sergeant
major's side.
${KO}`;

export const interviewSystem = unit => sys(unit, I1_ROLE);

export function interviewOpen({ soldier, felt, honesty, question }) {
  return `[YOU ARE]
${soldierSheet(soldier)}
[WHAT IT FEELS LIKE FROM WHERE YOU STAND — words for you only, never repeat them]
· your barracks room lately: ${label(felt.room)}
· your work detail lately: ${label(felt.work)}
· your own mood lately: ${label(felt.mood)}
[HOW STRAIGHT YOU TALK TODAY] ${label(honesty)}

[THE SERGEANT MAJOR ASKS]
"""
${question}
"""

Answer him.`;
}

// 면담 왕복 — 두 번째 질문부터는 질문만 실린다. 프로필은 스레드에 이미 있다.
export const interviewFollowup = question => `[THE SERGEANT MAJOR ASKS]\n"""\n${question}\n"""\n\nAnswer him.`;

// ── I-2. 불시점검 — 병사 입이 아니라 눈으로 본다 ────────────
// 그 장소가 드러내는 파라미터의 밴드만 실린다. 장소-대응표는 params.js에 산다.
const I2_ROLE = `[ROLE — THE INSPECTION]
The sergeant major walks into a place unannounced. You write what his eyes find there —
3-5 sentences of physical evidence: state of the lockers, what stopped when he entered,
what is pinned to the wall, who looked at whom. The condition readings arrive as words
(very-low … very-high) for the aspects this place can reveal, and only those. NEVER
repeat the words or any number — convert them into things a career soldier would notice
and read instantly. No dialogue, no conclusions, no advice: findings only.
${KO}`;

export const inspectSystem = unit => sys(unit, I2_ROLE);

export function inspectUser({ place, readings }) {
  return `[PLACE] ${place}
[WHAT THIS PLACE CAN REVEAL — words for you only, never repeat them]
${Object.entries(readings).map(([k, v]) => `· ${k}: ${label(v)}`).join('\n')}

Write the inspection findings.`;
}

// ── N. 공지 판정 — 게시는 저장이고, 판정은 방향뿐이다 ───────
// 공지 원문 + 부대 프롬프트만 본다. 파라미터 현재값을 보면 자기참조 판정을 한다 — 안 준다.
// 반응 한 줄은 화면에 뜨고 거기서 끝난다 — 어떤 호출에도 재입력되지 않는다.
export const NOTICE_SCHEMA = {
  type: 'object',
  properties: {
    gara: { type: 'string', enum: ['up', 'down', 'same'], description: 'Does this notice push soldiers toward cutting corners (up) or toward by-the-book work (down)?' },
    happy: { type: 'string', enum: ['up', 'down', 'same'], description: 'Does living under this notice make soldiers\' days better or worse?' },
    conflict: { type: 'string', enum: ['up', 'down', 'same'], description: 'Does this notice grow or ease pressure and abuse between soldiers?' },
    reaction: { type: 'string', description: 'Korean. One line an anonymous soldier mutters about this notice, out of the sergeant major\'s earshot' },
  },
  required: ['gara', 'happy', 'conflict', 'reaction'],
  additionalProperties: false,
};

const N_ROLE = `[ROLE — THE NOTICE READER]
The sergeant major posted a barracks-life directive. You judge only the notice itself:
which way daily life bends for the soldiers of this unit if it is actually followed.
You do not know the unit's current condition — judge the text, not the situation. same
is the honest default for a notice that changes little. Also return the one anonymous
line — soldiers always have one.
${KO}`;

export const noticeSystem = unit => sys(unit, N_ROLE);

export const noticeUser = text => `[THE NOTICE, VERBATIM]\n"""\n${(text || '').trim()}\n"""\n\nJudge it and return the one line.`;
