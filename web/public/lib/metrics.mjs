// 지표 산출 — 3에이전트 토론(2026-07-26) 확정 정의.
//
// 🔒 성질이 다른 지표(언급률 · 재현성 · 인용 · 점유율)를 임의 가중치로 섞은 단일 종합
// "가시성 점수"는 여전히 만들지 않는다. 가중치에 검증된 근거가 없어 정밀해 보이는 만큼
// 오해를 키운다. 헤드라인이 필요하면 statusLabels()의 상태 라벨을 쓴다.
//
// 단 순위 하나만 쓰는 단일 축 점수는 예외다(2026-09-01 추가, RANK_CURVES 참조).
// 축이 하나뿐이라 "무엇을 섞었나"라는 질문 자체가 생기지 않고, 곡선을 바꿔도 결과가
// 어떻게 흔들리는지 화면에서 직접 확인할 수 있게 3종을 함께 굽는다.
//
// 행(row) 스키마 — data/history.jsonl 한 줄:
//   { run_id, ts, brand, model, question, repeat, mentioned, rank, listed, entries[], citations[], web_search }

import { entityKey } from "./parse.mjs"

export function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// 소수점 금지 규칙: 정수 퍼센트만. n=5에서 42.3%는 없는 정밀도를 만든다.
export const pct = (num, den) => (den ? Math.round((num / den) * 100) : null)

// k/N 병기 문자열. 표본 크기를 절대 숨기지 않는다.
export const frac = (num, den) => (den ? `${num}/${den} · ${pct(num, den)}%` : "-")

// ---------- 순위 가중 점수 ----------
//
// 왜 만들었나: 히트맵 농도가 언급률(나왔냐/안 나왔냐) 한 축이라, 15/15 로 항상 1위인
// 앱과 항상 4~5위인 앱의 칸이 같은 농도로 찍혔다. 실측(korea-apps, 2026-08-24 회차)에서
// 8개 질문 중 6개에 노출률 100% 인 앱이 2곳 이상 있었고 총 18곳이 같은 색이었다.
// q1 이 극단이다 — Naver Map(15/15 전부 1위) · KakaoMap(1위 0회) · Subway Korea(4~5위)가
// 전부 새까만 칸이었다. 카테고리에서 가장 중요한 사실이 화면에서 지워져 있었다.
//
// 🔒 여기에 재현성·인용을 곱하지 않는다. 그 순간 파일 상단이 금지한 그 종합 점수가 된다.
// 재현성은 색이 아니라 별도 표식으로 보여준다.
export const TOP_N = 5

// 순위 → 가중치. 1위를 10 으로 고정해 세 곡선의 눈금을 맞춘다.
export const RANK_CURVES = {
  // 기본값. 방어 비용이 가장 싸다 — "1위 10점, 2위 8점"은 한 문장으로 끝난다.
  linear: { id: "linear", label: "선형", formula: "10 · 8 · 6 · 4 · 2", weights: [10, 8, 6, 4, 2] },
  // 검색·추천에서 쓰는 역순위(MRR). 1위 우대가 가장 강하다.
  mrr: { id: "mrr", label: "역순위", formula: "10 ÷ 순위", weights: [1, 2, 3, 4, 5].map((r) => 10 / r) },
  // 검색 랭킹 평가의 표준 감쇠(DCG). 선형과 역순위의 중간.
  ndcg: { id: "ndcg", label: "로그", formula: "10 ÷ log₂(순위+1)", weights: [1, 2, 3, 4, 5].map((r) => 10 / Math.log2(r + 1)) },
}
export const CURVE_IDS = Object.keys(RANK_CURVES)
export const DEFAULT_CURVE = "linear"

// 언급은 됐는데 순위를 못 붙인 응답(목록 형식이 아니어서 파싱 실패). 0(미언급)과는
// 다른 사실이므로 0 으로 죽이지 않되, 최하위인 5위(선형 2점)보다는 낮게 둔다.
export const UNRANKED_WEIGHT = 1

