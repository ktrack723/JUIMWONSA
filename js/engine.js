// engine.js — 부대 운영 하네스. 하루를 슬롯 단위로 돌리고 롤·호출·드리프트를 순서대로 잇는다.
// **DOM을 전혀 모른다.** 화면은 handlers로만 연결된다.
//
// 하루(runDay)의 전부:
//   전역/전입 (코드 + P 호출)
//   → D 아침 브리핑 (하루 스레드의 첫 쌍)
//   → 슬롯 아홉: 슬롯마다 사고 롤(코드). 성공하면 사건 —
//       E-1 장면 → (지침 입력) → E-2 결과 → E-3 확전 판정(스레드 밖, 지침 못 봄)
//       확전이면 **사고** — 무사고 카운터만 0. 병사·파라미터는 그대로.
//   → 하루 마감: 드리프트 적용, 조용한 날 평판 회복, 카운터 ±, 날짜 전진.
//
// 일과 중 주임원사가 할 수 있는 일은 셋 — 면담(I-1)·불시점검(I-2)·공지(N).
// 전부 평판 −1. 어떤 LLM 판정도 평판을 못 움직인다 — 개입 횟수가 곧 평판이다.
//
// 캐시 설계 (기획서 §7):
//   · D·E-1·E-2는 같은 스레드를 공유한다 — system 동일, messages에 쌓인다.
//   · 스레드는 하루가 끝나면 닫고, 다음 날은 어제의 코드 요약으로 시작한다.
//   · 면담은 별도 단명 스레드. 판정(E-3·N)은 스레드 없음 — user 한 장, 스키마 출력.
//   · 가변 데이터는 절대 system에 넣지 않는다.
//   · 병영 소음(A)은 **부임 때 한 콜**로 100일치를 받아 눕힌다. 스프라이트 대사는 그 뒤로 공짜다.
//     그 한 콜은 하루 스레드와 독립이라 아침 브리핑과 **나란히** 난다 — 직렬 대기가 없다.
//   · 전입(P)은 서로 독립이라 병렬로 받는다. 단 첫 콜만 홀로 내보내 recruitSystem 캐시를
//     데운 뒤 나머지를 일제히 쏜다 — 16콜 동시 발사는 전부 캐시 미스라 오히려 비싸다.
//
// ── 캐시 breakpoint를 왜 안 쪼갰는가 ──────────────────
// 블록 여섯(A·P·D·I-1·I-2·N)의 system은 [WORLD+UNIT](≈1.4k tok) + [ROLE]이고, 공통 접두사가
// 블록마다 통째로 다시 캐시된다. 「공통 접두사에 breakpoint를 하나 더 걸어 여섯이 나눠 쓰게
// 하면 싸지지 않나」가 자연스러운 생각인데, **재 보면 손해다.**
//   · 아끼는 것: 공통 접두사 기록 6번 → 1번. 1.4k × 5 × (1.25 − 0.1) ≈ 8k 토큰어치.
//   · 잃는 것: [ROLE]이 캐시 밖으로 나간다. 조각이 220~630 tok이라 Anthropic의 최소 캐시
//     단위(1024 tok)에 못 미쳐 두 번째 breakpoint가 아예 안 붙기 때문이다.
//     그러면 D·E-1·E-2처럼 하루에도 여러 번 나가는 블록이 매 호출마다 [ROLE]을 정가로 낸다 —
//     D 하나만 100일치로 38k 토큰어치다.
// 자주 불리는 블록일수록 기록 비용이 잘 상각된다. 지금처럼 **system 전체에 하나**가 맞다.
//
// 대신 실제로 값이 되는 자리는 따로 있고, 거기를 손봤다:
//   · 전입 열여섯은 서로를 안 본다 → 병렬. 다만 첫 한 건은 캐시를 깔러 혼자 먼저 간다
//     (한꺼번에 쏘면 열여섯이 전부 캐시 미스로 출발해 접두사를 열여섯 번 재과금한다).
//   · 병영 소음과 아침 브리핑도 서로를 안 본다 → 같이 띄운다.
//   · 확전 판정(E-3)은 결과 장면을 화면에 흘리는 동안 뒤에서 날아온다.

