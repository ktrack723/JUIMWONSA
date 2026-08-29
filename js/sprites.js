// sprites.js — 일과 타임라인 무대. 해가 움직이고 배경색이 바뀌며, 작은 사람 판때기들이
// 생활관·식당·작업장·흡연장을 왔다갔다한다. three.js 빌보드 — avatar.js의 저렴한 친척이다.
//
// 이 파일이 아는 것은 **자리와 시각과 대사 한 줄**뿐이다. 파라미터도, 사건 판정도,
// 무사고 카운터도 모른다. 게임 규칙은 engine.js에 있고 여기는 연출이다.
//
// 스프라이트 하나는 캔버스에 그린 도트 병사를 텍스처로 붙인 판때기다. 얼굴은 없다 —
// 판때기 열여섯에 표정을 그리면 그때부터 아바타 렌더러가 되고, 그건 이 게임에 없다.
// 계급(짬)만 색으로 구분한다: 막내는 밝고, 말년은 바랬다.
//
// 성능: 텍스처는 계급별로 한 장씩만 굽고 판때기들이 공유한다. WebGL 컨텍스트는 하나다.
// WebGL이 없거나 죽으면 조용히 물러난다 — 화면이 안 뜰 뿐 게임은 그대로 돈다.

import {
  Scene, OrthographicCamera, WebGLRenderer, Sprite, SpriteMaterial,
  CanvasTexture, NearestFilter,
} from '../vendor/three.module.min.js';
import { PLACES, dayFraction } from './params.js';

// 하루의 하늘. 시각(0..1)을 색 둘로 옮긴다 — 위/아래.
const SKY = [
  { at: 0.00, top: '#0a0f1c', bot: '#141c2b' },   // 한밤
  { at: 0.24, top: '#2a3550', bot: '#6b5a52' },   // 여명 (05:45)
  { at: 0.30, top: '#7fa8d8', bot: '#e8c9a0' },   // 아침 (07:12)
  { at: 0.50, top: '#8fc0ea', bot: '#cfe4f2' },   // 한낮
  { at: 0.72, top: '#e8a56a', bot: '#f0cba0' },   // 저녁놀 (17:17)
  { at: 0.80, top: '#3a4463', bot: '#7a6a72' },   // 땅거미 (19:12)
  { at: 0.90, top: '#111726', bot: '#1a2130' },   // 밤
  { at: 1.00, top: '#0a0f1c', bot: '#141c2b' },
];

const lerp = (a, b, t) => a + (b - a) * t;
function mixHex(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = p(a), [br, bg, bb] = p(b);
  const f = v => Math.round(v).toString(16).padStart(2, '0');
  return `#${f(lerp(ar, br, t))}${f(lerp(ag, bg, t))}${f(lerp(ab, bb, t))}`;
}
/** 시각(0..1) → { top, bot }. 구간 사이는 섞는다. */
export function skyAt(frac) {
  const f = Math.max(0, Math.min(1, frac));
  for (let i = 1; i < SKY.length; i++) {
    if (f > SKY[i].at) continue;
    const a = SKY[i - 1], b = SKY[i];
    const t = (f - a.at) / (b.at - a.at || 1);
    return { top: mixHex(a.top, b.top, t), bot: mixHex(a.bot, b.bot, t) };
  }
  return { top: SKY.at(-1).top, bot: SKY.at(-1).bot };
}

/**
 * 해(또는 달)의 자리. 06:00에 떠서 18:00에 지는 반원을 그린다.
 * 돌려주는 x·y는 0..1이고, night이면 달이다.
 */
export function sunAt(frac) {
  const day = (frac - 0.25) / 0.5;          // 06:00~18:00을 0..1로
  if (day >= 0 && day <= 1) return { x: day, y: Math.sin(day * Math.PI), night: false };
  const n = frac < 0.25 ? (frac + 0.25) / 0.5 : (frac - 0.75) / 0.5;   // 밤은 반대편 반원
  return { x: n, y: Math.sin(n * Math.PI) * 0.7, night: true };
}