export function rankWeight(rank, curveId = DEFAULT_CURVE) {
  const w = (RANK_CURVES[curveId] ?? RANK_CURVES[DEFAULT_CURVE]).weights
  if (rank === null || rank === undefined) return UNRANKED_WEIGHT
  if (!Number.isFinite(rank) || rank < 1) return 0
  // 수집이 TOP_N 까지라 6위 이하는 "없다"가 아니라 "측정 범위 밖"이다. 화면 각주로 밝힌다.
  return rank <= w.length ? w[rank - 1] : 0
}

/**
 * 0~100 정규화 점수. 100 = 유효 응답 전부에서 1위.
 * ranks 는 등장한 응답만 담는다(미언급은 항목 자체가 없다). 순위 미상은 null 로 넣는다.
 * V 는 그 칸의 유효 응답 수 — 미언급이 분모에 그대로 남아야 0점으로 눌린다.
 */
export function rankScore(ranks, V, curveId = DEFAULT_CURVE) {
  if (!V) return null
  const max = rankWeight(1, curveId)
  const got = ranks.reduce((s, r) => s + rankWeight(r, curveId), 0)
  return Math.round((got / (V * max)) * 100)
}

/** 곡선 3종을 미리 굽는다. 화면의 곡선 토글이 재계산 없이 필드만 바꾸도록. */
export function rankScores(ranks, V) {
  return Object.fromEntries(CURVE_IDS.map((c) => [c, rankScore(ranks, V, c)]))
}

/** 등장 n 건 중 순위가 붙은 게 ranks 뿐일 때, 나머지를 순위 미상으로 채운 배열. */
export function padUnranked(ranks, appearances) {
  const miss = Math.max(0, appearances - ranks.length)
  return [...ranks, ...Array(miss).fill(null)]
}

/** 유효 응답 = 파싱 대상이 된 응답(빈 응답 제외). rows는 이미 유효분만 담긴다. */
/**
 * 같은 모델 x 같은 질문을 n 회 반복했을 때 결과가 같게 나온 비율.
 * 셀 안에서 5/5 또는 0/5 면 그 셀은 100%, 3/5 면 60%. 전체는 응답 수 가중 평균.
 */
export function cellConsistency(rows) {
  if (!rows.length) return null
  const cells = new Map()
  for (const r of rows) {
    const k = `${r.model}|${r.question}`
    const c = cells.get(k) ?? { n: 0, m: 0 }
    c.n += 1
    if (r.mentioned) c.m += 1
    cells.set(k, c)
  }
  const agree = [...cells.values()].reduce((s, c) => s + Math.max(c.m, c.n - c.m), 0)
  return pct(agree, rows.length)
}

export function visibility(rows) {
  const V = rows.length
  const mentions = rows.filter((r) => r.mentioned).length
  const ranked = rows.filter((r) => r.rank !== null).map((r) => r.rank)
  const top3 = rows.filter((r) => r.rank !== null && r.rank <= 3).length
  return {
    V,
    mentions,
    mentionRate: pct(mentions, V),
    mentionLabel: frac(mentions, V),
    top3,
    top3Rate: pct(top3, V),
    top3Label: frac(top3, V),
    // 미언급을 최하위로 치환하지 않는다. 언급된 응답만으로 중위값.
    medianRank: median(ranked),
    rankedN: ranked.length,
    // 순위 가중 점수 — 히트맵 농도의 근거. 미언급은 분모에 남아 0 으로 눌린다.
    scores: rankScores(rows.filter((r) => r.mentioned).map((r) => r.rank ?? null), V),
    // 결과 일관성 = 같은 조건(모델 x 질문)을 반복했을 때 같은 결과가 나온 비율.
    //
    // 🔒 전체 응답을 한 덩어리로 max(언급, 미언급)/V 로 재면 일관성이 아니라
    // "언급률이 0% 나 100% 에서 얼마나 먼가"(희소성)를 잰다. 실측으로 라벨이 뒤집혔다 —
    // KakaoMap 은 24셀 전부 5/5 또는 0/5 로 완벽히 결정적인데 71%(낮음)였고,
    // 거의 등장하지 않는 Google Maps 가 99%(높음)였다. 반복은 셀 안에서만 의미가 있다.
    reproducibility: cellConsistency(rows),
    // 언급률이 양극단에서 얼마나 떨어져 있나. 옛 reproducibility 공식을 제 이름으로 남긴다.
    spread: V ? pct(Math.max(mentions, V - mentions), V) : null,
    rankDistribution: rankDistribution(rows),
  }
}

