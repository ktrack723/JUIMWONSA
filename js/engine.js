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

import * as P from './prompts.js';
import {
  band, honestyOf, complianceOf, initialParams, applyDirections, applyIntervention,
  applyDrift, endOfDayStreak, isPromoted, effectiveDifficulty, slotsFor, seasonOf,
  weekdayOf, dateAdd, todayIso, startDateFor, reviewDate, rollSlot, pickEvent,
  pickInvolved, rollGrades, PLACES, TUNING,
} from './params.js';
import { assignJob } from './roster.js';

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
   *   rng        — 주입식 난수 (테스트가 결정적으로 돈다)
   *   cheapModel — 판정 계열(E-3·N·I-2)을 태울 저가 모델 id. 없으면 기본 모델
   */
  constructor(llm, { unit, roster, state, handlers, rng = Math.random, cheapModel = null }) {
    this.llm = llm;
    this.unit = unit;
    this.roster = roster;
    this.h = handlers || {};
    this.rng = rng;
    this.cheapModel = cheapModel;
    this.state = state || Engine.newCampaign(unit);
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
  #judge({ label, system, user, schema }) {
    return this.llm.call({
      label, system, messages: [{ role: 'user', content: user }],
      schema, cache: true, effort: 'low', maxTokens: 2000,
      model: this.cheapModel || undefined,
    });
  }

  // ── P. 전입 — 등급은 코드가 굴리고, LLM은 인물만 쓴다 ──
  async recruitOne(joined = this.state.date) {
    const { grade, character } = rollGrades(this.unit, this.rng);
    const job = assignJob(this.unit, this.roster.soldiers, this.rng);
    // 군번은 명부가 채번한다. 프롬프트에는 채번될 군번을 미리 보여준다.
    const serial = `${this.unit.serial.tag}${joined.slice(2, 4)}-${String(this.roster.seq).padStart(this.unit.serial.pad, '0')}`;
    const out = await this.#gen({
      label: '전입 병사 생성',
      system: P.recruitSystem(this.unit),
      messages: [{ role: 'user', content: P.recruitUser({ serial, job, grade, character, joined }) }],
      schema: P.RECRUIT_SCHEMA,
    });
    return this.roster.enlist({
      name: String(out?.name || '무명용사').trim(), sheet: String(out?.sheet || '').trim(),
      job, grade, character, joined,
    });
  }

  /** 정원까지 채운다. 부임 첫날의 초기 명부 생성에도, 전역 후 충원에도 쓰인다. */
  async fillRoster(joinDates = null, onProgress = null) {
    const arrivals = [];
    let i = 0;
    while (this.roster.vacancies() > 0) {
      const joined = joinDates?.[i] || this.state.date;
      arrivals.push(await this.recruitOne(joined));
      await onProgress?.(arrivals.length, arrivals.at(-1));
      i++;
    }
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
          yesterday: s.yesterday, arrivals, departures, excerpt,
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
      const slotLines = Array.isArray(brief.slots) ? brief.slots.map(x => String(x || '')) : [];
      this.thread.push({ role: 'assistant', content: [brief.briefing, ...slotLines].filter(Boolean).join('\n') });
      await this.h.briefing?.({ date, day: s.day, briefing: String(brief.briefing || ''), arrivals, departures });

      // 슬롯 아홉 — 슬롯마다 사고 롤이 돈다. 화면은 h.slot에서 개입(면담·점검·공지)할 수 있다.
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        await this.h.slot?.({ index: i, count: slots.length, slot, line: slotLines[i] || '' });

        const roll = rollSlot(s.params, {
          intel: this.unit.intel.score, macho: this.unit.macho.score, difficulty: effDiff,
        }, slot.kind, this.rng);
        if (!roll) continue;

        const incident = await this.#runIncident(slot, roll.tier);
        if (incident) incidents.push(incident);
      }

      // 하루 마감 — 드리프트, 조용한 날 평판 회복, 카운터, 날짜 전진.
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
  async #runIncident(slot, tier) {
    const s = this.state;
    const event = pickEvent(tier, slot.kind, this.rng);
    const involved = pickInvolved(this.roster.soldiers, event.involved, this.rng);
    if (!involved.length) return null;
    const place = PLACES[event.place]?.label || event.place;

    // E-1. 사건 장면 — 활성 지침 목록이 여기 주입된다.
    this.thread.push({
      role: 'user',
      content: P.incidentUser({
        slotLabel: slot.label, place, tier, event: event.desc, involved, notices: s.notices,
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
   * I-1. 면담 — 병사를 지정해 불러다 이야기한다. 별도 단명 스레드.
   * 돌려주는 손잡이로 왕복하고, 스레드는 그 면담에서 닫힌다.
   */
  async interview(serial, question) {
    const soldier = this.roster.bySerial(serial);
    if (!soldier) throw new Error(`명부에 없는 군번: ${serial}`);
    this.state.params = applyIntervention(this.state.params);
    this.interventionsToday += 1;

    // 병사의 체감 밴드 — 부대 지표가 아니라 자기 주변이다. 한 칸 오차의 사견이 낀다.
    const jitter = v => clamp10(v + Math.floor(this.rng() * 3) - 1);
    const p = this.state.params;
    const felt = { room: band(jitter(p.conflict)), work: band(jitter(p.gara)), mood: band(jitter(p.happy)) };
    const honesty = honestyOf(p.rep);

    const thread = [{ role: 'user', content: P.interviewOpen({ soldier, felt, honesty, question }) }];
    const sysMsg = P.interviewSystem(this.unit);
    const call = () => this.#gen({ label: `면담 · ${soldier.name}`, system: sysMsg, messages: thread });

    const first = await call();
    thread.push({ role: 'assistant', content: first });
    return {
      soldier, reply: first,
      ask: async (q) => {   // 왕복 — 배급은 안 깎인다. 스레드는 이 면담 안에서만 산다
        thread.push({ role: 'user', content: P.interviewFollowup(q) });
        const out = await call();
        thread.push({ role: 'assistant', content: out });
        return out;
      },
    };
  }

  /** I-2. 불시점검 — 장소를 지정해 들이닥친다. 그 장소가 드러내는 밴드만 실린다. */
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
    return { place: place.label, findings };
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
