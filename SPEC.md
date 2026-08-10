# 근무표 시스템 로컬 실행 스펙 v1

CP-SAT 최적해 배정을 로컬에서 돌리기 위한 프론트/백엔드 스펙.
데이터 영속화는 범위 밖(v1 미포함).

---

## 1. 아키텍처

```
브라우저 (localhost:5173)                 로컬 서버 (localhost:8000)
┌─────────────────────────┐              ┌──────────────────────────┐
│ React SPA               │  POST /solve │ FastAPI                  │
│  - 모든 상태를 보유      │ ───────────> │  - 무상태                │
│    직원/규칙/board/lock  │              │  - 요청 1건 = 문제 1개   │
│  - 표시·수동편집         │ <─────────── │  - OR-Tools CP-SAT       │
│  - 새로고침 시 초기화    │  board+진단  │  - 프로세스 메모리만 사용 │
└─────────────────────────┘              └──────────────────────────┘
```

**백엔드는 무상태로 간다.** 저장을 안 하기로 했으므로 서버가 상태를 들고 있어 봐야
새로고침 한 번에 프론트와 어긋난다. 요청마다 직원·규칙·기존 배정을 통째로 보내면
DB 없이도 잠금·타 지점 지원·연속근무 판정이 전부 정확해진다.
나중에 저장 기능을 붙일 때도 이 계약은 그대로 두고 앞단에만 추가하면 된다.

---

## 2. 디렉터리

```
schedule/
  backend/
    main.py            FastAPI 앱, 엔드포인트
    solver.py          CP-SAT 모델 (roster.py를 함수화한 것)
    schemas.py         Pydantic 요청/응답 모델
    domain.py          버킷 변환, 요일 판정 등 순수 유틸
    requirements.txt
  frontend/
    index.html
    package.json
    vite.config.js
    src/
      main.jsx
      App.jsx          기존 ScheduleDemo (거의 그대로)
      api.js           백엔드 호출 래퍼
```

---

## 3. 실행

**백엔드** (Windows, 한 줄씩)

```
cd backend && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt
```
```
cd backend && .venv\Scripts\activate && uvicorn main:app --reload --port 8000
```

**프론트엔드**

```
cd frontend && npm install
```
```
cd frontend && npm run dev
```

`requirements.txt`
```
fastapi
uvicorn[standard]
ortools
pydantic
```

`vite.config.js`에 프록시를 걸어 CORS를 아예 없앤다.

```js
server: { proxy: { "/api": "http://localhost:8000" } }
```

---

## 4. 공통 단위 규약

| 항목 | 표현 | 예 |
|---|---|---|
| 시각 | 30분 버킷 정수. 0 = 00:00, 48 = 익일 00:00 | 16 = 08:00, 64 = 익일 08:00 |
| 날짜 | `"YYYY-MM-DD"` 문자열 | `"2026-08-10"` |
| 요일 | 월=0 … 일=6. 금토일(4,5,6)이 피크 | |
| 직원 ID | 정수 | |
| 근무일수 | 쩜오 0.5 / 풀타임 1.0 | |
| 출근 횟수 | 쩜오·풀타임 구분 없이 1회 | |

프론트의 `tb()` / `bucketLabel()`이 이미 이 규약이므로 변환 계층이 필요 없다.

---

## 5. API 계약

### `POST /api/solve`

#### 요청

