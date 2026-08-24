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
// 브랜드명은 우리가 정한 값이 아니라 모델 응답에서 파싱된 임의 문자열이다.
// 웹검색이 켜진 모델은 오염된 페이지를 읽을 수 있으므로 innerHTML 에 넣기 전에 반드시 통과시킨다.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

const dash = (v, suffix = "") => (v === null || v === undefined ? "-" : `${v}${suffix}`)

// [키, 메뉴 라벨, 묶음, 화면 부제]
// 카테고리가 1급이다. 브랜드 화면은 카테고리에서 이름을 눌러 들어가는 드릴다운.
const BASE_VIEWS = [
  ["home", "카테고리 한눈에", "마인드쉐어", "카테고리마다 AI가 맨 앞에 부르는 이름을 모았습니다."],
  ["brands", "브랜드 찾기", "브랜드", "추적 중인 브랜드를 폭과 깊이로 나란히 놓고 봅니다."],
  ["method", "방법론", "측정 설계", "질문, 모델, 계산 규칙, 그리고 이 측정의 한계."],
  ["run", "측정 실행", "도구", "질문만 넣으면 이 브라우저가 직접 AI에 물어봅니다."],
  ["settings", "설정", "도구", "API 키와 이 브라우저에 저장된 측정 결과를 관리합니다."],
]

/**
 * 브랜드에 종속된 화면들. 사이드바에 펴놓지 않고 브랜드 헤더의 탭으로 묶는다.
 * 이 5개는 앱의 최상위 목적지가 아니라 "고른 브랜드"의 하위 뷰다.
 */
const BRAND_TABS = [
  ["summary", "요약"],
  ["compete", "경쟁 구도"],
  ["diagnose", "질문·모델 진단"],
  ["sources", "출처"],
  ["evidence", "원문 증거"],
]
const BRAND_KEYS = BRAND_TABS.map(([k]) => k)

/** 카테고리는 데이터에서 나온다. 질문 세트가 바뀌면 메뉴도 따라 바뀐다. */
function allViews() {
  const cats = (DATA?.categories ?? []).map((c) => [
    `cat:${c.id}`, c.short, "카테고리",
    `이 질문 하나에 ${c.contenders}개 이름이 등장했습니다. 1순위를 누가 차지했는지 봅니다.`,
  ])
  const [home, ...rest] = BASE_VIEWS
  return [home, ...cats, ...rest]
}

let VIEWS = []
let DATA = null
let ALL = []      // 측정된 브랜드 전부 (같은 응답을 브랜드마다 다시 채점한 결과)
let BRAND = null  // 지금 보고 있는 브랜드

// ---------- 차트 (SVG 직접 생성, 라이브러리 없음) ----------
function sparkline(points, { w = 640, h = 140 } = {}) {
  if (!points.length) return el("p", { class: "empty" }, "표시할 측정 시점이 없습니다.")
  const pad = { l: 40, r: 40, t: 16, b: 34 }
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

  const mono = `font-family="IBM Plex Mono, monospace"`
  const areas = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => {
      const line = seg.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(points[i].movingRate).toFixed(1)}`).join("")
      const base = `L${x(seg.at(-1)).toFixed(1)},${(pad.t + ih).toFixed(1)}L${x(seg[0]).toFixed(1)},${(pad.t + ih).toFixed(1)}Z`
      return `<path d="${line}${base}" fill="url(#gpFade)"/>`
    }).join("")

  const paths = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => `<path d="${seg.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(points[i].movingRate).toFixed(1)}`).join("")}" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`)
    .join("")

  const breaks = points
    .map((p, i) => (p.protocolStart && i > 0
      ? `<line x1="${((x(i - 1) + x(i)) / 2).toFixed(1)}" x2="${((x(i - 1) + x(i)) / 2).toFixed(1)}" y1="${pad.t - 4}" y2="${pad.t + ih}" stroke="var(--line-strong)" stroke-width="1" stroke-dasharray="2 3"/>` +
        `<text x="${((x(i - 1) + x(i)) / 2 + 4).toFixed(1)}" y="${pad.t + 2}" fill="var(--dim2)" font-size="8.5" ${mono} letter-spacing=".08em">질문 세트 교체</text>`
      : "")).join("")

  const svg = [
    `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="언급률 추세">`,
    `<defs><linearGradient id="gpFade" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="var(--ink)" stop-opacity=".16"/>` +
      `<stop offset="100%" stop-color="var(--ink)" stop-opacity="0"/></linearGradient></defs>`,
    [0, 50, 100].map((g) =>
      `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(g)}" y2="${y(g)}" stroke="var(--line)" stroke-width="1" ${g ? "" : 'stroke-opacity="1"'}/>` +
      `<text x="2" y="${y(g) + 3.5}" fill="var(--dim2)" font-size="9" ${mono} letter-spacing=".06em">${String(g).padStart(3)}%</text>`).join(""),
    areas,
    breaks,
    paths,
    points.map((p, i) =>
      `<circle cx="${x(i)}" cy="${y(p.rate)}" r="2.6" fill="none" stroke="var(--dim2)" stroke-width="1"/>` +
      `<circle cx="${x(i)}" cy="${y(p.movingRate)}" r="3.6" fill="var(--ink)"/>` +
      `<title>${p.run_id} · 원값 ${p.mentions}/${p.V} (${p.rate}%) · ${p.movingLabel} · 질문 세트 ${p.protocol}</title>` +
      `<text x="${x(i)}" y="${h - 18}" fill="var(--dim)" font-size="9.5" ${mono} text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${String(p.run_id).slice(0, 10)}</text>` +
      `<text x="${x(i)}" y="${h - 7}" fill="var(--dim2)" font-size="8.5" ${mono} text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${p.protocol}</text>`).join(""),
    `</svg>`,
  ].join("")

  // 범례로 끝낸다. 문단 설명은 화면 아래 도움말이 담당한다.
  const protos = [...new Set(points.map((p) => p.protocol))]
  const legend = el("div", { class: "ramp" },
    el("span", {}, "● 이동평균"),
    el("span", {}, "○ 회차별 값"),
    protos.length > 1 ? el("span", {}, "┆ 질문 세트 교체") : null,
    points.length < 2 ? el("span", {}, "측정 시점 1개 · 추세선은 다음 회차부터") : null)
  return el("div", {}, el("div", { class: "chart", html: svg }), legend)
}

// 순위 분포 — 하나의 가로 막대에 쌓는다. 표로 나열하면 "미언급이 얼마나 큰 덩어리인가"가
// 눈에 안 들어온다. 미언급은 옅은 농도가 아니라 해치로 칠해 0건과 저빈도를 구분한다.
function rankStack(dist) {
  // Number("1위")는 NaN이라 그냥 Number(k)로 정렬하면 순위가 전혀 정렬되지 않는다. 숫자만 뽑아 쓴다.
  const order = (k) => (k.endsWith("위") ? Number(k.replace(/[^\d.]/g, "")) : k === "언급(순위없음)" ? 90 : 99)
  const keys = Object.keys(dist).sort((a, b) => order(a) - order(b))
  const total = keys.reduce((s, k) => s + dist[k], 0) || 1
  const ranked = keys.filter((k) => k !== "미언급")

  const seg = (k, i) => {
    const pct = (dist[k] / total) * 100
    const miss = k === "미언급"
    // 앞 순위일수록 진하게. 순위 자체가 농도로 읽히게 한다.
    const a = miss ? 0 : 0.95 - (i / Math.max(ranked.length, 1)) * 0.68
    return el("span", {
      class: miss ? "miss" : null,
      style: `flex:${dist[k]} 1 0;background:${miss ? "" : `rgba(var(--ink-rgb),${a.toFixed(3)})`};` +
        `color:${miss ? "var(--dim2)" : onInk(a) ? "var(--on-ink)" : "var(--tx)"}`,
      title: `${k} · ${dist[k]}건 (${Math.round(pct)}%)`,
    }, pct >= 7 ? String(dist[k]) : "")
  }

  return el("div", {},
    el("div", { class: "stack" }, ranked.map(seg), dist["미언급"] ? seg("미언급", 0) : null),
    el("div", { class: "stack-key" },
      ranked.map((k, i) => el("span", {},
        el("i", { style: `background:rgba(var(--ink-rgb),${(0.95 - (i / Math.max(ranked.length, 1)) * 0.68).toFixed(3)})` }),
        `${k} ${dist[k]}`)),
      dist["미언급"] ? el("span", {}, el("i", { class: "miss" }), `미언급 ${dist["미언급"]}`) : null),
  )
}

