// ambient.js — 병영 소음 풀. 스프라이트가 통근하며 흘리는 대사가 여기서 나온다.
//
// **부임 때 한 콜, 그 뒤로는 공짜다.** A 블록(prompts.js)을 한 번 불러 슬롯별 대사
// 27~36줄을 받아 localStorage에 눕히고, 100일 내내 코드가 뽑아 쓴다.
// 하루의 콜 수는 이 파일 때문에 늘지 않는다 — 조용한 날은 여전히 브리핑 한 콜이다.
//
// 풀은 두 갈래가 섞여 있다:
//   🟫 cached  — LLM이 쓴 잡담. 익명 병사의 소리라 누가 전역해도 안 상한다
//   🟩 static  — units.js의 군가 인용. 코드가 곧장 꽂는다. LLM은 가사를 쓰지 않는다
// 군가는 songSlots에서만, songMode에 따라 다르게 나온다 — 해병은 목으로 부르고(chorus),
// 공군은 스피커에서 흘러나온다(broadcast). 같은 데이터가 부대마다 다르게 도착한다.
//
// units.js를 고쳐 군가를 바꾸면 캐시를 지울 필요가 없다. 군가는 저장되지 않고
// 뽑을 때마다 부대 데이터에서 곧장 오기 때문이다. 저장되는 것은 잡담뿐이다.

import { songLines } from './units.js';

/** 군가가 나올 확률 — songSlots에서만. 나머지 슬롯에서는 0이다. */
const SONG_CHANCE = 0.45;

export class AmbientPool {
  /**
   * storage는 { getItem, setItem, removeItem } 흉내면 뭐든 된다.
   * 브라우저에서는 localStorage, 테스트에서는 Map 래퍼.
   */
  constructor(unit, { storage = defaultStorage(), key = `csm_ambient_${unit.id}` } = {}) {
    this.unit = unit;
    this.storage = storage;
    this.key = key;
    this.chatter = {};      // { slotKey: [text, ...] } — 저장되는 것은 이것뿐이다
    this.songs = songLines(unit);   // static. 저장 안 한다 — units.js가 언제나 원본이다
  }

  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return false;
      const data = JSON.parse(raw);
      this.chatter = data.chatter || {};
      return this.size() > 0;
    } catch { return false; }
  }

  save() {
    try { this.storage.setItem(this.key, JSON.stringify({ chatter: this.chatter })); } catch { /* 저장 차단 환경 */ }
  }

  clear() {
    this.chatter = {};
    try { this.storage.removeItem(this.key); } catch { /* 저장 차단 환경 */ }
  }

  size() { return Object.values(this.chatter).reduce((n, a) => n + a.length, 0); }
  ready() { return this.size() > 0; }

  /** A 호출의 결과를 눕힌다. [{slot, text}] → 슬롯별 묶음. 빈 줄과 중복은 여기서 걸러진다. */
  fill(lines) {
    const out = {};
    for (const l of lines || []) {
      const slot = String(l?.slot || '').trim();
      const text = String(l?.text || '').trim();
      if (!slot || !text) continue;
      (out[slot] ||= []);
      if (!out[slot].includes(text)) out[slot].push(text);
    }
    this.chatter = out;
    this.save();
    return this.size();
  }

  /** 이 슬롯에서 군가가 울리는가. 부대 데이터가 정한다 — 코드는 부대를 모른다. */
  singsAt(slotKey) { return this.unit.songSlots.includes(slotKey); }

  /**
   * 대사 하나를 뽑는다. 돌려주는 것은 { text, kind, title? }.
   *   kind 'song'    — 군가 인용 (static). broadcast 부대는 화면이 스피커로 그린다
   *   kind 'chatter' — 캐시된 잡담
   * 풀이 비어 있고 군가도 없는 슬롯이면 null. 화면은 그냥 아무 말도 안 시킨다.
   */
  pick(slotKey, rng = Math.random) {
    if (this.singsAt(slotKey) && this.songs.length && rng() < SONG_CHANCE) {
      const s = this.songs[Math.floor(rng() * this.songs.length)];
      return { text: s.text, kind: 'song', title: s.title, mode: this.unit.songMode };
    }
    const pool = this.chatter[slotKey];
    if (!pool?.length) return null;
    return { text: pool[Math.floor(rng() * pool.length)], kind: 'chatter' };
  }

  /** 서로 다른 대사 n개. 스프라이트 여럿이 한꺼번에 입을 열 때 같은 말을 하지 않게. */
  picks(slotKey, n, rng = Math.random) {
    const out = [];
    const seen = new Set();
    for (let tries = 0; out.length < n && tries < n * 6; tries++) {
      const p = this.pick(slotKey, rng);
      if (!p || seen.has(p.text)) continue;
      seen.add(p.text);
      out.push(p);
    }
    return out;
  }
}

function defaultStorage() {
  try { if (typeof localStorage !== 'undefined') return localStorage; } catch { /* 차단 */ }
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
}