```jsonc
{
  "storeId": "sinjung",
  "dates": ["2026-08-10", "...", "2026-08-16"],   // 이번에 배정할 날짜

  "employees": [
    {
      "id": 1, "storeId": "sinjung", "name": "김선우",
      "kind": "day",                    // "day" | "night"
      "maxPerWeek": 5,                  // 출근 횟수 상한
      "minPerWeek": 0,                  // 출근 횟수 하한
      "maxHalf": 4,
      "canEightStart": true,             // 8시 시작 자리(찐오/이른오전/오전쩜오) 전부에 대한 자격
      "until": null,                    // "YYYY-MM-DD" 또는 null
      "avail": { "weekday": null, "peak": [16, 30] },   // [시작버킷, 종료버킷]
      "fixedDays": [1, 3, 6],
      "pins": { "2026-08-22": "jjapO" },
      "vacations": ["2026-08-13"]
    }
  ],

  "slots": [
    { "key": "jjinO", "label": "찐오", "from": 16, "to": 36,
      "need": 1, "peak": 1, "extra": 0,
      "open": true, "late": false, "night": false, "half": false }
  ],

  "rules": {
    "weekCap": 6,
    "startShared": ["close"],           // 같은 시각 중복 출근이 허용되는 슬롯
    "floor":  { "from": 22, "until": 34, "min": 2, "ceil": 3 },
    "break":  { "len": 2, "afterStart": 4, "beforeEnd": 2, "concurrent": 1 },
    "bread":  { "weekday": 32, "peak": 35, "len": 1 },
    "overtime": { "maxExtraShifts": 1, "maxExtraUnits": 2 },
    "shortage": "both",                 // "leave" | "half" | "extra" | "both"
    "requireSlotFill": false,           // 6절 미결정 항목 참고
    "familyStartCap": 3                 // 오전(9/10시)·오후(12/13시) 계열 각각 주당 최대 출근 횟수
  },

  "weights": {
    "gapWeekday": 1, "gapPeak": 4, "gapDay": 20,
    "floor": 2, "over": 1.5,
    "fairness": 100, "minWeek": 500, "overtime": 180,
    "weekendExtraSun": 150, "weekendExtraSat": 100, "weekendExtraFri": 50,
    "underWeek": 250,
    "requireFillShort": 20000, "hardFloorShort": 8000, "peakIntegralShort": 5000
  },

  "existing": {                          // 읽기 전용 문맥. 배정 대상 아님
    "sinjung": { "2026-08-09": { "night": [7] } },
    "songdo":  { "2026-08-10": { "jjinO": [8] } }
  },
  "locked": ["2026-08-12"],              // dates 중 그대로 보존할 날짜

  "assumePrevNightCovered": true,
  "timeLimitSec": 30
}
```

**`existing`이 왜 필요한가.** 마감→오픈 연속근무와 마감-오픈-마감 패턴은 배정 범위
**바깥 하루**를 봐야 판정된다. 또 타 지점에 이미 배정된 사람을 이중으로 넣으면 안 된다.
프론트의 `board` 전체에서 `dates` 앞뒤 1일 + 타 매장 해당 주를 잘라 보낸다.
`locked` 날짜의 실제 배정도 여기에 함께 담는다.

#### 응답

```jsonc
{
  "status": "OPTIMAL",                  // OPTIMAL | FEASIBLE | INFEASIBLE | TIMEOUT
  "objective": 200,
  "bound": 200,                          // objective == bound 면 최적 증명 완료
  "wallTimeSec": 2.9,

  "board": {
    "sinjung": { "2026-08-10": { "close": [3], "thirteen": [5] } },
    "songdo":  { "2026-08-14": { "night": [8] } }     // 지원 나간 야간만
  },

  "breaks": {
    "2026-08-10": [ { "empId": 3, "from": 24, "to": 26 } ]
  },

  "diagnostics": {
    "perDay": [
      { "date": "2026-08-10", "peak": false,
        "gapMinutes": 0, "floorMin": 2, "overMinutes": 0 }
    ],
    "perEmployee": [
      { "empId": 1, "shifts": 5, "cap": 5,
        "workDays": 4.5, "overUnits": 0, "minShortfall": 0 }
    ],
    "penalties": {
      "gap": 0, "gapDays": 0, "floor": 0, "over": 0,
      "fairness": 200, "minWeek": 0, "overtime": 0
    }
  },

  "warnings": ["첫날 00~08시는 지난주 야간이 채워진 것으로 가정했습니다."]
}
```

`penalties`를 항목별로 쪼개 돌려주는 게 중요하다. 목적함수 총점만 보면
"200점이 형평 때문인지 부족 때문인지" 알 수 없어서 가중치 튜닝을 못 한다.

#### 실패 응답

| 상황 | HTTP | 처리 |
|---|---|---|
| 하드 제약 충돌로 해 없음 | 200 | `status: "INFEASIBLE"`, `warnings`에 원인 후보 |
| 시간 초과, 해는 있음 | 200 | `status: "TIMEOUT"`, 찾은 해 반환 |
| 요청 형식 오류 | 422 | Pydantic 기본 |
| 서버 예외 | 500 | `{ "detail": "..." }` |

