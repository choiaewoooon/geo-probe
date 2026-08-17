import { keys as KEYS, store as STORE, runMeasurement, testKey, defaultConfig } from "./engine.js"

// AI 가시성 모니터 — summary.json 만 읽는 정적 대시보드. 빌드 스텝·외부 의존성 없음.
// 표기 원칙(3에이전트 토론 확정): 소수점 금지 · k/N 병기 · 미언급은 순위 통계 제외 ·
// "시장 점유율" 금지 · 측정 불가는 0%가 아니라 '측정 불가' · 단일 종합 점수 안 만듦.

const $ = (s, r = document) => r.querySelector(s)
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t)
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false) continue
    if (k === "class") n.className = v
    else if (k === "html") n.innerHTML = v
    else n.setAttribute(k, v === true ? "" : v)
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : String(c))
  return n
}
const dash = (v, suffix = "") => (v === null || v === undefined ? "-" : `${v}${suffix}`)

const VIEWS = [
  ["summary", "요약"],
  ["compete", "경쟁 구도"],
  ["diagnose", "질문·모델 진단"],
  ["sources", "출처"],
  ["evidence", "원문 증거"],
  ["method", "방법론"],
  ["run", "측정 실행"],
  ["settings", "설정"],
]

let DATA = null
let BRAND = null

// ---------- 차트 (SVG 직접 생성, 라이브러리 없음) ----------
function sparkline(points, { w = 640, h = 140 } = {}) {
  if (!points.length) return el("p", { class: "empty" }, "표시할 측정 시점이 없습니다.")
  const pad = { l: 34, r: 12, t: 12, b: 34 }
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  const n = points.length
  const x = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v) => pad.t + ih - ((v ?? 0) / 100) * ih

  // 프로토콜(질문 세트)이 바뀌면 선을 잇지 않는다. 이으면 설계 변경이 성과 변화처럼 보인다.
  const segments = []
  let cur = []
  points.forEach((p, i) => {
    if (p.protocolStart && cur.length) { segments.push(cur); cur = [] }
    cur.push(i)
  })
  if (cur.length) segments.push(cur)

  const paths = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => `<path d="${seg.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(points[i].movingRate).toFixed(1)}`).join("")}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`)
    .join("")

  const breaks = points
    .map((p, i) => (p.protocolStart && i > 0
      ? `<line x1="${((x(i - 1) + x(i)) / 2).toFixed(1)}" x2="${((x(i - 1) + x(i)) / 2).toFixed(1)}" y1="${pad.t}" y2="${pad.t + ih}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="3 3"/>`
      : "")).join("")

  const svg = [
    `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="언급률 추세">`,
    [0, 50, 100].map((g) =>
      `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(g)}" y2="${y(g)}" stroke="var(--line)" stroke-width="1"/>` +
      `<text x="4" y="${y(g) + 4}" fill="var(--dim2)" font-size="10" font-family="monospace">${g}%</text>`).join(""),
    breaks,
    paths,
    points.map((p, i) =>
      `<circle cx="${x(i)}" cy="${y(p.rate)}" r="3" fill="var(--dim2)" opacity=".55"/>` +
      `<circle cx="${x(i)}" cy="${y(p.movingRate)}" r="4" fill="var(--accent)"/>` +
      `<title>${p.run_id} · 원값 ${p.mentions}/${p.V} (${p.rate}%) · ${p.movingLabel} · 질문 세트 ${p.protocol}</title>` +
      `<text x="${x(i)}" y="${h - 20}" fill="var(--dim2)" font-size="10" font-family="monospace" text-anchor="middle">${String(p.run_id).slice(0, 10)}</text>` +
      `<text x="${x(i)}" y="${h - 8}" fill="var(--dim2)" font-size="9" font-family="monospace" text-anchor="middle" opacity=".7">${p.protocol}</text>`).join(""),
    `</svg>`,
  ].join("")

  const protos = [...new Set(points.map((p) => p.protocol))]
  const notes = ["진한 점과 실선은 이동평균, 흐린 점은 회차별 값입니다. 표본이 작아 회차별 값의 변동이 큽니다."]
  if (protos.length > 1) {
    notes.push("점선은 <b>질문 세트가 바뀐 지점</b>입니다. 그 앞뒤는 서로 다른 질문으로 잰 값이라 선을 잇지 않았고, 직접 비교해서도 안 됩니다.")
  } else if (points.length < 2) {
    notes.push("현재 측정 시점이 1개입니다. 추세선은 다음 측정부터 그려집니다.")
  }
  return el("div", {}, el("div", { html: svg }), el("p", { class: "note", html: notes.join(" " ) }))
}

function distBars(dist) {
  const order = (k) => (k.endsWith("위") ? Number(k) : k === "언급(순위없음)" ? 90 : 99)
  const keys = Object.keys(dist).sort((a, b) => order(a) - order(b))
  const max = Math.max(...keys.map((k) => dist[k]), 1)
  return el("table", {}, el("tbody", {},
    keys.map((k) => el("tr", {},
      el("td", { style: "width:110px;color:var(--dim)" }, k),
      el("td", {}, el("span", {
        class: "bar",
        style: `width:${(dist[k] / max) * 100}%;background:${k === "미언급" ? "var(--bad)" : "var(--accent)"}`,
      })),
      el("td", { class: "n", style: "width:52px" }, dist[k]),
    ))))
}


// ---------- 정렬 가능한 표 ----------
// cols: [{ key, label, cls?, num?, sortable?, render?(row) }]
// 헤더를 누르면 그 열로 정렬하고, 다시 누르면 방향이 바뀐다.
let SORT = {}   // 표별 정렬 상태 (표 id -> {key, dir})