// 계급 띠 — 짬이 찰수록 전투복이 바랜다. 명부의 전입일 순서로 정해진다.
const RANKS = [
  { key: 'new', top: '#4a5a3a', bot: '#3a4a2e', skin: '#e8c8a8' },   // 막내 — 새 옷
  { key: 'mid', top: '#5a6a46', bot: '#46543a', skin: '#e0bc9a' },
  { key: 'old', top: '#6b7a58', bot: '#55624a', skin: '#d8b28e' },   // 말년 — 바랜 옷
];

// 도트 병사 한 장. 32×48 캔버스에 그려 텍스처로 굽는다. 계급마다 한 장씩만 굽는다.
function drawSoldier(rank) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 48;
  const g = c.getContext('2d');
  const px = (x, y, w, h, fill) => { g.fillStyle = fill; g.fillRect(x, y, w, h); };
  px(11, 4, 10, 3, '#2c3626');        // 모자챙
  px(12, 1, 8, 4, rank.top);          // 모자
  px(12, 7, 8, 7, rank.skin);         // 얼굴 (이목구비는 안 그린다)
  px(10, 14, 12, 15, rank.top);       // 상의
  px(7, 15, 3, 12, rank.top);         // 팔
  px(22, 15, 3, 12, rank.top);
  px(7, 25, 3, 3, rank.skin);         // 손
  px(22, 25, 3, 3, rank.skin);
  px(11, 29, 4, 14, rank.bot);        // 다리
  px(17, 29, 4, 14, rank.bot);
  // 군화는 캔버스 **맨 아래까지** 채운다. 밑에 투명 픽셀을 남기면 그만큼 병사가
  // 땅 위에 떠 보인다 — 판때기는 텍스처 전체 높이로 배치되기 때문이다.
  px(10, 43, 6, 5, '#241f1a');        // 군화
  px(16, 43, 6, 5, '#241f1a');
  const tex = new CanvasTexture(c);
  tex.magFilter = NearestFilter;      // 도트는 도트로 — 뭉개지 않는다
  tex.minFilter = NearestFilter;
  return tex;
}

// 땅의 높이(0..1). CSS의 .stage-ground와 **같은 값이어야 한다** — 병사는 이 선 위에 선다.
export const GROUND = 0.22;

const rand = (a, b) => a + Math.random() * (b - a);