`INFEASIBLE`은 서버 오류가 아니다. 고정 요일과 휴가가 겹치는 등 **입력이 모순**일 때 나온다.
프론트는 이걸 에러 토스트가 아니라 "이 조건으로는 표를 만들 수 없습니다 + 원인 후보"로 보여준다.

### `GET /api/health`

```json
{ "ok": true, "ortools": "9.15.6755" }
```
프론트 기동 시 1회 호출해 서버가 안 떠 있으면 안내 배너를 띄운다.

---

## 6. 백엔드 상세

### 6.1 solver.py 인터페이스

```python
def solve(req: SolveRequest) -> SolveResponse: ...
```

내부 구성은 `roster.py`와 동일. 상수를 요청값으로 바꾸고 아래를 추가한다.

| 추가 항목 | 내용 |
|---|---|
| 다매장 | 야간 슬롯만 타 매장 인력 후보 허용. 주간은 자기 매장만 |
| `existing` 반영 | 해당 직원·날짜의 x 변수를 아예 만들지 않아 이중 배정 차단 |
| `locked` 반영 | 그 날짜 변수를 기존 값으로 고정 |
| `pins` | 해당 x 변수를 1로 고정 |
| `until` | 종료일 이후 x 변수 미생성 |
| `startShared` | 요청값으로 8시 그룹 배타 제약 생성 |
| `shortage` | `"leave"`면 extra·half 슬롯 상한을 0으로 (평일만) |
| `canEightStart` | false면 8시 시작 슬롯(from이 8시인 슬롯 전부, half 포함) 전체에 대해 x 변수 미생성 |
| `familyStartCap` | 오전(9/10시 시작)·오후(12/13시 시작) 슬롯을 각각 계열로 묶어 직원별 주당 합을 이 값 이하로 제한 |
| `maxWeekday` | 월~금(피크 여부 무관) 출근 횟수 상한. 수요 계산의 `is_peak`(금토일)과는 별개 개념 |
| 쩜오 순서 | half를 하나라도 쓰려면 그 직원의 풀타임 출근 횟수가 이미 `min(maxPerWeek, weekCap)`에 도달해 있어야 함 (하드) |
| 마감-오픈-마감 | 캘린더 인접일이 아니라 그 직원이 실제로 근무한 바로 전/다음 날 기준으로 검사 (쉬는 날 스킵) |
| 바 인원 최소 보장 | 금토일 12~17시 최소 3명, 11~21시 나머지 최소 2명 / 평일 12~21시 최소 2명. 소프트 floor(11~17, 요일 무관, 12절)보다 훨씬 무거운 페널티(`hardFloorShort`)로 별도로 건다 — 채울 수 있으면 사실상 하드, 인력이 정말 모자라면 그 시간대만 미달로 남기고 warnings에 남김 |
| 필수 자리·바 인원 완화 | `requireFillShort`/`hardFloorShort`로 다른 모든 항을 압도하는 무거운 페널티를 줘서, 인력 부족으로 도저히 못 채우는 경우에도 INFEASIBLE 대신 최선의 부분 배정 + 어디가 비었는지 warnings로 반환 |
| 금토일 vs 평일 적분값 | 가장 적게 채워진 금토일의 11~21시 총 커버리지가 가장 많이 채워진 평일의 그것보다 작으면 안 된다는 요청. `peakIntegralShort`로 완화 페널티(위 둘보다는 약하게) |
| 일>토>금 여유 배치 | 월~목보다 일/토/금에 여유 인력을 더 배치하도록 `weekendExtraSun/Sat/Fri`로 목적함수에 보상을 더함 (소프트). over 페널티의 요일별 차이를 이길 만큼 세야 실제로 방향이 튼다 |
| 개인 상한 최대 활용 | 형평(13절)은 편차만 줄일 뿐 상한까지 채우진 않아서, `underWeek`로 남는 여력에 페널티를 매겨 상한까지 쓰도록 유도 (소프트, 홈 매장 직원만) |

### 6.2 슬롯 그룹 배타 제약의 일반화

`roster.py`는 8시 그룹을 하드코딩했다. 일반화한다.

```
같은 from 값을 갖고 startShared에 없는 슬롯들을 묶어
그룹당 "사용된 슬롯 종류 수 <= 1"
```