function sortableTable(id, cols, rows, { highlight, initial } = {}) {
  const st = SORT[id] ?? (SORT[id] = initial ?? { key: null, dir: "desc" })

  const sorted = [...rows]
  if (st.key) {
    const col = cols.find((c) => c.key === st.key)
    sorted.sort((a, b) => {
      const av = a[st.key], bv = b[st.key]
      // 값이 없는 행(측정 불가 등)은 방향과 무관하게 항상 뒤로 보낸다.
      const an = av === null || av === undefined, bn = bv === null || bv === undefined
      if (an && bn) return 0
      if (an) return 1
      if (bn) return -1
      const r = col?.num ? av - bv : String(av).localeCompare(String(bv), "ko")
      return st.dir === "asc" ? r : -r
    })
  }

  const head = el("tr", {}, cols.map((c) => {
    if (c.sortable === false) return el("th", { class: c.cls }, c.label)
    const on = st.key === c.key
    return el("th", {
      class: c.cls, "data-sort": c.key, tabindex: "0", role: "button",
      "aria-sort": on ? (st.dir === "asc" ? "ascending" : "descending") : "none",
      style: "cursor:pointer;user-select:none;white-space:nowrap",
      title: "눌러서 정렬",
    }, c.label, el("span", { class: "sort-ind" }, on ? (st.dir === "asc" ? " ▲" : " ▼") : ""))
  }))

  const body = el("tbody", {}, sorted.map((r) => el("tr", { class: highlight?.(r) ? "me" : null },
    cols.map((c) => el("td", { class: c.cls }, c.render ? c.render(r) : (r[c.key] ?? "-"))))))

  const table = el("table", {}, el("thead", {}, head), body)
  table.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]")
    if (!th) return
    const key = th.dataset.sort
    // 같은 열을 다시 누르면 방향만 바꾸고, 다른 열이면 그 열의 기본 방향으로 시작한다.
    const col = cols.find((c) => c.key === key)
    SORT[id] = st.key === key
      ? { key, dir: st.dir === "asc" ? "desc" : "asc" }
      // 순위처럼 낮을수록 좋은 열은 1위부터 보여주는 게 자연스럽다.
      : { key, dir: col?.bestLow ? "asc" : col?.num ? "desc" : "asc" }
    show(CURRENT)
  })
  table.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.target.closest("th[data-sort]")?.click() }
  })
  return el("div", { class: "scroll" }, table)
}

// ---------- 뷰 ----------
function intro(b) {
  const kr = "한국어 로컬 질문"
  return el("div", { class: "intro" },
    el("p", { class: "lead" },
      "생성형 AI에게 브랜드 이름을 감추고 질문했을 때, 그 브랜드가 답변에 등장하는지를 반복 측정한 기록입니다."),
    el("p", {},
      "AI는 같은 질문에도 매번 다르게 답합니다. 그래서 한 번 물어보고 캡처하는 것은 관찰이지 측정이 아닙니다. " +
      "여기서는 같은 질문을 여러 번 반복해 우연과 경향을 가르고, 응답에 함께 등장한 경쟁사까지 집계했습니다."),
    el("p", {},
      "측정 도구는 직접 만들었고 코드와 응답 원문을 모두 공개합니다. " +
      "숫자가 어떻게 나왔는지 직접 확인할 수 있습니다."),
    el("p", { class: "byline" },
      "최재원 · 측정 도구 ", el("a", { href: "https://github.com/choiaewoooon/geo-probe", target: "_blank", rel: "noopener" }, "geo-probe"),
      " · 자세한 계산 규칙과 한계는 ", el("a", { href: "#", "data-go": "method" }, "방법론"), " 참조"),
  )
}

function viewSummary(b) {
  const v = b.visibility
  const c = b.completeness
  const mySov = b.shareOfVoice.find((s) => s.name === b.brand)
  const st = b.status
  const cls = { 높음: "good", 중간: "warn", 낮음: "bad", 상승: "good", 하락: "bad" }

  return el("div", {},
    intro(b),
    sourceSwitch(),
    el("div", { class: "pills" },
      el("span", { class: `pill ${cls[st.visibility] ?? ""}` }, "가시성 ", el("b", {}, st.visibility)),
      el("span", { class: `pill ${st.reproducibility === "높음" ? "good" : "warn"}` }, "결과 일관성 ", el("b", {}, st.reproducibility)),
      el("span", { class: `pill ${cls[st.direction] ?? ""}` }, "방향 ", el("b", {}, st.direction)),
    ),
    el("p", { class: "note" },
      "종합 점수를 만들지 않습니다. 언급률·순위·점유율을 임의 가중치로 합치면 억지로 정확해 보일 수 있어, " +
      "요약은 위 상태 라벨로만 보여줍니다."),

    el("h2", {}, "핵심 지표"),
    el("div", { class: "cards" },
      card("추천 언급률", dash(v.mentionRate, "%"), v.mentionLabel),
      card("Top 3 추천률", dash(v.top3Rate, "%"), v.top3Label),
      card("언급 시 중위 순위", v.medianRank === null ? "-" : `${v.medianRank}위`,
        v.rankedN ? `${v.rankedN}건 기준 · 미언급 제외` : "산출 불가"),
      card("응답 점유율", dash(mySov?.sov, "%"), "추적 질문군 내"),
      card("결과 일관성", dash(v.reproducibility, "%"), "같은 결과가 반복된 정도"),
      card("측정 완결성", dash(c.validRate, "%"), c.validLabel, c.warn),
    ),

    el("h2", {}, "언급률 추세", el("small", {}, "회차별 값과 이동평균")),
    sparkline(b.trend),

    el("h2", {}, "순위 분포", el("small", {}, "중위값 뒤에 가려지는 변동까지")),
    distBars(v.rankDistribution),

    el("h2", {}, "우선 점검할 질문", el("small", {}, "언급률이 낮고 대체 경쟁사가 반복되는 순")),
    b.priorities.slice(0, 3).map((p, i) => el("div", { class: "prio" },
      el("div", { class: "rank" }, i + 1),
      el("div", { class: "body" },
        el("div", { class: "q" }, questionLabel(p.question)),
        el("div", { class: "why" },
          `언급 ${p.mentionLabel}`,
          p.medianRank !== null ? ` · 중위 ${p.medianRank}위` : "",
          p.topSubstitute ? ` · 이 질문에서 자리를 대신 차지한 1위: ${p.topSubstitute.name} (${p.topSubstitute.rate}%)` : ""),
      ),
    )),
  )
}