import * as P from './prompts.js';
import {
  band, honestyOf, complianceOf, initialParams, applyDirections, applyIntervention,
  applyDrift, endOfDayStreak, isPromoted, effectiveDifficulty, slotsFor, seasonOf,
  weekdayOf, dateAdd, todayIso, startDateFor, reviewDate, rollSlot, pickEvent,
  pickInvolved, rollGrades, rollMental, mentalDrift, counselMental, incidentMental,
  minMentalOf, applyInspection, PLACES, TUNING,
} from './params.js';
import { assignJob, rankLine } from './roster.js';
import { AmbientPool } from './ambient.js';

const clamp10 = v => Math.max(0, Math.min(10, v));

const SAME = { outcome: 'contained', gara: 'same', happy: 'same', conflict: 'same' };

// 밴드 뭉치 — 프롬프트로 나가는 것은 언제나 이 라벨들이다. 수치는 못 나간다.
const bandsOf = params => ({ gara: band(params.gara), happy: band(params.happy), conflict: band(params.conflict) });

export class Engine {
  /**
   * opts:
   *   unit       — units.js의 한 항목
   *   roster     — roster.js의 Roster (병사 저장·채번)
   *   state      — 캠페인 상태. 없으면 새 부임(newCampaign)
   *   handlers   — 화면 연결점. 전부 선택이고 await 된다
   *   ambient    — ambient.js의 AmbientPool. 안 주면 이 부대 것으로 하나 만든다
   *   rng        — 게임 난수. 사고 롤·등급 굴림·연루자 선정이 쓴다 (테스트가 결정적으로 돈다)
   *   cosmeticRng— 연출 난수. 스프라이트 대사 뽑기가 쓴다. **게임 난수와 반드시 갈라 둔다** —
   *                한 통을 같이 쓰면 말풍선 몇 개를 뽑았느냐가 사고 확률을 밀어낸다
   *   cheapModel — 판정 계열(E-3·N·I-2)을 태울 저가 모델 id. 없으면 기본 모델
   */
  constructor(llm, { unit, roster, state, handlers, ambient = null, rng = Math.random, cosmeticRng = Math.random, cheapModel = null }) {
    this.llm = llm;
    this.unit = unit;
    this.roster = roster;
    this.h = handlers || {};
    this.rng = rng;
    this.cosmeticRng = cosmeticRng;
    this.cheapModel = cheapModel;
    this.state = state || Engine.newCampaign(unit);
    // 병영 소음 풀. 부임 때 한 번 채우고 100일 내내 쓴다 — 저장돼 있으면 그걸 집는다.
    this.ambient = ambient || new AmbientPool(unit);
    this.ambient.load();
    this.thread = [];            // 오늘의 D·E-1·E-2 공유 스레드
    this.daySys = P.daySystem(unit);
    this.interventionsToday = 0;
    this.accidentToday = false;
    this.running = false;
  }

  /** 새 부임. startDate = 현실 오늘 − 100일. 달력은 여기서부터 언제나 전진한다. */
  static newCampaign(unit, today = todayIso()) {
    const start = startDateFor(today);
    return {
      unitId: unit.id,
      startDate: start,
      date: start,
      day: 0,             // 부임 후 며칠째인가 (표시용)
      streak: 0,          // 무사고 연속 일수 — 사고만이 이걸 0으로 돌린다
      params: initialParams(),
      notices: [],        // 활성 지침 목록 — E-1에 주입된다
      yesterday: '',      // 어제의 코드 요약 (⬛ → D의 입력)
      accidents: [],      // [{date, desc}] — 기록
      promoted: false,
    };
  }

