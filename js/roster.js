// roster.js — 병사 명부. 저장·군번 채번·전입/전역 수명주기.
//
// 프로필은 다섯 필드 + 전입일이다 (기획서 §3):
//   { name, serial, job, grade, character, sheet, joined }
// 등급 둘(grade·character)은 params.js가 굴리고, sheet는 P 호출(LLM)이 쓴다.
// 여기는 그 결과를 **보관하고 순환시키는** 일만 한다 — LLM도 프롬프트도 모른다.
//
// 만들어진 병사는 localStorage에 저장되어 재사용된다. 사고로 카운터가 리셋되어도
// 병사 데이터는 유지된다 — 어제 싸운 두 놈은 0일차에도 여전히 서로를 노려보고 있다.
// 저장소는 주입식이다 — node 테스트는 Map 흉내를 꽂는다.

import { TUNING } from './params.js';

const monthsAdd = (iso, months) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

export const ROSTER_SIZE = TUNING.roster.size;

/** 군번 채번 — 군별 형식으로 코드가 채운다. 예: 해병24-0001207 */
export function makeSerial(unit, joinedIso, seq) {
  const yy = joinedIso.slice(2, 4);
  return `${unit.serial.tag}${yy}-${String(seq).padStart(unit.serial.pad, '0')}`;
}

/** 전역일 — 전입일 + 복무기간(부대 프롬프트 ①의 수치판). */
export const dischargeDate = (unit, joinedIso) => monthsAdd(joinedIso, unit.serviceMonths);

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
    this.seq = 1000 + Math.floor(Math.random() * 9000);   // load()가 저장값으로 덮는다
  }

  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return false;
      const data = JSON.parse(raw);
      this.soldiers = data.soldiers || [];
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
  vacancies() { return Math.max(0, ROSTER_SIZE - this.soldiers.length); }

  /**
   * 전입 — 굴려진 등급과 LLM이 쓴 인물(name·sheet)을 받아 명부에 올린다.
   * 군번은 여기서 채번된다. P 호출은 engine.js가 한다 — 명부는 프롬프트를 모른다.
   */
  enlist({ name, sheet, job, grade, character, joined }) {
    const serial = makeSerial(this.unit, joined, this.seq++);
    const soldier = { name, serial, job, grade, character, sheet, joined };
    this.soldiers.push(soldier);
    this.save();
    return soldier;
  }

  /** 복무기간이 찬 병사들을 전역시킨다. 돌려주는 것은 전역자 명단이다. */
  discharge(dateIso) {
    const out = this.soldiers.filter(s => dischargeDate(this.unit, s.joined) <= dateIso);
    if (out.length) {
      this.soldiers = this.soldiers.filter(s => !out.includes(s));
      this.save();
    }
    return out;
  }

  /** 오늘 등장할 병사들 — 브리핑 명부 발췌용 표본. */
  sample(n, rng = Math.random) {
    const pool = this.soldiers.slice();
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
