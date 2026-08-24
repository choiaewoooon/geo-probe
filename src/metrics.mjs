// 지표 산출 — 3에이전트 토론(2026-07-26) 확정 정의.
// 단일 종합 "가시성 점수"는 의도적으로 만들지 않는다: 가중치에 검증된 근거가 없어
// 정밀해 보이는 만큼 오해를 키운다. 헤드라인이 필요하면 statusLabels()의 상태 라벨을 쓴다.
//
// 행(row) 스키마 — data/history.jsonl 한 줄:
//   { run_id, ts, brand, model, question, repeat, mentioned, rank, listed, entries[], citations[], web_search }

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

/** 유효 응답 = 파싱 대상이 된 응답(빈 응답 제외). rows는 이미 유효분만 담긴다. */
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
    // 결과 일관성 = 같은 결과가 반복된 비율. 5/5도 0/5도 100%(일정), 3/5는 60%(흔들림).
    reproducibility: V ? pct(Math.max(mentions, V - mentions), V) : null,
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
export function statusLabels(vis, trendPoints = []) {
  const rate = vis.mentionRate ?? 0
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
    .map(([question, rs]) => {
      const v = visibility(rs)
      const sub = substitution(rs, brand)
      return {
        question,
        mentionRate: v.mentionRate,
        mentionLabel: v.mentionLabel,
        medianRank: v.medianRank,
        topSubstitute: sub.brands[0] ?? null,
        // 낮은 언급률 + 반복적 대체 경쟁사 = 최우선
        score: (100 - (v.mentionRate ?? 0)) + (sub.brands[0]?.rate ?? 0) / 2,
      }
    })
    .sort((a, b) => b.score - a.score)
}

/** 대시보드가 읽는 단일 산출물. */
export function summarize(rows, { brand, expected, ownDomains = [] } = {}) {
  const vis = visibility(rows)
  const tr = trend(rows)
  return {
    brand,
    visibility: vis,
    status: statusLabels(vis, tr),
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
        slots += 1
        // 한 응답에 같은 이름이 두 번 나와도 한 번으로 센다(등장 '응답 수'가 기준).
        if (seen.has(e.name)) continue
        seen.add(e.name)
        const a = agg.get(e.name) ?? { n: 0, firsts: 0, ranks: [], byModel: new Map() }
        a.n += 1
        if (e.rank === 1) a.firsts += 1
        if (typeof e.rank === "number") a.ranks.push(e.rank)
        const bm = a.byModel.get(r.model) ?? { n: 0, firsts: 0 }
        bm.n += 1
        if (e.rank === 1) bm.firsts += 1
        a.byModel.set(r.model, bm)
        agg.set(e.name, a)
      }
    }

    const perModelV = Object.fromEntries(
      modelIds.map((m) => [m, rs.filter((r) => r.model === m).length]),
    )

    const entities = [...agg.entries()]
      .map(([name, a]) => ({
        name,
        appearances: a.n,
        rate: pct(a.n, V),
        firsts: a.firsts,
        firstRate: pct(a.firsts, V),
        medianRank: median(a.ranks),
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
      const best = entities
        .filter((e) => e.byModel[m].n > 0)
        .sort((a, b) => b.byModel[m].firsts - a.byModel[m].firsts
          || b.byModel[m].n - a.byModel[m].n
          || (a.medianRank ?? 99) - (b.medianRank ?? 99))[0]
      return [m, best?.name ?? null]
    }))
    const agreed = [...new Set(Object.values(leaderByModel).filter(Boolean))]

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
      concentration: pct(entities.slice(0, 3).reduce((s, e) => s + e.appearances, 0), slots),
      entities,
    }
  })
}
