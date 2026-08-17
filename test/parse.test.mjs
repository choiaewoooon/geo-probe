// node --test test/
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseEntries, extractCitations, cleanEntry, buildAliasIndex, normalizeBrand, measureResponse } from "../src/parse.mjs"
import { visibility, shareOfVoice, substitution, completeness, citations, trend, statusLabels } from "../src/metrics.mjs"

const LIST = `1. Edelman
2. **Weber Shandwick** — 글로벌 대형
3. Burson
4. FleishmanHillard
5. BCW`

test("parseEntries: 번호 목록에서 전 항목을 뽑는다", () => {
  const e = parseEntries(LIST)
  assert.equal(e.length, 5)
  assert.deepEqual(e.map((x) => x.name), ["Edelman", "Weber Shandwick", "Burson", "FleishmanHillard", "BCW"])
  assert.equal(e[2].rank, 3)
})

test("parseEntries: 산문 응답은 빈 배열", () => {
  assert.deepEqual(parseEntries("Burson은 좋은 회사입니다. Edelman도 있습니다."), [])
})

test("parseEntries: 빈 입력·null 안전", () => {
  assert.deepEqual(parseEntries(""), [])
  assert.deepEqual(parseEntries(null), [])
})

test("cleanEntry: 마크다운·수식어 제거", () => {
  assert.equal(cleanEntry("**Weber Shandwick** — 글로벌 대형"), "Weber Shandwick")
  assert.equal(cleanEntry("Edelman (독립계 1위)"), "Edelman")
})

test("extractCitations: URL 있으면 도메인, 없으면 빈 배열", () => {
  assert.deepEqual(extractCitations("출처: https://www.bursonglobal.com/expertise 및 http://prweek.com/a"), [
    "bursonglobal.com",
    "prweek.com",
  ])
  assert.deepEqual(extractCitations("URL 없는 응답"), [])
})

test("normalizeBrand: 별칭을 하나의 엔티티로", () => {
  const idx = buildAliasIndex({ Burson: ["버슨", "BCW"] })
  assert.equal(normalizeBrand("BCW", idx), "Burson")
  assert.equal(normalizeBrand("버슨", idx), "Burson")
  assert.equal(normalizeBrand("Burson Korea", idx), "Burson")
  assert.equal(normalizeBrand("Edelman", idx), "Edelman")
})

test("measureResponse: 목록 응답 → 순위 + 전 항목 + 인용", () => {
  const idx = buildAliasIndex({ Burson: ["BCW"] })
  const m = measureResponse(LIST, { brand: "Burson", aliasIndex: idx })
  assert.equal(m.mentioned, true)
  assert.equal(m.rank, 3)
  assert.equal(m.listed, true)
  assert.ok(m.entries.includes("Edelman"))
})

test("measureResponse: 산문 언급은 mentioned=true, rank=null (순위 통계 제외)", () => {
  const idx = buildAliasIndex({ Burson: [] })
  const m = measureResponse("Burson은 위기관리에 강합니다.", { brand: "Burson", aliasIndex: idx })
  assert.equal(m.mentioned, true)
  assert.equal(m.rank, null)
  assert.equal(m.listed, false)
})

test("measureResponse: 빈 응답은 null (유효 응답에서 제외)", () => {
  const idx = buildAliasIndex({ Burson: [] })
  assert.equal(measureResponse("   ", { brand: "Burson", aliasIndex: idx }), null)
})

// --- metrics ---------------------------------------------------------------
const rows = [
  { run_id: "r1", ts: "2026-07-13T00:00:00Z", brand: "Burson", model: "chatgpt", question: "q1", mentioned: true, rank: 3, listed: true, entries: ["Edelman", "Burson"], citations: ["bursonglobal.com"] },
  { run_id: "r1", ts: "2026-07-13T00:00:00Z", brand: "Burson", model: "chatgpt", question: "q1", mentioned: true, rank: 2, listed: true, entries: ["Edelman", "Burson"], citations: [] },
  { run_id: "r1", ts: "2026-07-13T00:00:00Z", brand: "Burson", model: "chatgpt", question: "q1", mentioned: false, rank: null, listed: true, entries: ["Edelman", "Weber Shandwick"], citations: [] },
  { run_id: "r2", ts: "2026-07-26T00:00:00Z", brand: "Burson", model: "chatgpt", question: "q1", mentioned: true, rank: 1, listed: true, entries: ["Burson", "Edelman"], citations: [] },
]

test("visibility: 언급률·Top3·중위순위(미언급 제외)·재현성", () => {
  const v = visibility(rows)
  assert.equal(v.V, 4)
  assert.equal(v.mentions, 3)
  assert.equal(v.mentionRate, 75)
  assert.equal(v.mentionLabel, "3/4 · 75%")
  assert.equal(v.top3, 3)
  assert.equal(v.medianRank, 2) // [1,2,3] 중위 = 2, 미언급은 제외
  assert.equal(v.rankedN, 3)
  assert.equal(v.reproducibility, 75)
})

test("visibility: 미언급을 최하위 순위로 치환하지 않는다", () => {
  const none = visibility([{ mentioned: false, rank: null, listed: true, entries: [] }])
  assert.equal(none.medianRank, null) // '6위' 같은 값이 만들어지면 안 됨
})

