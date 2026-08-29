// names.js — 병사 이름 생성기. **코드가 굴린다.**
//
// 등급과 같은 자리다: 굴림은 코드가 하고, LLM은 굴려진 것에 맞는 인물을 쓰는 일만 한다.
// 이름을 LLM에 맡기면 전원이 「김민준·이서준」으로 수렴한다 — 등급을 맡겼을 때와 같은 병이다.
// 부대마다 이름의 결이 달라야 하는데, 그 결은 프롬프트로 설명하는 것보다 음절 통에서
// 뽑는 쪽이 확실하고 싸다.
//
// 결은 부대 데이터의 nameStyle이 고른다 — 코드는 어느 부대인지 모른다.
//
//   marine-meme : 해병문학 밈의 작명법. 흔치 않은 성에 옛날식 두 음절을 붙인다.
//                 변왕추·황근출·말딸필이 그 장르의 대표 이름이고, 여기서 뽑는 것은
//                 그 이름들 자체가 아니라 **같은 문법으로 지은 새 이름**이다.
//                 (해병문학은 해병대 갤러리에서 자란 인터넷 창작 장르다 — docs/research.md)
//   elite       : 후방 정보체계 부대의 결. 흔한 성에 요즘 이십대 이름.
//                 「수능 다시 보러 온 것 같은 놈들」이라는 지능 서술과 같은 곳을 가리킨다.
//
// 두 통 다 조합이 수백 가지라 정원 16명이 겹칠 일은 거의 없고, 겹치면 부르는 쪽이 다시 뽑는다.

// ── 해병문학 결 ─────────────────────────────────────────
// 성은 흔치 않은 것으로 — 흔한 성을 쓰면 그 장르 특유의 낯섦이 안 산다.
const MEME_SURNAMES = [
  '변', '황', '말', '탁', '국', '견', '추', '마', '반', '판',
  '봉', '육', '표', '어', '옥', '석', '진', '하', '천', '삼',
  '방', '길', '단', '독', '빈', '설', '왕', '甘'.replace('甘', '감'), '노', '두',
];
// 이름은 옛날식 두 음절. 앞뒤 음절을 따로 뽑아 곱한다 — 통 두 개로 수백 가지가 나온다.
const MEME_FIRST = [
  '왕', '근', '딸', '만', '두', '칠', '갑', '덕', '순', '태',
  '봉', '판', '종', '상', '용', '철', '구', '막', '점', '억',
];
const MEME_SECOND = [
  '추', '출', '필', '득', '식', '성', '수', '배', '만', '석',
  '달', '팔', '동', '복', '기', '남', '재', '호', '길', '문',
];

// ── 명문대생 결 ─────────────────────────────────────────
const ELITE_SURNAMES = [
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
  '한', '오', '서', '신', '권', '황', '안', '송', '류', '전',
];
const ELITE_GIVEN = [
  '서준', '도현', '지훈', '예준', '시우', '준서', '하준', '건우', '우진', '민재',
  '재원', '승주', '태민', '현우', '지환', '주원', '연우', '유찬', '동현', '성민',
  '규리', '진우', '해린', '한결', '시윤', '겸', '온유', '유진', '재이', '선우',
];

const STYLES = {
  'marine-meme': rng => MEME_SURNAMES[idx(rng, MEME_SURNAMES)]
    + MEME_FIRST[idx(rng, MEME_FIRST)] + MEME_SECOND[idx(rng, MEME_SECOND)],
  elite: rng => ELITE_SURNAMES[idx(rng, ELITE_SURNAMES)] + ELITE_GIVEN[idx(rng, ELITE_GIVEN)],
};

export const NAME_STYLES = new Set(Object.keys(STYLES));

const idx = (rng, arr) => Math.floor(rng() * arr.length);

/** 이 부대 결의 이름 하나. 모르는 결이면 명문대생 통으로 떨어진다. */
export function rollName(style, rng = Math.random) {
  return (STYLES[style] || STYLES.elite)(rng);
}

/**
 * 명부에 없는 이름 하나. 같은 부대에 동명이인이 생기면 부르는 것부터 꼬인다.
 * 통이 말라도(다 뽑혀도) 무한루프에 안 빠지게 횟수를 끊는다 — 그때는 겹쳐도 내보낸다.
 */
export function rollUniqueName(style, taken = [], rng = Math.random) {
  const seen = new Set(taken);
  for (let i = 0; i < 40; i++) {
    const n = rollName(style, rng);
    if (!seen.has(n)) return n;
  }
  return rollName(style, rng);
}

/** 통의 크기 — 테스트가 「겹칠 일이 거의 없다」를 실제로 재는 데 쓴다. */
export function poolSize(style) {
  return style === 'marine-meme'
    ? MEME_SURNAMES.length * MEME_FIRST.length * MEME_SECOND.length
    : ELITE_SURNAMES.length * ELITE_GIVEN.length;
}
