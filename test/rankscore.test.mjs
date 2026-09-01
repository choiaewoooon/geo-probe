import test from "node:test"
import assert from "node:assert/strict"
import {
  categories, rankWeight, rankScore, rankScores, padUnranked,
  RANK_CURVES, CURVE_IDS, DEFAULT_CURVE,
} from "../src/metrics.mjs"

// 순위 가중 점수(2026-09-01). 만든 이유는 히트맵이 "나왔냐/안 나왔냐" 한 축이라
// 항상 1위인 앱과 항상 4~5위인 앱이 같은 농도로 찍혔기 때문이다.
// 그 회귀를 그대로 테스트로 박는다.

const Q = [{ id: "q1", short: "지도", prompt: "지도 앱?" }]
const M = [{ id: "m1", name: "A" }]

const row = (repeat, names) => ({
  run_id: "r1", brand: "X", model: "m1", question: "q1", repeat,
  mentioned: names.includes("X"), rank: names.indexOf("X") + 1 || null, listed: true,
  entries: names,
  entriesWithRank: names.map((name, i) => ({ rank: i + 1, name })),
})

test("rankWeight: 1위가 10 이고, 수집 범위(TOP 5) 밖은 0 이다", () => {
  assert.equal(rankWeight(1), 10)
  assert.equal(rankWeight(5), 2)
  assert.equal(rankWeight(6), 0)
  assert.equal(rankWeight(0), 0)
})

test("rankWeight: 언급됐지만 순위 미상은 0 이 아니다. 미언급과 다른 사실이다", () => {
  // 다만 최하위(5위 = 2점)보다는 낮아야 한다. 그래야 순위가 붙은 등장이 항상 더 무겁다.
  assert.equal(rankWeight(null), 1)
  assert.ok(rankWeight(null) < rankWeight(5))
})

test("모든 곡선이 1위를 10 으로 맞춘다. 눈금이 다르면 곡선 토글이 점수를 비교 불가로 만든다", () => {
  for (const id of CURVE_IDS) assert.equal(RANK_CURVES[id].weights[0], 10)
})

test("rankScore: 유효 응답 전부에서 1위면 100 이다", () => {
  assert.equal(rankScore([1, 1, 1], 3), 100)
})

test("rankScore: 미언급은 분모에 남아 점수를 끌어내린다", () => {
  // 3건 중 1건만 1위 → 10 / 30. 등장한 것만으로 재면 100 이 나와 거짓말이 된다.
  assert.equal(rankScore([1], 3), 33)
  assert.equal(rankScore([], 3), 0)
  assert.equal(rankScore([1], 0), null)
})

test("padUnranked: 등장 수보다 순위가 적으면 나머지를 순위 미상으로 채운다", () => {
  assert.deepEqual(padUnranked([1, 2], 4), [1, 2, null, null])
  assert.deepEqual(padUnranked([1, 2], 1), [1, 2]) // 음수 길이로 터지지 않는다
})

test("🔒 노출률이 같아도 순위가 다르면 점수가 갈린다 (히트맵이 답답했던 원인)", () => {
  // A 는 항상 1위, B 는 항상 2위, C 는 항상 3위. 셋 다 노출률 100% 라
  // 언급률로 칠하면 세 칸이 같은 검정이 된다.
  const rows = [row(1, ["A", "B", "C"]), row(2, ["A", "B", "C"]), row(3, ["A", "B", "C"])]
  const [c] = categories(rows, { questions: Q, models: M })
  const get = (n) => c.entities.find((e) => e.name === n)
  assert.equal(get("A").rate, 100)
  assert.equal(get("B").rate, 100)
  assert.equal(get("C").rate, 100)
  assert.equal(get("A").score, 100)
  assert.equal(get("B").score, 80)
  assert.equal(get("C").score, 60)
})

test("🔒 점수 최대는 1순위 1등과 어긋날 수 있다. 코드가 이걸 감추면 안 된다", () => {
  // 이 테스트는 원래 "둘은 항상 같다"로 썼다가 여기서 반증됐다. 실제 회차(korea-apps
  // 2026-08-24)에서는 8개 카테고리 전부 일치했지만 그건 그 데이터의 성질이지 구조적
  // 보장이 아니다. 아래가 반례다 — W 는 3건 중 2건에서 1위(점수 67), K 는 3건 전부
  // 2위(점수 80). "맨 앞에 가장 자주 불린 쪽"과 "누적 노출 무게가 가장 큰 쪽"이 다르다.
  //
  // 둘 중 하나를 조용히 이기게 두면 화면이 거짓말을 한다(트리맵 면적 = K, 헤드라인 = W).
  // 그래서 leader 는 1순위 기준으로 그대로 두고, 갈리는 사실 자체를 화면에 적는다.
  // 같은 파일의 "동점을 조용히 깨면 분열이 합의로 둔갑한다"와 같은 원칙이다.
  const rows = [
    row(1, ["W", "K"]),
    row(2, ["W", "K"]),
    row(3, ["N", "K"]),
  ]
  const [c] = categories(rows, { questions: Q, models: M })
  const top = [...c.entities].sort((a, b) => b.score - a.score)[0]
  assert.equal(c.leader.name, "W")   // 1순위 기준 1등은 그대로 W
  assert.equal(top.name, "K")        // 점수 최대는 K — 갈린다
  assert.equal(c.entities.find((e) => e.name === "W").score, 67)
  assert.equal(c.entities.find((e) => e.name === "K").score, 80)
})

test("1순위가 0회여도 점수에서 사라지지 않는다 (트리맵에서 통째로 증발했던 문제)", () => {
  // 실측: q5 한 곳에서만 9곳이 그림에서 빠졌고 그중 2·3위 세력이 있었다.
  const rows = [row(1, ["W", "K"]), row(2, ["W", "K"])]
  const [c] = categories(rows, { questions: Q, models: M })
  const k = c.entities.find((e) => e.name === "K")
  assert.equal(k.firsts, 0)
  assert.ok(k.score > 0)
})

test("곡선 3종이 모두 구워져 나온다. 화면 토글이 재계산 없이 필드만 바꾼다", () => {
  const rows = [row(1, ["A", "B"])]
  const [c] = categories(rows, { questions: Q, models: M })
  const a = c.entities.find((e) => e.name === "A")
  assert.deepEqual(Object.keys(a.scores).sort(), [...CURVE_IDS].sort())
  assert.equal(a.scores[DEFAULT_CURVE], a.score)
  assert.deepEqual(rankScores([1], 1), Object.fromEntries(CURVE_IDS.map((k) => [k, 100])))
})

test("곡선마다 2위 대우가 다르다. 토글이 실제로 그림을 바꾼다는 뜻이다", () => {
  assert.equal(rankScore([2], 1, "linear"), 80)
  assert.equal(rankScore([2], 1, "mrr"), 50)
  assert.equal(rankScore([2], 1, "ndcg"), 63)
})
