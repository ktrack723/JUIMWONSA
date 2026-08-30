// roster.js — 병사 명부. 저장·군번 채번·계급·기수·전입/전역 수명주기.
//
// 프로필은 다섯 필드 + 전입일이다 (기획서 §3):
//   { name, serial, job, grade, character, sheet, joined }
// 등급 둘(grade·character)은 params.js가, 이름은 names.js가 굴리고, sheet는 P 호출(LLM)이 쓴다.
// 여기는 그 결과를 **보관하고 순환시키는** 일만 한다 — LLM도 프롬프트도 모른다.
//
// **계급과 기수는 저장하지 않는다.** 둘 다 전입일에서 계산되는 것이라 저장하면 거짓말이 된다:
//   · 계급은 날이 갈수록 오른다. 어제 일병이던 놈이 오늘 상병이다 — 저장하면 100일 내내 일병이다.
//   · 기수는 안 변하지만 전입일에서 나오는 값이라 따로 들고 있을 이유가 없다.
// 저장되는 것은 「언제 왔는가」뿐이고, 나머지는 그때그때 계산한다 (rankOf · cohortOf).
//
// 만들어진 병사는 localStorage에 저장되어 재사용된다. 사고로 카운터가 리셋되어도
// 병사 데이터는 유지된다 — 어제 싸운 두 놈은 0일차에도 여전히 서로를 노려보고 있다.
// 저장소는 주입식이다 — node 테스트는 Map 흉내를 꽂는다.
//
// **명부에 있다는 것과 부대에 있다는 것은 다르다.** 탈영한 놈도 입원한 놈도 명부에는
// 남는다(제적이 아니다) — 다만 `away`가 붙어 부대에서 빠진다. 그래서 목록이 둘이다:
//   · soldiers — 명부 전체. 저장·군번·정원(빈자리)이 보는 것
//   · present  — 오늘 부대에 있는 사람. 사건·멘탈·면담·브리핑이 보는 것
// 빈자리를 정원으로 세지 않는 것이 요점이다: 입원한 놈 자리에 신병이 오지 않는다.
// 열다섯으로 며칠을 버티는 것이 사고의 값이다.

import { TUNING } from './params.js';
import { rollUniqueName } from './names.js';

const monthsAdd = (iso, months) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

export const ROSTER_SIZE = TUNING.roster.size;

/**
 * 군번 채번. 실제 병 군번은 **입대연도 두 자리 + 여덟 자리**다 (1991년부터 이 체계).
 * 군을 가르는 것은 표기가 아니라 별도의 군 코드다 — 육군 1 · 해군/해병 3 · 공군 5를
 * 앞에 붙인다고 생각하면 전 군에서 겹치지 않는다. 화면에는 실제로 찍히는 형태만 쓴다.
 *   예) 26-70001207
 */
export function makeSerial(unit, joinedIso, seq) {
  const yy = joinedIso.slice(2, 4);
  return `${yy}-${String(seq).padStart(SERIAL_DIGITS, '0')}`;
}
export const SERIAL_DIGITS = 8;

/** 전역일 — 전입일 + 복무기간(부대 프롬프트 ①의 수치판). */
export const dischargeDate = (unit, joinedIso) => monthsAdd(joinedIso, unit.serviceMonths);