function viewCompete(b) {
  const max = Math.max(...b.shareOfVoice.map((s) => s.appearances), 1)
  const isMe = (r) => r.name === b.brand
  const bar = (r) => el("span", {
    class: "bar",
    style: `width:${(r.appearances / max) * 100}%;background:${isMe(r) ? "var(--accent)" : "var(--dim2)"}`,
  })

  return el("div", {},
    el("h2", {}, "추적 질문군 내 응답 점유율", el("small", {}, "실제 시장 점유율이 아닙니다")),
    sortableTable("sov", [
      { key: "name", label: "브랜드" },
      { key: "appearances", label: "등장", cls: "n", num: true },
      { key: "_bar", label: "", cls: "", sortable: false, render: bar },
      { key: "sov", label: "점유율", cls: "n", num: true, render: (r) => dash(r.sov, "%") },
      { key: "mentionRate", label: "언급률", cls: "n", num: true, render: (r) => dash(r.mentionRate, "%") },
      { key: "medianRank", label: "중위 순위", cls: "n", num: true, bestLow: true,
        render: (r) => (r.medianRank === null ? "-" : `${r.medianRank}위`) },
    ], b.shareOfVoice.slice(0, 20), { highlight: isMe, initial: { key: "appearances", dir: "desc" } }),
    el("p", { class: "note" }, "열 제목을 누르면 그 기준으로 정렬됩니다. 다시 누르면 오름차순과 내림차순이 바뀝니다."),

    el("h2", {}, "자사 미언급 시 등장한 브랜드",
      el("small", {}, `${b.substitution.missedN}건 기준 · 한 응답에 여러 곳이 나와 합계는 100%를 넘을 수 있음`)),
    b.substitution.brands.length
      ? sortableTable("sub", [
          { key: "name", label: "브랜드" },
          { key: "n", label: "건수", cls: "n", num: true },
          { key: "rate", label: "비율", cls: "n", num: true, render: (r) => `${r.rate}%` },
        ], b.substitution.brands.slice(0, 15), { initial: { key: "n", dir: "desc" } })
      : el("p", { class: "empty" }, "자사가 미언급된 응답이 없습니다."),

    el("h2", {}, "함께 언급된 브랜드", el("small", {}, "어떤 회사와 함께 언급되는가")),
    b.coOccurrence.brands.length
      ? sortableTable("co", [
          { key: "name", label: "브랜드" },
          { key: "n", label: "동시 등장", cls: "n", num: true },
          { key: "rate", label: "비율", cls: "n", num: true, render: (r) => `${r.rate}%` },
        ], b.coOccurrence.brands.slice(0, 15), { initial: { key: "n", dir: "desc" } })
      : el("p", { class: "empty" }, "데이터 없음"),
  )
}

function viewDiagnose(b) {
  const models = [...new Set(b.matrix.map((c) => c.model))]
  const questions = [...new Set(b.matrix.map((c) => c.question))]
  const cellOf = (m, q) => b.matrix.find((c) => c.model === m && c.question === q)
  return el("div", {},
    el("h2", {}, "질문 × 모델", el("small", {}, "실제 값으로 우선순위를 찾는 화면")),
    el("div", { class: "scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "질문"), models.map((m) => el("th", {}, modelLabel(m))))),
      el("tbody", {}, questions.map((q) => el("tr", {},
        el("td", {}, questionLabel(q)),
        models.map((m) => {
          const c = cellOf(m, q)
          if (!c) return el("td", { class: "cell" }, "-")
          if (!c.mentions) return el("td", { class: "cell miss" }, el("span", { class: "r" }, "미언급"),
            el("span", { class: "f" }, ` 0/${c.V}`))
          return el("td", { class: "cell" },
            el("span", { class: "r" }, c.medianRank === null ? "언급" : `${c.medianRank}위`),
            el("span", { class: "f" }, ` ${c.mentions}/${c.V}`))
        }),
      )))),
    ),
    el("p", { class: "note" },
      "각 셀은 언급 횟수와, 언급된 응답의 최초 순위 중위값입니다. 모델마다 웹 검색 조건이 달라 " +
      "모델 간 절대 우열로 비교하지 않습니다."),
  )
}

function viewSources(b) {
  const c = b.citations
  if (!c.measurable) {
    return el("div", {},
      el("h2", {}, "인용 출처"),
      el("p", {
        class: "note",
        html: "이번 측정에서는 어떤 모델도 응답에 출처 URL을 달지 않았습니다. " +
          "그래서 자사 도메인 인용률을 0%가 아니라 <b>측정 불가</b>로 표기합니다. " +
          "출처를 안 준 것과 자사가 인용되지 않은 것은 서로 다른 사실이기 때문입니다.",
      }),
      el("p", { class: "note" },
        "출처를 측정하려면 웹 검색과 인용이 켜진 모델 설정으로 재야 합니다. 자세한 내용은 방법론에 있습니다."))
  }
  const q = c.quadrant
  return el("div", {},
    el("h2", {}, "인용 도메인", el("small", {}, `출처가 제시된 응답 ${c.citedResponses}건 기준`)),
    el("div", { class: "cards" },
      card("자사 도메인 인용률", dash(c.ownCitationRate, "%"), "출처 제시 응답 중")),
    el("div", { style: "margin-top:12px" },
      sortableTable("dom", [
        { key: "domain", label: "도메인", render: (d) => el("span", {}, d.domain, d.own ? el("span", { class: "tag" }, "자사") : null) },
        { key: "n", label: "등장", cls: "n", num: true },
        { key: "share", label: "비중", cls: "n", num: true, render: (d) => `${d.share}%` },
      ], c.domains.slice(0, 20), { highlight: (d) => d.own, initial: { key: "n", dir: "desc" } })),
    el("h2", {}, "브랜드 노출 × 자사 출처"),
    el("div", { class: "quad" },
      quad("자사 출처와 함께 언급", q.자사근거_동반노출),
      quad("외부 인식 중심 노출", q.외부인식_중심노출),
      quad("콘텐츠만 인용 (브랜드 연결 약함)", q.콘텐츠만_사용),
      quad("미노출", q.미노출)),
    el("p", { class: "note" },
      "여기서 인용은 응답에 표시된 출처를 뜻합니다. 그 출처가 노출의 직접적인 원인이라고 단정하지는 않습니다."),
  )
}