test("shareOfVoice: 등장한 모든 브랜드를 집계", () => {
  const sov = shareOfVoice(rows)
  const names = sov.map((s) => s.name)
  assert.ok(names.includes("Edelman"))
  assert.ok(names.includes("Weber Shandwick"))
  assert.equal(sov.find((s) => s.name === "Edelman").appearances, 4)
})

test("substitution: 자사 미언급 시 그 자리를 채운 브랜드", () => {
  const sub = substitution(rows, "Burson")
  assert.equal(sub.missedN, 1)
  assert.equal(sub.brands[0].rate, 100)
})

test("completeness: 유효/예정 비율과 경고", () => {
  const c = completeness(rows, 10)
  assert.equal(c.valid, 4)
  assert.equal(c.validRate, 40)
  assert.equal(c.warn, true)
})

test("citations: 인용 없으면 측정 불가(0%가 아니라 null)", () => {
  const c0 = citations([{ mentioned: true, citations: [] }], ["bursonglobal.com"])
  assert.equal(c0.measurable, false)
  assert.equal(c0.ownCitationRate, null)
  const c1 = citations(rows, ["bursonglobal.com"])
  assert.equal(c1.measurable, true)
  assert.equal(c1.ownCitationRate, 100)
})

test("trend: run별 시계열 + 이동평균", () => {
  const t = trend(rows)
  assert.equal(t.length, 2)
  assert.equal(t[0].run_id, "r1")
  assert.equal(t[1].rate, 100)
})

test("statusLabels: 종합 점수 대신 상태 라벨", () => {
  const s = statusLabels(visibility(rows), trend(rows))
  assert.equal(s.visibility, "높음")
  assert.ok(["상승", "하락", "보합", "—"].includes(s.direction))
})

// --- 중복 방지 회귀 (2026-07-26: analyze 재실행 시 history 2배 누적 버그) ---
test("appendHistory: 같은 응답을 두 번 넣어도 한 번만 쌓인다", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { appendHistory, readHistory } = await import("../src/analyze.mjs")
  const p = path.join(os.tmpdir(), `geo-hist-${Date.now()}.jsonl`)
  const batch = [
    { brand: "B", run_id: "r1", model: "m", question: "q1", repeat: 1, mentioned: true, rank: 1 },
    { brand: "B", run_id: "r1", model: "m", question: "q1", repeat: 2, mentioned: false, rank: null },
  ]
  assert.equal(appendHistory(p, batch), 2)
  assert.equal(appendHistory(p, batch), 0) // 재실행 → 추가 0
  assert.equal(readHistory(p).length, 2)
  fs.rmSync(p, { force: true })
})

// --- 별칭 부분일치 회귀 (2026-07-26: 한글 2글자 별칭이 임계값에 걸려 언급을 놓쳤다) ---
test("normalizeBrand: 한글 2글자 별칭도 부분 일치한다", () => {
  const idx = buildAliasIndex({ Burson: ["버슨", "버슨콘앤울프"] })
  assert.equal(normalizeBrand("시너지버슨", idx), "Burson")           // 앞에 수식어
  assert.equal(normalizeBrand("버슨콘앤울프 코리아", idx), "Burson")   // 합병 전 사명
  assert.equal(normalizeBrand("버슨 코리아", idx), "Burson")
})

test("normalizeBrand: 긴 별칭이 짧은 별칭보다 먼저 매칭된다", () => {
  const idx = buildAliasIndex({ Burson: ["버슨"], "버슨콘앤울프": ["버슨콘앤울프"] })
  assert.equal(normalizeBrand("버슨콘앤울프", idx), "버슨콘앤울프")
})

test("normalizeBrand: 영문 2글자는 부분 일치시키지 않는다(오탐 방지)", () => {
  const idx = buildAliasIndex({ Foo: ["ab"] })
  assert.equal(normalizeBrand("Nabisco", idx), "Nabisco")
})

// --- 프로토콜 경계 회귀 (2026-07-26: 질문 세트가 바뀐 구간을 이어 비교하면 안 된다) ---
test("trend/statusLabels: 질문 세트가 다르면 방향을 '비교 불가'로 둔다", async () => {
  const { trend: tr, statusLabels: sl, visibility: vis } = await import("../src/metrics.mjs")
  const rows = [
    { run_id: "r1", ts: "2026-07-13T00:00:00Z", protocol: "v1", mentioned: true, rank: 1, listed: true, entries: [] },
    { run_id: "r2", ts: "2026-07-26T00:00:00Z", protocol: "v2", mentioned: false, rank: null, listed: true, entries: [] },
  ]
  const t = tr(rows)
  assert.equal(t[1].protocolStart, true)          // 세트가 바뀐 지점 표시
  assert.equal(sl(vis(rows), t).direction, "비교 불가")
})

test("trend: 이동평균이 다른 프로토콜을 섞지 않는다", async () => {
  const { trend: tr } = await import("../src/metrics.mjs")
  const rows = [
    { run_id: "a", ts: "2026-01-01T00:00:00Z", protocol: "v1", mentioned: true, rank: 1, listed: true, entries: [] },
    { run_id: "b", ts: "2026-02-01T00:00:00Z", protocol: "v2", mentioned: false, rank: null, listed: true, entries: [] },
  ]
  const t = tr(rows)
  assert.equal(t[1].movingRate, 0)  // v1 의 100% 가 섞이면 50% 가 된다
})
