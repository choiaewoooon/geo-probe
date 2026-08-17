// 응답 원문 파싱 — 번호 목록의 "전 항목"과 인용 도메인을 뽑는다.
// v1은 자사 브랜드 순위만 뽑고 나머지를 버렸다. 경쟁 구도·인용 지표의 원재료가 여기서 나온다.

const NUMBERED = /^\s*(\d+)\s*[.)]\s*(.+)$/

// 항목 텍스트에서 회사명만 남긴다. "**Edelman** — 글로벌 1위" → "Edelman"
export function cleanEntry(raw) {
  return raw
    .replace(/\*\*/g, "")
    .replace(/^[`"'\s]+|[`"'\s]+$/g, "")
    .split(/\s[—–-]\s|[:(]/)[0]
    .replace(/\s+/g, " ")
    .trim()
}

// 번호 목록 → [{ rank, name }]. 목록이 아니면 빈 배열.
export function parseEntries(text) {
  const out = []
  const seen = new Set()
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(NUMBERED)
    if (!m) continue
    const name = cleanEntry(m[2])
    if (!name) continue
    const rank = Number(m[1])
    if (seen.has(rank)) continue // 같은 번호 중복 방지
    seen.add(rank)
    out.push({ rank, name })
  }
  return out.sort((a, b) => a.rank - b.rank)
}

// 응답에 등장한 URL → 정규화 도메인 배열(중복 제거, 등장 순).
export function extractCitations(text) {
  const out = []
  const seen = new Set()
  const re = /https?:\/\/([^\s/)\]"'>,]+)/gi
  for (const m of String(text ?? "").matchAll(re)) {
    const host = m[1].toLowerCase().replace(/^www\./, "").replace(/[.,;]+$/, "")
    if (!host.includes(".")) continue
    if (seen.has(host)) continue
    seen.add(host)
    out.push(host)
  }
  return out
}

// 별칭 사전으로 표기 흔들림을 하나의 엔티티로 통합.
// dict: { "Burson": ["버슨", "BCW", "Burson-Marsteller"], ... }
export function buildAliasIndex(dict = {}) {
  const idx = new Map()
  for (const [canonical, aliases] of Object.entries(dict)) {
    for (const term of [canonical, ...(aliases ?? [])]) {
      idx.set(String(term).toLowerCase().replace(/\s+/g, ""), canonical)
    }
  }
  return idx
}

// 한글은 2글자로도 충분한 식별자다("버슨"). 영문은 오탐이 잦아 3글자 이상만 부분 일치시킨다.
// (실측 2026-07-26: 임계값 3 때문에 "시너지버슨"·"버슨콘앤울프 코리아"를 놓쳐 언급을 과소집계했다.)
const hasHangul = (s) => /[가-힣]/.test(s)

export function normalizeBrand(name, aliasIndex) {
  const key = String(name ?? "").toLowerCase().replace(/\s+/g, "")
  if (!key) return null
  if (aliasIndex.has(key)) return aliasIndex.get(key)
  // 부분 일치 — "Burson Korea", "시너지버슨"처럼 앞뒤에 수식어가 붙는 경우.
  // 가장 긴 별칭부터 검사해 "버슨"이 "버슨콘앤울프"를 가로채지 않게 한다.
  for (const [alias, canonical] of [...aliasIndex].sort((a, b) => b[0].length - a[0].length)) {
    const min = hasHangul(alias) ? 2 : 3
    if (alias.length >= min && key.includes(alias)) return canonical
  }
  return name
}

// 한 응답을 측정 행으로 환원한다. 자사 순위 + 전 항목 + 인용을 한 번에.
export function measureResponse(text, { brand, aliasIndex }) {
  const raw = String(text ?? "").trim()
  if (!raw) return null // 빈 응답 = 무효(유효 응답 수에서 제외)

  const entries = parseEntries(raw).map((e) => ({ ...e, name: normalizeBrand(e.name, aliasIndex) }))
  const hit = entries.find((e) => e.name === brand)

  // 목록에 없더라도 본문에 브랜드가 등장하면 '언급'으로는 인정하되 순위는 null.
  const mentionedInProse = normalizeBrand(brand, aliasIndex) === brand
    && new RegExp(escapeRe(brand), "i").test(raw)

  return {
    mentioned: Boolean(hit) || mentionedInProse,
    rank: hit ? hit.rank : null, // 산문 언급은 순위 통계에서 제외
    listed: entries.length > 0,
    entries: entries.map((e) => e.name),
    entriesWithRank: entries,
    citations: extractCitations(raw),
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
