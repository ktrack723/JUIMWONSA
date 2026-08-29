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
  '참고 · 일과 중 쓸 수 있는 것은 셋이다. 면담 · 불시점검 · 공지. 전부 평판 −1이다.',
  '참고 · 개입이 없는 조용한 날은 평판이 +1 회복된다. 조용한 날이 제일 싼 날이다.',
  '참고 · 평판이 낮으면 지침이 안 먹히고 면담에서 거짓말을 듣는다. 정보에는 값이 있다.',
  '참고 · 브리핑은 수치를 말하지 않는다. 증상만 말한다 — 읽는 눈이 실력이다.',
  '참고 · 생활관은 갈등을, 작업장은 가라를 드러낸다. 장소마다 보이는 것이 다르다.',
  '참고 · 가라가 높으면 편해서 행복하지만, 힘든 일을 대충 하면 다친다.',
  '참고 · 갈등·부조리가 적당하면 잔사고가 준다. 방치하면 탈영이 터진다. 눌린 것은 크게 터진다.',
  '참고 · 공지는 게시되는 순간부터 모든 사건 생성에 주입된다. 판정은 방향뿐이다.',
  '참고 · 사고로 카운터가 리셋되어도 병사들은 그대로 남는다. 어제 싸운 두 놈은 오늘도 서로를 노려본다.',
  '참고 · 여름 혹서기와 겨울 제설은 일과를 더 힘들게 한다. 주말은 일과가 없다. 달력이 정한다.',
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
