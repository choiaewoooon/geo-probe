---
name: geo-probe
description: Use when someone wants to measure how discoverable a brand is inside AI assistant answers (Generative Engine Optimization / GEO) — e.g. "how often does ChatGPT/Gemini/Claude recommend brand X for category questions", "measure our AI visibility", "GEO audit". Runs a repeated, brand-blind measurement and produces a mention-rate + median-rank matrix.
---

# geo-probe — GEO 발견성 측정

브랜드가 생성형 AI 답변에서 얼마나 발견되는지 **반복·브랜드 비노출**로 측정한다.

## 핵심 원칙 (반드시 지킬 것)
- **브랜드 비노출**: 질문에 브랜드명을 넣지 않는다. 카테고리·문제 중심 질문만 던진다.
- **반복 측정**: 같은 질문을 모델당 여러 번(기본 n=5) 던져 언급률과 중위 순위를 낸다. 단발 결과로 단정하지 않는다.
- **정직한 조건 기록**: 모델·웹검색 여부·조사일을 그대로 남긴다. 조건이 다르면 절대 비교로 말하지 않는다.
- **창작 금지**: 판정은 실제 응답 원문에서만. 순위가 뚜렷하지 않으면 언급/미언급만 기록한다.

## 절차
1. `geo.config.example.json` 을 `geo.config.json` 으로 복사하고 `brand`·`questions`·`models` 를 대상에 맞게 수정한다.
2. `.env.example` 을 `.env` 로 복사하고 사용할 모델의 API 키를 채운다. (또는 provider `command` 로 로컬 CLI 사용)
3. `npm run run` — 수집+분석을 한 번에. (또는 `npm run probe` 후 `npm run analyze -- <results/디렉터리>`)
4. 결과 `results/<시각>/report.md` 의 매트릭스를 읽고, **언급률이 낮거나 미언급인 질문 = 우선 최적화 지점**으로 해석한다.
5. 월 단위로 재실행해 `measurements.csv` 를 누적하면 추세를 추적할 수 있다.

## 해석 가이드
- 셀 = `중위순위 (언급횟수/반복수)`. 예: `4위 (5/5)` = 다섯 번 모두 4위. `미언급 (0/5)` = 한 번도 안 나옴.
- 1순위 언급이 드물고 특정 카테고리에서 미언급이면 → 인지가 아니라 **발견성·연결성**의 문제일 가능성.
- 결과를 시장 점유율이나 절대 순위로 확대 해석하지 말 것.