export function rankDistribution(rows) {
  const dist = {}
  for (const r of rows) {
    const key = r.rank === null ? (r.mentioned ? "언급(순위없음)" : "미언급") : `${r.rank}위`
    dist[key] = (dist[key] ?? 0) + 1
  }
  return dist
}

/** 추적 질문군 내 AI 응답 점유율. "시장 점유율"이 아니다 — 명칭 주의. */
export function shareOfVoice(rows) {
  const appear = new Map() // brand -> 등장 응답 수
  const ranks = new Map()
  let totalAppearances = 0
  for (const r of rows) {
    const uniq = [...new Set(r.entries ?? [])]
    for (const name of uniq) {
      appear.set(name, (appear.get(name) ?? 0) + 1)
      totalAppearances += 1
    }
    for (const e of r.entriesWithRank ?? []) {
      if (!ranks.has(e.name)) ranks.set(e.name, [])
      ranks.get(e.name).push(e.rank)
    }
  }
  return [...appear.entries()]
    .map(([name, n]) => ({
      name,
      appearances: n,
      sov: pct(n, totalAppearances),
      mentionRate: pct(n, rows.length),
      medianRank: median(ranks.get(name) ?? []),
    }))
    .sort((a, b) => b.appearances - a.appearances)
}

/** 자사가 미언급일 때 그 자리를 채운 브랜드. 합계 100% 초과 가능(한 응답에 복수 등장). */
export function substitution(rows, brand) {
  const missed = rows.filter((r) => !r.mentioned)
  const count = new Map()
  for (const r of missed) {
    for (const name of new Set(r.entries ?? [])) {
      if (name === brand) continue
      count.set(name, (count.get(name) ?? 0) + 1)
    }
  }
  return {
    missedN: missed.length,
    brands: [...count.entries()]
      .map(([name, n]) => ({ name, n, rate: pct(n, missed.length) }))
      .sort((a, b) => b.n - a.n),
  }
}

/** 자사가 등장한 응답에서 함께 등장한 브랜드 — 우리가 어떤 회사와 한 묶음으로 인식되는가. */
export function coOccurrence(rows, brand) {
  const withUs = rows.filter((r) => (r.entries ?? []).includes(brand))
  const count = new Map()
  for (const r of withUs) {
    for (const name of new Set(r.entries ?? [])) {
      if (name === brand) continue
      count.set(name, (count.get(name) ?? 0) + 1)
    }
  }
  return {
    baseN: withUs.length,
    brands: [...count.entries()]
      .map(([name, n]) => ({ name, n, rate: pct(n, withUs.length) }))
      .sort((a, b) => b.n - a.n),
  }
}

/** 측정 완결성 — 마케팅 이득이 0인 지표. 그래서 KPI 급으로 노출한다. */
export function completeness(rows, expected) {
  const V = rows.length
  const parsed = rows.filter((r) => r.listed).length
  return {
    expected,
    valid: V,
    validRate: pct(V, expected),
    validLabel: expected ? `예정 ${expected}회 중 ${V}회 유효` : "-",
    parseRate: pct(parsed, V),
    parseLabel: frac(parsed, V),
    warn: expected ? V / expected < 0.8 : false,
  }
}