// ---------- 밀도 매트릭스 ----------
// 값 = 잉크 농도. 0건은 옅은 회색이 아니라 해치. (0건과 저빈도는 다른 사실이다)
const inkA = (rate) => 0.1 + (Math.max(0, Math.min(100, rate)) / 100) * 0.85

/**
 * 잉크 농도 a 위에 올릴 글자색. 임계값이 테마마다 다르다.
 * 라이트는 잉크가 검정이라 a가 높을수록 어두워지고, 다크는 흰색이라 반대로 밝아진다.
 * 하나의 상수(0.58)를 양쪽에 쓰던 탓에 다크모드 농도 0.38~0.56 구간에서
 * 밝은 배경 위 밝은 글자가 나왔다(실측 최악 2.64:1).
 */
const isDark = () => {
  const t = document.documentElement.getAttribute("data-theme")
  if (t) return t === "dark"
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
}
const onInk = (a) => a > (isDark() ? 0.44 : 0.56)

function densityCell(c) {
  if (!c) return el("div", { class: "cellwrap miss" }, el("div", { class: "hatch" }),
    el("div", { class: "txt" }, el("span", { class: "r" }, "—")))
  if (!c.mentions) {
    return el("div", { class: "cellwrap miss", title: `미언급 0/${c.V}` },
      el("div", { class: "hatch" }),
      el("div", { class: "txt" },
        el("span", { class: "r" }, "미언급"),
        el("span", { class: "f" }, `0/${c.V}`)))
  }
  const a = inkA(c.mentionRate)
  return el("div", {
    class: `cellwrap ${onInk(a) ? "on-ink" : "on-bg"}`,
    title: `언급 ${c.mentionLabel} · Top3 ${c.top3Label} · 중위 ${c.medianRank === null ? "산출 불가" : c.medianRank + "위"} · 일관성 ${c.reproducibility}%`,
  },
    el("div", { class: "fill", style: `opacity:${a.toFixed(3)}` }),
    el("div", { class: "txt" },
      el("span", { class: "r" }, c.medianRank === null ? "언급" : `${c.medianRank}위`),
      el("span", { class: "f" }, `${c.mentions}/${c.V}`)))
}

function densityMatrix(b) {
  const models = [...new Set(b.matrix.map((c) => c.model))]
  const questions = [...new Set(b.matrix.map((c) => c.question))]
  const cellOf = (m, q) => b.matrix.find((c) => c.model === m && c.question === q)
  const agg = (cells) => {
    const V = cells.reduce((s, c) => s + (c?.V ?? 0), 0)
    const n = cells.reduce((s, c) => s + (c?.mentions ?? 0), 0)
    return { V, n, rate: V ? Math.round((n / V) * 100) : null }
  }

  const head = el("tr", {},
    el("th", { class: "rowhead" }, "질문"),
    models.map((m) => el("th", {}, modelLabel(m))),
    el("th", {}, "질문 합계"))

  const rows = questions.map((q) => {
    const a = agg(models.map((m) => cellOf(m, q)))
    return el("tr", {},
      el("td", { class: "rowhead" },
        el("span", { class: "qid" }, q.toUpperCase()),
        questionShort(q)),
      models.map((m) => el("td", {}, densityCell(cellOf(m, q)))),
      el("td", { class: "marg" }, el("div", { class: "margcell" },
        el("b", {}, a.rate === null ? "—" : `${a.rate}%`),
        el("i", {}, `${a.n}/${a.V}`))))
  })

  const foot = el("tr", {},
    el("td", { class: "rowhead" }, el("span", { class: "qid" }, "MODEL"), "모델 합계"),
    models.map((m) => {
      const a = agg(questions.map((q) => cellOf(m, q)))
      return el("td", { class: "marg" }, el("div", { class: "margcell" },
        el("b", {}, a.rate === null ? "—" : `${a.rate}%`),
        el("i", {}, `${a.n}/${a.V}`)))
    }),
    el("td", {}))

  return el("div", { class: "plate" },
    el("table", { class: "mx" },
      el("thead", {}, head),
      el("tbody", {}, rows, foot)),
    el("div", { class: "ramp" },
      el("span", {}, "언급률"),
      el("span", { class: "steps" },
        [0, 20, 40, 60, 80, 100].map((r) => el("i", { style: `opacity:${inkA(r).toFixed(3)}`, title: `${r}%` }))),
      el("span", {}, "0 → 100%"),
      el("span", {}, el("i", { class: "sw" }), "미언급 (0건)"),
      el("span", {}, "칸 안 숫자 = 언급 시 중위 순위 · 아래 = 언급/유효")),
  )
}

// ---------- 트리맵 ----------
// squarified treemap. 3ridge 마인드쉐어 분포와 같은 읽기법:
// 면적 = 등장량, 농도 = 점유율. 자사 타일만 이중 링으로 표시한다.
function squarify(items, x, y, w, h, out = []) {
  if (!items.length) return out
  if (items.length === 1) { out.push({ ...items[0], x, y, w, h }); return out }
  const total = items.reduce((s, i) => s + i.value, 0)
  const horiz = w >= h
  const side = horiz ? h : w
  const worst = (row, len) => {
    const s = row.reduce((a, i) => a + i.value, 0)
    if (!s) return Infinity
    const rw = (s / total) * (horiz ? w : h)
    return Math.max(...row.map((i) => {
      const l = (i.value / s) * side
      return Math.max(rw / l, l / rw)
    }))
  }
  const row = [items[0]]
  let i = 1
  while (i < items.length && worst([...row, items[i]], side) <= worst(row, side)) row.push(items[i++])
  const rest = items.slice(i)
  const rowSum = row.reduce((a, it) => a + it.value, 0)
  const frac = rowSum / total
  if (horiz) {
    const rw = w * frac
    let cy = y
    for (const it of row) { const ih = h * (it.value / rowSum); out.push({ ...it, x, y: cy, w: rw, h: ih }); cy += ih }
    return squarify(rest, x + rw, y, w - rw, h, out)
  }
  const rh = h * frac
  let cx = x
  for (const it of row) { const iw = w * (it.value / rowSum); out.push({ ...it, x: cx, y, w: iw, h: rh }); cx += iw }
  return squarify(rest, x, y + rh, w, h - rh, out)
}