  /**
   * 프롬프트로 나갈 병사 표기. 저장된 필드에 **그날의 기수·계급**을 얹는다.
   * 계급은 날이 갈수록 오르므로 저장돼 있지 않다 — 나갈 때마다 계산한다.
   */
  dressed(soldier) {
    return {
      ...soldier,
      standing: rankLine(this.unit, soldier, this.state.date),
      // 멘탈은 화면에는 숫자로, 프롬프트에는 밴드로 간다 — 수치 차단은 그대로다.
      spirit: band(soldier.mental ?? TUNING.mental.default),
    };
  }
  dressedAll(list) { return (list || []).map(s => this.dressed(s)); }

  snapshot() {
    const s = this.state;
    return {
      unitId: s.unitId,
      date: s.date, day: s.day, weekday: weekdayOf(s.date),
      streak: s.streak, goal: TUNING.goal,
      reviewDate: reviewDate(s.date, s.streak),
      accidents: s.accidents.length,
      promoted: s.promoted,
      roster: this.roster.soldiers.length,
      notices: s.notices.slice(),
      // 파라미터 수치는 화면에 안 띄운다 — 콘솔·테스트용으로만 실어 보낸다.
      params: { ...s.params },
    };
  }

  // ── LLM 호출 손잡이 ───────────────────────────────────
  #gen({ label, system, messages, schema = null, maxTokens = 3000 }) {
    return this.llm.call({ label, system, messages, schema, cache: true, effort: 'low', maxTokens });
  }
  /**
   * 판정 계열(E-3·N·I-2). 저가 모델로 태운다.
   *
   * ⚠ 여기 붙은 cache:true는 **Haiku에서는 아무 일도 안 한다.** 최소 캐시 단위가
   * 모델마다 다르고 세대순도 아니다 — Opus 5는 512, Sonnet 5는 1024, **Haiku 4.5는 4096**
   * 토큰이다. 우리 system 블록은 1,200~1,400토큰이라 Opus·Sonnet에서는 캐시되고
   * Haiku에서는 조용히 안 된다(오류도 없다, cache_creation_input_tokens가 0일 뿐).
   *
   * 그래도 Haiku로 두는 이유는 실측했기 때문이다(단가 $1 vs $2 vs $5, 입력 한 콜당):
   *   E-3(sys 597tok — 부대 프롬프트가 없어 어느 모델에서도 최소치 미달)
   *        haiku $0.00083 · sonnet $0.00165 · opus $0.00145   → haiku
   *   N·I-2(sys ~1,200tok — sonnet에서는 캐시된다)
   *        haiku $0.00142 · sonnet $0.00070 · opus $0.00176   → sonnet
   * 블록마다 모델을 갈라 태우면 100일에 $0.05쯤 아끼는데, 그만큼 갈래가 는다.
   * 지금은 한 모델로 두고 이 주석을 남긴다 — 「캐시가 붙는 줄 알았다」가 아니라
   * 「안 붙는 걸 알고 골랐다」로 남기려는 것이다.
   */
  #judge({ label, system, user, schema }) {
    return this.llm.call({
      label, system, messages: [{ role: 'user', content: user }],
      schema, cache: true, effort: 'low', maxTokens: 2000,
      model: this.cheapModel || undefined,
    });
  }

  // ── P. 전입 — 굴림은 코드가, 인물은 LLM이 ────────────
  // 코드 결정분(이름·등급·직무·군번)과 LLM 호출을 가른다. 결정은 순서에 민감하고(난수·채번·
  // 직무 균형·동명이인 회피) 호출은 서로 독립이라, 결정을 먼저 전부 굴려 두면 호출은 병렬로 쏠 수 있다.

  /** 전입 명세 하나를 굴린다 — 난수 소비와 군번 채번이 전부 여기서, 호출 전에 끝난다. */
  #recruitSpec(joined, pending = []) {
    const { grade, character } = rollGrades(this.unit, this.rng);
    const mental = rollMental(character, this.rng);
    // 직무 균형과 동명이인 회피는 아직 명부에 안 오른 병렬 대기분(pending)까지 세어야 한다.
    const waiting = [...this.roster.soldiers, ...pending];
    const job = assignJob(this.unit, waiting, this.rng);
    // 이름도 굴림이 정한다 — 등급과 같은 자리다(names.js). LLM에 맡기면 부대가 통째로
    // 「김민준·이서준」으로 수렴해서, 부대마다 이름의 결이 다르다는 사실 자체가 사라진다.
    const name = this.roster.rollName(this.rng, waiting.map(x => x.name));
    const serial = this.roster.reserveSerial(joined);
    return { name, serial, job, grade, character, mental, joined };
  }

  /** 명세대로 P를 불러 시트를 받아 명부에 올린다 — 이 부분만이 병렬로 돈다. */
  async #writeRecruit(spec) {
    const out = await this.#gen({
      label: '전입 병사 생성',
      system: P.recruitSystem(this.unit),
      messages: [{ role: 'user', content: P.recruitUser({
        ...spec, standing: rankLine(this.unit, spec, this.state.date),
      }) }],
      schema: P.RECRUIT_SCHEMA,
    });
    return this.roster.enlist({ ...spec, sheet: String(out?.sheet || '').trim() });
  }

  async recruitOne(joined = this.state.date) {
    return this.#writeRecruit(this.#recruitSpec(joined));
  }

  // ── A. 병영 소음 — 부임 때 한 콜, 그 뒤로는 공짜 ──────
  #ambientJob = null;   // 떠 있는 소음 콜 — 브리핑 실패 후 재시도가 같은 콜을 또 쏘지 않게

  /**
   * 앰비언트 대사 풀을 채운다. 이미 차 있으면 아무것도 안 한다(부임당 한 콜).
   * 실패해도 하루는 돈다 — 군가는 static이라 풀이 비어도 스프라이트가 그건 부른다.
   * 브리핑과 나란히 날아가므로 재진입될 수 있다 — 떠 있는 콜이 있으면 그걸 돌려준다.
   */
  ensureAmbient() {
    if (this.ambient.ready()) return Promise.resolve(false);
    this.#ambientJob ||= this.#fetchAmbient().finally(() => { this.#ambientJob = null; });
    return this.#ambientJob;
  }

  async #fetchAmbient() {
    const slots = slotsFor(this.state.date);
    try {
      const out = await this.#gen({
        label: '병영 소음 생성',
        system: P.ambientSystem(this.unit),
        messages: [{ role: 'user', content: P.ambientUser({
          slots, songSlots: this.unit.songSlots, songMode: this.unit.songMode,
        }) }],
        schema: P.AMBIENT_SCHEMA, maxTokens: 4000,
      });
      this.ambient.fill(out?.lines || []);
      return true;
    } catch {
      return false;   // 소음이 없어도 게임은 돈다. 조용한 부대가 될 뿐이다
    }
  }

  /**
   * 화면이 스프라이트에 물릴 대사. 코드가 뽑는다 — 여기서 LLM은 안 돈다.
   * **연출 난수를 쓴다.** 게임 난수를 쓰면 말풍선을 몇 개 뽑았느냐가 그 뒤 사고 롤을
   * 통째로 밀어낸다 — 대사 하나 늘렸다고 사고가 나는 게임이 된다.
   */
  ambientFor(slotKey, n = 3) {
    return this.ambient.picks(slotKey, n, this.cosmeticRng);
  }

  /**
   * 정원까지 채운다. 부임 첫날의 초기 명부 생성에도, 전역 후 충원에도 쓰인다.
   *
   * 호출은 병렬이되 **첫 콜만 홀로** 나간다 — 16콜을 한꺼번에 쏘면 전부 캐시 미스로
   * recruitSystem 전문을 각자 정가(+기록비)로 내게 된다. 첫 콜이 캐시를 데우고 나면
   * 나머지가 일제히 나가 캐시를 읽는다. 직렬 16콜 대비 벽시계 시간은 약 2콜 분량.
   * 실패는 전부 가라앉힌 뒤 첫 오류를 던진다 — 성공분은 이미 명부에 올라 있으므로
   * 재시도는 남은 빈 자리만 다시 채운다.
   */
  async fillRoster(joinDates = null, onProgress = null) {
    // 결정분 선굴림 — 난수 소비·군번 채번·직무 균형이 직렬 시절과 같은 순서로 끝난다.
    const specs = [];
    while (this.roster.vacancies() > specs.length) {
      specs.push(this.#recruitSpec(joinDates?.[specs.length] || this.state.date, specs));
    }
    if (!specs.length) return [];

    const arrivals = new Array(specs.length);
    let done = 0;
    const write = async (spec, i) => {
      arrivals[i] = await this.#writeRecruit(spec);
      await onProgress?.(++done, arrivals[i], specs.length);
    };
    await write(specs[0], 0);   // 캐시 예열 — 이 한 콜만 직렬이다
    const rest = await Promise.allSettled(specs.slice(1).map((sp, i) => write(sp, i + 1)));
    const failed = rest.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    return arrivals;
  }

  // ── 하루 한 턴 ─────────────────────────────────────────
  async runDay() {
    if (this.running) throw new Error('이미 하루가 돌고 있다');
    this.running = true;
    this.thread = [];
    this.interventionsToday = 0;
    this.accidentToday = false;
    const s = this.state;
    const date = s.date;
    const effDiff = effectiveDifficulty(this.unit.difficulty, date);
    const slots = slotsFor(date);
    const incidents = [];   // 오늘의 사건 기록 (코드 요약용)

    try {
      // 병영 소음이 아직 없으면 여기서 한 번 채운다 (부임 첫날 한 콜).
      // 하루 스레드와 완전히 독립이라 **띄워만 놓고** 브리핑과 나란히 받는다 —
      // 슬롯이 대사를 뽑기 전에만 도착하면 된다. 실패는 안에서 삼킨다(조용한 부대).
      const ambientJob = this.ensureAmbient();

      // 전역 → 전입. 빈 자리는 그날 바로 채워진다.
      const departures = this.roster.discharge(date);
      const arrivals = this.roster.vacancies() > 0 ? await this.fillRoster() : [];

      // D. 아침 브리핑 — 하루 스레드의 첫 user/assistant 쌍.
      const excerpt = this.roster.sample(4, this.rng);
      this.thread.push({
        role: 'user',
        content: P.briefingUser({
          date, weekday: weekdayOf(date), season: seasonOf(date),
          slots: slots.map(x => x.label),
          difficulty: band(effDiff), bands: bandsOf(s.params),
          yesterday: s.yesterday,
          arrivals: this.dressedAll(arrivals), departures, excerpt: this.dressedAll(excerpt),
        }),
      });
      let brief;
      try {
        brief = await this.#gen({
          label: '아침 브리핑', system: this.daySys, messages: this.thread,
          schema: P.BRIEFING_SCHEMA, maxTokens: 4000,
        });
      } catch (e) {
        this.thread.pop();
        throw e;   // 브리핑 없이는 하루가 못 열린다 — 화면이 재시도를 안내한다
      }
      await ambientJob;   // 첫 슬롯이 대사를 뽑기 전에는 도착해 있어야 한다
      const slotLines = Array.isArray(brief.slots) ? brief.slots.map(x => String(x || '')) : [];
      this.thread.push({ role: 'assistant', content: [brief.briefing, ...slotLines].filter(Boolean).join('\n') });
      await this.h.briefing?.({ date, day: s.day, briefing: String(brief.briefing || ''), arrivals, departures });

      // 첫 슬롯이 대사를 뽑기 전에 소음 풀이 눕는다 — 브리핑을 받고 읽는 동안 뒤에서 날아왔다.
      await ambientJob;

      // 슬롯 아홉 — 슬롯마다 사고 롤이 돈다. 화면은 h.slot에서 개입(면담·점검·공지)할 수 있다.
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        await this.h.slot?.({
          index: i, count: slots.length, slot, line: slotLines[i] || '',
          // 스프라이트가 흘릴 대사. 캐시된 잡담과 static 군가가 섞여 나온다 — 콜은 없다.
          chatter: this.ambientFor(slot.key, 3),
        });

        const roll = rollSlot({ ...s.params, minMental: minMentalOf(this.roster.soldiers) }, {
          intel: this.unit.intel.score, macho: this.unit.macho.score, difficulty: effDiff,
        }, slot.kind, this.rng);
        if (!roll) continue;

        const incident = await this.#runIncident(slot, roll.tier, roll.cause);
        if (incident) incidents.push(incident);
      }

      // 하루 마감 — 드리프트, 조용한 날 평판 회복, 카운터, 날짜 전진.
      // 병사별 멘탈 드리프트 — 부대 분위기가 전원을 쓸어간다. 파라미터 드리프트보다 먼저,
      // 오늘의(드리프트 전) 분위기로 계산한다.
      for (const man of this.roster.soldiers) man.mental = mentalDrift(man.mental ?? TUNING.mental.default, s.params);
      this.roster.save();

      s.params = applyDrift(s.params, effDiff, { interventions: this.interventionsToday });
      s.streak = endOfDayStreak(s.streak, this.accidentToday);
      s.yesterday = this.#summarize(date, incidents, arrivals, departures);
      s.date = dateAdd(date, 1);
      s.day += 1;
      if (isPromoted(s.streak)) s.promoted = true;
      await this.h.dayEnd?.(this.snapshot());
      return this.snapshot();
    } finally {
      this.running = false;
      this.thread = [];   // 100일치 원문을 끌고 다니지 않는다 — 내일은 코드 요약으로 시작한다
    }
  }

  // 사건 하나 — E-1 장면 → 지침 → E-2 결과 → E-3 확전 판정.
  async #runIncident(slot, tier, cause = null) {
    const s = this.state;
    const event = pickEvent(tier, slot.kind, this.rng);
    // 멘탈이 연 큰 사건은 **무너진 그 놈들**의 사건이다 — 멘탈 낮은 순으로 고른다.
    // 그 밖의 사건은 가중 추첨(등급·멘탈)이다.
    const involved = cause === 'mental'
      ? this.roster.soldiers.slice()
        .sort((a, b) => (a.mental ?? TUNING.mental.default) - (b.mental ?? TUNING.mental.default))
        .slice(0, event.involved)
      : pickInvolved(this.roster.soldiers, event.involved, this.rng);
    if (!involved.length) return null;
    const place = PLACES[event.place]?.label || event.place;

    // E-1. 사건 장면 — 활성 지침 목록이 여기 주입된다.
    this.thread.push({
      role: 'user',
      content: P.incidentUser({
        slotLabel: slot.label, place, tier, event: event.desc,
        involved: this.dressedAll(involved), notices: s.notices,
      }),
    });
    let scene;
    try {
      scene = await this.#gen({ label: '사건 장면', system: this.daySys, messages: this.thread });
    } catch {
      this.thread.pop();
      return null;   // 회선 두절 — 이 사건은 기록되지 않았다
    }
    this.thread.push({ role: 'assistant', content: scene });

    // 지침 입력 — 화면이 텍스트를 돌려주거나, 무시(null)를 돌려준다.
    const directive = (await this.h.incident?.({ slot, place, tier, event, involved, scene })) || null;

    // E-2. 대응 결과 — 지침 원문이 그대로 실린다. 평판 밴드가 「먹히는 정도」다.
    this.thread.push({
      role: 'user',
      content: P.outcomeUser({ directive, standing: complianceOf(s.params.rep) }),
    });
    let outcomeScene;
    try {
      outcomeScene = await this.#gen({ label: '대응 결과', system: this.daySys, messages: this.thread });
    } catch {
      this.thread.pop();
      return null;
    }
    this.thread.push({ role: 'assistant', content: outcomeScene });

    // E-3. 확전 판정 — 띄워놓고 결과 장면을 먼저 흘린다. 읽는 동안 뒤에서 날아온다.
    const judging = this.#judge({
      label: '확전 판정', system: P.JUDGE_SYSTEM,
      user: P.judgeUser({ scene: outcomeScene, tier }),
      schema: P.ESCALATION_SCHEMA,
    }).catch(() => SAME);
    await this.h.outcome?.({ scene: outcomeScene, directive });
    const verdict = await judging;

    s.params = applyDirections(s.params, verdict);
    const escalated = verdict?.outcome === 'escalated';
    // 연루는 멘탈을 깎는다. 사고가 되면 더 깎인다 — 그 병사들이 다음 사건의 씨앗이 된다.
    for (const man of involved) man.mental = incidentMental(man.mental ?? TUNING.mental.default, escalated);
    this.roster.save();
    if (escalated) {
      // 사건이 사고가 됐다 — 무사고 카운터만 0. 날짜도, 병사도, 파라미터도 안 돌아간다.
      this.accidentToday = true;
      s.streak = 0;
      s.accidents.push({ date: s.date, desc: event.desc });
    }
    await this.h.verdict?.({ escalated, verdict, event, tier });
    return { desc: event.desc, tier, escalated, directive: !!directive };
  }

  // 어제의 코드 요약 — 다음 날 D의 입력이 된다. 원문 스레드는 닫힌다.
  #summarize(date, incidents, arrivals, departures) {
    const parts = [`${date}:`];
    if (!incidents.length) parts.push('사건 없음. 조용한 하루였다.');
    for (const it of incidents) {
      parts.push(`「${it.desc}」(${it.tier === 'major' ? '중대' : '경미'}) — ${it.escalated ? '사고로 확전, 무사고 기록이 깨졌다' : it.directive ? '주임원사 개입으로 수습' : '개입 없이 지나갔다'}.`);
    }
    if (arrivals.length) parts.push(`전입 ${arrivals.map(a => a.name).join('·')}.`);
    if (departures.length) parts.push(`전역 ${departures.map(d => d.name).join('·')}.`);
    return parts.join(' ');
  }

  // ── 일과 중 개입 셋 — 전부 평판 −1. 개입 횟수가 곧 평판이다 ──

  /**
   * I-1. 면담 — 상담이다. 병사를 불러 이야기를 들어주고, 그 자리가 **멘탈을 +1 회복**시킨다.
   * 파라미터가 계기판에 다 떠 있는 게임에서 면담의 일은 정보 캐기가 아니라 사람 붙잡기다:
   * 계기판의 멘탈 낮은 놈을 골라 부르는 것이 곧 큰 사고(자해·탈영) 예방이다.
   * 여전히 평판 −1이다 — 주임원사실로 불려가는 것 자체가 소문이 나는 일이라서다.
   * 별도 단명 스레드. 돌려주는 손잡이로 왕복하고, 스레드는 그 면담에서 닫힌다.
   */
  async interview(serial, question) {
    const soldier = this.roster.bySerial(serial);
    if (!soldier) throw new Error(`명부에 없는 군번: ${serial}`);
    this.state.params = applyIntervention(this.state.params);
    this.interventionsToday += 1;

    // 병사의 체감 밴드 — 부대 지표가 아니라 자기 주변이다. 한 칸 오차의 사견이 낀다.
    // 제 마음(spirit)만은 오차 없이 제 것이다 — dressed()가 그 병사의 멘탈 밴드를 싣는다.
    const jitter = v => clamp10(v + Math.floor(this.rng() * 3) - 1);
    const p = this.state.params;
    const felt = { room: band(jitter(p.conflict)), work: band(jitter(p.gara)) };
    const honesty = honestyOf(p.rep);

    const thread = [{ role: 'user', content: P.interviewOpen({ soldier: this.dressed(soldier), felt, honesty, question }) }];
    const sysMsg = P.interviewSystem(this.unit);
    const call = () => this.#gen({ label: `면담 · ${soldier.name}`, system: sysMsg, messages: thread });

    const first = await call();
    thread.push({ role: 'assistant', content: first });
    // 들어준 것이 통했다 — 대화가 실제로 성립한 뒤에만 회복이 붙는다 (호출이 죽으면 없다).
    const before = soldier.mental ?? TUNING.mental.default;
    soldier.mental = counselMental(before);
    this.roster.save();
    return {
      soldier, reply: first,
      mental: { before, after: soldier.mental },
      ask: async (q) => {   // 왕복 — 배급도 회복도 안 늘어난다. 스레드는 이 면담 안에서만 산다
        thread.push({ role: 'user', content: P.interviewFollowup(q) });
        const out = await call();
        thread.push({ role: 'assistant', content: out });
        return out;
      },
    };
  }

  /**
   * I-2. 불시점검 — 군기 점검이다. 계기판이 상시로 열린 게임에서 「밴드를 본다」는
   * 원래 의의는 죽었다. 대신 이것은 파라미터를 직접 미는 유일한 결정적 레버다:
   * 들이닥치면 일은 각이 잡히고(가라 −1) 분위기는 가라앉는다(행복 −1). 순수 코드다.
   * LLM은 그 자리에서 눈에 띈 것(점검 소견)만 쓴다 — 장소-대응표는 그 장면의 재료로 남는다.
   */
  async inspect(placeKey) {
    const place = PLACES[placeKey];
    if (!place) throw new Error(`대응표에 없는 장소: ${placeKey}`);
    this.state.params = applyIntervention(this.state.params);
    this.interventionsToday += 1;

    const NAMES = { gara: 'corner-cutting', happy: 'morale', conflict: 'friction-and-abuse' };
    const readings = Object.fromEntries(place.reveals.map(k => [NAMES[k], band(this.state.params[k])]));
    const findings = await this.#judge({
      label: `불시점검 · ${place.label}`,
      system: P.inspectSystem(this.unit),
      user: P.inspectUser({ place: place.label, readings }),
      schema: null,
    });
    // 효과는 장면과 무관하게 확정이다 — LLM이 폭을 정하는 자리는 이 게임에 없다.
    this.state.params = applyInspection(this.state.params);
    return { place: place.label, findings, effect: { ...TUNING.inspect } };
  }

  /**
   * N. 공지 — 게시는 저장이고, 판정은 방향뿐이다. 반응 한 줄은 화면에서 끝난다.
   * 텍스트는 활성 지침 목록에 들어가 이후 모든 사건 생성(E-1)에 주입된다.
   */
  async postNotice(text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('빈 공지는 게시할 수 없다');
    this.state.params = applyIntervention(this.state.params);
    this.interventionsToday += 1;
    this.state.notices.push(t);

    let out;
    try {
      out = await this.#judge({
        label: '공지 판정', system: P.noticeSystem(this.unit),
        user: P.noticeUser(t), schema: P.NOTICE_SCHEMA,
      });
    } catch {
      out = { gara: 'same', happy: 'same', conflict: 'same', reaction: '(반응이 들리지 않았다)' };
    }
    this.state.params = applyDirections(this.state.params, out);
    return { reaction: String(out.reaction || '') };
  }

  /** 활성 지침 철회 — 게시의 반대. 판정도 호출도 없다. 평판도 안 깎인다. */
  removeNotice(index) {
    this.state.notices.splice(index, 1);
  }
}
