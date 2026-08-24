import test from "node:test"
import assert from "node:assert/strict"
import { squarify, inkA, perQuestion } from "../web/public/lib/viz.mjs"

// 트리맵 배치는 틀려도 화면이 그럴듯하게 그려진다. 면적 비율이 어긋난 걸
// 사람 눈으로 잡을 수 없으므로 수로 확인한다.

const area = (t) => t.w * t.h

test("squarify: 타일 면적의 합이 주어진 사각형을 채운다", () => {
  const items = [{ value: 50 }, { value: 30 }, { value: 20 }]
  const out = squarify(items, 0, 0, 100, 100)
  const total = out.reduce((s, t) => s + area(t), 0)
  assert.ok(Math.abs(total - 10000) < 0.01, `면적 합 ${total}`)
})

test("squarify: 면적이 value 비율과 일치한다", () => {
  const items = [{ value: 60 }, { value: 30 }, { value: 10 }]
  const out = squarify(items, 0, 0, 200, 100)
  const sum = items.reduce((s, i) => s + i.value, 0)
  for (const t of out) {
    const expected = (t.value / sum) * 200 * 100
    assert.ok(Math.abs(area(t) - expected) < 0.5,
      `${t.value} 의 면적 ${area(t)} 가 기대값 ${expected} 와 다르다`)
  }
})

test("squarify: 타일이 서로 겹치지 않는다", () => {
  const items = [5, 4, 3, 2, 1, 1, 1].map((value) => ({ value }))
  const out = squarify(items, 0, 0, 300, 200)
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      const a = out[i], b = out[j]
      const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
      assert.ok(overlap < 0.01, `${i}번과 ${j}번 타일이 겹친다`)
    }
  }
})

test("squarify: 모든 타일이 주어진 사각형 안에 있다", () => {
  const out = squarify([9, 5, 3, 1].map((value) => ({ value })), 10, 20, 100, 80)
  for (const t of out) {
    assert.ok(t.x >= 10 - 0.01 && t.x + t.w <= 110 + 0.01, "가로 범위 이탈")
    assert.ok(t.y >= 20 - 0.01 && t.y + t.h <= 100 + 0.01, "세로 범위 이탈")
  }
})

test("squarify: 항목 하나면 사각형 전체를 쓴다. 빈 배열은 빈 결과", () => {
  const [one] = squarify([{ value: 7 }], 0, 0, 40, 60)
  assert.deepEqual([one.x, one.y, one.w, one.h], [0, 0, 40, 60])
  assert.deepEqual(squarify([], 0, 0, 10, 10), [])
})

test("inkA: 0 도 완전히 투명하지 않고, 100 에서 가장 진하며, 범위를 벗어나면 잘린다", () => {
  assert.ok(inkA(0) > 0)
  assert.ok(inkA(100) > inkA(50) && inkA(50) > inkA(0))
  assert.equal(inkA(-20), inkA(0))
  assert.equal(inkA(999), inkA(100))
  assert.ok(inkA(100) <= 1)
})

test("perQuestion: 질문별로 셀을 합치고 중위 순위를 낸다", () => {
  const b = {
    matrix: [
      { model: "m1", question: "q1", V: 5, mentions: 5, medianRank: 2 },
      { model: "m2", question: "q1", V: 5, mentions: 3, medianRank: 4 },
      { model: "m1", question: "q2", V: 5, mentions: 0, medianRank: null },
    ],
  }
  const per = perQuestion(b)
  const q1 = per.find((p) => p.q === "q1")
  assert.equal(q1.V, 10)
  assert.equal(q1.mentions, 8)
  assert.equal(q1.rate, 80)
  const q2 = per.find((p) => p.q === "q2")
  assert.equal(q2.rate, 0)
  assert.equal(q2.medianRank, null) // 미언급뿐이면 순위가 없다
})
