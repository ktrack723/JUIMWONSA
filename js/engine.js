// engine.js — 부대 운영 하네스. 하루를 슬롯 단위로 돌리고 롤·호출·드리프트를 순서대로 잇는다.
// **DOM을 전혀 모른다.** 화면은 handlers로만 연결된다.
//
// 하루(runDay)의 전부:
//   전역/전입 (코드 + P 호출)
//   → D 아침 브리핑 (하루 스레드의 첫 쌍)
//   → 슬롯 아홉: 슬롯마다 사고 롤(코드). 성공하면 사건 —
//       E-1 장면 → (지침 입력) → E-2 결과 → E-3 확전 판정(스레드 밖, 지침 못 봄)
//       확전이면 **사고** — 무사고 카운터가 0이 되고, 유형에 따라 연루자 하나가
//       부대에서 실제로 빠진다(탈영은 사라지고 부상은 입원한다 — params.js의 부재 규칙).
//       빠진 자리는 충원되지 않는다. 복귀일까지 남은 인원으로 버틴다.
//       사건에는 언제나 유형이 하나 붙는다(params.js의 열둘). 씨앗이 풀에서 오므로
//       장면이 아무리 갈라져도 유형은 코드가 알고, 화면은 거기에 그림을 붙인다.
//   → 하루 마감: 드리프트 적용, 조용한 날 평판 회복, 카운터 ±, 날짜 전진.
//
// 일과 중 주임원사가 할 수 있는 일은 셋 — 면담(I-1)·불시점검(I-2)·공지(N).
// 전부 평판 −1. 어떤 LLM 판정도 평판을 못 움직인다 — 개입 횟수가 곧 평판이다.
//
// 100일을 찍으면 하루가 아니라 임기가 끝난다 — 그 밤이 환송회(F)다. 부임당 한 콜이고,
// 거하게 차려지느냐 아무도 없느냐는 **행복도가 코드로** 정한다 (farewell 메서드).
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
  minMentalOf, applyInspection, categoryFor, absenceFor, ABSENCE_KINDS, PLACES, TUNING,
  GARA_BY_ID, garaCap, garaAt, syncGaraList, inspectGara,
  farewellTone, pickSendoff, PARAM_KEYS,
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
   *   garaRng    — 가라의 **정체**를 뽑는 통. 어느 관행이 돌고 있고 들이닥쳤을 때 뭐가 걸리는가.
   *                사고 확률이 보는 것은 가라의 **개수**(params.gara)뿐이고 정체는 안 본다 —
   *                그래서 이 통도 게임 난수와 갈라 둔다. 같은 통을 쓰면 「가라 목록이 몇 칸
   *                움직였나」가 그날의 사고 롤을 통째로 밀어낸다(말풍선 때 겪은 그 사고다).
   *                안 주면 연출 통을 같이 쓴다.
   *   cheapModel — 판정 계열(E-3·N·I-2)을 태울 저가 모델 id. 없으면 기본 모델
   */
  constructor(llm, { unit, roster, state, handlers, ambient = null, rng = Math.random, cosmeticRng = Math.random, garaRng = null, cheapModel = null }) {
    this.llm = llm;
    this.unit = unit;
    this.roster = roster;
    this.h = handlers || {};
    this.rng = rng;
    this.cosmeticRng = cosmeticRng;
    this.garaRng = garaRng || cosmeticRng;
    this.cheapModel = cheapModel;
    this.state = state || Engine.newCampaign(unit);
    this.#migrate();
    this.#syncGara();   // 「가라 4」가 실제로 무엇 넷인지를 부임 첫날 굴려 둔다
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
      notices: [],        // [{text, bans}] — 활성 지침. text는 E-1에 주입되고 bans는 가라를 막는다
      // 가라 내역 — 게이지 눈금의 내용물.
      //   active — 지금 돌고 있는 관행 id들. **플레이어에게 통째로는 절대 안 보인다**
      //   known  — 확인 명부 [{id, on}]. 들이닥쳐서 잡은 것만 오른다. 확인한 그날의 사실이다
      //   seen   — 장소별 마지막 확인 날짜. 명부가 얼마나 낡았는지의 근거
      gara: { active: [], known: [], seen: {} },
      yesterday: '',      // 어제의 코드 요약 (⬛ → D의 입력)
      accidents: [],      // [{date, desc}] — 기록
      promoted: false,
      farewell: null,     // 마지막 밤. 한 번 치르면 여기 눕고, 다시 열어도 같은 밤이다
    };
  }

  /** 옛 저장분 흡수 — 지침이 문자열 배열이던 시절, 가라 내역이 없던 시절. */
  #migrate() {
    const s = this.state;
    s.notices = (s.notices || []).map(n => (typeof n === 'string'
      ? { text: n, bans: [] }
      : { text: String(n?.text || ''), bans: (n?.bans || []).filter(id => GARA_BY_ID[id]) }));
    const g = s.gara || (s.gara = {});
    g.active = (g.active || []).filter(id => GARA_BY_ID[id]);
    g.known = (g.known || []).filter(k => GARA_BY_ID[k?.id]);
    g.seen ||= {};
  }

  /** 지침이 막아 놓은 관행 전부. 지침을 철회하면 그 문이 다시 열린다. */
  bannedGara() { return this.state.notices.flatMap(n => n.bans || []); }

  /**
   * 목록을 수치에 맞춘다. **수치가 원본이고 목록이 따라간다** — 가라가 오르면 새 관행이
   * 하나 조용히 시작되고, 내리면 하나가 멎는다. 플레이어에게는 아무 통보도 없다:
   * 계기판은 개수를 말하지만 정체는 말하지 않는다.
   * 금지가 늘면 천장이 내려가므로 수치 자체가 눌린다 — 지침이 가라를 「제한」한다는 것이 이것이다.
   */
  #syncGara() {
    const s = this.state, banned = this.bannedGara();
    s.params.gara = Math.min(s.params.gara, garaCap(banned));
    s.gara.active = syncGaraList(s.gara.active, s.params.gara, { banned, rng: this.garaRng });
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
      // day는 「마감한 날 수」고, dayNo는 **지금 date가 부임 며칠째인가**다. 화면이 쓰는 건
      // 언제나 뒤쪽이다 — 첫날에 「부임 0일차」라고 쓰면 달력과 한 칸 어긋난다.
      dayNo: s.day + 1,
      streak: s.streak, goal: TUNING.goal,
      reviewDate: reviewDate(s.date, s.streak),
      accidents: s.accidents.length,
      promoted: s.promoted,
      farewell: s.farewell ? { ...s.farewell } : null,
      // 병력은 **오늘 부대에 있는 인원**이다. 입원·이탈은 명부에 남아도 병력이 아니다.
      roster: this.roster.present.length,
      away: this.roster.absent.map(x => ({ name: x.name, serial: x.serial, ...x.away })),
      notices: s.notices.map(n => ({ text: n.text, bans: (n.bans || []).slice() })),
      // 가라 내역 중 **화면이 봐도 되는 것만** 싣는다. active 목록은 여기 없다 —
      // 계기판이 개수(params.gara)를 말하고, 명부가 확인된 것만 말한다. 그 틈이 이 게임이다.
      gara: {
        running: s.params.gara,                     // 몇 개가 돌고 있는가 (= 가라 게이지)
        known: s.gara.known.map(k => ({ ...k })),   // 그중 확인한 것
        banned: this.bannedGara(),                  // 지침으로 막아 놓은 것
        seen: { ...s.gara.seen },                   // 장소별 마지막 확인 날짜
        cap: garaCap(this.bannedGara()),            // 금지가 내려 놓은 천장
      },
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
    // 새벽의 바늘. 하루가 끝나면 여기와 비교해 「오늘 무엇이 얼마나 움직였나」를 만든다 —
    // 개입·판정·드리프트가 각자 조용히 미는 값이라, 이 차이 말고는 화면이 알 길이 없다.
    const dawn = { ...s.params };

    try {
      // 병영 소음이 아직 없으면 여기서 한 번 채운다 (부임 첫날 한 콜).
      // 하루 스레드와 완전히 독립이라 **띄워만 놓고** 브리핑과 나란히 받는다 —
      // 슬롯이 대사를 뽑기 전에만 도착하면 된다. 실패는 안에서 삼킨다(조용한 부대).
      const ambientJob = this.ensureAmbient();

      // 복귀 → 전역 → 전입. 순서가 있다: 병원에서 돌아온 놈이 그날 전역일이면 그날 나간다.
      // 부재로 빈 자리는 정원으로 세지 않으므로 전입은 전역분만 채운다.
      const returns = this.roster.returnFrom(date);
      const departures = this.roster.discharge(date);
      const arrivals = this.roster.vacancies() > 0 ? await this.fillRoster() : [];
      const away = this.roster.absent;

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
          // 지금 부대에 없는 사람들 — 장면에 세우면 안 된다. 돌아온 사람은 오늘 아침의 뉴스다.
          away: away.map(x => ({ name: x.name, serial: x.serial, en: ABSENCE_KINDS[x.away.kind]?.en || 'away', until: x.away.until })),
          returns: returns.map(x => ({ name: x.name, serial: x.serial, en: ABSENCE_KINDS[x.away.kind]?.en || 'away' })),
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
      await this.h.briefing?.({ date, day: s.day, briefing: String(brief.briefing || ''), arrivals, departures, returns });

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

        const roll = rollSlot({ ...s.params, minMental: minMentalOf(this.roster.present) }, {
          intel: this.unit.intel.score, macho: this.unit.macho.score,
          comrade: this.unit.comrade.score, difficulty: effDiff,
        }, slot.kind, this.rng);
        if (!roll) continue;

        const incident = await this.#runIncident(slot, roll.tier, roll.cause);
        if (incident) incidents.push(incident);
      }

      // 하루 마감 — 드리프트, 조용한 날 평판 회복, 카운터, 날짜 전진.
      // 병사별 멘탈 드리프트 — 부대 분위기가 전원을 쓸어간다. 파라미터 드리프트보다 먼저,
      // 오늘의(드리프트 전) 분위기로 계산한다.
      // 부재자는 부대 분위기에 안 쓸린다 — 여기에 없으니까. 멘탈은 나간 날 그대로 얼어 있다.
      for (const man of this.roster.present) man.mental = mentalDrift(man.mental ?? TUNING.mental.default, s.params);
      this.roster.save();

      s.params = applyDrift(s.params, effDiff, {
        interventions: this.interventionsToday,
        baseline: this.unit.difficulty,   // 「오늘이 평소보다 힘든가」는 이 부대 기준이다
      });
      s.streak = endOfDayStreak(s.streak, this.accidentToday);
      s.yesterday = this.#summarize(date, incidents, arrivals, departures, returns);
      s.date = dateAdd(date, 1);
      s.day += 1;
      if (isPromoted(s.streak)) s.promoted = true;

      // 오늘의 장부 — 화면이 마감에 「무슨 일이 있었고 바늘이 어디로 갔는지」를 쓴다.
      const ledger = {
        date,
        incidents: incidents.length,
        accidents: incidents.filter(i => i.escalated).length,
        interventions: this.interventionsToday,
        moved: PARAM_KEYS.reduce((acc, k) => {
          const d = s.params[k] - dawn[k];
          if (d) acc[k] = d;
          return acc;
        }, {}),
        arrivals: arrivals.map(a => a.name),
        departures: departures.map(d => d.name),
        returns: returns.map(r => r.name),
        // 오늘 사고가 데려간 인원 — 카운터가 0으로 돌아간 것과 별개로 부대가 실제로 빈다.
        taken: incidents.flatMap(i => i.absences || []).map(a => a.soldier.name),
      };
      const snap = { ...this.snapshot(), today: ledger };
      await this.h.dayEnd?.(snap);
      return snap;
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
      ? this.roster.present
        .sort((a, b) => (a.mental ?? TUNING.mental.default) - (b.mental ?? TUNING.mental.default))
        .slice(0, event.involved)
      : pickInvolved(this.roster.present, event.involved, this.rng);
    if (!involved.length) return null;
    const place = PLACES[event.place]?.label || event.place;
    // 유형은 코드가 안다 — 그림도 기록도 이걸 본다. 판정 콜은 늘지 않는다.
    const category = categoryFor(event);

    // E-1. 사건 장면 — 활성 지침 목록이 여기 주입된다.
    this.thread.push({
      role: 'user',
      content: P.incidentUser({
        slotLabel: slot.label, place, tier, event: event.desc, category: category?.en,
        involved: this.dressedAll(involved), notices: s.notices.map(n => n.text),
        // 그 자리에서 잘라먹고 있던 모서리. 사건이 거기서 자라 나오게 하는 재료다 —
        // 실린다고 플레이어가 아는 것은 아니다. 확인 명부는 점검으로만 채워진다.
        garaHere: garaAt(s.gara.active, event.place).map(id => GARA_BY_ID[id].en),
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
    const directive = (await this.h.incident?.({ slot, place, tier, event, category, involved, scene })) || null;

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
    this.#syncGara();   // 가라가 움직였으면 관행 하나가 새로 돌기 시작했거나 멎었다
    const escalated = verdict?.outcome === 'escalated';
    // 확전한 사건은 유형이 넘어갈 수 있다 — 「취침 중 누가 운다」가 사고가 되면 자해다.
    const stamped = categoryFor(event, escalated);
    // 연루는 멘탈을 깎는다. 사고가 되면 더 깎인다 — 그 병사들이 다음 사건의 씨앗이 된다.
    for (const man of involved) man.mental = incidentMental(man.mental ?? TUNING.mental.default, escalated);
    this.roster.save();
    // 사고가 사람을 데려간다 — 탈영은 사라지고, 부상·자해는 실려 간다. 유형만 보고 코드가 정한다.
    const absences = escalated ? this.#takeAway(involved, stamped?.id) : [];
    if (escalated) {
      // 사건이 사고가 됐다 — 무사고 카운터는 0, 그리고 자리 하나가 빈다.
      // 날짜도 파라미터도 안 돌아가고, 빠진 병사는 지워지는 것이 아니라 복귀일을 달고 명부에 남는다.
      this.accidentToday = true;
      s.streak = 0;
      s.accidents.push({
        date: s.date, desc: event.desc, tier, category: stamped?.id || null,
        away: absences.map(a => ({ name: a.soldier.name, serial: a.soldier.serial, kind: a.kind, until: a.until })),
      });
    }
    await this.h.verdict?.({ escalated, verdict, event, tier, category: stamped, absences });
    return {
      desc: event.desc, tier, escalated, directive: !!directive,
      category: stamped?.id || null, absences,
    };
  }

  /**
   * 사고가 데려간 사람. 유형이 부재 규칙에 걸릴 때만, 사건당 한 명이다(TUNING.absence).
   * 데려가는 것은 연루자 중 **첫 번째** — 가중 추첨이 앞세운 사람이고, 멘탈이 연 사건이라면
   * 제일 무너진 사람이다. 자해·탈영이 아무에게나 안 일어나는 이유가 여기서도 지켜진다.
   * 복귀일은 여기서 굳는다. 이 굴림은 게임 난수를 쓴다 — 연출 난수와 섞이지 않는다.
   */
  #takeAway(involved, categoryId) {
    const out = [];
    for (const man of involved.slice(0, TUNING.absence.perIncident)) {
      const rule = absenceFor(categoryId, this.rng);
      if (!rule || man.away) continue;
      const gone = this.roster.sendAway(man, { kind: rule.kind, days: rule.days, since: this.state.date });
      if (gone) out.push({ soldier: gone, kind: rule.kind, days: rule.days, until: gone.away.until });
    }
    return out;
  }

  // 어제의 코드 요약 — 다음 날 D의 입력이 된다. 원문 스레드는 닫힌다.
  #summarize(date, incidents, arrivals, departures, returns = []) {
    const parts = [`${date}:`];
    if (!incidents.length) parts.push('사건 없음. 조용한 하루였다.');
    for (const it of incidents) {
      parts.push(`「${it.desc}」(${it.tier === 'major' ? '중대' : '경미'}) — ${it.escalated ? '사고로 확전, 무사고 기록이 깨졌다' : it.directive ? '주임원사 개입으로 수습' : '개입 없이 지나갔다'}.`);
      // 사람이 빠진 것은 내일의 사실이다 — 어제 요약에 실려 아침 브리핑까지 간다.
      for (const a of it.absences || []) {
        const kind = ABSENCE_KINDS[a.kind];
        parts.push(`${a.soldier.name} ${kind?.label || '부재'} — 복귀 예정 ${a.until}.`);
      }
    }
    if (returns.length) parts.push(`복귀 ${returns.map(r => r.name).join('·')}.`);
    if (arrivals.length) parts.push(`전입 ${arrivals.map(a => a.name).join('·')}.`);
    if (departures.length) parts.push(`전역 ${departures.map(d => d.name).join('·')}.`);
    return parts.join(' ');
  }

  // ── 일과 중 개입 셋 — 전부 평판 −1. 개입 횟수가 곧 평판이다 ──

  /**
   * 개입 하나의 값을 치른다. 셋이 전부 같은 값이라 여기 한 자리에 둔다 —
   * 넷째 레버가 생겨도 이걸 안 부르면 공짜 개입이 되어 규칙이 깨진다.
   * 오늘의 개입 횟수는 하루 마감의 「조용한 날 회복」과 장부가 같이 본다.
   */
  #charge() {
    this.state.params = applyIntervention(this.state.params);
    this.interventionsToday += 1;
  }


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
    // 없는 사람은 못 부른다 — 병원에 있거나 부대 밖에 있다. 평판도 안 깎인다(부르지도 못했으니).
    if (soldier.away) {
      const kind = ABSENCE_KINDS[soldier.away.kind];
      throw new Error(`${soldier.name}은(는) 지금 부대에 없다 — ${kind?.label || '부재'}, 복귀 예정 ${soldier.away.until}`);
    }
    this.#charge();

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
   * I-2. 불시점검 — 군기 점검이다. 이제 이것이 **가라 내역을 사는 유일한 창구**다.
   * 계기판은 「가라 4」라고만 말한다. 그 넷이 무엇인지는 들이닥쳐야 안다.
   *
   * 한 번 들이닥치면 세 가지가 같이 일어난다:
   *   · 그 자리의 관행 중 일부가 적발돼 확인 명부에 오른다 — **일부다.** 나머지는 제때 치웠다.
   *     적발 확률은 부대 지능이 정한다: 머리 좋은 부대일수록 절반쯤만 걸린다.
   *   · 없어진 것은 명부에서 지워진다. 들어가 봤으면 아니까.
   *   · 파라미터가 확정으로 밀린다(가라 −1 · 행복 −1). 그 −1은 「각이 잡혔다」는 **일반 효과**라
   *     아무 관행이나 하나를 멎게 한다 — 방금 적발한 그것을 골라 끊지는 않는다.
   *
   * 마지막 줄이 중요하다. **점검은 정체를 사고, 관행을 끊는 것은 지침의 일이다.** 적발한 것을
   * 점검이 스스로 끊게 해 봤더니, 한 자리에 도는 관행이 평균 한 건이라 산 정보가 같은 개입의
   * 부수효과에 그대로 지워졌다(실측: 털고 나면 명부가 언제나 비었다). 자세한 것은 params.js의
   * syncGaraList 주석에 남겼다.
   * LLM은 코드가 정해 준 적발 목록을 장면으로 옮겨 쓸 뿐이다. 무엇이 걸리는지는 안 정한다.
   */
  async inspect(placeKey) {
    const place = PLACES[placeKey];
    if (!place) throw new Error(`대응표에 없는 장소: ${placeKey}`);
    const s = this.state;
    this.#charge();

    // 무엇이 걸리고 무엇이 숨는가 — 전부 코드다. 호출보다 먼저 끝난다.
    const res = inspectGara({
      active: s.gara.active, known: s.gara.known, placeKey,
      intel: this.unit.intel.score, on: s.date, rng: this.garaRng,
    });
    s.gara.known = res.known;
    s.gara.seen[placeKey] = s.date;

    const NAMES = { gara: 'corner-cutting', happy: 'morale', conflict: 'friction-and-abuse' };
    const readings = Object.fromEntries(place.reveals.map(k => [NAMES[k], band(s.params[k])]));
    const findings = await this.#judge({
      label: `불시점검 · ${place.label}`,
      system: P.inspectSystem(this.unit),
      user: P.inspectUser({
        place: place.label, readings,
        found: res.spotted.map(id => GARA_BY_ID[id].en),
      }),
      schema: null,
    });

    // 효과는 장면과 무관하게 확정이다 — LLM이 폭을 정하는 자리는 이 게임에 없다.
    // 명부는 여기서 안 건드린다. 무엇이 멎었는지는 주임원사가 알 길이 없고, 방금 확인한 것이
    // 조용히 멎었다면 그 줄은 그날부터 낡기 시작한다 — 그게 이 게임에 남겨 둔 안개다.
    s.params = applyInspection(s.params);
    this.#syncGara();

    // 놓친 것의 **개수조차** 안 돌려준다. 「3건 중 1건 적발」이라고 말해 버리면
    // 그 자리의 진짜 개수가 통째로 새고, 숨긴다는 것 자체가 의미를 잃는다.
    return {
      place: place.label, findings, effect: { ...TUNING.inspect },
      spotted: res.spotted.map(id => GARA_BY_ID[id]),
    };
  }

  /**
   * N. 공지 — 게시는 저장이고, 판정은 방향뿐이다. 반응 한 줄은 화면에서 끝난다.
   * 텍스트는 활성 지침 목록에 들어가 이후 모든 사건 생성(E-1)에 주입된다.
   *
   * 여기에 두 번째 일이 붙었다: 판정자가 **이 공지가 어느 관행의 문을 닫는가**를 같이 돌려준다.
   * 판정자가 보는 것은 이 군대에 존재하는 관행의 static 대장뿐이고 — 무엇이 지금 돌고 있는지는
   * 여전히 하나도 못 본다 — 그중 어느 것이 실제로 돌고 있었는지는 코드가 혼자 맞대 본다.
   * 막힌 관행은 그 자리에서 멎고(가라가 그만큼 내려간다) 지침이 서 있는 한 다시 안 생긴다.
   *
   * 실제로 돌던 것을 끊었으면 **판정자의 가라 방향은 버린다.** 끊은 개수가 이미 그 공지의
   * 가라 효과이기 때문이다 — 여기에 「분위기상 가라가 내려갈 듯」을 더하면 같은 것을 두 번 센다.
   */
  async postNotice(text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('빈 공지는 게시할 수 없다');
    const s = this.state;
    this.#charge();

    let out;
    try {
      out = await this.#judge({
        label: '공지 판정', system: P.noticeSystem(this.unit),
        user: P.noticeUser(t), schema: P.NOTICE_SCHEMA,
      });
    } catch {
      out = { gara: 'same', happy: 'same', conflict: 'same', bans: [], reaction: '(반응이 들리지 않았다)' };
    }

    const bans = [...new Set((out.bans || []).filter(id => GARA_BY_ID[id]))];
    s.notices.push({ text: t, bans });
    // 막은 것 중 **실제로 돌고 있던** 것들. 이 개수가 곧 이 공지가 끊어낸 가라다.
    const cut = s.gara.active.filter(id => bans.includes(id));

    s.params = applyDirections(s.params, cut.length ? { ...out, gara: 'same' } : out);
    s.params.gara = Math.max(0, s.params.gara - cut.length);
    this.#syncGara();
    // 끊긴 것은 확인 명부에서도 내린다 — 내가 끊었으니 안 돌아간다는 것은 안다.
    s.gara.known = s.gara.known.filter(k => !cut.includes(k.id));

    return {
      reaction: String(out.reaction || ''),
      banned: bans.map(id => GARA_BY_ID[id]),
      cut: cut.map(id => GARA_BY_ID[id]),
    };
  }

  /**
   * 활성 지침 철회 — 게시의 반대. 판정도 호출도 없다. 평판도 안 깎인다.
   * 막아 뒀던 관행의 문이 다시 열린다. 다만 **끊긴 것이 되살아나지는 않는다** —
   * 가라 수치는 내려간 자리에 그대로 있고, 문이 열렸을 뿐이다. 다시 차오르는 것은 시간의 몫이다.
   */
  removeNotice(index) {
    this.state.notices.splice(index, 1);
    this.#syncGara();
  }

  // ── F. 환송회 — 마지막 밤. 100일을 찍은 그날의 끝에 딱 한 콜 ──

  /**
   * 진급이 통과된 날 밤. 원사 진급은 이 부대를 뜬다는 뜻이라 마지막 씬이 여기서 열린다.
   *
   * **무엇이 열리는지는 행복도 하나가 정한다** (params.js의 farewellTone) — 무사고 기록도
   * 평판도 아니다. 기록은 주임원사가 가져가는 것이고 밥상은 병사들이 차리는 것이라서다.
   * 높으면 거하게 차려 놓고 앞에 나와 인사하고, 낮으면 식당에 아무도 없다.
   * 누가 입을 여는지도 코드가 고른다 — 사건 연루자 선정의 정확한 반대편이다(잘 버틴 순).
   *
   * 결과는 캠페인 상태에 눕는다. 화면을 다시 열어도 같은 밤이고, 콜은 다시 안 나간다.
   */
  async farewell() {
    const s = this.state;
    if (s.farewell) return s.farewell;
    const tone = farewellTone(s.params.happy);
    const speakers = pickSendoff(this.roster.soldiers, tone);

    const out = await this.#gen({
      label: '환송회',
      system: P.farewellSystem(this.unit),
      messages: [{ role: 'user', content: P.farewellUser({
        tone,
        morale: band(s.params.happy),
        clean: s.accidents.length === 0,
        speakers: this.dressedAll(speakers),
      }) }],
      schema: P.FAREWELL_SCHEMA, maxTokens: 4000,
    });

    // 이름은 코드가 고른 그 몇 명 밖으로 안 나간다 — 없는 병사가 인사하고 가면
    // 마지막 장면이 명부에 대해 거짓말을 한다. 아무도 안 온 밤은 대사 자체가 없다.
    const allowed = new Map(speakers.map(x => [x.name, x]));
    const lines = tone === 'none' ? [] : (Array.isArray(out?.lines) ? out.lines : [])
      .map(l => ({ name: String(l?.name || '').trim(), text: String(l?.text || '').trim() }))
      .filter(l => l.text && allowed.has(l.name))
      .map(l => ({ ...l, serial: allowed.get(l.name).serial }));

    s.farewell = {
      tone,
      scene: String(out?.scene || '').trim(),
      lines,
      closing: String(out?.closing || '').trim(),
      speakers: speakers.map(x => x.serial),
    };
    await this.h.farewell?.({ ...s.farewell });
    return s.farewell;
  }
}