function treemap(items, { me, label, density } = {}) {
  const clean = items.filter((i) => i.value > 0)
  if (!clean.length) return el("p", { class: "empty" }, "표시할 데이터가 없습니다.")
  const maxV = Math.max(...clean.map((i) => i.value))
  // 면적과 농도를 다른 변수로 쓸 수 있게 한다. density 를 안 주면 예전처럼 면적=농도.
  const maxD = density ? Math.max(...clean.map((i) => density(i) ?? 0), 1) : maxV
  const laid = squarify([...clean].sort((a, b) => b.value - a.value), 0, 0, 100, 100)

  return el("div", { class: "tree" }, laid.map((t) => {
    const a = 0.12 + ((density ? (density(t) ?? 0) : t.value) / maxD) * 0.83
    const mine = t.name === me
    const tiny = t.w < 11 || t.h < 18
    return el("div", {
      class: `tile ${onInk(a) || mine ? "on-ink" : "on-bg"}${mine ? " me" : ""}${tiny ? " tiny" : ""}`,
      style: `left:${t.x}%;top:${t.y}%;width:${t.w}%;height:${t.h}%`,
      title: t.title ?? t.name,
    }, el("div", {
      class: "box",
      style: `background:rgba(var(--ink-rgb),${(mine ? Math.max(a, 0.9) : a).toFixed(3)})`,
    },
      mine ? el("div", { class: "own" }, "선택") : null,
      el("div", { class: "nm" }, logo(t.name, "sm"), el("span", {}, t.name)),
      el("div", { class: "vl" }, label ? label(t) : t.value)))
  }))
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
      class: c.cls, "data-sort": c.key, tabindex: "0",
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
function viewSummary(b) {
  const v = b.visibility
  const c = b.completeness
  const mySov = b.shareOfVoice.find((s) => s.name === b.brand)
  const st = b.status
  const cls = { 높음: "good", 중간: "warn", 낮음: "bad", 상승: "good", 하락: "bad" }

  return el("div", {},
    sourceSwitch(),
    el("div", { class: "pills" },
      el("span", { class: `pill ${cls[st.visibility] ?? ""}` }, "가시성 ", el("b", {}, st.visibility)),
      el("span", { class: `pill ${st.reproducibility === "높음" ? "good" : "warn"}` }, "결과 일관성 ", el("b", {}, st.reproducibility)),
      el("span", { class: `pill ${cls[st.direction] ?? ""}` }, "방향 ", el("b", {}, st.direction)),
    ),

    el("h2", {}, "핵심 지표"),
    el("div", { class: "cards" },
      card("추천 언급률", dash(v.mentionRate, "%"), v.mentionLabel, false, v.mentionRate),
      card("Top 3 추천률", dash(v.top3Rate, "%"), v.top3Label, false, v.top3Rate),
      card("언급 시 중위 순위", v.medianRank === null ? "-" : `${v.medianRank}위`,
        v.rankedN ? `${v.rankedN}건 기준 · 미언급 제외` : "산출 불가"),
      card("응답 점유율", dash(mySov?.sov, "%"), "추적 질문군 내", false, mySov?.sov),
      card("결과 일관성", dash(v.reproducibility, "%"), "같은 결과가 반복된 정도", false, v.reproducibility),
      card("측정 완결성", dash(c.validRate, "%"), c.validLabel, c.warn, c.validRate),
    ),

    el("h2", {}, "밀도 매트릭스", el("small", {}, "칸이 짙을수록 자주 불립니다")),
    densityMatrix(b),

    // 회차가 하나뿐이면 그릴 추세가 없다. 빈 차트가 화면을 차지할 이유가 없다.
    b.trend.length > 1 ? el("h2", {}, "언급률 추세", el("small", {}, "회차별 값과 이동평균")) : null,
    b.trend.length > 1 ? sparkline(b.trend) : null,

    el("h2", {}, "순위 분포", el("small", {}, "중위값에 가려지는 변동까지")),
    rankStack(v.rankDistribution),

    el("h2", {}, "우선 점검할 질문", el("small", {}, "언급률이 낮고 대체 경쟁사가 반복되는 순")),
    b.priorities.slice(0, 3).map((p, i) => el("div", { class: "prio" },
      el("div", { class: "rank" }, String(i + 1).padStart(2, "0")),
      el("div", { class: "body" },
        el("div", { class: "q" }, questionLabel(p.question)),
        el("div", { class: "why", html:
          `언급 <b>${p.mentionLabel}</b>` +
          (p.medianRank !== null ? ` · 중위 ${p.medianRank}위` : "") +
          (p.topSubstitute ? ` · 이 자리를 대신 차지한 1위는 <b>${esc(p.topSubstitute.name)}</b>입니다 (${p.topSubstitute.rate}%)` : "") }),
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

  // 상위만 그린다. "그 외" 합계 타일을 넣으면 그게 최대 면적이 되어 1위 브랜드보다 진해지고,
  // 실제로 가장 큰 경쟁자가 누구인지가 그림에서 사라진다.
  const TOP = 14
  const top = b.shareOfVoice.slice(0, TOP)
  const allN = b.shareOfVoice.reduce((s, r) => s + r.appearances, 0)
  const shown = top.reduce((s, r) => s + r.appearances, 0)
  const meIn = top.some((r) => r.name === b.brand)
  const meRow = b.shareOfVoice.find((r) => r.name === b.brand)
  const tiles = (meIn || !meRow ? top : [...top.slice(0, TOP - 1), meRow]).map((r) => ({
    name: r.name, value: r.appearances, sov: r.sov, rate: r.mentionRate, rank: r.medianRank,
    title: `${r.name} · 등장 ${r.appearances}회 · 점유율 ${r.sov}% · 언급률 ${r.mentionRate}%` +
      (r.medianRank === null ? "" : ` · 중위 ${r.medianRank}위`),
  }))

  return el("div", {},
    el("h2", {}, "점유율 분포", el("small", {}, "면적 = 등장 횟수 · 농도 = 점유율")),
    treemap(tiles, { me: b.brand, label: (t) => `${t.sov}% · ${t.value}회` }),

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

    el("h2", {}, "선택한 브랜드가 빠졌을 때 등장한 브랜드",
      el("small", {}, `${b.substitution.missedN}건 기준 · 한 응답에 여러 곳이 나와 합계는 100%를 넘을 수 있음`)),
    b.substitution.brands.length
      ? sortableTable("sub", [
          { key: "name", label: "브랜드" },
          { key: "n", label: "건수", cls: "n", num: true },
          { key: "rate", label: "비율", cls: "n", num: true, render: (r) => `${r.rate}%` },
        ], b.substitution.brands.slice(0, 15), { initial: { key: "n", dir: "desc" } })
      : el("p", { class: "empty" }, "선택한 브랜드가 빠진 응답이 없습니다."),

    el("h2", {}, "함께 언급된 브랜드", el("small", {}, "AI가 한 묶음으로 인식하는 브랜드")),
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
  const rows = [...b.matrix].sort((x, y) => x.mentionRate - y.mentionRate)
  const weak = rows.filter((c) => c.mentionRate < 50)

  return el("div", {},
    el("h2", {}, "밀도 매트릭스", el("small", {}, "질문 × 모델")),
    densityMatrix(b),

    el("h2", {}, "약한 조합", el("small", {}, `언급률 50% 미만 ${weak.length}개`)),
    weak.length
      ? sortableTable("weak", [
          { key: "question", label: "질문", render: (c) => questionLabel(c.question) },
          { key: "model", label: "모델", render: (c) => modelLabel(c.model) },
          { key: "mentionRate", label: "언급률", cls: "n", num: true, render: (c) => `${c.mentionRate}%` },
          { key: "_bar", label: "", sortable: false, render: (c) => el("span", {
              class: "bar", style: `width:${Math.max(3, c.mentionRate)}%` }) },
          { key: "mentions", label: "언급/유효", cls: "n", num: true, render: (c) => `${c.mentions}/${c.V}` },
          { key: "medianRank", label: "중위 순위", cls: "n", num: true, bestLow: true,
            render: (c) => (c.medianRank === null ? "—" : `${c.medianRank}위`) },
        ], weak, { initial: { key: "mentionRate", dir: "asc" } })
      : el("p", { class: "empty" }, "모든 조합에서 절반 이상 언급됐습니다."),
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
          "출처가 없으니 자사 도메인 인용률은 <b>측정 불가</b>로 적습니다. " +
          "출처를 주지 않은 것과 자사가 인용되지 않은 것은 서로 다른 사실입니다.",
      }),)
  }
  const q = c.quadrant
  return el("div", {},
    el("h2", {}, "인용 도메인", el("small", {}, `출처가 제시된 응답 ${c.citedResponses}건 기준`)),
    c.citedResponses < 5
      ? el("p", { class: "note" },
          `${DATA.categories.reduce((s2, x) => s2 + x.V, 0)}건 중 ${c.citedResponses}건만 출처를 제시했습니다. ` +
          "표로 그리면 비중처럼 보이지만 통계로 쓸 수 있는 수가 아닙니다.")
      : null,
    el("div", { class: "cards" },
      card("이 브랜드 도메인 인용률", dash(c.ownCitationRate, "%"), "출처 제시 응답 중")),
    el("div", { style: "margin-top:12px" },
      sortableTable("dom", [
        { key: "domain", label: "도메인", render: (d) => el("span", {}, d.domain, d.own ? el("span", { class: "tag" }, "자사") : null) },
        { key: "n", label: "등장", cls: "n", num: true },
        { key: "share", label: "비중", cls: "n", num: true, render: (d) => `${d.share}%` },
      ], c.domains.slice(0, 20), { highlight: (d) => d.own, initial: { key: "n", dir: "desc" } })),
    c.citedResponses >= 5 ? el("h2", {}, "브랜드 노출 × 자체 도메인") : null,
    c.citedResponses >= 5 ? el("div", { class: "quad" },
      quad("자체 도메인과 함께 언급", q.자사근거_동반노출),
      quad("외부 인식 중심 노출", q.외부인식_중심노출),
      quad("콘텐츠만 인용, 브랜드 연결 약함", q.콘텐츠만_사용),
      quad("미노출", q.미노출)) : null,
  )
}

function viewEvidence(b) {
  return el("div", {},
    el("h2", {}, "원문 증거", el("small", {}, "수치와 원문을 함께 확인")),
    el("p", {
      class: "note",
      html: "수집한 응답 원문은 전부 저장소(<span class='cell'>results/&lt;회차&gt;/raw/</span>)에 보관합니다. 아래는 회차별 색인.",
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
      "질문에 브랜드명을 넣지 않습니다. 이름을 대고 물으면 대부분의 모델이 정확히 설명해 주기 때문에, " +
      "이름 없이 던진 질문에서 떠오르는지를 봅니다." +
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
        "⚠️ <b>모델마다 웹 검색 조건이 다릅니다.</b> 검색이 켜진 모델은 그 시점의 웹 문서를 근거로 답하고, " +
        "꺼진 모델은 학습된 지식만 씁니다. 서로 다른 것을 재는 셈이라 " +
        "<b>이 표의 모델 간 수치는 우열로 비교하지 않습니다.</b>" })
    })(),

    el("h2", {}, "계산 규칙"),
    el("div", { class: "note" }, el("ul", {},
      ["언급률은 유효 응답 중 브랜드가 언급된 비율. k/N을 늘 함께 적습니다.",
        "중위 순위는 브랜드가 언급된 응답만으로 계산합니다. 미언급을 최하위로 치환하지 않습니다.",
        "점유율은 추적 질문군 안에서의 응답 점유율. 시장 점유율과는 다릅니다.",
        "결과 일관성은 같은 결과가 반복된 비율. 5회 모두 언급이거나 모두 미언급이면 100%.",
        "빈 응답은 유효 응답에서 빼고, 측정 완결성에 따로 표시합니다.",
        "표본이 작아 퍼센트는 정수로만 적습니다. 소수점은 실제보다 정밀해 보이게 만듭니다.",
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
    html: "브랜드 이름과 질문만 넣으면 이 브라우저가 AI에 직접 물어보고 결과를 집계합니다.",
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
    "브랜드 이름을 감춘 질문이라야 의미가 있습니다. 이름을 대고 물으면 대부분의 AI가 그냥 설명해 줍니다."))

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
    ALL = SOURCE === "own" ? [OWN] : DATA.brands
    renderSubject()
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
    html: "<b>키는 이 브라우저에만 저장되고, 측정할 때 선택한 AI 회사로만 전송됩니다.</b> " +
      "이 사이트에는 서버가 없어 저희 쪽을 거치지 않습니다. " +
      "브라우저 데이터를 지우면 키도 함께 사라집니다.",
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

const btnStyle = (bg) => `background:${bg};color:${bg === "transparent" ? "var(--dim)" : "var(--on-ink)"};` +
  `border:1px solid ${bg === "transparent" ? "var(--line)" : "var(--ink)"};border-radius:9px;` +
  `padding:10px 17px;font:inherit;font-size:13px;letter-spacing:-.01em;` +
  `font-weight:${bg === "transparent" ? 500 : 650};cursor:pointer`

// ---------- 화면 설명 ----------
// 각 화면이 무엇에 답하는지를 처음 보는 사람도 알 수 있게. 평소엔 접혀 있다.
const VIEW_HELP = {
  home: {
    q: "이 화면은 무엇을 보여주나요?",
    body: [
      ["묻는 것", "<b>카테고리마다 AI가 누구를 맨 앞에 부르는지</b> 봅니다. 특정 브랜드를 기준으로 삼지 않습니다."],
      ["1등의 기준", "목록 <b>1순위</b>로 언급된 비율입니다. 첫 줄만 읽고 넘어가는 사용자가 많습니다."],
      ["모델 분열", "세 모델이 서로 다른 1위를 꼽았습니다. <b>1위가 아직 고정되지 않았다</b>는 신호입니다."],
      ["브랜드 이름을 감춘 질문", "질문에 앱 이름을 하나도 넣지 않았습니다. 이름을 대고 물으면 모델이 그대로 설명해 줍니다."],
    ],
  },
  category: {
    q: "이 카테고리는 어떻게 읽나요?",
    body: [
      ["1순위 점유율", "<b>목록 1순위</b>로 언급된 비율입니다. 카테고리 1위를 가리는 기준입니다."],
      ["언급률", "목록 <b>어디에든</b> 이름이 오른 비율입니다. 1순위와는 다른 값이라 둘을 같이 봐야 합니다."],
      ["마인드쉐어 분포", "면적은 등장 횟수, 농도는 1순위 횟수입니다. <b>크고 옅은 타일</b>은 자주 언급되지만 1순위는 아닌 브랜드입니다."],
      ["상위 3곳 집중도", "상위 3곳이 차지한 비중입니다. 높을수록 신규 진입이 어렵습니다."],
      ["모델별 1등", "1위가 갈리는지 자체가 신호입니다. 갈렸다면 아직 고정되지 않은 카테고리입니다."],
    ],
  },
  field: {
    q: "이 카테고리는 누가 나눠 갖고 있나요?",
    body: [
      ["한 번의 측정, 여러 브랜드", "질문에 브랜드 이름이 없으니 같은 응답을 브랜드만 바꿔 다시 채점할 수 있습니다. 여기 숫자는 전부 <b>같은 표본</b>에서 나왔습니다."],
      ["폭과 깊이를 왜 나누나요", "전체 언급률 하나로 줄세우면 한 주제만 담당하는 브랜드가 손해를 봅니다. <b>등장 질문 수</b>가 폭, <b>가장 센 질문의 언급률</b>이 깊이입니다."],
      ["밀도판 읽는 법", "가로로 빗금이 이어지면 한 질문에서만 등장하는 브랜드입니다. 노출 범위가 좁은 것과 노출 강도가 약한 것은 원인이 다릅니다."],
      ["줄을 누르면", "그 브랜드로 나머지 화면이 전환됩니다. 요약·경쟁 구도·진단이 선택한 브랜드 기준으로 다시 그려집니다."],
    ],
  },
  summary: {
    q: "선택한 브랜드는 AI 답변에서 어떤 상태인가요?",
    body: [
      ["추천 언급률", "브랜드명을 감춘 질문에서 그 브랜드가 언급된 비율입니다. 몇 번 중 몇 번인지 함께 표시합니다."],
      ["Top 3 추천률", "이름만 오른 게 아니라 <b>앞쪽 3순위 안</b>에 들었는지 봅니다. 실제 영향에 더 가까운 값입니다."],
      ["언급 시 중위 순위", "언급된 응답만 모아 순위의 가운데 값을 냅니다. 안 나온 응답을 꼴찌로 치면 '얼마나 자주'와 '나오면 몇 등'이 한 숫자에 섞입니다."],
      ["응답 점유율", "이 질문들에 등장한 모든 회사 중 선택한 브랜드의 몫입니다. <b>시장 점유율과는 다릅니다.</b>"],
      ["결과 일관성", "같은 질문을 반복했을 때 결과가 얼마나 일정한지 봅니다. 5번 모두 나오거나 모두 안 나오면 100%, 3번이면 60%입니다."],
      ["측정 완결성", "재려던 횟수 중 실제로 쓸 만한 응답이 온 비율입니다. 빈 응답을 빼고 계산하면 나머지 숫자가 부풀려집니다."],
      ["순위 분포", "가운데 값 하나로는 보이지 않는 흔들림입니다. 1위도 있고 미언급도 있는지 그대로 펼쳐 보여줍니다."],
      ["우선 점검할 질문", "언급률이 낮고 같은 경쟁사가 반복해서 1순위를 차지한 질문 순입니다. 개선 우선순위로 보시면 됩니다."],
    ],
  },
  compete: {
    q: "선택한 브랜드가 빠졌을 때 누가 등장하나요?",
    body: [
      ["응답 점유율", "AI 답변에 등장한 회사를 모두 집계해 비중을 냅니다. 숫자 하나만으로는 위치를 알기 어렵습니다."],
      ["선택한 브랜드가 빠졌을 때 등장한 브랜드", "선택한 브랜드가 빠진 응답에 등장한 회사들입니다. 한 응답에 여러 곳이 나올 수 있어 합계는 100%를 넘습니다."],
      ["함께 언급된 브랜드", "선택한 브랜드와 함께 언급된 회사입니다. AI가 비슷한 맥락으로 묶는 브랜드를 볼 수 있습니다."],
    ],
  },
  diagnose: {
    q: "어느 질문, 어느 AI에서 약한가요?",
    body: [
      ["보는 법", "가로는 AI 모델, 세로는 질문입니다. 각 칸은 <b>언급된 응답의 순위 가운데 값</b>과 <b>몇 번 중 몇 번 나왔는지</b>를 보여줍니다."],
      ["왜 쪼개서 보나요", "평균 하나로는 뭉뚱그려집니다. 쪼개야 '이 질문에서만 전부 빈다' 같은 <b>구멍</b>이 보입니다."],
      ["주의할 점", "모델마다 웹 검색 조건이 다릅니다. 어떤 조건으로 쟀는지는 표에 그대로 적어 뒀습니다."],
    ],
  },
  sources: {
    q: "AI는 그 브랜드를 언급할 때 무엇을 인용하나요?",
    body: [
      ["인용 도메인", "AI 답변에 표시된 출처 도메인을 보여줍니다. 선택한 브랜드의 도메인과 외부 도메인을 나눠 볼 수 있습니다."],
      ["자사 도메인 인용률", "출처가 표시된 응답 중 그 브랜드의 도메인이 포함된 비율입니다. 출처가 아예 없는 모델은 0%가 아니라 <b>측정 불가</b>로 표시합니다."],
      ["노출 × 자체 도메인", "브랜드 언급 여부와 자체 도메인 인용 여부를 조합한 네 칸입니다. <b>브랜드는 언급되지 않고 콘텐츠만 인용된 칸</b>은 정보가 브랜드로 연결되지 않는다는 신호입니다."],
      ["한계", "여기서 인용은 응답에 표시된 출처일 뿐, 노출의 원인은 아닙니다."],
    ],
  },
  evidence: {
    q: "이 숫자를 어떻게 믿을 수 있나요?",
    body: [
      ["하는 일", "수치에서 실제 AI 응답 원문으로 되돌아가는 통로입니다. 수집한 응답은 하나도 버리지 않고 전부 보관합니다."],
      ["왜 필요한가요", "집계 코드는 언젠가 어긋납니다. 원문이 남아 있어야 어디서 틀렸는지 되짚을 수 있습니다."],
    ],
  },
  method: {
    q: "어떻게 쟀고, 무엇을 재지 못하나요?",
    body: [
      ["질문 설계", "브랜드명을 넣지 않고 묻습니다. 이름을 대고 물으면 대부분의 AI가 정확히 설명하기 때문에, 의미 있는 신호는 '이름 없이도 떠오르는가'입니다."],
      ["반복", "AI는 같은 질문에도 매번 다르게 답합니다. 여러 번 물어야 우연과 경향이 갈립니다."],
      ["표기 원칙", "퍼센트는 정수로만 쓰고, 비율에는 늘 '몇 번 중 몇 번'을 함께 적습니다. 표본이 작을 때 소수점은 실제보다 정밀한 것처럼 착각하게 합니다."],
      ["하지 않는 것", "여러 지표를 임의 가중치로 합친 종합 점수를 만들지 않습니다. 근거 없는 정밀도가 생깁니다."],
    ],
  },
  run: {
    q: "직접 측정하려면 어떻게 하나요?",
    body: [
      ["어디서 도나요", "측정은 이 브라우저에서 실행됩니다. 결과는 이 컴퓨터에 남고, 키는 선택한 AI 회사로만 전송됩니다."],
      ["무엇을 넣나요", "브랜드 이름과, 브랜드명을 넣지 않은 질문 몇 개면 됩니다."],
      ["얼마나 걸리나요", "호출 수만큼 걸립니다. 모델 3개 × 질문 3개 × 3회면 27번 호출하니 몇 분 정도입니다."],
    ],
  },
  settings: {
    q: "키는 어디에 저장되나요?",
    body: [
      ["저장 위치", "이 브라우저에 저장되고, 측정할 때 선택한 AI 회사로만 전송됩니다. 이 사이트의 서버는 거치지 않습니다."],
      ["지우려면", "아래 '저장된 키 모두 지우기'를 누르거나, 브라우저 데이터를 지우면 함께 사라집니다."],
    ],
  },
}

function viewHelp(key) {
  // 카테고리 화면은 8개지만 읽는 법은 하나다.
  const h = VIEW_HELP[key.startsWith("cat:") ? "category" : key === "brands" ? "field" : key]
  if (!h) return null
  return el("details", { class: "help" },
    el("summary", {}, el("span", {}, h.q), el("span", { class: "cell f toggle" }, "")),
    el("div", { style: "padding:4px 16px 14px" },
      h.body.map(([k, v]) => el("p", { style: "margin:9px 0", html: `<b>${k}</b>: ${v}` }))),
  )
}

// ---------- 조각 ----------
const card = (k, v, n, flag, gauge) => el("div", { class: `card${flag ? " flag" : ""}` },
  el("div", { class: "k" }, k), el("div", { class: "v" }, v), n ? el("div", { class: "n" }, n) : null,
  typeof gauge === "number"
    ? el("div", { class: "gauge" }, el("i", { style: `width:${Math.max(1.5, Math.min(100, gauge))}%` }))
    : null)
const quad = (k, v) => el("div", {}, el("div", { class: "qv" }, v), el("div", { class: "qk" }, k))

const questionShort = (id) => {
  const q = DATA?.methodology?.questions?.find((x) => x.id === id)
  return q ? (q.short ?? q.prompt.slice(0, 26)) : id
}
const questionLabel = (id) => {
  const q = DATA?.methodology?.questions?.find((x) => x.id === id)
  return q ? `${id.toUpperCase()} · ${q.short ?? q.prompt.slice(0, 24)}` : id
}
const modelLabel = (id) => DATA?.methodology?.models?.find((x) => x.id === id)?.name ?? id

// ---------- 로고 ----------
// App Store 아이콘을 web/public/logos/ 에 캐시해 둔다(scripts/fetch-logos.mjs).
// 컬러 아이콘을 그대로 쓰면 2톤 원칙이 깨지므로 화면에서는 흑백으로 렌더한다.
// 없으면 이름 첫 글자 모노그램으로 떨어진다 — 로고 유무가 레이아웃을 흔들지 않게.
let LOGOS = {}

async function loadLogos() {
  try {
    const res = await fetch("./logos/index.json", { cache: "no-store" })
    if (res.ok) LOGOS = await res.json()
  } catch { /* 로고는 있으면 좋고 없어도 되는 자산이다 */ }
}

const monogram = (name) => {
  const m = String(name).match(/[A-Za-z0-9가-힣]/u)
  return m ? m[0].toUpperCase() : "?"
}

/** size: sm(20) · md(28) · lg(40) */
function logo(name, size = "md") {
  const hit = LOGOS[name]
  const box = el("span", { class: `lg lg-${size}`, title: name })
  if (hit?.file) {
    box.append(el("img", { src: `./${hit.file}`, alt: "", loading: "lazy", decoding: "async" }))
  } else {
    box.classList.add("mono")
    box.append(el("span", {}, monogram(name)))
  }
  return box
}

/** 로고 + 이름 한 덩어리. 표·카드·타일이 같은 조합을 쓰게 한다. */
const named = (name, size = "md", extra) =>
  el("span", { class: "nmrow" }, logo(name, size), el("span", { class: "t" }, name), extra ?? null)

// ---------- 카테고리 마인드쉐어 ----------
// 이 화면들에는 '자사'가 없다. 묻는 것은 하나다 — 이 카테고리는 지금 누가 먹고 있나.

const catOf = (id) => (DATA?.categories ?? []).find((c) => c.id === id)

/**
 * 카테고리 1위를 퍼센트가 아니라 모델 득표로 보여준다.
 *
 * 🔒 반복 5회는 독립 표본이 아니다. 같은 모델·같은 질문 5회에서 1위가 만장일치인 셀이
 * 24개 중 18개다. 즉 1순위의 분산은 모델 사이에만 있고 반복 사이에는 거의 없다.
 * 그래서 "1순위 47%"는 사실상 3개 모델의 투표를 퍼센트로 위장한 값이고,
 * 모델을 클러스터로 본 95% CI 는 경합 카테고리 5개 전부 [0%, 100%]다.
 * 없는 정밀도를 지우고 실제로 관측된 것(누가 몇 표를 받았나)만 남긴다.
 */
function modelVotes(e, c) {
  const models = DATA?.methodology?.models ?? []
  const won = models.filter((m) => (c.leaderByModel[m.id]?.names ?? []).includes(e.name)).length
  const label = won === models.length ? "만장일치" : won > models.length / 2 ? "다수" : "분열"
  return `모델 ${won}/${models.length} · ${label}`
}

/** 클릭으로 이동하는 표. 행이 마우스 전용이 되지 않게 키보드 경로를 같이 준다. */
function clickableRows(table, onPick) {
  for (const tr of table.querySelectorAll("tr[data-brand], tr[data-go]")) {
    tr.tabIndex = 0
    tr.setAttribute("role", "link")
    const label = tr.cells[0]?.textContent?.trim()
    if (label) tr.setAttribute("aria-label", `${label} 자세히 보기`)
  }
  const pick = (e) => {
    const tr = e.target.closest("tr[data-brand], tr[data-go]")
    if (!tr) return
    if (e.type === "keydown") {
      if (e.key !== "Enter" && e.key !== " ") return
      e.preventDefault()
    }
    onPick(tr)
  }
  table.addEventListener("click", pick)
  table.addEventListener("keydown", pick)
  return table
}

/** 모델별 1위 셀. 동점을 조용히 깨지 않으므로 이름이 여럿일 수 있다. */
function leaderCell(w) {
  const names = w?.names ?? []
  if (!names.length) return el("td", {}, "—")
  return el("td", {}, el("span", { class: "nmrow" },
    logo(names[0], "sm"),
    el("span", { class: "t" }, names.join(" · ")),
    w.tied ? el("span", { class: "tag" }, "동점") : null))
}

/** 카테고리 카드 한 장 = 그 판의 1등과 경쟁 밀도. */
function catCard(c) {
  const L = c.leader
  const top = c.entities.slice(0, 5)
  // 카드마다 정규화하면 8장을 나란히 놓은 의미가 없다. 척도는 전 카드 공통이어야 한다.
  const maxF = 100
  return el("button", { class: "ccard", type: "button", "data-go": `cat:${c.id}` },
    el("div", { class: "ct" },
      el("span", { class: "cid" }, c.id.toUpperCase()),
      el("span", { class: "cq" }, c.short),
      el("span", { class: "cgo" }, "→")),
    el("div", { class: "clead" },
      L ? logo(L.name, "lg") : null,
      el("span", { class: "lw" },
        el("span", { class: "nm" }, L?.name ?? "—"),
        el("span", { class: "pc" }, L ? modelVotes(L, c) : ""))),
    el("div", { class: "cfaces" }, c.entities.slice(1, 6).map((e) => logo(e.name, "sm"))),
    el("div", { class: "cbars" }, top.map((e) => el("span", {
      class: "cb", title: `${e.name} · 1순위 ${e.firstRate}% · 언급 ${e.rate}%`,
    },
      el("i", { style: `height:${Math.max(6, ((e.firstRate ?? 0) / maxF) * 100)}%;` +
        `opacity:${inkA(e.firstRate ?? 0).toFixed(3)}` })))),
    el("div", { class: "cfoot" },
      `경쟁 ${c.contenders}곳`,
      el("span", { class: c.leaderAgreed ? "ok" : "split" },
        c.leaderAgreed ? "모델 합의" : "모델 분열")),
  )
}

function viewHome() {
  const cats = DATA.categories ?? []
  const split = cats.filter((c) => !c.leaderAgreed)
  const ds = DATA.dataset
  return el("div", {},

    el("h2", {}, "카테고리", el("small", {}, "큰 이름이 그 카테고리 1등입니다")),
    el("div", { class: "cgrid" }, cats.map(catCard)),

    el("h2", {}, "모델이 갈리는 카테고리", el("small", {}, `${split.length}/${cats.length}개`)),
    split.length
      ? el("div", { class: "scroll" }, el("table", {},
          el("thead", {}, el("tr", {},
            el("th", {}, "카테고리"),
            DATA.methodology.models.map((m) => el("th", {}, m.name)))),
          el("tbody", {}, split.map((c) => el("tr", { "data-go": `cat:${c.id}`, style: "cursor:pointer" },
            el("td", {}, c.short),
            DATA.methodology.models.map((m) => leaderCell(c.leaderByModel[m.id])))))))
      : el("p", { class: "empty" }, "모든 카테고리에서 세 모델이 같은 1등을 꼽았습니다."),
  )
}

function viewCategory(id) {
  const c = catOf(id)
  if (!c) return el("p", { class: "empty" }, "카테고리를 찾을 수 없습니다.")
  const L = c.leader
  const models = DATA.methodology.models

  // 🔒 면적을 등장 횟수로 두면 그림이 헤드라인을 반박한다.
  // 실측: 결제 카테고리의 가장 큰 타일이 1순위 0% 인 KakaoPay 였다. 사람 눈은 면적을
  // 먼저 읽으므로 "이 판의 주인은 KakaoPay" 로 읽히는데, 바로 위 카드는 WOWPASS 라고
  // 적혀 있었다. 이 화면 제목이 마인드쉐어이고 마인드쉐어는 맨 앞에 불리는 것이니,
  // 면적도 1순위 획득 횟수여야 한다. 1순위가 0인 이름은 이 그림에서 빠지는 게 맞다.
  const contenders = c.entities.filter((e) => e.firsts > 0)
  const tiles = contenders.slice(0, 14).map((e) => ({
    name: e.name, value: e.firsts, firstRate: e.firstRate, rate: e.rate,
    title: `${e.name} · 1순위 ${e.firsts}회 (${e.firstRate}%) · 언급 ${e.rate}% · 중위 ${e.medianRank ?? "—"}위`,
  }))

  return el("div", {},
    el("p", { class: "prompt" }, el("span", {}, "실제로 던진 질문"), c.prompt ?? c.short),

    el("h2", {}, "카테고리 1위"),
    el("div", { class: "cards k4" },
      el("div", { class: "card" },
        el("div", { class: "k" }, "1등"),
        el("div", { class: "mlead" }, L ? logo(L.name, "md") : null, el("b", {}, L?.name ?? "—")),
        el("div", { class: "n" }, L ? `1순위 ${L.firsts}회 / 응답 ${c.V}건` : "")),
      el("div", { class: "card" },
        el("div", { class: "k" }, "모델 득표"),
        el("div", { class: "v" }, L ? modelVotes(L, c).replace("모델 ", "") : "—"),
        el("div", { class: "n" }, L ? `모델별 1순위 ${models.map((m) => (L.firstsByModel?.[m.id] ?? 0)).join(" · ")}회` : "")),
      card("경쟁 브랜드", c.contenders, `응답 ${c.V}건에 등장한 이름`),
      card("상위 3곳 집중도", dash(c.concentration, "%"), "높을수록 신규 진입이 어렵습니다", false, c.concentration),
    ),

    el("h2", {}, "마인드쉐어 분포",
      el("small", {}, `면적 = 1순위 획득 횟수 · 1순위를 한 번이라도 가져간 ${contenders.length}곳`)),
    tiles.length
      ? treemap(tiles, { label: (t) => `1순위 ${t.value}회 · 언급 ${t.rate}%` })
      : el("p", { class: "empty" }, "1순위를 가져간 이름이 없습니다."),

    el("h2", {}, "순위표", el("small", {}, "1순위 점유율 순")),
    el("div", { class: "scroll" }, (() => {
      const table = el("table", {},
        el("thead", {}, el("tr", {},
          el("th", {}, "#"), el("th", {}, "브랜드"),
          el("th", { class: "n" }, "1순위"),
          el("th", {}, ""),
          el("th", { class: "n" }, "언급률"),
          el("th", { class: "n" }, "중위 순위"),
          el("th", {}, models.map((m) => m.name).join(" · ")))),
        el("tbody", {}, c.entities.map((e, i) => el("tr", {
          "data-brand": ALL.some((b) => b.brand === e.name) ? e.name : null,
          style: ALL.some((b) => b.brand === e.name) ? "cursor:pointer" : null,
          title: ALL.some((b) => b.brand === e.name) ? `${e.name} 프로필 보기` : "추적 목록에 없는 브랜드입니다",
        },
          el("td", { class: "n", style: "color:var(--dim2);font-family:var(--mono)" }, i + 1),
          el("td", {}, named(e.name, "md", e.rate >= 60 && e.firstRate === 0
            ? el("span", { class: "tag" }, "언급률 높음, 1순위 아님") : null)),
          el("td", { class: "n" }, dash(e.firstRate, "%")),
          el("td", { style: "width:110px" }, el("span", {
            class: "bar",
            style: `width:${Math.max(2, e.firstRate ?? 0)}%`,
          })),
          el("td", { class: "n", style: "color:var(--dim)" }, dash(e.rate, "%")),
          el("td", { class: "n" }, e.medianRank === null ? "—" : `${e.medianRank}위`),
          el("td", {}, el("span", { class: "strip" }, models.map((m) => {
            const b = e.byModel[m.id]
            return el("i", {
              class: b.n ? null : "miss",
              style: b.n ? `background:rgba(var(--ink-rgb),${inkA(b.rate).toFixed(3)})` : "",
              title: `${m.name} · ${b.n}/${b.V}${b.firsts ? ` · 1순위 ${b.firsts}회` : ""}`,
            })
          }))),
        ))))
      return clickableRows(table, (tr) => { setBrand(tr.dataset.brand); show("summary") })
    })()),

    el("h2", {}, "모델별 1등"),
    el("div", { class: "cards" }, models.map((m) => {
      const w = c.leaderByModel[m.id]
      const names = w?.names ?? []
      return el("div", { class: "card" },
        el("div", { class: "k" }, m.name),
        el("div", { class: "mlead" },
          names[0] ? logo(names[0], "md") : null,
          el("b", {}, names.length ? names.join(" · ") : "—")),
        el("div", { class: "n" },
          (w?.tied ? "동점 · " : "") + (m.webSearch ? "웹 검색 ON" : "웹 검색 OFF")))
    })),
  )
}

// ---------- 판세 ----------
// 브랜드 하나를 깊게 보기 전에, 추적한 브랜드들이 서로 어떻게 갈리는지 먼저 본다.
// 같은 응답을 브랜드마다 다시 채점한 결과라 한 판에 놓고 비교하는 것이 정당하다.
function modelStrip(b, models) {
  // 빈 <i> + 배경색 + title 만으로는 접근성 트리에 아무것도 안 나타난다.
  // 띠 전체를 하나의 이미지로 보고 요약 문장을 붙인다.
  const parts = []
  const marks = models.map((m) => {
    const cells = b.matrix.filter((c) => c.model === m)
    const V = cells.reduce((s, c) => s + c.V, 0)
    const n = cells.reduce((s, c) => s + c.mentions, 0)
    const rate = V ? Math.round((n / V) * 100) : 0
    parts.push(`${modelLabel(m)} ${rate}%`)
    return el("i", {
      style: n ? `background:rgba(var(--ink-rgb),${inkA(rate).toFixed(3)})` : "",
      class: n ? null : "miss",
      title: `${modelLabel(m)} · ${n}/${V} (${rate}%)`,
    })
  })
  return el("span", { class: "strip", role: "img", "aria-label": `모델별 언급률 ${parts.join(", ")}` }, marks)
}

/** 브랜드의 질문별 집계. 판세 표와 밀도판이 같은 수를 쓰게 한다. */
function perQuestion(b) {
  const questions = [...new Set(b.matrix.map((c) => c.question))]
  return questions.map((q) => {
    const cells = b.matrix.filter((c) => c.question === q)
    const V = cells.reduce((s, c) => s + c.V, 0)
    const n = cells.reduce((s, c) => s + c.mentions, 0)
    const ranks = cells.filter((c) => c.medianRank !== null).map((c) => c.medianRank).sort((x, y) => x - y)
    return {
      q, V, mentions: n,
      rate: V ? Math.round((n / V) * 100) : 0,
      medianRank: ranks.length ? ranks[Math.floor(ranks.length / 2)] : null,
    }
  })
}

function viewField() {
  const list = [...ALL].sort((a, b) => (b.visibility.mentionRate ?? 0) - (a.visibility.mentionRate ?? 0))
  const models = [...new Set(list[0]?.matrix.map((c) => c.model) ?? [])]

  return el("div", {},

    el("h2", {}, "브랜드별 가시성", el("small", {}, "폭과 깊이를 따로 봅니다")),
    el("div", { class: "scroll" }, (() => {
      const table = el("table", {},
        el("thead", {}, el("tr", {},
          el("th", {}, "브랜드"),
          el("th", { class: "n" }, "등장 질문"),
          el("th", { class: "n" }, "가장 센 질문"),
          el("th", {}, ""),
          el("th", { class: "n" }, "중위 순위"),
          el("th", { class: "n" }, "전체 언급률"),
          el("th", {}, models.map((m) => modelLabel(m)).join(" · ")))),
        el("tbody", {}, list.map((b) => {
          const v = b.visibility
          const per = perQuestion(b)
          const hit = per.filter((p) => p.mentions > 0)
          const best = hit.slice().sort((a, c) => c.rate - a.rate)[0]
          return el("tr", {
            class: b.brand === BRAND.brand ? "me" : null,
            "data-brand": b.brand, style: "cursor:pointer",
            title: `${b.brand} 로 전환`,
          },
            el("td", {}, named(b.brand)),
            el("td", { class: "n" }, `${hit.length}/${per.length}`),
            el("td", { class: "n" }, best ? `${best.q.toUpperCase()} ${best.rate}%` : "—"),
            el("td", { style: "width:110px" }, el("span", {
              class: "bar",
              style: `width:${Math.max(2, best?.rate ?? 0)}%`,
            })),
            el("td", { class: "n" }, v.medianRank === null ? "—" : `${v.medianRank}위`),
            el("td", { class: "n", style: "color:var(--dim)" }, dash(v.mentionRate, "%")),
            el("td", {}, modelStrip(b, models)))
        })))
      return clickableRows(table, (tr) => { setBrand(tr.dataset.brand); show("summary") })
    })()),

    el("h2", {}, "질문별 1순위 분포", el("small", {}, "브랜드 × 질문")),
    fieldMatrix(list),
  )
}

/** 브랜드 × 질문 밀도판. densityMatrix 와 읽는 법은 같고 축만 다르다. */
function fieldMatrix(list) {
  const questions = [...new Set(list[0]?.matrix.map((c) => c.question) ?? [])]
  const cellFor = (b, q) => {
    const p = perQuestion(b).find((x) => x.q === q)
    if (!p) return null
    return { V: p.V, mentions: p.mentions, mentionRate: p.rate, medianRank: p.medianRank,
      mentionLabel: `${p.mentions}/${p.V}`, top3Label: "-", reproducibility: 0 }
  }
  return el("div", { class: "plate" },
    el("table", { class: "mx field" },
      el("thead", {}, el("tr", {},
        el("th", { class: "rowhead" }, "브랜드"),
        questions.map((q) => el("th", {}, q.toUpperCase())))),
      el("tbody", {}, list.map((b) => el("tr", { class: b.brand === BRAND.brand ? "on" : null },
        el("td", { class: "rowhead" }, b.brand),
        questions.map((q) => el("td", {}, densityCell(cellFor(b, q)))))))),
    el("div", { class: "ramp" },
      el("span", {}, "언급률"),
      el("span", { class: "steps" },
        [0, 20, 40, 60, 80, 100].map((r) => el("i", { style: `opacity:${inkA(r).toFixed(3)}`, title: `${r}%` }))),
      el("span", {}, "0 → 100%"),
      el("span", {}, el("i", { class: "sw" }), "미언급 (0건)"),
      el("span", {}, questions.map((q) => `${q.toUpperCase()} ${questionShort(q)}`).join(" · "))),
  )
}

const RENDER = { home: viewHome, brands: viewField, field: viewField, summary: viewSummary, compete: viewCompete, diagnose: viewDiagnose, sources: viewSources, evidence: viewEvidence, method: viewMethod, run: viewRun, settings: viewSettings }

/** 사이드바 "측정 대상" 카드. 브랜드가 여럿이면 전환기가 된다. */
function renderSubject() {
  const m = DATA?.methodology
  const ds = DATA?.dataset
  const nm = $("#dsName")
  if (nm) nm.textContent = ds?.name ?? "측정 데이터"
  const cats = DATA?.categories ?? []
  $("#runStamp").textContent = m
    ? `카테고리 ${cats.length} · 모델 ${m.models.length} · n=${m.repeats} · 응답 ${cats.reduce((s, c) => s + c.V, 0)}건`
    : ""
}

function setBrand(name) {
  const b = ALL.find((x) => x.brand === name)
  if (!b || b === BRAND) return
  BRAND = b
  renderSubject()
  show(CURRENT)
}

/** 브랜드 헤더 아래 탭. 브랜드 스코프 화면에서만 나타난다. */
function renderBrandTabs(active) {
  const host = $("#brandTabs")
  if (!host) return
  host.innerHTML = ""
  if (!active || !BRAND) { host.hidden = true; return }
  host.hidden = false
  host.append(el("div", { class: "bsel" },
    el("select", { "aria-label": "브랜드 선택" },
      [...ALL].sort((a, b) => a.brand.localeCompare(b.brand))
        .map((b) => el("option", { value: b.brand, selected: b.brand === BRAND.brand }, b.brand)))))
  host.append(el("div", { class: "btabs", role: "tablist" },
    BRAND_TABS.map(([k, label]) => el("button", {
      type: "button", role: "tab", "data-k": k,
      "aria-selected": String(k === active),
    }, label))))
  host.querySelector("select").addEventListener("change", (e) => setBrand(e.target.value))
  host.querySelector(".btabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]")
    if (b) show(b.dataset.k)
  })
}

// ---------- 커맨드 팔레트 ----------
// 앱 전체에 입력 필드가 0개였다. Toss 담당자가 자기 앱을 찾으려면 카테고리 8개를
// 하나씩 열어 평균 10화면씩 스크롤해야 했다. 찾을 대상이 브랜드 63개와 카테고리 8개
// 두 종류라 텍스트박스 하나로는 결과 타입이 섞여, 타입을 붙인 팔레트로 만든다.

function paletteItems() {
  const items = []
  for (const c of DATA?.categories ?? []) {
    items.push({ type: "카테고리", label: c.short, hint: `1위 ${c.leader?.name ?? "—"}`, go: `cat:${c.id}` })
  }
  const seen = new Set()
  for (const c of DATA?.categories ?? []) {
    for (const e of c.entities) {
      if (seen.has(e.name)) continue
      seen.add(e.name)
      const tracked = ALL.some((b) => b.brand === e.name)
      items.push({
        type: "브랜드", label: e.name,
        hint: `${c.short} ${e.rate}%${tracked ? "" : " · 프로필 없음"}`,
        brand: tracked ? e.name : null, go: `cat:${c.id}`,
      })
    }
  }
  return items
}

function openPalette() {
  if ($("#pal")) return
  const items = paletteItems()
  const input = el("input", { type: "text", placeholder: "브랜드나 카테고리 이름", "aria-label": "검색" })
  const list = el("div", { class: "pal-list", role: "listbox" })
  const box = el("div", { class: "pal-box" }, input, list)
  const wrap = el("div", { id: "pal", class: "pal" }, box)
  let cur = 0, shown = []

  const render = () => {
    const q = input.value.trim().toLowerCase()
    shown = (q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items).slice(0, 40)
    if (cur >= shown.length) cur = 0
    list.innerHTML = ""
    if (!shown.length) { list.append(el("div", { class: "pal-empty" }, "결과가 없습니다.")); return }
    shown.forEach((i, n) => list.append(el("div", {
      class: `pal-row${n === cur ? " on" : ""}`, role: "option", "aria-selected": String(n === cur),
      "data-n": n,
    },
      el("span", { class: "pal-t" }, i.type),
      i.type === "브랜드" ? logo(i.label, "sm") : null,
      el("span", { class: "pal-l" }, i.label),
      el("span", { class: "pal-h" }, i.hint))))
  }
  const pick = (i) => {
    close()
    if (i.brand) { setBrand(i.brand); show("summary") } else show(i.go)
  }
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey, true) }
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close() }
    else if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(cur + 1, shown.length - 1); render() }
    else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(cur - 1, 0); render() }
    else if (e.key === "Enter" && shown[cur]) { e.preventDefault(); pick(shown[cur]) }
  }
  input.addEventListener("input", () => { cur = 0; render() })
  list.addEventListener("click", (e) => {
    const r = e.target.closest(".pal-row")
    if (r) pick(shown[Number(r.dataset.n)])
  })
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close() })
  document.addEventListener("keydown", onKey, true)
  document.body.append(wrap)
  render()
  input.focus()
}