/** 인용 지표. 인용을 제공하지 않는 모델은 0%가 아니라 '측정 불가'. */
export function citations(rows, ownDomains = []) {
  const withCit = rows.filter((r) => (r.citations ?? []).length > 0)
  const own = new Set(ownDomains.map((d) => d.toLowerCase().replace(/^www\./, "")))
  const isOwn = (d) => [...own].some((o) => d === o || d.endsWith(`.${o}`))

  const domainCount = new Map()
  for (const r of rows) {
    for (const d of new Set(r.citations ?? [])) domainCount.set(d, (domainCount.get(d) ?? 0) + 1)
  }
  const total = [...domainCount.values()].reduce((a, b) => a + b, 0)
  const ownCited = withCit.filter((r) => (r.citations ?? []).some(isOwn)).length

  // 노출 × 자사 출처 4분면
  const quadrant = { 자사근거_동반노출: 0, 외부인식_중심노출: 0, 콘텐츠만_사용: 0, 미노출: 0 }
  for (const r of withCit) {
    const o = (r.citations ?? []).some(isOwn)
    if (r.mentioned && o) quadrant.자사근거_동반노출 += 1
    else if (r.mentioned && !o) quadrant.외부인식_중심노출 += 1
    else if (!r.mentioned && o) quadrant.콘텐츠만_사용 += 1
    else quadrant.미노출 += 1
  }

  return {
    measurable: withCit.length > 0,
    citedResponses: withCit.length,
    ownCitationRate: withCit.length ? pct(ownCited, withCit.length) : null, // null = 측정 불가
    domains: [...domainCount.entries()]
      .map(([domain, n]) => ({ domain, n, share: pct(n, total), own: isOwn(domain) }))
      .sort((a, b) => b.n - a.n),
    quadrant,
  }
}

/** run_id별 시계열 + 4주 이동평균. n=5는 주간 20%p씩 튀므로 원값과 이동평균을 함께 본다. */
export function trend(rows, window = 4) {
  const byRun = new Map()
  for (const r of rows) {
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, [])
    byRun.get(r.run_id).push(r)
  }
  const points = [...byRun.entries()]
    .map(([run_id, rs]) => ({
      run_id,
      ts: rs[0].ts,
      protocol: rs[0].protocol ?? "v1",
      V: rs.length,
      mentions: rs.filter((x) => x.mentioned).length,
      rate: pct(rs.filter((x) => x.mentioned).length, rs.length),
      medianRank: median(rs.filter((x) => x.rank !== null).map((x) => x.rank)),
    }))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))

  // 질문 세트(프로토콜)가 바뀌면 이전 회차와 같은 것을 잰 게 아니다.
  // 이동평균을 프로토콜 경계 너머로 계산하면 설계 변경을 성과 변화처럼 보이게 만든다.
  return points.map((p, i) => {
    const sameProto = []
    for (let j = i; j >= 0 && points[j].protocol === p.protocol && sameProto.length < window; j -= 1) {
      sameProto.unshift(points[j])
    }
    const m = sameProto.reduce((a, x) => a + x.mentions, 0)
    const v = sameProto.reduce((a, x) => a + x.V, 0)
    return {
      ...p,
      protocolStart: i === 0 || points[i - 1].protocol !== p.protocol,
      movingRate: pct(m, v),
      movingLabel: `이 프로토콜에서 ${sameProto.length}회 ${m}/${v}`,
    }
  })
}

/** 종합 점수 대신 쓰는 상태 라벨. 근거 없는 숫자를 만들지 않으면서 헤드라인 역할을 한다. */
/**
 * 상태 라벨.
 *
 * 🔒 가시성은 브랜드가 실제로 뛰는 판에서만 판정한다.
 * 전체 응답 언급률로 재면 배달앱이 지도·번역·택시 질문에 안 나오는 것까지 분모에
 * 들어간다. 실측에서 배민은 배달 카테고리 100% 인데 전체 13% 라 "낮음"이 찍혔고,
 * 14개 브랜드 중 "높음" 이 하나도 없었다. 자기 판을 완전히 장악한 6개가 전부 "낮음"이었다.
 */
