# geo-probe v2 — AI 가시성 모니터링 제품화

> 작성 2026-07-26 · `/spec` · 현재 v1(CLI 250줄) → v2(자동 수집 + 라이브 대시보드)
> 사용 모델(D1 확정): **라이브 읽기전용 대시보드 + 오픈소스 CLI.** 내가 스케줄로 돌린 측정이 누적돼 라이브로 보이고, 남은 CLI를 자기 키로 돌린다.

## Context

지금 geo-probe는 "한 번 재고 끝나는 스크립트"다. 브랜드·질문·모델이 이미 설정 주입이라(`geo.config.example.json:2-18`) 아무 브랜드나 넣을 수는 있지만, **제품이 파는 가치인 "반복 측정으로 추세 추적"을 정작 도구가 못 한다.** 실행할 때마다 `results/<타임스탬프>/`에 새 폴더만 쌓이고 런 간 비교 코드는 0줄이다(`bin/geo-probe.mjs:90`).

목표는 "내 AI 활용 수준을 남도 쓸 수 있는 형태로 만드는 것". 그 증거가 되려면 **자동으로 계속 수집되고, 아무 브랜드나 꽂아도 돌아가고, 결과가 시간축 위에 쌓여야** 한다. 레퍼런스는 Canton Hub(수집 스케줄러 → API → 라이브 대시보드).

## Current State (2026-07-26 검증)

| 파일 | 줄 | 역할 | v2 변경 |
|---|---|---|---|
| `bin/geo-probe.mjs` | 117 | CLI probe/analyze/run | 퀵모드·멀티브랜드·시계열 append |
| `src/providers.mjs` | 67 | openai·gemini·anthropic·command 어댑터 | 유지 (구조 양호) |
| `src/analyze.mjs` | 63 | 내 브랜드 순위만 파싱 | **전면 확장** |
| 출력 | — | `results/<stamp>/report.md`+`measurements.csv`+`raw/` | + `data/history.jsonl` 누적 |

**측정 능력 갭 4개 (JD 요구 대비):**

| JD 요구 문구 | 현재 | 갭 |
|---|---|---|
| 브랜드 가시성 | ✅ 언급률·최초순위 | — |
| **점유율(SoV)** | ❌ | `rankOf()`가 내 브랜드만 뽑고 같은 응답의 경쟁사는 **전부 폐기**(`analyze.mjs:11-17`) |
| 순위 | ✅ 중위순위 | 시간축 없음 |
| **인용 출처** | ❌ | URL/도메인 추출 코드 없음 |
| (추세) | ❌ | 런 간 비교 0줄 |

**성능 제약(실측 계산):** 3모델×4질문×5회×`spacingMs 8000` ≈ **8분/회**. 대화 중 즉석 실행은 불가 → 퀵모드 필요.

## Proposed Change

### 아키텍처 (서버 0대·DB 0개·비용 0원)

```
GitHub Actions (cron, 주 1회)
  → node bin/geo-probe.mjs run --config configs/<brand>.json
  → data/history.jsonl 에 append + results/<stamp>/raw 저장
  → git commit & push
  → Vercel 자동 리빌드
  → web/ (Next.js 정적) 이 history.jsonl 읽어 추세 렌더
```

Canton Hub는 상주 서버(FastAPI+APScheduler)가 필요했지만, GEO 측정은 주기가 길어(주/월) **크론+정적 사이트로 충분**하다. 운영 부담 0, 재원 님 self-driving 원칙 충족.

### 데이터 모델 (핵심 — 이게 제품의 뼈대)

`data/history.jsonl` — append-only, 한 줄 = (실행배치 × 모델 × 질문 × 반복) 1회:

```json
{
  "run_id": "2026-07-26-1430",
  "ts": "2026-07-26T14:30:00Z",
  "brand": "Burson",
  "model": "chatgpt",
  "question": "q1",
  "repeat": 1,
  "rank": 4,
  "mentioned": true,
  "entries": ["Edelman", "Weber Shandwick", "FleishmanHillard", "Burson", "BCW"],
  "citations": ["bursonglobal.com", "prweek.com"],
  "web_search": false
}
```

이 한 줄에서 파생되는 것: 언급률·중위순위(기존) + **SoV**(`entries` 집계) + **인용 도메인**(`citations`) + **추세**(`run_id`별). 원문은 기존대로 `results/<stamp>/raw/`에 남겨 투명성 유지.

### 지표 정의 (3에이전트 토론 확정, 2026-07-26)

> 재미나이·코덱스·나 3자 채점 결과. **단일 종합 "가시성 점수"는 채택하지 않는다** — 가중치에 검증된 근거가 없어, 정밀해 보이는 만큼 오해를 키우고 "한계를 숨기지 않는 측정"이라는 제품 정체성을 배반한다. 헤드라인이 필요하면 점수 대신 **상태 라벨**(`가시성: 중간 · 재현성: 낮음 · 방향: 상승`).

