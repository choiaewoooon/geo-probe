import test from "node:test"
import assert from "node:assert/strict"
import { categories, cellConsistency, homeRate } from "../src/metrics.mjs"

// 이 함수는 커버리지 0% 였고, 감사에서 나온 집계 버그 세 개가 전부 여기 있었다.
// 회귀를 막기 위해 그 세 가지를 그대로 테스트로 박는다.

const Q = [{ id: "q1", short: "지도", prompt: "지도 앱?" }]
const M = [{ id: "m1", name: "A" }, { id: "m2", name: "B" }]

const row = (model, repeat, names) => ({
  run_id: "r1", brand: "X", model, question: "q1", repeat,
  mentioned: names.includes("X"), rank: names.indexOf("X") + 1 || null, listed: true,
  entries: names,
  entriesWithRank: names.map((name, i) => ({ rank: i + 1, name })),
})

test("categories: 한 응답에 같은 이름이 두 번 나와도 slots 를 두 번 세지 않는다", () => {
  // slots 를 dedup 앞에서 세면 분모만 부풀어 sov 합계가 100% 에 못 미친다.
  const rows = [row("m1", 1, ["A", "B", "B"])]
  const [c] = categories(rows, { questions: Q, models: M })
  assert.equal(c.slots, 2)
  assert.equal(c.entities.reduce((s, e) => s + e.sov, 0), 100)
})

test("categories: 1위는 1순위 점유율 순이다. 언급이 최다여도 1순위가 0이면 밀린다", () => {
  // 실측 사례: 결제 카테고리에서 KakaoPay 는 언급 최다인데 1순위 0% 였고
  // 실제로 자리를 쥔 건 WOWPASS 였다.
  const rows = [
    row("m1", 1, ["W", "K"]),
    row("m1", 2, ["W", "K"]),
    row("m2", 1, ["N", "K"]),
  ]
  const [c] = categories(rows, { questions: Q, models: M })
  assert.equal(c.leader.name, "W")
  const kakao = c.entities.find((e) => e.name === "K")
  assert.equal(kakao.appearances, 3) // 최다 등장
  assert.equal(kakao.firstRate, 0)   // 그런데 한 번도 맨 앞이 아니다
})

test("categories: 모델별 1위 동점을 조용히 깨지 않는다", () => {
  // 동점을 임의로 깨면 "모델 분열"이 "합의"로 둔갑한다.
  const rows = [row("m1", 1, ["P"]), row("m1", 2, ["Q"]), row("m2", 1, ["P"])]
  const [c] = categories(rows, { questions: Q, models: M })
  assert.equal(c.leaderByModel.m1.tied, true)
  assert.deepEqual(c.leaderByModel.m1.names.sort(), ["P", "Q"])
  assert.equal(c.leaderAgreed, false) // 동점이 있으면 합의라고 말하지 않는다
})

test("categories: 집중도는 등장이 많은 상위 3곳 기준이다", () => {
  // entities 는 1순위 순 정렬이라 그대로 slice 하면 '등장이 많은 3곳'이 아니다.
  const rows = [
    row("m1", 1, ["A", "B", "C", "D"]),
    row("m1", 2, ["B", "C", "D", "A"]),
    row("m2", 1, ["B", "C", "D", "E"]),
  ]
  const [c] = categories(rows, { questions: Q, models: M })
  const total = c.entities.reduce((s, e) => s + e.appearances, 0)
  const top3 = [...c.entities].sort((a, b) => b.appearances - a.appearances)
    .slice(0, 3).reduce((s, e) => s + e.appearances, 0)
  assert.equal(c.concentration, Math.round((top3 / total) * 100))
})

test("categories: 표기만 다른 같은 이름은 한 줄로 합친다", () => {
  const rows = [row("m1", 1, ["Korea Tour Card"]), row("m1", 2, ["KOREA TOUR CARD"])]
  const [c] = categories(rows, { questions: Q, models: M })
  assert.equal(c.entities.length, 1)
  assert.equal(c.entities[0].appearances, 2)
})

test("cellConsistency: 셀 안에서 5/5 나 0/5 면 100%, 3/5 면 60%", () => {
  const mk = (model, question, hits, n) => Array.from({ length: n }, (_, i) => ({
    model, question, mentioned: i < hits,
  }))
  assert.equal(cellConsistency(mk("m1", "q1", 5, 5)), 100)
  assert.equal(cellConsistency(mk("m1", "q1", 0, 5)), 100)
  assert.equal(cellConsistency(mk("m1", "q1", 3, 5)), 60)
  // 셀마다 완벽히 결정적이면, 전체 언급률이 50% 여도 일관성은 100% 다.
  assert.equal(cellConsistency([...mk("m1", "q1", 5, 5), ...mk("m2", "q1", 0, 5)]), 100)
})

test("homeRate: 브랜드가 한 번도 안 나온 질문은 분모에서 뺀다", () => {
  const rows = [
    ...Array.from({ length: 5 }, () => ({ question: "q1", mentioned: true })),
    ...Array.from({ length: 5 }, () => ({ question: "q2", mentioned: false })),
  ]
  // 전체로 재면 50% 지만, 실제로 뛰는 판(q1)에서는 100% 다.
  assert.equal(homeRate(rows), 100)
})
