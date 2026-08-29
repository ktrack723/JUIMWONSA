// units.js — 부대 프롬프트 대장. couples.js 포지션 — 전부 손으로 쓴 고정 데이터다.
//
// 군마다 다른 것은 단 하나, 이 부대 프롬프트다. 다섯 절(①문화 ②규정 ③병사간 룰
// ④지능 ⑤마초)이 병사의 생활을 뽑아내는 엔진의 재료로 들어가고, 신규 전입 병사의
// 프로필을 뽑을 때도 들어간다.
//
// ④·⑤는 수치+서술 한 쌍이다 — **서술은 프롬프트로, 수치는 코드로** 간다.
// 지능·마초는 생성 텍스트의 말투를 정하는 동시에 사고 확률 공식(params.js)의 입력이다.
// 같은 원천에서 한 번만 정의한다. 수치가 프롬프트 문자열에 새면 테스트가 깨진다.
//
// 셋째 군은 이 파일에 항목 하나를 더하는 것으로 끝나야 한다.
// **코드 어디에도 특정 부대를 아는 분기를 두지 않는다.**
//
// 스키마 검증 — 로드 시 돈다. 스키마 밖 필드가 있으면 죽는다.

export const UNITS = [
  {
    id: 'marine-fort',
    name: '해병 성채',
    branch: '해병대',
    desc: '서해 최전방 도서 방어 대대',
    // ① 문화 — 핵심가치·군 역사·분위기. 창설 서사, 전용 용어, 복식, 복무기간
    culture: `귀신 잡는 해병의 전통을 이어받았다고 전원이 믿는다. 기수 문화가 뼛속까지 박혀 있고,
상륙 서사를 술자리마다 왼다. 전용 용어: 딸녀(부대 마스코트 조각상), 악기바리(억지로 많이 먹이기),
돌격(뭐든 일단 몸부터 나가는 것). 팔각모와 상륙돌격형 두발을 목숨처럼 여긴다.
복무기간 18개월. "해병은 태어나는 것이 아니라 만들어진다"를 정문에 새겨 놨다.`,
    // ② 규정 — 기본 군 규정
    rules: `출타 통제가 빡빡하다 — 외출·외박 승인이 짜다. 휴대폰 사용은 평일 저녁 한정.
개인 태블릿 불허. 실외에서 모자를 벗는 것(탈모) 금지. 두발 규정은 상륙돌격형으로 통일.
해안 경계 근무와 진지 공사가 일과의 중심이다.`,
    // ③ 병사간 룰 — 자체 룰 (부조리의 씨앗)
    soldierRules: `이병은 BX(매점) 이용 금지. 일병 이하는 사이버지식정보방 주말 한정.
기수 열외 문화가 잔존한다 — 찍힌 병사는 기수 전체가 없는 사람 취급한다.
후임은 선임 앞에서 계급 호칭을 생략할 수 없다.`,
    // ④ 지능 — 수치는 코드로(사고 공식), 서술은 프롬프트로(말투)
    intel: { score: 4, desc: '머리보다 몸이 먼저 나간다' },
    // ⑤ 마초 — 위와 같다
    macho: { score: 9, desc: '다치는 걸 자랑으로 아는 놈들' },
    difficulty: 8,          // 일과 난이도 — static. 주임원사가 못 건드린다
    serviceMonths: 18,      // 복무기간 (①의 수치판 — 전역 판정은 코드가 한다)
    serial: { tag: '해병', pad: 7 },   // 군번 채번 형식 — 코드가 채운다
    jobs: ['해안 경계병', '통신병', '조리병', '운전병', '보급병', '의무병', '화기관리병', '행정병'],
  },

  {
    id: 'airforce-sys',
    name: '공군 체계단',
    branch: '공군',
    desc: '후방 정보체계 관리 부대',
    culture: `신사적인 분위기를 스스로 자랑한다. 창설 이래 무사고 전통이 부대 자부심의 전부다.
전용 용어: 딸수(달력에 전역일까지 남은 날을 지우는 것), 짬찌(막내), 찐빠(일 처리 실수).
복무기간 21개월. 약모를 쓰고, 전투복보다 근무복을 입는 날이 많다.
"우리는 조용히 이긴다"가 복도에 걸려 있는데 아무도 어디서 이겼는지 모른다.`,
    rules: `출타가 자유로운 편이다. 휴대폰은 일과 후 상시 사용 가능. 개인 태블릿 허용.
두발 규정이 느슨해서 파마를 하고 오는 병사도 있다. 서버 점검과 문서 작업이 일과의 중심이다.`,
    soldierRules: `병사간 자체 룰이 거의 없다 — 대신 은근한 따돌림형 부조리가 취약점이다.
단체 채팅방에서 한 명만 빼고 방을 새로 파는 식이다. 겉으로는 전원이 존댓말을 쓴다.`,
    intel: { score: 8, desc: '수능 다시 보러 온 것 같은 놈들' },
    macho: { score: 2, desc: '체력 검정이 최대 위기' },
    difficulty: 3,
    serviceMonths: 21,
    serial: { tag: '공군', pad: 7 },
    jobs: ['정보체계관리병', '네트워크운용병', '행정병', '군사경찰', '조리병', '시설관리병', '수송병', '보급병'],
  },
];

// ── 검증 — 스키마 밖의 필드가 생기거나 절이 비면 로드 자체가 죽는다 ──────
export const UNIT_FIELDS = new Set([
  'id', 'name', 'branch', 'desc', 'culture', 'rules', 'soldierRules',
  'intel', 'macho', 'difficulty', 'serviceMonths', 'serial', 'jobs',
]);

const seenId = new Set();
for (const u of UNITS) {
  for (const f of Object.keys(u)) if (!UNIT_FIELDS.has(f)) throw new Error(`units.js: ${u.id}에 스키마 밖 필드 「${f}」`);
  for (const f of UNIT_FIELDS) if (u[f] === undefined) throw new Error(`units.js: ${u.id}에 ${f}가 없다`);
  if (!u.id || seenId.has(u.id)) throw new Error(`units.js: id 중복 또는 누락 — ${u.id}`);
  seenId.add(u.id);
  for (const f of ['culture', 'rules', 'soldierRules']) {
    if (typeof u[f] !== 'string' || u[f].trim().length < 20) throw new Error(`units.js: ${u.id}.${f} 절이 부실하다`);
  }
  for (const f of ['intel', 'macho']) {
    const v = u[f];
    if (!v || typeof v.score !== 'number' || v.score < 0 || v.score > 10) throw new Error(`units.js: ${u.id}.${f}.score는 0~10이어야 한다`);
    if (typeof v.desc !== 'string' || v.desc.length < 2) throw new Error(`units.js: ${u.id}.${f}.desc 서술이 없다`);
  }
  if (typeof u.difficulty !== 'number' || u.difficulty < 0 || u.difficulty > 10) throw new Error(`units.js: ${u.id} 일과 난이도는 0~10이어야 한다`);
  if (!(u.serviceMonths >= 12)) throw new Error(`units.js: ${u.id} 복무기간이 이상하다`);
  if (!u.serial?.tag || !(u.serial.pad >= 4)) throw new Error(`units.js: ${u.id} 군번 형식 누락`);
  if (!(u.jobs?.length >= 4)) throw new Error(`units.js: ${u.id} 직무 슬롯이 4개 미만이다`);
  if (new Set(u.jobs).size !== u.jobs.length) throw new Error(`units.js: ${u.id} 직무 중복`);
}

export const UNIT_BY_ID = Object.fromEntries(UNITS.map(u => [u.id, u]));