`V` = 유효 응답 수(파싱 성공), `N` = 예정 반복 수.

| 지표 | 계산식 | 표기 규칙 |
|---|---|---|
| 언급률 | `언급 응답 수 / V` | **항상 `3/5 · 60%` 병기** (표본 숨기지 않음) |
| Top 3 추천률 | `최초순위 1~3위 응답 수 / V` | 단순 언급보다 실질 임팩트 |
| 중위 순위 | `median(rank \| 언급된 응답만)` | **미언급은 제외**(6위 치환 금지). 0회면 `— 산출 불가` |
| SoV | `브랜드 등장 응답 수 / 전체 브랜드 등장 수 합` | 명칭 = **"추적 질문군 내 AI 응답 점유율"** (시장 점유율 ❌) |
| **재현성** | `max(언급수, 미언급수) / V` | 최대 차별점. 상태 라벨로 표기(`재현성 낮음`) |
| 순위 분포 | 순위별 응답 수 | n=5는 박스플롯 ❌ → **이산 막대** |
| **대체율** | `자사 미언급 & 경쟁사 c 등장 / 자사 미언급 수` | 합계 100% 초과 가능(복수 등장) |
| 공동 언급 | 자사 등장 응답에서 동시 등장한 타사 빈도 | PR 포지셔닝용 |
| **측정 완결성** | `V / (N×모델×질문)`, 파싱 성공률 | **KPI 급으로 노출** — 마케팅 이득 0인 지표를 띄우는 게 정직성의 증거 |
| 자사 도메인 인용률 | `자사 도메인 인용 응답 / 인용 제공 응답` | 인용 미제공 모델은 `0%` ❌ → **`측정 불가`** |
| 노출×출처 4분면 | 언급 유무 × 자사 인용 유무 | `미언급+자사인용` = 콘텐츠는 쓰이나 브랜드 연결 약함 |
| 4주 이동 언급률 | `최근 4주 언급 합 / 최근 4주 V 합` | 실선=이동평균, 흐린 점=주별 원값 |

### 신규 분석 함수

| 함수 | 입력 → 출력 |
|---|---|
| `parseEntries(text)` | 응답 → 번호목록 **전 항목 배열** (SoV·대체율의 원재료. 현재 `rankOf`는 내 브랜드만 보고 나머지 폐기) |
| `extractCitations(text)` | 응답 → 도메인 배열 (URL 정규식 → 호스트 정규화) |
| `normalizeBrand(name, dict)` | 별칭·약칭·자회사를 하나의 엔티티로 통합 |
| `metrics(rows)` | 위 표의 지표 일괄 산출 |
| `trend(rows)` | run_id별 시계열 + 4주 이동평균 |

**판정 정직성 규칙(제품 원칙):** `mentioned`는 명시 등장, `rank`는 번호목록에서만 유효. 목록이 아닌 산문 응답은 `rank: null, mentioned: true`로 기록하고 순위 통계에서 제외한다. 현재 `rankOf`는 이 경우 `0`을 반환해(`analyze.mjs:16`) 순위와 섞일 여지가 있다 → 명시 분리.

**표기 금지 목록(대시보드 전역):** 소수점 1자리 이상(42.3% ❌ → 42%) · "시장 점유율" · n=5 신뢰구간/유의성 · 미언급을 최하위로 친 평균 순위 · 검색조건 다른 모델의 절대 비교 · 인용을 "노출의 원인"으로 단정 · PR 활동과 순위 변화의 인과 주장.

**감성 분석 제외 근거(확정):** 현재 프롬프트가 "회사명만 번호 목록으로" 답하게 설계돼 감성 판단에 필요한 문맥이 없다. 지금 감성 점수를 만들면 전부 중립이거나 모델의 추측이 된다. 재려면 별도 프롬프트("각 회사 추천 이유와 주의점을 한 문장씩")로 **별도 트랙** 운영이 맞다.

### CLI 변경 (`bin/geo-probe.mjs`)

```bash
geo-probe run                          # 기존 (풀 측정 ≈8분)
geo-probe run --quick                  # 1모델·2질문·n=2·간격0 ≈30초 (데모/스모크용)
geo-probe run --config configs/x.json  # 멀티 브랜드
geo-probe trend                        # history.jsonl → 추세 요약 출력
```

멀티 브랜드: 단일 `geo.config.json` → `configs/<brand>.json` 다중. 기존 경로도 계속 지원(하위호환).

### 대시보드 (`web/`, Next.js + Tailwind, Vercel)

| 화면 | 내용 |
|---|---|
| 개요 | 현재 언급률·중위순위 카드 + **추세 차트**(run별) + 마지막 측정 시각 |
| 경쟁 | SoV 랭킹 표, 내 브랜드 위치 하이라이트 |
| 출처 | 인용 도메인 Top N + 자사/타사 구분 |
| 모델별 | 모델 간 편차 비교 |
| 원문 | 특정 실행 응답 열람 (측정 신뢰성 증명) |
| 방법론 | 측정 조건·한계 명시 고정 섹션 |

