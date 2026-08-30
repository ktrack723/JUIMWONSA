# 사고 유형 그림

`js/params.js`의 `INCIDENT_CATEGORIES` 열두 항목에 **파일 하나씩** 대응한다.
파일 이름이 곧 유형 id다 — `artFor(id)`가 `assets/incidents/<id>.svg`를 가리킨다.

| 파일 | 유형 | 갈래 |
|---|---|---|
| `injury.svg` | 부상·안전사고 | 안전사고 |
| `blast.svg` | 화재·폭발 | 안전사고 |
| `vehicle.svg` | 차량·중장비 | 안전사고 |
| `health.svg` | 보건·환자 | 안전사고 |
| `firearm.svg` | 총기·탄약 | 군기사고 |
| `guard.svg` | 경계·근무 실패 | 군기사고 |
| `violation.svg` | 규정위반 검거 | 군기사고 |
| `abuse.svg` | 가혹행위·부조리 | 군기사고 |
| `absent.svg` | 인원이탈 | 군기사고 |
| `supply.svg` | 보급·물자 | 군기사고 |
| `outside.svg` | 대외·민간 | 군기사고 |
| `selfharm.svg` | 자해·신상 | 신상사고 |

지금 들어 있는 것은 **자리를 잡아 둔 스텐실**이다. 진짜 그림으로 갈아 끼울 때:

1. 같은 이름으로 덮어쓴다. 확장자를 바꾸려면 `params.js`의 `artFor` 한 줄만 고친다.
2. 정사각형으로 만든다 — 화면은 48px 사각 칸에 `object-fit: cover`로 앉힌다.
3. **파일이 없어도 게임은 안 깨진다.** 로드에 실패하면 유형의 icon 글자가 대신 뜬다
   (`js/game.js`의 `incidentArt`). 그림 없이 유형만 먼저 늘려도 된다.

테두리 색이 갈래다 — 안전사고 호박, 군기사고 적, 신상사고 청.