/** 며칠 뒤 (ISO). 복귀 예정일 계산이 쓴다. */
export function daysAdd(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── 계급 ────────────────────────────────────────────────
// 병 계급 넷. 진급은 최저복무기간이 차면 자동이다 — 법이 정한 눈금이라 코드가 든다.
// 2019년 9월부터 이병 2개월 · 일병 6개월 · 상병 6개월로 단축됐고, 그 결과 누적
// 진급 시점이 일병 2개월차 · 상병 8개월차 · 병장 14개월차다. 병장은 남는 기간 전부 —
// 해병대 18개월이면 병장 4개월, 공군 21개월이면 병장 7개월이다.
// 눈금은 부대 데이터(rankMonths)가 들고 있다. 코드는 어느 군인지 모른다.
export const RANKS = ['이병', '일병', '상병', '병장'];

/** 두 날짜 사이의 개월 수 (날짜까지 본다 — 하루 모자라면 아직 그 달이 안 찬 것이다). */
export function monthsBetween(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`), b = new Date(`${toIso}T00:00:00Z`);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;
  return m;
}

/** 그날 그 병사의 계급. 전입일과 오늘만 있으면 나온다 — 저장하지 않는 이유다. */
export function rankOf(unit, joinedIso, todayIso) {
  const served = monthsBetween(joinedIso, todayIso);
  const marks = unit.rankMonths;   // [일병, 상병, 병장] 진급 누적 개월
  let i = 0;
  while (i < marks.length && served >= marks[i]) i++;
  return RANKS[Math.min(i, RANKS.length - 1)];
}

// ── 기수 ────────────────────────────────────────────────
// 해병대와 공군은 육군과 달리 한 훈련소에서 같이 훈련받아, 선후임을 「X월 군번」이 아니라
// **기수**로 가린다. 둘 다 창설 이래 입대순으로 번호를 매기고 지금은 대체로 월 1개 기수다.
// 부대 데이터가 「언제가 몇 기였는가」 하나를 들고 있으면 나머지는 달수로 계산된다.
export function cohortOf(unit, joinedIso) {
  const { base, at } = unit.cohort;
  return base + monthsBetween(`${at}-01`, `${joinedIso.slice(0, 7)}-01`);
}

/** 화면과 프롬프트가 같이 쓰는 표기. 「1333기 상병」 */
export function rankLine(unit, soldier, todayIso) {
  return `${cohortOf(unit, soldier.joined)}기 ${rankOf(unit, soldier.joined, todayIso)}`;
}

/** 부임 시점 초기 명부의 전입일들 — 복무기간에 고르게 흩뿌려 전역이 몰리지 않게 한다. */
export function staggeredJoinDates(unit, startIso, n = ROSTER_SIZE, rng = Math.random) {
  const days = Math.floor(unit.serviceMonths * 30.4);
  return Array.from({ length: n }, (_, i) => {
    // 칸을 n등분해 한 칸에 하나씩 — 순수 랜덤이면 전역 공백기가 생긴다.
    const lo = Math.floor(days * i / n), hi = Math.floor(days * (i + 1) / n);
    const back = lo + Math.floor(rng() * Math.max(1, hi - lo));
    const d = new Date(`${startIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  });
}

/** 직무 배정 — 부대 프롬프트의 직무 슬롯에서, 덜 찬 직무부터. */
export function assignJob(unit, roster, rng = Math.random) {
  const counts = Object.fromEntries(unit.jobs.map(j => [j, 0]));
  for (const s of roster) if (counts[s.job] !== undefined) counts[s.job]++;
  const min = Math.min(...Object.values(counts));
  const open = unit.jobs.filter(j => counts[j] === min);
  return open[Math.floor(rng() * open.length)];
}