/** 브랜드가 실제로 등장한 질문들만 모은 언급률. 안 뛰는 판을 분모에서 뺀다. */
export function homeRate(rows) {
  const byQ = new Map()
  for (const r of rows) {
    if (!byQ.has(r.question)) byQ.set(r.question, [])
    byQ.get(r.question).push(r)
  }
  const home = [...byQ.values()].filter((rs) => rs.some((r) => r.mentioned)).flat()
  return home.length ? pct(home.filter((r) => r.mentioned).length, home.length) : null
}

export function statusLabels(vis, trendPoints = [], homeRate = null) {
  const rate = homeRate ?? vis.mentionRate ?? 0
  const visibility_ = rate >= 70 ? "높음" : rate >= 35 ? "중간" : "낮음"
  const repro = vis.reproducibility === null ? "-" : vis.reproducibility >= 80 ? "높음" : "낮음"
  // 방향은 같은 질문 세트끼리만 비교한다. 세트가 바뀐 구간을 이어 비교하면
  // 측정 설계 변경이 성과 하락처럼 보인다.
  let direction = "-"
  const last = trendPoints.at(-1)
  const prev = trendPoints.at(-2)
  if (last && prev && last.protocol === prev.protocol) {
    const d = (last.movingRate ?? 0) - (prev.movingRate ?? 0)
    direction = d > 5 ? "상승" : d < -5 ? "하락" : "보합"
  } else if (last && prev) {
    direction = "비교 불가"
  }
  return { visibility: visibility_, reproducibility: repro, direction }
}

/** 모델 × 질문 진단 매트릭스 — 어디를 먼저 손볼지 결정하는 화면의 데이터. */
export function matrix(rows) {
  const cells = {}
  for (const r of rows) {
    const k = `${r.model}|${r.question}`
    ;(cells[k] ??= []).push(r)
  }
  return Object.entries(cells).map(([k, rs]) => {
    const [model, question] = k.split("|")
    return { model, question, ...visibility(rs) }
  })
}

/** 먼저 손볼 질문 랭킹 — PR 실무의 진짜 납품물은 숫자가 아니라 할 일 목록이다. */
export function priorities(rows, brand) {
  const byQ = new Map()
  for (const r of rows) {
    if (!byQ.has(r.question)) byQ.set(r.question, [])
    byQ.get(r.question).push(r)
  }
  return [...byQ.entries()]
    // 🔒 그 브랜드가 한 번도 등장하지 않은 카테고리는 개선 대상이 아니라 남의 판이다.
    // 이 필터가 없어서 점수가 100 + 50 = 150 에서 포화됐고, 무관한 카테고리가 전부
    // 동점이 되어 설정의 질문 순서대로 정렬됐다. 그 결과 배달앱에게 "지도·택시·번역을
    // 먼저 손보라"고 말하고 있었다.
    .filter(([, rs]) => rs.some((r) => r.mentioned))
    .map(([question, rs]) => {
      const v = visibility(rs)
      const sub = substitution(rs, brand)
      return {
        question,
        mentionRate: v.mentionRate,
        mentionLabel: v.mentionLabel,
        medianRank: v.medianRank,
        topSubstitute: sub.brands[0] ?? null,
        // 발판이 있는 판에서, 언급률이 낮고 같은 경쟁사가 반복해서 자리를 가져간 순서.
        score: (100 - (v.mentionRate ?? 0)) + (sub.brands[0]?.rate ?? 0) / 2,
      }
    })
    .sort((a, b) => b.score - a.score || a.question.localeCompare(b.question))
}

/** 대시보드가 읽는 단일 산출물. */
export function summarize(rows, { brand, expected, ownDomains = [] } = {}) {
  const vis = visibility(rows)
  const tr = trend(rows)
  return {
    brand,
    visibility: vis,
    // 브랜드가 한 번이라도 등장한 질문들만 모아 낸 언급률. 이게 그 브랜드의 판이다.
    status: statusLabels(vis, tr, homeRate(rows)),
    completeness: completeness(rows, expected),
    shareOfVoice: shareOfVoice(rows),
    substitution: substitution(rows, brand),
    coOccurrence: coOccurrence(rows, brand),
    citations: citations(rows, ownDomains),
    trend: tr,
    matrix: matrix(rows),
    priorities: priorities(rows, brand),
  }
}