function viewEvidence(b) {
  return el("div", {},
    el("h2", {}, "원문 증거", el("small", {}, "수치와 원문을 함께 확인")),
    el("p", {
      class: "note",
      html: "수집한 응답 원문은 모두 저장소(<span class='cell'>results/&lt;회차&gt;/raw/</span>)에 보관합니다. 아래는 회차별 색인입니다.",
    }),
    b.trend.map((p) => el("details", {},
      el("summary", {},
        el("span", {}, p.run_id),
        el("span", { class: "cell f" }, `언급 ${p.mentions}/${p.V} · ${p.rate}% · 중위 ${p.medianRank === null ? "-" : p.medianRank + "위"}`)),
      el("pre", {},
        `회차       ${p.run_id}\n측정 시각  ${p.ts}\n유효 응답  ${p.V}건\n언급       ${p.mentions}건 (${p.rate}%)\n중위 순위  ${p.medianRank === null ? "산출 불가" : p.medianRank + "위"}\n이동평균   ${p.movingRate}% (${p.movingLabel})\n\n원문 경로  results/${p.run_id}/raw/<model>/<question>-run<n>.txt`),
    )),
  )
}

function viewMethod() {
  const m = DATA.methodology
  return el("div", {},
    el("h2", {}, "측정 설계"),
    el("div", { class: "cards" },
      card("반복 횟수", `n=${m.repeats}`, "질문·모델 조합당"),
      card("질문 수", m.questions.length, "브랜드명 없이 질문"),
      card("모델 수", m.models.length, "")),

    el("h2", {}, "질문"),
    el("div", { class: "scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "ID"), el("th", {}, "요약"), el("th", {}, "프롬프트"))),
      el("tbody", {}, m.questions.map((q) => el("tr", {},
        el("td", { class: "cell" }, q.id), el("td", {}, q.short ?? "-"), el("td", {}, q.prompt)))))),
    el("p", { class: "note" },
      "질문에 브랜드명을 넣지 않습니다. 브랜드를 직접 물으면 대부분의 모델이 정확히 설명하므로, " +
      "핵심은 브랜드명을 넣지 않은 질문에서도 그 브랜드가 언급되는가입니다." +
      (m.rankedListSuffix ? " 모든 질문 끝에 번호 목록으로 답해 달라고 덧붙여 순위를 뽑을 수 있게 합니다." : "")),

    el("h2", {}, "모델·조건"),
    el("div", { class: "scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "모델"), el("th", {}, "버전"),
        el("th", {}, "웹검색"), el("th", {}, "수집 방식"))),
      el("tbody", {}, m.models.map((x) => el("tr", {},
        el("td", {}, x.name), el("td", { class: "cell" }, x.model ?? "-"),
        el("td", { style: x.webSearch ? "color:var(--warn)" : "" }, x.webSearch ? "ON" : "OFF"),
        el("td", { style: "color:var(--dim);font-size:12px" }, x.collectedVia ?? "-")))))),
    (() => {
      const on = m.models.filter((x) => x.webSearch).length
      if (on === 0 || on === m.models.length) return null
      return el("p", { class: "note", html:
        "⚠️ <b>모델마다 웹 검색 조건이 다릅니다.</b> 웹 검색이 켜진 모델은 그 시점의 웹 문서를 근거로 답하고, " +
        "꺼진 모델은 학습된 지식만으로 답합니다. 서로 다른 것을 재고 있으므로 " +
        "<b>이 표의 모델 간 수치를 우열로 비교하지 않습니다.</b>" })
    })(),

    el("h2", {}, "계산 규칙"),
    el("div", { class: "note" }, el("ul", {},
      ["언급률은 유효 응답 중 브랜드가 언급된 비율입니다. 항상 k/N을 함께 표기합니다.",
        "중위 순위는 브랜드가 언급된 응답만으로 계산합니다. 미언급을 최하위 순위로 바꿔 넣지 않습니다.",
        "점유율은 추적 질문군 안에서의 응답 점유율입니다. 시장 점유율이 아닙니다.",
        "결과 일관성은 언급 또는 미언급 중 같은 결과가 반복된 비율입니다. 5회 모두 언급이거나 모두 미언급이면 100%입니다.",
        "빈 응답은 유효 응답에서 빼고, 측정 완결성에 따로 표시합니다.",
        "표본이 작으므로 퍼센트는 정수로만 표기합니다. 소수점은 실제보다 정밀한 것처럼 착각하게 합니다.",
      ].map((t) => el("li", {}, t)))),

    el("h2", {}, "한계"),
    el("div", { class: "note" }, el("ul", {}, DATA.methodology.notes.map((t) => el("li", {}, t)))),
  )
}

// ---------- 측정 실행 ----------
let OWN = null       // 이 브라우저에서 직접 측정한 결과
let SOURCE = "public"  // public | own