### 6.2.1 대체 그룹의 demand_curve "유령 부족" 수정

같은 frm에 대체 가능한 슬롯이 여럿(예: 찐오 8-18 / 이른오전 8-15 / 오전쩜오 8-14)이면
그중 하나만 그날 실제로 쓰인다(6.2절 배타 제약). 그런데 필요 인원 곡선(`demand_curve`)이
그룹 대표 슬롯(찐오)의 전체 길이를 그대로 요구하면, 이른오전이 대신 배정된 날 그
차이 구간(15~18시)이 실제로는 짭오·마감·13이 이미 커버하고 있는데도 매번 "유령 부족"으로
잡힌다. 그래서 대체 그룹(같은 frm에 startShared 제외 슬롯이 2개 이상)의 demand는 그날
필요한 다음 그룹이 시작하는 시점까지만 요구하고, 그 이후는 다음 그룹이 이어받는다고 본다.
대체 그룹이 아닌 슬롯(짭오·마감·13처럼 frm에 혼자인 슬롯)은 원래대로 자기 `to`까지 그대로 요구한다.

### 6.3 타임아웃

기본 30초. 1주는 3초 내로 끝난다. 달 단위는 미검증이므로 프론트에서 60초를 보낸다.

### 6.4 로그

`solver.parameters.log_search_progress = False`. 대신 응답의 `wallTimeSec`와
`bound`로 품질을 판단한다. `objective > bound`면 최적이 아니라 시간이 모자란 것이다.

---

## 7. 프론트엔드 변경점

기존 `ScheduleDemo`를 거의 그대로 쓴다. 손대는 곳은 아래뿐이다.

### 7.1 `runAuto` 교체

`AUTO_TRIES` 루프와 청크 분할을 통째로 들어낸다. CP-SAT는 3초에 끝나므로
진행률 표시가 필요 없다. `autoProgress` 상태와 관련 UI도 제거 대상이다.

```js
async function runAuto() {
  setAutoBusy(true);
  try {
    const res = await solveWeek({ storeId, dates: weekDates, employees, board, lockMap, needs, ... });
    applySolveResult(res);
  } catch (e) {
    setSolveError(e.message);
  } finally {
    setAutoBusy(false);
  }
}
```

버튼 문구는 `스케줄 짜는 중… (n/2500)` 대신 단순 스피너 + `계산 중…`.

### 7.2 `api.js`

```js
export async function solveWeek(payload) { /* POST /api/solve, 60초 타임아웃 */ }
export async function health() { /* GET /api/health */ }
```

`AbortController`로 타임아웃을 걸고, 서버 미기동(`fetch` 실패)과
`INFEASIBLE`을 구분해 던진다.

### 7.3 휴게 표시

서버가 `breaks`를 돌려주므로 그걸 우선 쓴다. 다만 **사용자가 그 날을 수동 편집하면
서버 휴게는 무효**가 된다. 이때는 기존 `breakPlan`으로 되돌린다.

```js
const breaksOf = (date) =>
  (!locked[date] && serverBreaks[date]) ? serverBreaks[date] : breakPlan(dayOf(date));
```

`markEdited(date)`가 이미 `lockMap`을 세우므로 추가 상태가 필요 없다.
**기존 `breakPlan`은 지우지 말 것.** 수동 편집 시 유일한 대체 수단이다.

### 7.4 진단 표시

`diagnostics.penalties`를 근무표 상단 경고 영역 아래에 접이식으로 붙인다.
가중치 튜닝 시 어느 항목이 점수를 먹는지 보려면 필요하다.

```
최적해 (200점) · 2.9초
  형평 200 · 부족 0 · 바인원 0 · 과잉 0 · 초과근무 0
```

`objective > bound`면 `최적해` 대신 `근사해 (200~180점)`으로 표기한다.

### 7.5 서버 미기동 배너

`health()` 실패 시 상단에 고정 배너.
```
계산 서버가 꺼져 있습니다. backend 폴더에서 uvicorn을 실행해 주세요.
```

### 7.6 남겨둘 것

기존 greedy(`autoAssignAll`, `scoreBoard`)를 **삭제하지 않는다.** 서버가 안 떠 있을 때의
폴백이자, CP-SAT 결과와 비교할 기준선이다. v1에서는 호출만 끊어둔다.