let CURRENT = null
let CURRENT_SET = false
const renderFor = (key) => (key.startsWith("cat:") ? () => viewCategory(key.slice(4)) : RENDER[key])

function show(key) {
  if (!renderFor(key)) key = "home"
  CURRENT = key
  const brandScoped = BRAND_KEYS.includes(key)
  const meta = VIEWS.find(([k]) => k === key)
  if (brandScoped && BRAND) {
    const per = perQuestion(BRAND)
    const hit = per.filter((x) => x.mentions > 0).length
    $("#pageEyebrow").textContent = "브랜드"
    $("#pageTitle").textContent = BRAND.brand
    $("#pageSub").textContent =
      `${per.length}개 카테고리 중 ${hit}곳 등장 · 전체 언급률 ${dash(BRAND.visibility.mentionRate, "%")}`
  } else if (meta) {
    $("#pageEyebrow").textContent = meta[2]
    $("#pageTitle").textContent = meta[1]
    $("#pageSub").textContent = meta[3]
  }
  renderBrandTabs(brandScoped ? key : null)
  const app = $("#app")
  app.innerHTML = ""
  // 데이터가 먼저다. 설명은 화면 맨 아래에 접어 둔다.
  app.append(renderFor(key)(BRAND))
  const help = viewHelp(key)
  if (help) app.append(help)
  for (const btn of $("#nav").querySelectorAll("button")) {
    // 브랜드 화면에 있을 때는 사이드바의 "브랜드 찾기"를 현재 위치로 표시한다.
    const on = btn.dataset.k === key || (brandScoped && btn.dataset.k === "brands")
    btn.setAttribute("aria-current", on ? "page" : "false")
    btn.setAttribute("aria-selected", String(on))
  }
  // 초기 렌더까지 pushState 하면 첫 뒤로가기가 아무 변화 없이 소모된다.
  if (location.hash.slice(1) !== key) {
    if (CURRENT_SET) history.pushState(null, "", `#${key}`)
    else history.replaceState(null, "", `#${key}`)
  }
  CURRENT_SET = true
  // H1 이 바뀌는데 공지가 없어 스크린리더가 화면 전환을 알 수 없었다.
  const live = $("#routeLive")
  if (live) live.textContent = `${$("#pageTitle").textContent} 화면`
  window.scrollTo({ top: 0 })
}

