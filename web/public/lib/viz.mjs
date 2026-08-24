// 화면 조립과 무관한 순수 계산. DOM 없이 돌고 테스트가 닿는다.
//
// squarify 는 특히 떼어낼 값이 있다. 배치가 틀려도 화면은 그럴듯하게 그려지고
// 사람 눈으로는 면적 비율이 어긋난 걸 못 잡는다. 조용히 모든 트리맵을 왜곡한다.

/** 값(0~100)을 잉크 농도로. 0 도 완전히 투명하지는 않게 바닥을 둔다. */
export const inkA = (rate) => 0.1 + (Math.max(0, Math.min(100, rate)) / 100) * 0.85

/**
 * squarified treemap. 주어진 사각형을 value 비율대로 나누되 각 타일이
 * 정사각형에 가깝게 되도록 행을 끊는다.
 */
export function squarify(items, x, y, w, h, out = []) {
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

/** 브랜드의 질문별 집계. 판세 표와 밀도판이 같은 수를 쓰게 한다. */
export function perQuestion(b) {
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
