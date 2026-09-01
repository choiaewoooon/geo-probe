# 기여 안내

의존성이 0개고 빌드 스텝이 없습니다. Node 18 이상이면 바로 돌아갑니다.

## 키 없이 시작하기

설정과 측정 데이터는 대부분 gitignore 대상이라, clone 직후에는 돌릴 설정이 없습니다.
가짜 모델로 파이프라인 전 구간을 확인할 수 있는 설정이 들어 있습니다.

```bash
git clone https://github.com/choiaewoooon/geo-probe.git
cd geo-probe

node bin/geo-probe.mjs run --config configs/demo-mock.json    # 측정 + 집계 (48회, 몇 초)
node bin/geo-probe.mjs export --config configs/demo-mock.json # 대시보드 데이터
npm run serve                                                  # http://localhost:4178
```

API 호출이 없으니 비용도 키도 필요 없습니다. 회차를 두 번 쌓으면 홈 화면의
"직전 회차 대비 1위 변동" 섹션까지 볼 수 있습니다.

## 테스트

```bash
node --test test/*.test.mjs
```

무엇을 덮고 있는지: 응답 파싱과 브랜드 정규화(`parse`), 지표 계산(`metrics`·`categories`),
트리맵 배치(`viz`), provider 어댑터, 추적 대상 확장(`trackTargets`).
대시보드 렌더는 아직 안 덮습니다.

## 알아둘 것

- **정본은 `web/public/lib/`** 입니다. `src/` 는 재수출만 합니다. 배포되는 파일이
  정본이어야 손복사본이 갈라지는 사고가 안 납니다.
- **이력 파일은 데이터셋마다 분리**합니다. 설정의 `historyFile`, `--history`,
  `GEO_HISTORY` 중 하나로 지정합니다. 하나에 몰아 쓰면 서로 다른 측정이 섞입니다.
- **대시보드가 읽는 데이터는 `results/` 가 아니라 이력 파일**입니다.
  `results/` 는 응답 원문 보관용이고, 집계는 이력에서 나옵니다.
- `--quick` 은 이력에 쌓지 않습니다(표본이 작아 추세를 왜곡). 그래서
  `run --quick` 다음에 `export` 를 하면 "이력이 비어 있다"가 뜹니다.

## 환경변수

| 이름 | 쓰임 |
|---|---|
| `OPENAI_API_KEY` · `GEMINI_API_KEY` · `ANTHROPIC_API_KEY` | provider 별 키 |
| `GEO_CONFIG` | 설정 파일 경로 (`--config` 와 동일) |
| `GEO_HISTORY` | 이력 파일 경로 (`--history` 와 동일) |
| `GEO_DEBUG=1` | 호출 실패 원인을 전부 출력 (첫 실패는 이것 없이도 나옵니다) |
| `PORT` | `npm run serve` 포트 (기본 4178) |

## 로컬 서버에 대해

`npm run serve` 는 개발용입니다. 인증이 없고, 같은 머신의 브라우저가 접근할 수
있다는 전제로 만들어졌습니다. cross-origin POST 는 막아 두었지만
공개 네트워크에 노출하지 마세요.

## 배포

**GitHub 에 push 해도 배포되지 않습니다.** Vercel 프로젝트(`ai-visibility-monitor`)는
저장소에 연결돼 있지 않고(`link: null`), 지금까지의 배포는 전부 CLI 업로드였습니다.
push 만 하고 라이브가 그대로라 헛기다린 적이 있어 적어 둡니다.

```bash
cd web/public && vercel --prod --yes
```

`web/public/` 이 배포 루트입니다(`.vercel/`·`.env.local` 은 gitignore 대상).
주소가 `ai-visibility-monitor-psi` 로 접미사가 붙은 이유는 `ai-visibility-monitor`
라는 이름을 다른 계정이 이미 쓰고 있기 때문입니다 — 그쪽은 남의 서비스입니다.

주간 측정 워크플로(`.github/workflows/probe.yml`)는 현재 동작하지 않습니다.
`provider: "command"` 설정이 로컬 CLI 래퍼(`cdx`·`gemq`)를 호출하는데 러너에는 없어
`spawn cdx ENOENT` 로 죽습니다. 대시보드는 2026-08-24 단일 회차 데이터로 고정돼 있습니다.