function viewRun() {
  const box = el("div", {})
  const st = KEYS.status()
  const ready = Object.values(st).filter(Boolean).length
  const cfg = STORE.loadConfig() ?? seedConfig()

  box.append(el("h2", {}, "직접 측정하기", el("small", {}, "브라우저에서 실행됩니다")))
  box.append(el("p", {
    class: "note",
    html: "브랜드 이름과 질문만 넣으면 이 브라우저가 AI에 직접 물어보고 결과를 집계합니다. " +
      "<b>키와 결과는 이 브라우저를 벗어나지 않습니다.</b>",
  }))

  if (!ready) {
    box.append(el("p", { class: "note", html: "<b>먼저 키가 필요합니다.</b> 설정 탭에서 가진 키를 넣어주세요." }))
    box.append(el("button", { type: "button", style: btnStyle("var(--accent)"), "data-go": "settings" }, "설정으로 가기"))
    return box
  }

  // --- 입력 ---
  const inp = (id, label, value, ph) => el("div", { style: "margin-bottom:12px" },
    el("div", { style: "color:var(--dim);font-size:12px;margin-bottom:6px" }, label),
    el("input", {
      id, value: value ?? "", placeholder: ph ?? "",
      style: "width:100%;background:var(--panel2);color:var(--tx);border:1px solid var(--line);" +
        "border-radius:8px;padding:9px 11px;font:inherit;font-size:13px",
    }))

  box.append(el("h2", {}, "무엇을 측정할까요"))
  box.append(inp("cfg-brand", "브랜드 이름", cfg.brand, "예: 우리회사"))
  box.append(inp("cfg-alias", "다르게 불리는 이름 (쉼표로 구분)", (cfg.brandAliases ?? []).join(", "),
    "예: 우리회사 코리아, Our Company"))
  box.append(el("div", { style: "color:var(--dim);font-size:12px;margin-bottom:6px" },
    "질문 (한 줄에 하나씩, 브랜드 이름은 넣지 마세요)"))
  box.append(el("textarea", {
    id: "cfg-q", rows: "5",
    style: "width:100%;background:var(--panel2);color:var(--tx);border:1px solid var(--line);" +
      "border-radius:8px;padding:10px 11px;font:inherit;font-size:13px;line-height:1.6;resize:vertical",
  }, cfg.questions.map((q) => q.prompt).filter(Boolean).join("\n")))
  box.append(el("p", { class: "note" },
    "브랜드 이름을 감춘 질문이라야 의미가 있습니다. 이름을 대고 물으면 대부분의 AI가 그냥 설명해 주기 때문입니다."))

  const sel = el("select", {
    id: "cfg-n",
    style: "background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font:inherit;font-size:13px",
  }, [2, 3, 5].map((n) => el("option", { value: n, selected: n === (cfg.repeats ?? 3) }, `${n}회 반복`)))
  const models = el("div", { style: "display:flex;gap:14px;flex-wrap:wrap;margin-top:10px" },
    cfg.models.map((m) => {
      const has = st[m.provider]
      return el("label", { style: `display:flex;gap:6px;align-items:center;font-size:13px;color:${has ? "var(--tx)" : "var(--dim2)"}` },
        el("input", { type: "checkbox", "data-model": m.id, checked: has, disabled: !has }),
        m.name, has ? null : el("span", { class: "tag" }, "키 없음"))
    }))
  box.append(el("div", { style: "margin:14px 0" }, sel, models))

  const est = el("p", { class: "note" })
  const runBtn = el("button", { type: "button", style: btnStyle("var(--accent)") }, "측정 시작")
  const stopBtn = el("button", { type: "button", style: btnStyle("transparent") + ";display:none" }, "중단")
  box.append(el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, runBtn, stopBtn))
  box.append(est)

  const bar = el("div", { style: "height:6px;background:var(--panel2);border-radius:4px;overflow:hidden;margin:12px 0 8px" },
    el("div", { id: "prog", style: "height:100%;width:0;background:var(--accent);transition:width .2s" }))
  const log = el("pre", {
    id: "runlog",
    style: "background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 15px;font-size:12px;" +
      "font-family:var(--mono);white-space:pre-wrap;color:var(--dim);max-height:300px;overflow:auto;margin:0",
  }, "측정을 시작하면 진행 상황이 여기에 표시됩니다.")
  box.append(bar, log)

  const collect = () => {
    const qs = ($("#cfg-q")?.value ?? "").split("\n").map((t) => t.trim()).filter(Boolean)
    const picked = [...box.querySelectorAll("input[data-model]:checked")].map((c) => c.dataset.model)
    return {
      ...cfg,
      brand: ($("#cfg-brand")?.value ?? "").trim(),
      brandAliases: ($("#cfg-alias")?.value ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      repeats: Number($("#cfg-n")?.value ?? 3),
      questions: qs.map((prompt, i) => ({ id: `q${i + 1}`, short: prompt.slice(0, 14), prompt })),
      models: cfg.models.filter((m) => picked.includes(m.id)),
    }
  }
  const refreshEst = () => {
    const c = collect()
    const total = c.models.length * c.questions.length * c.repeats
    est.textContent = total
      ? `총 ${total}회 호출합니다. AI 요금이 발생하고 몇 분 걸릴 수 있습니다.`
      : "브랜드 이름과 질문을 넣고 모델을 하나 이상 선택하세요."
  }
  box.addEventListener("input", refreshEst)
  box.addEventListener("change", refreshEst)
  setTimeout(refreshEst, 0)

  let ctrl = null
  runBtn.addEventListener("click", async () => {
    const c = collect()
    if (!c.brand) { log.textContent = "브랜드 이름을 넣어주세요.\n"; return }
    if (!c.questions.length) { log.textContent = "질문을 한 줄 이상 넣어주세요.\n"; return }
    if (!c.models.length) { log.textContent = "모델을 하나 이상 선택하세요.\n"; return }
    STORE.saveConfig(c)

    ctrl = new AbortController()
    runBtn.disabled = true
    stopBtn.style.display = ""
    log.textContent = ""
    const write = (t) => { log.textContent += t; log.scrollTop = log.scrollHeight }
    write(`${c.brand} · 모델 ${c.models.length} · 질문 ${c.questions.length} · ${c.repeats}회\n\n`)

    try {
      const rows = await runMeasurement({
        config: c,
        signal: ctrl.signal,
        onProgress: ({ done, total, model, question, repeat, ok, message }) => {
          $("#prog").style.width = `${(done / total) * 100}%`
          write(`${String(done).padStart(3)}/${total}  ${model} · ${question} #${repeat}  ${ok ? "완료" : "실패 " + message}\n`)
        },
      })
      if (!rows.length) { write("\n유효한 응답을 받지 못했습니다. 키와 오류 메시지를 확인해 주세요.\n"); return }
      STORE.save(rows)
      write(`\n측정을 마쳤습니다. 유효 응답 ${rows.length}건을 이 브라우저에 저장했습니다.\n`)
      write("요약 화면에서 '내 측정 결과'로 전환하면 볼 수 있습니다.\n")
      await loadOwnData()
    } catch (e) {
      write(`\n중단됐습니다: ${e.message}\n`)
    }
    runBtn.disabled = false
    stopBtn.style.display = "none"
  })
  stopBtn.addEventListener("click", () => ctrl?.abort())

  return box
}

/** 공개 측정에 쓴 질문을 시작값으로 준다. 처음 온 사람이 빈 화면을 보지 않게. */
function seedConfig() {
  const c = defaultConfig()
  const qs = DATA?.methodology?.questions ?? []
  if (qs.length) c.questions = qs.map((q) => ({ id: q.id, short: q.short, prompt: q.prompt }))
  return c
}