/**
 * 카테고리(질문) 단위 마인드쉐어.
 *
 * 시선이 반대다. summarize() 는 "우리가 몇 등인가"를 보지만 여기서는
 * "이 카테고리는 지금 누가 먹고 있나"를 본다. 자사 개념이 없다.
 *
 * 응답 1건을 1표로 세야 하므로 브랜드별로 복제된 행을 그대로 쓰면 안 된다.
 * 호출부가 한 브랜드 몫(= 응답 전체와 1:1)만 넘긴다.
 */
/**
 * 회차별 카테고리 스냅샷 + 직전 회차 대비 1위 변동.
 *
 * 🔒 categories() 를 전체 이력에 한 번 돌리면 홈 숫자가 전 기간 누적 평균이 된다.
 * 최신 회차에서 1위가 바뀌어도 화면은 서서히 흐려질 뿐 변화가 드러나지 않는다.
 * 브랜드 화면에는 trend() 가 있는데 정작 메인인 카테고리에는 시간 축이 없었다.
 */
export function categoryTrend(rows, opts = {}) {
  const runs = [...new Set(rows.map((r) => r.run_id))].sort()
  if (runs.length < 2) return null
  const snap = (id) => categories(rows.filter((r) => r.run_id === id), opts)
  const latest = snap(runs.at(-1))
  const prev = snap(runs.at(-2))
  return {
    runs,
    latestRun: runs.at(-1),
    prevRun: runs.at(-2),
    // 카테고리별 1위가 직전 회차와 같은가. 바뀌었다면 그게 이 화면의 뉴스다.
    changes: latest.map((c) => {
      const p = prev.find((x) => x.id === c.id)
      return {
        id: c.id, short: c.short,
        now: c.leader?.name ?? null,
        was: p?.leader?.name ?? null,
        changed: Boolean(p && c.leader && p.leader && c.leader.name !== p.leader.name),
      }
    }),
  }
}