---

## 8. 검증 기준

| # | 항목 | 통과 조건 |
|---|---|---|
| 1 | 기본 데이터 1주 | `status: OPTIMAL`, 전 요일 `gapMinutes: 0`, 5초 이내 |
| 2 | 출근 상한 | 배정서 `shifts <= 4`. 쩜오를 섞어도 초과 불가 |
| 3 | 초과근무 | 김규리 `maxPerWeek: 3`으로 낮추면 `overUnits: 1` + 쩜오 선택 |
| 4 | 잠금 | 특정 날짜 `locked` 후 재실행 시 그 날 배정 불변 |
| 5 | 지원 | 야간 인력이 모자라면 타 매장 야간 직원이 `board.songdo`에 등장 |
| 6 | 모순 입력 | 김선우 고정 요일 화요일 + 화요일 휴가 → `INFEASIBLE`, 원인 안내 |
| 7 | 서버 미기동 | 배너 노출, 앱이 죽지 않음 |

1~3번은 별도 세션에서 CP-SAT로 이미 확인한 값이다. 그대로 재현되면 이식이 성공한 것이다.

---

## 9. 미결정 사항 → 확정

### 9.1 `requireSlotFill` — **true로 확정**

기본값을 `true`로 한다. `need_of(key,d) > 0`인 슬롯은 `sum(그 슬롯 배정) >= need_of(key,d)`
하드 제약으로 건다(등호가 아니라 이상. `extra`가 함께 있는 슬롯에서 추가 패딩을 막지 않기 위함).

근거:
- 월간 뷰가 슬롯별 막대를 그리는 이상, 커버리지 곡선만으로 채점하면 "찐오 빈칸인데 부족 0분"
  같은 표시-채점 불일치가 사용자에게 그대로 노출된다. 하드 제약이 이 불일치를 구조적으로 없앤다.
- `roster.py` 검증 실행에서 이 제약 없이도 최적해가 찐오/마감/13을 전부 채웠다
  (신중동 기본 데이터엔 여유 인력이 이미 충분하다는 뜻). 즉 하드 제약을 걸어도
  기본 데이터에서 해가 줄어들 위험이 낮다.
- 실제로 인력이 부족해 슬롯을 못 채우는 주가 오면 `INFEASIBLE`로 드러나고, 그 경우
  `requireSlotFill`을 낮추는 게 아니라 애초에 사람을 더 뽑아야 한다는 신호로 보는 게 맞다.

`rules.requireSlotFill` 필드 자체는 남겨 프론트가 껐다 켰다 실험할 수 있게 하되, 기본값과
프론트가 항상 보내는 값은 `true`.

**후속 수정(12절 참고):** "인력 부족이면 INFEASIBLE로 드러내는 게 맞다"는 위 판단은,
실제로 종료일 등으로 후보가 줄어 INFEASIBLE이 나는 주를 겪어보니 사용자에게 아무 표도
안 주는 게 오히려 더 나쁘다는 쪽으로 뒤집었다. `requireSlotFill`과 12.5절 바 인원 최소
보장 둘 다, 이제 진짜 하드가 아니라 다른 모든 항을 압도하는 무거운 페널티(소프트)로
바꿨다 — 채울 수 있으면 사실상 하드와 동일하게 동작하고, 정말 못 채울 때만 그 자리를
비운 채 나머지를 최선으로 채우고 warnings에 어디가 비었는지 남긴다.

### 9.2 `fixedDays`(고정 요일) — **하드 제약으로 확정**

`roster.py`와 동일하게 하드로 둔다.

근거: 8절 검증기준 #6이 이미 "김선우 고정 요일 화요일 + 화요일 휴가 → `INFEASIBLE`"을
통과 조건으로 못 박아뒀다. 소프트 제약이면 이 시나리오는 벌점만 받고 `FEASIBLE`로
넘어가므로 #6을 통과시킬 방법이 없다 — 즉 검증기준 자체가 이미 하드 제약을 전제하고 있었다.
발주 등 반드시 지켜야 하는 요일이라는 실무 의미와도 맞는다.