/** 내 측정 결과를 지표로 환산해 화면에 반영한다. */
async function loadOwnData() {
  const rows = STORE.load()
  if (!rows.length) { OWN = null; return }
  const { summarize } = await import("./lib/metrics.mjs")
  const brand = rows[0].brand
  OWN = { ...summarize(rows, { brand, expected: rows.length, ownDomains: [] }), brand, _rows: rows.length }
}

/** 공개 결과와 내 측정 결과 전환. 내 측정이 있을 때만 보인다. */
function sourceSwitch() {
  if (!OWN) return null
  const btn = (key, label, sub) => el("button", {
    type: "button", "data-src": key,
    style: `flex:1;min-width:180px;text-align:left;background:${SOURCE === key ? "var(--panel)" : "transparent"};` +
      `border:1px solid ${SOURCE === key ? "var(--accent)" : "var(--line)"};border-radius:12px;` +
      `padding:11px 14px;font:inherit;cursor:pointer;color:var(--tx)`,
  }, el("div", { style: "font-size:13px;font-weight:600" }, label),
     el("div", { style: "font-size:12px;color:var(--dim);margin-top:2px" }, sub))

  const wrap = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 4px" },
    btn("public", "공개 결과", `${DATA.brands[0].brand} · 기록된 측정`),
    btn("own", "내 측정 결과", `${OWN.brand} · 응답 ${OWN._rows}건`))
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-src]")
    if (!b) return
    SOURCE = b.dataset.src
    BRAND = SOURCE === "own" ? OWN : DATA.brands[0]
    $("#brandName").textContent = BRAND.brand
    show(CURRENT)
  })
  return wrap
}

// ---------- 설정 ----------
const KEY_SLOTS = [
  { slot: "openai", label: "OpenAI", env: "OPENAI_API_KEY", where: "platform.openai.com/api-keys" },
  { slot: "gemini", label: "Gemini", env: "GEMINI_API_KEY", where: "aistudio.google.com/apikey" },
  { slot: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY", where: "console.anthropic.com/settings/keys" },
]

function viewSettings() {
  const box = el("div", {})
  const st = KEYS.status()
  const ready = Object.values(st).filter(Boolean).length

  box.append(el("h2", {}, "AI 접속 키"))
  box.append(el("p", {
    class: "note",
    html: "<b>키는 이 브라우저에만 저장되고 어디로도 전송되지 않습니다.</b> " +
      "이 사이트에는 서버가 없어서, 측정은 브라우저가 AI 회사로 직접 요청을 보내는 방식으로 이뤄집니다. " +
      "키가 저희 쪽으로 갈 경로 자체가 없습니다. 브라우저 데이터를 지우면 키도 함께 사라집니다.",
  }))

  const rows = el("div", { style: "display:grid;gap:14px;margin:16px 0" })
  for (const k of KEY_SLOTS) {
    const on = st[k.slot]
    const msg = el("span", { style: "font-size:12px;color:var(--dim2);margin-left:10px" })
    const test = el("button", {
      type: "button", "data-test": k.slot,
      style: "background:transparent;color:var(--dim);border:1px solid var(--line);border-radius:8px;" +
        "padding:6px 12px;font:inherit;font-size:12px;cursor:pointer",
    }, "연결 확인")
    rows.append(el("div", { style: "background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px" },
      el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:9px" },
        el("div", {}, el("span", { style: "font-size:14px;font-weight:600" }, k.label)),
        el("span", { style: `font-size:12px;color:${on ? "var(--good)" : "var(--dim2)"}` }, on ? "● 저장됨" : "○ 없음")),
      el("input", {
        type: "password", id: `key-${k.slot}`, autocomplete: "off", spellcheck: "false",
        placeholder: on ? "저장되어 있습니다. 바꾸려면 새 키를 입력하세요" : "키를 붙여넣으세요",
        style: "width:100%;background:var(--panel2);color:var(--tx);border:1px solid var(--line);" +
          "border-radius:8px;padding:9px 11px;font:inherit;font-size:13px;font-family:var(--mono)",
      }),
      el("div", { style: "display:flex;align-items:center;margin-top:9px" }, test, msg),
      el("div", { style: "color:var(--dim2);font-size:11.5px;margin-top:7px" }, `발급: ${k.where}`),
    ))
  }
  box.append(rows)

  const saveBtn = el("button", { type: "button", style: btnStyle("var(--accent)") }, "저장하기")
  const clearBtn = el("button", { type: "button", style: btnStyle("transparent") }, "저장된 키 모두 지우기")
  const msg = el("span", { style: "margin-left:12px;font-size:12.5px;color:var(--dim)" })
  box.append(el("div", { style: "display:flex;align-items:center;flex-wrap:wrap;gap:8px" }, saveBtn, clearBtn, msg))

  saveBtn.addEventListener("click", () => {
    const patch = {}
    for (const k of KEY_SLOTS) {
      const v = $(`#key-${k.slot}`)?.value ?? ""
      if (v.trim()) patch[k.slot] = v.trim()
    }
    if (!Object.keys(patch).length) { msg.textContent = "입력된 키가 없습니다."; return }
    KEYS.save(patch)
    msg.textContent = "저장했습니다. 측정 실행 탭에서 바로 재보실 수 있습니다."
    setTimeout(() => show("settings"), 800)
  })
  clearBtn.addEventListener("click", () => {
    if (!confirm("이 브라우저에 저장된 키를 모두 지울까요?")) return
    KEYS.clear(); show("settings")
  })

  rows.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-test]")
    if (!b) return
    const slot = b.dataset.test
    const typed = $(`#key-${slot}`)?.value?.trim()
    const key = typed || KEYS.load()[slot]
    const out = b.nextSibling
    if (!key) { out.textContent = "키를 먼저 입력하세요."; return }
    b.disabled = true; out.textContent = "확인 중…"
    try {
      await testKey(slot, key)
      out.textContent = "연결됐습니다."
      out.style.color = "var(--good)"
    } catch (err) {
      out.textContent = err.message.slice(0, 90)
      out.style.color = "var(--bad)"
    }
    b.disabled = false
  })

  box.append(el("h2", {}, "내 측정 결과"))
  const mine = STORE.load()
  box.append(el("p", { class: "note" },
    mine.length
      ? `이 브라우저에 ${mine.length}건이 저장돼 있습니다. 요약 화면 위쪽에서 공개 결과와 전환할 수 있습니다.`
      : "아직 직접 측정한 결과가 없습니다. 키를 넣고 측정 실행 탭에서 돌려보세요."))
  if (mine.length) {
    const del = el("button", { type: "button", style: btnStyle("transparent") }, "내 측정 결과 지우기")
    del.addEventListener("click", () => {
      if (!confirm("이 브라우저에 저장된 측정 결과를 지울까요?")) return
      STORE.clear(); location.reload()
    })
    box.append(del)
  }
  return box
}