export class Stage {
  /**
   * canvas 하나를 받아 무대를 연다. WebGL이 안 되면 ok=false로 조용히 죽는다.
   * onSpeak는 말풍선을 그리는 쪽에 자리를 알려주려고 부른다 (화면 좌표 0..1).
   */
  constructor(canvas, { count = 12 } = {}) {
    this.canvas = canvas;
    this.ok = false;
    this.sprites = [];
    this.frac = 0.5;
    this.aspect = 1;
    this.raf = null;
    try {
      // alpha:true — 하늘과 땅은 CSS가 그린다. 셰이더 하나 안 쓰고 그라디언트가 나온다.
      this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true });
      this.renderer.setClearAlpha(0);
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.scene = new Scene();
      // 정사영 카메라. 무대는 언제나 0..1 × 0..1이다 — 캔버스가 커져도 좌표는 안 바뀐다.
      this.camera = new OrthographicCamera(0, 1, 1, 0, -10, 10);
      this.textures = RANKS.map(drawSoldier);
      this.#build(count);
      this.ok = true;
      this.resize();
    } catch { this.ok = false; }   // WebGL 미지원·컨텍스트 고갈 — 무대 없이 간다
  }

  #build(count) {
    for (let i = 0; i < count; i++) {
      // 계급은 고르게 흩는다. 막내가 넷, 중간이 넷, 말년이 넷.
      const tex = this.textures[i % this.textures.length];
      const sp = new Sprite(new SpriteMaterial({ map: tex, transparent: true }));
      const h = rand(0.26, 0.32);
      sp.scale.set(h * (32 / 48), h, 1);   // resize()가 곧바로 비율을 맞춰 준다
      // 스프라이트는 가운데를 기준으로 놓인다 — 발을 땅에 대려면 반 키만큼 올려야 한다.
      // 여기를 GROUND로만 두면 병사가 허리까지 땅에 묻힌다.
      sp.position.set(Math.random(), GROUND + h / 2, 0);
      this.scene.add(sp);
      this.sprites.push({
        sp, h,
        x: Math.random(), tx: Math.random(),   // 지금 자리 / 가려는 자리
        speed: rand(0.10, 0.20),
        bob: Math.random() * Math.PI * 2,      // 걸을 때 위아래로 까딱이는 위상
        base: sp.position.y,
      });
    }
  }

  /**
   * 캔버스 크기가 바뀌면 부른다. 무대 좌표계(0..1 × 0..1)는 안 바뀌고 픽셀만 맞춘다.
   * 다만 **가로세로 비율은 보정해야 한다.** 정사영 카메라가 가로도 0..1, 세로도 0..1로
   * 잡는데 캔버스는 가로로 길다 — 보정 없이 두면 병사가 납작한 판때기로 뭉개진다
   * (900×250이면 가로 1칸이 세로 1칸의 3.6배로 그려진다).
   */
  resize() {
    if (!this.ok) return;
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 250;
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    for (const s of this.sprites) this.#fit(s);
  }

  /** 한 스프라이트의 가로 지름을 지금 비율에 맞춘다. 보는 방향(부호)은 지킨다. */
  #fit(s) {
    const w = (s.h * (32 / 48)) / (this.aspect || 1);
    s.sp.scale.x = w * Math.sign(s.sp.scale.x || 1);
    s.sp.scale.y = s.h;
  }

  /**
   * 슬롯이 바뀌었다. 병사들이 그 장소로 통근하기 시작하고, 하늘이 그 시각으로 간다.
   * slot은 params.js의 slotsFor()가 준 것 — { key, label, time, at }.
   */
  goto(slot) {
    if (!this.ok) return;
    this.frac = dayFraction(slot.time);
    const place = PLACES[slot.at];
    const cx = place ? place.x : 0.5;
    for (const s of this.sprites) {
      // 한 점에 겹쳐 서지 않게 그 자리 주변으로 흩는다. 점호는 모이고, 휴식은 퍼진다.
      const spread = slot.kind === 'rollcall' ? 0.05 : slot.kind === 'rest' ? 0.16 : 0.10;
      s.tx = Math.max(0.03, Math.min(0.97, cx + rand(-spread, spread)));
    }
  }

  /** 지금 이 순간 스프라이트들이 서 있는 화면 좌표(0..1). 말풍선이 이걸 보고 붙는다. */
  positions() {
    return this.sprites.map(s => ({ x: s.x, y: 1 - s.base }));
  }

  start() {
    if (!this.ok || this.raf) return;
    let last = performance.now();
    const loop = now => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.#step(dt);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  /** 지금 시각의 하늘과 해. 화면이 이걸 CSS로 옮겨 그린다. */
  look() { return { sky: skyAt(this.frac), sun: sunAt(this.frac) }; }

  #step(dt) {
    for (const s of this.sprites) {
      const d = s.tx - s.x;
      if (Math.abs(d) > 0.004) {
        s.x += Math.sign(d) * Math.min(Math.abs(d), s.speed * dt);
        s.bob += dt * 14;
        s.sp.position.y = s.base + Math.abs(Math.sin(s.bob)) * 0.012;   // 걸을 때만 까딱인다
        s.sp.scale.x = Math.abs(s.sp.scale.x) * (d < 0 ? -1 : 1);       // 가는 쪽을 본다
      } else {
        s.sp.position.y = s.base;
      }
      s.sp.position.x = s.x;
    }
  }

  dispose() {
    this.stop();
    if (!this.ok) return;
    for (const s of this.sprites) { s.sp.material.map?.dispose?.(); s.sp.material.dispose(); }
    this.renderer.dispose();
    this.ok = false;
  }
}