**방법론 페이지는 필수 기능이다.** 이 도구의 차별점은 화려함이 아니라 "한계를 스스로 밝히는 측정"이고, PR·명성 도메인에서 그게 곧 신뢰다.

## Acceptance Criteria

1. `geo-probe run --quick` 이 **60초 이내** 완료되고 `data/history.jsonl`에 행이 append된다.
2. 같은 브랜드로 2회 이상 실행하면 대시보드 추세 차트에 **2개 이상 시점**이 그려진다.
3. `shareOfVoice()`가 한 응답에서 등장한 **모든 회사**를 집계한다(내 브랜드 외 최소 1개 이상 추출 확인).
4. `extractCitations()`가 URL 포함 응답에서 도메인을 추출하고, URL 없는 응답에서 빈 배열을 반환한다(에러 아님).
5. 번호목록이 아닌 산문 응답이 `rank: null, mentioned: true`로 기록되고 중위순위 계산에서 제외된다.
6. `configs/` 아래 브랜드 2개를 각각 실행해도 서로 데이터가 섞이지 않는다.
7. GitHub Actions 크론이 수동 트리거(`workflow_dispatch`)로 성공하고 결과가 커밋된다.
8. 대시보드가 Vercel에 배포되어 공개 URL로 열리고, 방법론·한계 섹션이 보인다.
9. API 키가 없는 상태에서 CLI가 **명확한 에러 메시지**로 실패한다(현재 `providers.mjs:7` 동작 유지).
10. 기존 `results/2026-07-13-*` 데이터가 마이그레이션되어 추세의 첫 시점으로 표시된다.

## Testing Plan

| 레이어 | 대상 | 개수 |
|---|---|---|
| 단위 | `parseEntries`(번호목록/산문/빈응답), `extractCitations`(URL유무), `shareOfVoice`, `rankOf` 회귀 | +8 |
| 통합 | `run --quick`(mock provider) → history.jsonl append → `trend` 출력 | +2 |
| E2E | 대시보드 빌드 후 추세·SoV·출처 렌더 확인 | +1 |

`examples/command-adapter.config.json`의 mock provider를 테스트 픽스처로 재사용해 API 비용 없이 돌린다.

## Rollback Plan

- `data/history.jsonl`은 append-only → 손상 시 `results/*/raw`에서 전량 재생성 가능(재측정 불필요).
- 대시보드는 정적 배포 → Vercel 이전 배포로 즉시 롤백.
- v1 CLI 경로(`geo.config.json` 단일 설정) 유지 → v2 실패해도 기존 사용 흐름 안 깨짐.

## Effort Estimate (CC 기준)

| 컴포넌트 | 추정 |
|---|---|
| `analyze.mjs` 확장 (파싱·SoV·출처·추세) + 테스트 | ~40분 |
| CLI 퀵모드·멀티브랜드·history append | ~25분 |
| 기존 7/13 데이터 마이그레이션 | ~10분 |
| GitHub Actions 크론 | ~10분 |
| 대시보드 6화면 (Next.js+차트) | ~90분 |
| Vercel 배포·검증 | ~15분 |
| **합계** | **~3시간** |

## Files Reference

| 파일 | 변경 |
|---|---|
| `src/analyze.mjs` | 전면 확장 (신규 함수 4개 + rank 판정 분리) |
| `bin/geo-probe.mjs:30-53` | 퀵모드 플래그, spacing 우회 |
| `bin/geo-probe.mjs:90` | run 디렉터리 + `data/history.jsonl` append |
| `src/providers.mjs` | 변경 없음 |
| `configs/*.json` (신규) | 브랜드별 설정 |
| `data/history.jsonl` (신규) | 시계열 정본 |
| `web/` (신규) | Next.js 대시보드 |
| `.github/workflows/probe.yml` (신규) | 주 1회 크론 + 수동 트리거 |
| `scripts/migrate-v1.mjs` (신규) | 기존 results → history.jsonl |

## Out of Scope (의도적 제외)

- **웹에서 방문자가 즉석 실행** — 내 API 키 소진·오남용 위험. 남이 쓰려면 CLI를 자기 키로(D1 결정).
- 사용자 인증·계정·멀티테넌시 — 읽기전용 공개 대시보드라 불필요.
- 감성 분석(긍/부정) — 별도 스코프. 지금은 등장·순위·출처까지.
- Perplexity·Grok 등 추가 엔진 — provider 구조상 나중에 설정만 추가하면 됨(코드 변경 불필요).
- 상용 GEO 툴과의 벤치마크 비교.

## Related

- 측정 산출물: `examples/burson-2026-07/report.md`
- 라이브 렌더: jaewon-choi.vercel.app/6HTtPFFuCD
- 레퍼런스 아키텍처: `~/project/Ozzycanton/canton-hub` (수집 스케줄 → API → 대시보드)