const btnStyle = (bg) => `background:${bg};color:${bg === "transparent" ? "var(--dim)" : "#08131f"};` +
  `border:1px solid ${bg === "transparent" ? "var(--line)" : bg};border-radius:9px;` +
  `padding:10px 16px;font:inherit;font-size:13px;font-weight:${bg === "transparent" ? 400 : 600};cursor:pointer`

// ---------- 화면 설명 ----------
// 각 화면이 무엇에 답하는지를 처음 보는 사람도 알 수 있게. 평소엔 접혀 있다.
const VIEW_HELP = {
  summary: {
    q: "지금 우리 브랜드는 AI 답변에서 어떤 상태인가요?",
    body: [
      ["추천 언급률", "브랜드명을 감춘 질문에 AI가 답할 때 우리 이름이 나온 응답의 비율입니다. 몇 번 중 몇 번 나왔는지를 늘 함께 적습니다."],
      ["Top 3 추천률", "나오긴 나오되 <b>앞쪽 3순위 안</b>에 들었는지 봅니다. 사람은 보통 앞의 몇 개만 읽기 때문에, 단순히 언급됐는지보다 실제 영향에 가깝습니다."],
      ["언급 시 중위 순위", "언급된 응답만 모아 순위의 가운데 값을 냅니다. 나오지 않은 응답을 꼴찌로 치지 않습니다. 그렇게 하면 '얼마나 자주 나오나'와 '나오면 몇 등인가'가 한 숫자에 섞이기 때문입니다."],
      ["응답 점유율", "이 질문들에 등장한 모든 회사 중 우리가 차지한 비중입니다. <b>시장 점유율이 아닙니다.</b>"],
      ["결과 일관성", "같은 질문을 반복했을 때 결과가 얼마나 일정한지 봅니다. 5번 모두 나오거나 5번 모두 나오지 않으면 100%, 3번만 나오면 60%입니다. 낮으면 아직 자리가 잡히지 않았다는 뜻입니다."],
      ["측정 완결성", "재려던 횟수 중 실제로 쓸 수 있는 응답을 받은 비율입니다. 빈 응답이 섞였는데 나머지로만 비율을 내면 숫자가 부풀려지기 때문에 따로 보여줍니다."],
      ["순위 분포", "가운데 값 하나로는 보이지 않는 흔들림입니다. 1위도 있고 미언급도 있는지 그대로 펼쳐 보여줍니다."],
      ["우선 점검할 질문", "언급률이 낮고 경쟁사가 반복해서 그 자리를 차지한 질문 순서입니다. <b>이 화면의 결론이자 할 일 목록</b>입니다."],
    ],
  },
  compete: {
    q: "우리가 나오지 않을 때, 그 자리는 누가 차지하나요?",
    body: [
      ["응답 점유율", "AI 답변에 등장한 회사를 전부 모아 비중을 냅니다. 우리 숫자만 보면 그게 좋은지 나쁜지 알기 어렵지만, 경쟁사와 나란히 놓으면 위치가 보입니다."],
      ["자사 미언급 시 등장한 브랜드", "우리가 빠진 응답에서 대신 나온 회사들입니다. 가시성이 낮다는 데서 끝나지 않고 <b>누구에게 밀리는지</b>까지 알려줍니다. 한 응답에 여러 곳이 나오므로 합계는 100%를 넘을 수 있습니다."],
      ["함께 언급된 브랜드", "우리가 나올 때 같이 나오는 회사입니다. AI가 우리를 어떤 무리로 묶어 인식하는지 보여주므로 포지셔닝을 점검할 때 씁니다."],
    ],
  },
  diagnose: {
    q: "어느 질문, 어느 AI에서 약한가요?",
    body: [
      ["보는 법", "가로는 AI 모델, 세로는 질문입니다. 각 칸은 <b>언급된 응답의 순위 가운데 값</b>과 <b>몇 번 중 몇 번 나왔는지</b>를 보여줍니다."],
      ["왜 쪼개서 보나요", "전체 평균만 보면 하나의 숫자로 뭉뚱그려집니다. 쪼개서 봐야 '이 질문에서만 전부 빈다' 같은 <b>구체적인 구멍</b>이 드러나고, 그게 곧 개선 순서가 됩니다."],
      ["주의할 점", "모델마다 웹 검색 조건이 다르면 서로 다른 것을 재는 셈이므로, 모델 간 우열로 비교하지 않습니다."],
    ],
  },
  sources: {
    q: "AI는 무엇을 근거로 우리 브랜드를 언급하나요?",
    body: [
      ["인용 도메인", "AI가 답변에 출처를 달았을 때 어떤 사이트를 근거로 삼았는지 보여줍니다. 우리 사이트가 근거가 되는지, 아니면 언론이나 제3자만 인용되는지 알 수 있습니다."],
      ["자사 도메인 인용률", "출처가 달린 응답 중 우리 도메인이 포함된 비율입니다. 출처를 아예 주지 않는 모델은 0%가 아니라 <b>측정 불가</b>로 적습니다. 출처를 주지 않은 것과 우리가 인용되지 않은 것은 다른 사실이기 때문입니다."],
      ["노출 × 자사 출처", "네 칸으로 나눈 상태입니다. 특히 <b>브랜드는 언급되지 않는데 우리 콘텐츠는 인용된 경우</b>는, 정보는 쓰이지만 브랜드로 연결되지 않는다는 신호입니다."],
      ["한계", "여기서 인용은 응답에 표시된 출처일 뿐입니다. 그 출처가 노출의 직접적인 원인이라고 단정하지 않습니다."],
    ],
  },
  evidence: {
    q: "이 숫자를 어떻게 믿을 수 있나요?",
    body: [
      ["하는 일", "수치에서 실제 AI 응답 원문으로 되돌아가는 통로입니다. 수집한 응답은 하나도 버리지 않고 전부 보관합니다."],
      ["왜 필요한가요", "순위를 뽑아내는 코드는 언젠가 어긋납니다. 실제로 이 화면 덕분에 브랜드 별칭이 빠져 언급을 놓치던 오류를 찾아 고쳤습니다. <b>원문이 없으면 틀린 것을 영영 찾지 못합니다.</b>"],
    ],
  },
  method: {
    q: "어떻게 쟀고, 무엇을 재지 못하나요?",
    body: [
      ["질문 설계", "브랜드명을 넣지 않고 묻습니다. 이름을 대고 물으면 대부분의 AI가 정확히 설명하기 때문에, 의미 있는 신호는 '이름 없이도 떠오르는가'입니다."],
      ["반복", "AI는 같은 질문에도 매번 다르게 답합니다. 그래서 한 번이 아니라 여러 번 물어 우연과 경향을 가릅니다."],
      ["표기 원칙", "퍼센트는 정수로만 쓰고, 비율에는 늘 '몇 번 중 몇 번'을 함께 적습니다. 표본이 작을 때 소수점은 실제보다 정밀한 것처럼 착각하게 합니다."],
      ["하지 않는 것", "여러 지표를 임의의 가중치로 합친 종합 점수를 만들지 않습니다. 근거 없는 정밀도가 생기기 때문입니다."],
    ],
  },
  run: {
    q: "직접 측정하려면 어떻게 하나요?",
    body: [
      ["어디서 도나요", "이 브라우저에서 돕니다. 키와 결과 모두 이 컴퓨터를 벗어나지 않습니다."],
      ["무엇을 넣나요", "브랜드 이름과, 브랜드명을 넣지 않은 질문 몇 개면 됩니다."],
      ["얼마나 걸리나요", "호출 수만큼 걸립니다. 모델 3개 × 질문 3개 × 3회면 27번 호출하니 몇 분 정도입니다."],
    ],
  },
  settings: {
    q: "키는 어디에 저장되나요?",
    body: [
      ["저장 위치", "이 브라우저에만 저장됩니다. 이 사이트에는 서버가 없어서 키가 전달될 경로 자체가 없습니다."],
      ["지우려면", "아래 '저장된 키 모두 지우기'를 누르거나, 브라우저 데이터를 지우면 함께 사라집니다."],
    ],
  },
}

