import test from "node:test"
import assert from "node:assert/strict"
import { trackTargets, rowKey } from "../src/analyze.mjs"

const base = {
  brand: "Naver Map",
  brandAliases: ["네이버 지도"],
  competitorAliases: {
    "Naver Map": ["네이버지도"],
    KakaoMap: ["카카오맵", "Daum Map"],
    Toss: ["토스"],
  },
  models: [{ id: "chatgpt" }],
}

test("trackTargets: trackBrands 가 없으면 기존처럼 단일 브랜드만 본다", () => {
  const t = trackTargets(base)
  assert.equal(t.length, 1)
  assert.equal(t[0].brand, "Naver Map")
  // 자기 자신은 competitorAliases 가 아니라 brandAliases 를 그대로 쓴다.
  assert.deepEqual(t[0].brandAliases, ["네이버 지도"])
})

test("trackTargets: 브랜드마다 competitorAliases 에서 별칭을 가져온다", () => {
  const t = trackTargets({ ...base, trackBrands: ["KakaoMap", "Toss"] })
  assert.deepEqual(t.map((x) => x.brand), ["KakaoMap", "Toss"])
  assert.deepEqual(t[0].brandAliases, ["카카오맵", "Daum Map"])
  assert.deepEqual(t[1].brandAliases, ["토스"])
})

test("trackTargets: 별칭이 없는 브랜드도 빈 배열로 안전하게 돈다", () => {
  const t = trackTargets({ ...base, trackBrands: ["Unlisted App"] })
  assert.deepEqual(t[0].brandAliases, [])
})

test("trackTargets: 나머지 설정(질문·모델)은 그대로 물려준다", () => {
  const t = trackTargets({ ...base, trackBrands: ["KakaoMap"] })
  assert.deepEqual(t[0].models, base.models)
  assert.equal(t[0].competitorAliases, base.competitorAliases)
})

test("rowKey: 브랜드가 키에 들어가야 같은 응답을 여러 브랜드로 채점해도 안 겹친다", () => {
  const row = { run_id: "r1", model: "chatgpt", question: "q1", repeat: 1 }
  assert.notEqual(
    rowKey({ ...row, brand: "Naver Map" }),
    rowKey({ ...row, brand: "KakaoMap" }),
  )
})
