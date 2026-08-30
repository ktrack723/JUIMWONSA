// ui.js — 화면 어디서나 쓰는 손잡이들. 게임 규칙은 한 줄도 없다.
//
// game.js가 1000줄을 넘던 시절 여기저기 흩어져 있던 것들을 한 곳에 모은 것이다.
// 여기 있는 것은 전부 「DOM에 무언가를 하는 법」이고, 무엇을 할지는 부르는 쪽이 정한다.

import { sfx } from './audio.js';
import * as pace from './pacing.js';

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const list = v => (Array.isArray(v) ? v.join(' / ') : String(v ?? ''));

// 스토리지 차단 환경에서도 죽지 않게
export const sget = (store, k) => { try { return window[store].getItem(k); } catch { return null; } };
export const sset = (store, k, v) => { try { v === null ? window[store].removeItem(k) : window[store].setItem(k, v); } catch { } };

// 대기막에 뜨는 참고. 규칙을 한 줄로 줄여 둔 것이라 규칙이 바뀌면 여기도 바뀐다.
const TIPS = [
  '참고 · 사건은 아직 사고가 아니다. 대응에 실패해 커진 사건만이 사고고, 그때만 카운터가 0이 된다.',
  '참고 · 사고가 나도 날짜는 안 돌아간다. 무사고 카운터만 0이 되고, 진급 심사일이 미래로 밀린다.',
  '참고 · 일과 중 쓸 수 있는 것은 셋이다. 면담(상담) · 군기 점검 · 공지. 전부 평판 −1이다.',
  '참고 · 개입이 없는 조용한 날은 평판이 +1 회복된다. 조용한 날이 제일 싼 날이다.',
  '참고 · 면담은 캐묻는 자리가 아니라 들어주는 자리다. 불려온 병사의 멘탈이 +1 회복된다.',
  '참고 · 멘탈 2 이하로 무너진 병사는 탈영·자해급 사고의 문이다. 계기판이 빨개지면 불러라.',
  '참고 · 군기 점검은 가라를 −1 잡고 행복을 −1 깎는다. 각과 분위기는 같이 못 간다.',
  '참고 · 가라 수치는 지금 돌고 있는 편법의 개수다. 무엇인지는 들이닥쳐 봐야 안다.',
  '참고 · 확인한 가라 내역은 그날의 사실이다. 안 가 본 자리의 기록은 낡는다.',
  '참고 · 머리 좋은 부대일수록 들이닥쳐도 잘 숨긴다. 명부가 비었다고 없는 것은 아니다.',
  '참고 · 관행을 콕 집어 금지한 공지만이 그 가라를 끊는다. 「군기를 잡아라」는 아무것도 못 막는다.',
  '참고 · 가라가 높으면 편해서 행복하지만, 힘든 일을 대충 하면 다친다.',
  '참고 · 갈등·부조리가 적당하면 잔사고가 준다. 8을 넘기면 눌린 것이 크게 터진다.',
  '참고 · 부대가 어두우면(행복↓·갈등↑) 매일 밤 전원의 멘탈이 쓸려 내려간다.',
  '참고 · 공지는 게시되는 순간부터 모든 사건 생성에 주입된다. 판정은 방향뿐이다.',
  '참고 · 사고로 카운터가 리셋되어도 병사들은 그대로 남는다. 무너진 놈은 여전히 무너져 있다.',
  '참고 · 여름 혹서기와 겨울 제설은 일과를 더 힘들게 한다. 주말은 일과가 없다. 달력이 정한다.',
  '참고 · 가라에는 등급이 있다. 가벼운 가라, 징계감, 그리고 재판급 — 검열에서 터지는 것은 재판급뿐이다.',
  '참고 · 가라마다 도는 시간이 다르다. 자리를 맞춰도 시간이 어긋나면 방은 깨끗하다.',
  '참고 · 감당 못 하는 가라는 표가 난다. 머리 안 되는 부대가 큰 걸 치면 잡히기 전에 사고부터 난다.',
  '참고 · 검열은 부임 17·38·61·85일차다. 사흘 전부터 상황판에 뜬다 — 치울 시간은 그 사흘이다.',
  '참고 · 검열관은 자리를 안 고른다. 흩어져서 전부 뒤진다. 대신 그 시간에 도는 것만 현장이 잡힌다.',
  '참고 · 검열을 지적 0으로 넘기면 평판 +1 · 행복 +1. 이 게임에 몇 안 되는 상방이다.',
  '참고 · 가라를 전부 없애면 병사들이 못 산다. 재판급만 뽑고 나머지는 두는 것이 100일을 가는 길이다.',
];

export function loading(on, label = '') {
  $('#loading-overlay').classList.toggle('hidden', !on);
  if (on) {
    $('#loading-text').textContent = label;
    $('#loading-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  }
}

// 겹쳐 불러도 마지막 하나가 끝날 때 걷힌다.
let loadingDepth = 0;
export async function withLoading(label, fn) {
  loadingDepth++;
  loading(true, label);
  try { return await fn(); } finally { if (--loadingDepth === 0) loading(false); }
}

let toastTimer = null;
export function toast(msg, ms = 5000) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// 한 덩어리로 읽는 글(후일담)을 흘려 넣는다. 재생 속도 설정과 '눌러서 건너뛰기'가 똑같이 먹힌다.
export async function typeText(el, text, cps = 60) {
  const mult = pace.paceMult();
  let n = 0;
  await pace.typeInto(el, text, () => { if (n++ % 6 === 0) sfx.type(); },
    { typeMs: mult > 0 ? (text.length / cps) * 1000 * mult : 0, mult });
}