export class Roster {
  /**
   * storage는 { getItem, setItem, removeItem } 흉내면 뭐든 된다.
   * 브라우저에서는 localStorage, 테스트에서는 Map 래퍼.
   */
  constructor(unit, { storage = defaultStorage(), key = `csm_roster_${unit.id}` } = {}) {
    this.unit = unit;
    this.storage = storage;
    this.key = key;
    this.soldiers = [];
    // 군번 뒷자리. 부대마다 다른 대역에서 시작한다 — load()가 저장값으로 덮는다.
    this.seq = unit.serial.seqBase + Math.floor(Math.random() * 90000);
  }

  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return false;
      const data = JSON.parse(raw);
      this.soldiers = data.soldiers || [];
      // 멘탈이 생기기 전의 저장분 — 기본값으로 채워 읽는다. 옛 세이브가 죽으면 안 된다.
      for (const s of this.soldiers) {
        s.mental ??= TUNING.mental.default;
        // 복귀일 없는 부재는 영원히 안 돌아온다 — 깨진 저장분은 부대로 되돌린다.
        if (s.away && !s.away.until) delete s.away;
      }
      this.seq = data.seq || this.seq;
      return this.soldiers.length > 0;
    } catch { return false; }
  }

  save() {
    try { this.storage.setItem(this.key, JSON.stringify({ soldiers: this.soldiers, seq: this.seq })); } catch { /* 저장 차단 환경 */ }
  }

  clear() {
    this.soldiers = [];
    try { this.storage.removeItem(this.key); } catch { /* 저장 차단 환경 */ }
  }

  bySerial(serial) { return this.soldiers.find(s => s.serial === serial) || null; }

  /** 오늘 부대에 있는 사람. 사건 연루·멘탈 드리프트·면담·브리핑 표본이 전부 이걸 본다. */
  get present() { return this.soldiers.filter(s => !s.away); }
  /** 지금 부대에 없는 사람 — 입원·이탈. 명부에는 남아 있고 자리도 비워 둔다. */
  get absent() { return this.soldiers.filter(s => s.away); }

  // 빈자리는 **명부 전체**로 센다 — 입원·이탈로 빈 자리는 충원되지 않는다.
  vacancies() { return Math.max(0, ROSTER_SIZE - this.soldiers.length); }

  /**
   * 부대에서 빼낸다 — 사고가 데려간 것이다. 제적이 아니라 부재다.
   *   kind  — 'hospital'(입원) · 'awol'(이탈). 라벨과 문장은 params.js의 ABSENCE_KINDS가 든다
   *   days  — 며칠 뒤에 돌아오는가. 복귀일은 여기서 날짜로 굳는다
   * 이미 부재 중인 사람은 그대로 둔다 — 없는 놈이 또 사라질 수는 없다.
   */
  sendAway(soldier, { kind, days, since }) {
    if (!soldier || soldier.away) return null;
    soldier.away = { kind, since, until: daysAdd(since, Math.max(1, days)) };
    this.save();
    return soldier;
  }

  /**
   * 복귀 — 예정일이 된 사람들을 부대로 되돌린다. 돌려주는 것은 복귀자 명단이고,
   * 각 항목에는 어디에 있었는지(away)가 붙어 온다. 화면과 어제 요약이 그걸 읽는다.
   */
  returnFrom(dateIso) {
    const back = this.soldiers.filter(s => s.away && s.away.until <= dateIso);
    if (!back.length) return [];
    const out = back.map(s => ({ ...s, away: { ...s.away } }));
    for (const s of back) delete s.away;
    this.save();
    return out;
  }

  /**
   * 군번 예약 — 채번만 하고 명부에는 안 올린다. 병렬 전입이 서로 같은 번호를
   * 미리보기하지 않도록, P 호출을 쏘기 전에 여기서 하나씩 따 간다.
   * 예약 후 전입이 실패하면 그 번호는 결번이 된다 — 군번은 유일하기만 하면 된다.
   */
  reserveSerial(joined) {
    return makeSerial(this.unit, joined, this.seq++);
  }

  /**
   * 이 부대 결의 이름 하나. 명부에 이미 있는 이름은 피한다.
   * extraTaken은 「아직 명부에 안 올랐지만 이번에 같이 굴리는 중인」 이름들이다 —
   * 병렬 전입에서 열여섯을 미리 굴릴 때 자기들끼리 겹치는 것을 막는다.
   */
  rollName(rng = Math.random, extraTaken = []) {
    return rollUniqueName(this.unit.nameStyle, [...this.soldiers.map(x => x.name), ...extraTaken], rng);
  }

  /**
   * 전입 — 굴려진 것들(이름·등급·직무·군번)과 LLM이 쓴 sheet를 받아 명부에 올린다.
   * 예약분(serial)을 들고 오면 그걸 쓰고, 없으면 여기서 채번한다.
   * 이름을 안 주면 여기서 굴린다(부대 결에 맞게, 명부에 없는 것으로).
   * P 호출은 engine.js가 한다 — 명부는 프롬프트를 모른다.
   */
  enlist({ name, sheet, job, grade, character, joined, serial = null, mental = null, rng = Math.random }) {
    serial = serial || makeSerial(this.unit, joined, this.seq++);
    const soldier = {
      name: name || this.rollName(rng), serial, job, grade, character, sheet, joined,
      // 멘탈은 계급과 달리 **저장한다** — 전입일에서 계산되는 값이 아니라 살아온 결과라서다.
      mental: mental ?? TUNING.mental.default,
    };
    this.soldiers.push(soldier);
    this.save();
    return soldier;
  }

  /**
   * 복무기간이 찬 병사들을 전역시킨다. 돌려주는 것은 전역자 명단이다.
   * **부재자는 못 나간다** — 병원에 있는 놈도, 이탈한 놈도 전역 신고를 할 수 없다.
   * 돌아온 날 전역일이 이미 지나 있으면 그날 바로 나간다.
   */
  discharge(dateIso) {
    const out = this.present.filter(s => dischargeDate(this.unit, s.joined) <= dateIso);
    if (out.length) {
      this.soldiers = this.soldiers.filter(s => !out.includes(s));
      this.save();
    }
    return out;
  }

  /** 오늘 등장할 병사들 — 브리핑 명부 발췌용 표본. 부재자는 무대에 없다. */
  /**
   * 지금 제일 낮은 놈들. **아침 브리핑이 이걸 본다** — 무작위 넷을 보여 주면 산문이 명부에
   * 대해 거짓말을 한다(실측: 브리핑이 「오만근이 새벽까지 화면 켜 놓고 앉아 있다」를 썼는데
   * 그 놈 멘탈은 6이었다. 그 부대에서 실제로 무너지고 있던 것은 다른 놈이었다).
   * 브리핑이 쓰는 것은 **부대의 증상**이고, 증상은 제일 아픈 데서 나온다.
   */
  lowestMental(n, fallback = 6) {
    return this.present
      .slice()
      .sort((a, b) => (a.mental ?? fallback) - (b.mental ?? fallback))
      .slice(0, n);
  }

  sample(n, rng = Math.random) {
    const pool = this.present;
    const picked = [];
    while (picked.length < n && pool.length) {
      picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    return picked;
  }
}

function defaultStorage() {
  try { if (typeof localStorage !== 'undefined') return localStorage; } catch { /* 차단 */ }
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
}