구현 시 유의: `roster.py`처럼 "그날 배정 가능한 자리가 하나도 없으면 제약을 건너뛴다"로
구현하면 안 된다(그러면 #6이 `FEASIBLE`로 조용히 통과해버려 검증이 무력화된다). 배정 가능한
자리가 0개인데 고정 요일인 경우, 항상-모순 제약(`z==0`와 `z==1`을 동시에 거는 등)을 걸어
`INFEASIBLE`을 강제하고, 원인을 `warnings`에 사람이 읽을 수 있는 문장으로 남긴다.

### 9.3 배정 범위

v1은 **주 단위 고정**을 권한다. 달 단위는 변수가 4배 이상 늘어 속도 미검증이고,
현재 UI의 `runAuto`도 주 단위다. 달 단위가 필요하면 별도 검증 후 추가한다.

---

## 10. v1 범위 밖

- ~~데이터 저장 (DB, 파일, localStorage 전부)~~ → 11절에서 Supabase로 추가
- 사용자 인증, 다중 사용자
- 배포 (Docker, 리버스 프록시)
- 달 단위 일괄 배정
- 실행 취소 / 이력

---

## 11. DB (Supabase)

로그인 기능이 없는 내부 도구라, 브라우저가 Supabase anon key로 테이블을 직접 읽고 쓴다.
백엔드(FastAPI)는 여전히 무상태 — DB는 프론트에서만 붙는다.

### 11.1 테이블

`supabase/schema.sql`, `supabase/schema_v2_schedule_runs.sql`을 Supabase SQL Editor에서
순서대로 한 번씩 실행하면 만들어진다.

| 테이블 | 내용 |
|---|---|
| `employees` | 직원 한 명당 한 행. `id`는 클라이언트가 `Math.max(기존 id)+1`로 채번(자동증가 아님) |
| `app_state` | `id='default'` 고정 한 행에 배정표(`board`)·잠금(`lock_map`)·필요인원(`needs`)·빵 시간·인원부족 모드(`shortage`)·서버 계산 휴게(`server_breaks`)를 JSONB로 통째로 저장 |
| `schedule_runs` | 자동 배정(`runAuto`) 성공할 때마다 한 행 추가(insert-only, 안 지움). 그 시점 직원 설정·규칙·필요인원 스냅샷 + 그 주 결과 + 진단정보. `employees`/`app_state`는 "지금" 상태만 있어서, 나중에 설정이 바뀌면 과거 배정이 왜 그렇게 나왔는지 알 수 없다 — 이 테이블이 그 감사 기록이다 |

두 테이블 다 RLS를 켜두고 `anon` 롤에 전체 권한(`for all using (true)`)을 열어뒀다 —
로그인이 없으니 URL을 아는 사람은 누구나 읽고 쓸 수 있다는 뜻. 나중에 로그인을 붙이면
이 정책을 좁혀야 한다.

### 11.2 프론트 동작

- 기동 시 1회(`useEffect([])`) `employees`·`app_state`를 불러와 React state를 채운다.
  `employees`가 비어 있으면(첫 실행) 코드의 `INITIAL_EMPLOYEES`로 시드한다.
- `employees`, `board`/`lockMap`/`needs`/`breadWeekday`/`breadPeak`/`shortage`/`serverBreaks`가
  바뀌면 1초 디바운스 후 각각 `employees`/`app_state` 테이블에 upsert한다.
- 직원 삭제는 upsert로는 반영이 안 되므로(빠진 행이 안 지워짐) `removeEmployee`에서
  즉시 `delete`를 따로 호출한다.
- 로드가 끝나기 전(`dbLoaded===false`)엔 "불러오는 중…"만 보여주고, 그 전엔 저장
  effect를 아예 돌리지 않는다 — 초기 기본값으로 DB를 덮어쓰는 걸 막기 위해서다.

### 11.3 환경변수

`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (Vite라 `VITE_` 접두사 필수, 클라이언트
번들에 그대로 노출됨 — anon key는 원래 공개돼도 되는 키다). 로컬은 `.env`(git 제외),
Vercel은 프로젝트 Settings > Environment Variables에 같은 값을 넣어야 배포본에서도 동작한다.
둘 다 없으면 `src/supabaseClient.js`가 `supabase = null`로 두고 DB 없이(로컬 state만) 동작한다.