export function categories(rows, { questions = [], models = [] } = {}) {
  const qMeta = new Map(questions.map((q) => [q.id, q]))
  const qIds = questions.length
    ? questions.map((q) => q.id)
    : [...new Set(rows.map((r) => r.question))]
  const modelIds = models.length ? models.map((m) => m.id) : [...new Set(rows.map((r) => r.model))]

  return qIds.map((id) => {
    const rs = rows.filter((r) => r.question === id)
    const V = rs.length
    const agg = new Map() // name -> { n, firsts, ranks[], byModel: Map }

    let slots = 0
    for (const r of rs) {
      const seen = new Set()
      for (const e of r.entriesWithRank ?? []) {
        // 한 응답에 같은 이름이 두 번 나와도 한 번으로 센다(등장 '응답 수'가 기준).
        // slots 도 같은 규칙을 따라야 한다. dedup 앞에 두면 분모만 부풀어 sov 합계가 100% 에 못 미친다.
        if (seen.has(e.name)) continue
        seen.add(e.name)
        slots += 1
        // 별칭에 없는 이름은 원문 그대로 들어온다. 표기만 다른 같은 앱이 갈라지지 않게
        // 집계 키를 정규화하고, 보여줄 이름은 그 키에 모인 표기 중 최빈값을 쓴다.
        const ek = entityKey(e.name)
        const a = agg.get(ek) ?? { n: 0, firsts: 0, ranks: [], byModel: new Map(), labels: new Map() }
        a.labels.set(e.name, (a.labels.get(e.name) ?? 0) + 1)
        a.n += 1
        if (e.rank === 1) a.firsts += 1
        if (typeof e.rank === "number") a.ranks.push(e.rank)
        const bm = a.byModel.get(r.model) ?? { n: 0, firsts: 0 }
        bm.n += 1
        if (e.rank === 1) bm.firsts += 1
        a.byModel.set(r.model, bm)
        agg.set(ek, a)
      }
    }

    const perModelV = Object.fromEntries(
      modelIds.map((m) => [m, rs.filter((r) => r.model === m).length]),
    )

    const entities = [...agg.entries()]
      .map(([, a]) => ({
        name: [...a.labels.entries()].sort((x, y) => y[1] - x[1])[0][0],
        appearances: a.n,
        rate: pct(a.n, V),
        firsts: a.firsts,
        firstRate: pct(a.firsts, V),
        // 1순위 분산은 사실상 모델 간에만 있다(같은 셀 5회는 24개 중 18개가 만장일치).
        // 퍼센트 하나로 뭉개지 말고 모델별 득표를 그대로 들고 간다.
        firstsByModel: Object.fromEntries(modelIds.map((m) =>
          [m, (a.byModel.get(m) ?? { firsts: 0 }).firsts])),
        medianRank: median(a.ranks),
        // 곡선 3종을 모두 굽는다. 기본 곡선 값은 정렬·표에서 바로 쓰도록 score 로도 편다.
        scores: rankScores(padUnranked(a.ranks, a.n), V),
        score: rankScore(padUnranked(a.ranks, a.n), V),
        sov: pct(a.n, slots),
        byModel: Object.fromEntries(modelIds.map((m) => {
          const mv = perModelV[m] ?? 0
          const bm = a.byModel.get(m) ?? { n: 0, firsts: 0 }
          return [m, { n: bm.n, firsts: bm.firsts, V: mv, rate: pct(bm.n, mv) }]
        })),
      }))
      // 카테고리의 주인은 '자주 불리는 쪽'이 아니라 '맨 앞에 불리는 쪽'이다.
      // 실측: 결제 카테고리에서 KakaoPay 는 언급 73% 로 최다지만 1순위는 0% 였고,
      // 1순위 47% 인 WOWPASS 가 실제로 그 자리를 쥐고 있었다. 언급률로 줄세우면 이걸 놓친다.
      .sort((a, b) => (b.firstRate ?? 0) - (a.firstRate ?? 0)
        || b.appearances - a.appearances
        || (a.medianRank ?? 99) - (b.medianRank ?? 99))

    // 모델마다 1등이 갈리는지 — 갈리면 "합의된 1등"이 없다는 뜻이다.
    const leaderByModel = Object.fromEntries(modelIds.map((m) => {
      const ranked = entities
        .filter((e) => e.byModel[m].firsts > 0)
        .sort((a, b) => b.byModel[m].firsts - a.byModel[m].firsts)
      const topN = ranked[0]?.byModel[m].firsts ?? 0
      // 동점을 조용히 깨면 "모델 분열"이 "합의"로 둔갑한다. 전부 남긴다.
      const names = ranked.filter((e) => e.byModel[m].firsts === topN).map((e) => e.name)
      return [m, { names, firsts: topN, tied: names.length > 1 }]
    }))
    const votes = Object.values(leaderByModel)
    const decided = votes.filter((v) => v.names.length === 1).map((v) => v.names[0])
    // 산출 실패나 동점이 하나라도 있으면 합의라고 말하지 않는다.
    const agreed = decided.length === votes.length ? [...new Set(decided)] : []

    return {
      id,
      short: qMeta.get(id)?.short ?? id,
      prompt: qMeta.get(id)?.prompt ?? null,
      V,
      listed: rs.filter((r) => r.listed).length,
      slots,
      contenders: entities.length,
      leader: entities[0] ?? null,
      leaderByModel,
      leaderAgreed: agreed.length === 1,
      // 상위 3곳이 얼마나 가져가는가. 높을수록 뚫고 들어갈 틈이 좁다.
      // entities 는 1순위 점유율 순이라 그대로 slice 하면 '등장이 많은 3곳'이 아니다.
      concentration: pct(
        [...entities].sort((a, b) => b.appearances - a.appearances)
          .slice(0, 3).reduce((s, e) => s + e.appearances, 0),
        entities.reduce((s, e) => s + e.appearances, 0)),
      entities,
    }
  })
}