async function boot() {
  try {
    const res = await fetch("./summary.json", { cache: "no-store" })
    if (!res.ok) throw new Error(`summary.json ${res.status}`)
    DATA = await res.json()
  } catch (e) {
    $("#app").innerHTML = `<p class="note">데이터를 불러오지 못했습니다 (${esc(e.message)}).<br>
      저장소에서 <span class="cell">node bin/geo-probe.mjs export</span> 를 실행하면 생성됩니다.</p>`
    return
  }
  await Promise.all([loadOwnData(), loadLogos()])
  VIEWS = allViews()
  ALL = DATA.brands
  BRAND = DATA.brands[0]
  if (!BRAND) { $("#app").innerHTML = `<p class="note">측정된 브랜드가 없습니다.</p>`; return }

  renderSubject()
  const last = BRAND.trend.at(-1)
  $("#stamp").innerHTML =
    `<b>최근 측정 ${last?.run_id ?? "-"}</b>생성 ${String(DATA.generatedAt).slice(0, 16).replace("T", " ")}`

  const nav = $("#nav")
  // 측정 실행·설정은 로컬 서버에서만 동작한다. 배포판에서도 탭은 보여주고
  // 화면 안에서 이유를 설명한다(숨기면 그런 기능이 있다는 것 자체가 안 보인다).
  let group = null
  let ix = 0
  for (const [k, label, grp] of VIEWS) {
    if (grp !== group) { nav.append(el("div", { class: "grp" }, grp)); group = grp }
    const cat = k.startsWith("cat:") ? catOf(k.slice(4)) : null
    nav.append(el("button", { "data-k": k, type: "button" },
      el("span", { class: "ix", "aria-hidden": "true" }, String(++ix).padStart(2, "0")),
      el("span", { class: "lb" }, label),
      // 메뉴에서 이미 1등이 보이면 목록 자체가 요약이 된다.
      cat?.leader ? el("span", { class: "lead1", title: `1위 ${cat.leader.name}` },
        logo(cat.leader.name, "sm")) : null))
  }
  nav.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.k) })

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette() }
    else if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
      e.preventDefault(); openPalette()
    }
  })
  $("#palBtn")?.addEventListener("click", openPalette)
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-go]")
    if (a) { e.preventDefault(); show(a.dataset.go) }
  })
  // 주소창 해시·브라우저 뒤로가기로도 화면이 바뀌게 한다(탭 클릭만 되던 문제).
  window.addEventListener("hashchange", () => {
    const k = location.hash.slice(1)
    if (renderFor(k) && k !== CURRENT) show(k)
  })
  const start = location.hash.slice(1)
  show(renderFor(start) ? start : "home")
}
boot()
