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
      idx.set(entityKey(term), canonical)
    }
  }
  return idx
}

// 한글은 2글자로도 충분한 식별자다("버슨"). 영문은 오탐이 잦아 3글자 이상만 부분 일치시킨다.
// (실측 2026-07-26: 임계값 3 때문에 "시너지버슨"·"버슨콘앤울프 코리아"를 놓쳐 언급을 과소집계했다.)
const hasHangul = (s) => /[가-힣]/.test(s)

/**
 * 집계 키. 표기가 달라도 같은 앱이면 한 칸에 모으기 위한 것.
 *
 * 🔒 이게 없어서 같은 앱이 최대 3개로 쪼개졌다 —
 * iM Taxi / i.M Taxi / i.M, HANPASS / Hanpass, Korea Tour Card / KOREA TOUR CARD,
 * Tabling / Tableing, McDelivery / McDelivery Korea. 로고까지 따로 받아졌다.
 */
/** 브랜드 뒤에 붙어도 같은 브랜드인 말. 이 목록 밖이면 다른 제품으로 본다. */
const MODIFIERS = new Set([
  "korea", "kr", "global", "worldwide", "international", "asia",
  "inc", "corp", "corporation", "ltd", "llc", "co", "group", "company",
  "app", "official", "코리아", "한국", "글로벌",
])

export const entityKey = (n) => String(n ?? "").toLowerCase().normalize("NFKC")
  .replace(/[^\p{L}\p{N}]/gu, "")

export function normalizeBrand(name, aliasIndex) {
  const key = entityKey(name)
  if (!key) return null
  if (aliasIndex.has(key)) return aliasIndex.get(key)
  // 부분 일치 — "Burson Korea", "시너지버슨"처럼 앞뒤에 수식어가 붙는 경우.
  // 가장 긴 별칭부터 검사해 "버슨"이 "버슨콘앤울프"를 가로채지 않게 한다.
  // 🔒 라틴 별칭의 부분 일치는 남는 말이 '시장·법인 수식어'일 때만 허용한다.
  //
  // 무조건 includes 하면 "Uber Eats"(배달)가 "Uber"(택시)로 합쳐진다 — 실측 확인.
  // 단어 경계를 줘도 안 된다. "Uber Eats" 는 정말로 Uber 라는 단어를 품고 있다.
  // 그렇다고 부분 일치를 없애면 "Burson Korea" 를 놓친다. 가르는 기준은 남는 토큰이
  // 지역·법인격 같은 수식어인가, 아니면 다른 제품을 뜻하는 말인가다.
  //
  // 한글은 조사와 합성이 흔해("시너지버슨", "버슨콘앤울프") includes 를 유지한다.
  // 이걸 놓쳐 언급을 과소집계한 실측 사고가 있었다(2026-07-26).
  for (const [alias, canonical] of [...aliasIndex].sort((a, b) => b[0].length - a[0].length)) {
    if (hasHangul(alias)) {
      if (alias.length >= 2 && key.includes(alias)) return canonical
    } else if (alias.length >= 3 && key.includes(alias)) {
      const rest = key.split(alias).join("")
      if (!rest || MODIFIERS.has(rest)) return canonical
    }
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
  // 경계 없이 검사하면 본문의 "KakaoTalk" 이 brand "Kakao T" 를 언급으로 만든다(실측).
  const proseRe = hasHangul(brand)
    ? new RegExp(escapeRe(brand))
    : new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(brand)}(?:[^A-Za-z0-9]|$)`, "i")
  const mentionedInProse = normalizeBrand(brand, aliasIndex) === brand && proseRe.test(raw)

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