function viewHelp(key) {
  const h = VIEW_HELP[key]
  if (!h) return null
  return el("details", { class: "help" },
    el("summary", {}, el("span", {}, h.q), el("span", { class: "cell f toggle" }, "")),
    el("div", { style: "padding:4px 16px 14px" },
      h.body.map(([k, v]) => el("p", { style: "margin:9px 0", html: `<b>${k}</b>: ${v}` }))),
  )
}

// ---------- 조각 ----------
const card = (k, v, n, flag) => el("div", { class: `card${flag ? " flag" : ""}` },
  el("div", { class: "k" }, k), el("div", { class: "v" }, v), n ? el("div", { class: "n" }, n) : null)
const quad = (k, v) => el("div", {}, el("div", { class: "qv" }, v), el("div", { class: "qk" }, k))

const questionLabel = (id) => {
  const q = DATA?.methodology?.questions?.find((x) => x.id === id)
  return q ? `${id.toUpperCase()} · ${q.short ?? q.prompt.slice(0, 24)}` : id
}
const modelLabel = (id) => DATA?.methodology?.models?.find((x) => x.id === id)?.name ?? id

const RENDER = { summary: viewSummary, compete: viewCompete, diagnose: viewDiagnose, sources: viewSources, evidence: viewEvidence, method: viewMethod, run: viewRun, settings: viewSettings }

let CURRENT = null
function show(key) {
  CURRENT = key
  const app = $("#app")
  app.innerHTML = ""
  const help = viewHelp(key)
  if (help) app.append(help)
  app.append(RENDER[key](BRAND))
  for (const btn of $("#nav").children) btn.setAttribute("aria-selected", String(btn.dataset.k === key))
  if (location.hash.slice(1) !== key) history.pushState(null, "", `#${key}`)
  window.scrollTo({ top: 0 })
}

async function boot() {
  try {
    const res = await fetch("./summary.json", { cache: "no-store" })
    if (!res.ok) throw new Error(`summary.json ${res.status}`)
    DATA = await res.json()
  } catch (e) {
    $("#app").innerHTML = `<p class="note">데이터를 불러오지 못했습니다 (${e.message}).<br>
      저장소에서 <span class="cell">node bin/geo-probe.mjs export</span> 를 실행하면 생성됩니다.</p>`
    return
  }
  await loadOwnData()
  BRAND = DATA.brands[0]
  if (!BRAND) { $("#app").innerHTML = `<p class="note">측정된 브랜드가 없습니다.</p>`; return }

  $("#brandName").textContent = BRAND.brand
  const last = BRAND.trend.at(-1)
  $("#stamp").textContent = `최근 측정 ${last?.run_id ?? "-"} · 생성 ${String(DATA.generatedAt).slice(0, 16).replace("T", " ")}`

  const nav = $("#nav")
  // 측정 실행·설정은 로컬 서버에서만 동작한다. 배포판에서도 탭은 보여주고
  // 화면 안에서 이유를 설명한다(숨기면 그런 기능이 있다는 것 자체가 안 보인다).
  for (const [k, label] of VIEWS) {
    nav.append(el("button", { "data-k": k, type: "button" }, label))
  }
  nav.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.k) })
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-go]")
    if (a) { e.preventDefault(); show(a.dataset.go) }
  })
  // 주소창 해시·브라우저 뒤로가기로도 화면이 바뀌게 한다(탭 클릭만 되던 문제).
  window.addEventListener("hashchange", () => {
    const k = location.hash.slice(1)
    if (RENDER[k] && k !== CURRENT) show(k)
  })
  const start = location.hash.slice(1)
  show(RENDER[start] ? start : "summary")
}
boot()
