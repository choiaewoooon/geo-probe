// 브라우저에서 도는 측정 엔진.
//
// 설계 원칙: AI 접속 키는 이 브라우저를 떠나지 않는다.
// 키는 localStorage 에만 저장하고, 호출은 브라우저가 AI 회사 서버로 직접 보낸다.
// 이 사이트에는 서버가 없으므로 키가 우리 쪽으로 전달될 경로 자체가 없다.
//
// 측정 로직(파싱·지표)은 CLI 와 똑같은 파일을 그대로 쓴다. 두 벌로 나뉘면 결과가 갈린다.
import { measureResponse, buildAliasIndex } from "./lib/parse.mjs"

const KEY_STORE = "geo.keys"
const RESULT_STORE = "geo.rows"
const CONFIG_STORE = "geo.config"

// ---------- 키 (이 브라우저에만) ----------
export const keys = {
  load() {
    try { return JSON.parse(localStorage.getItem(KEY_STORE) || "{}") } catch { return {} }
  },
  save(patch) {
    const cur = keys.load()
    for (const [k, v] of Object.entries(patch)) {
      if (v && String(v).trim()) cur[k] = String(v).trim()
      else delete cur[k]
    }
    localStorage.setItem(KEY_STORE, JSON.stringify(cur))
    return keys.status()
  },
  clear() { localStorage.removeItem(KEY_STORE) },
  status() {
    const k = keys.load()
    return { openai: Boolean(k.openai), gemini: Boolean(k.gemini), anthropic: Boolean(k.anthropic) }
  },
}

// ---------- 내 측정 결과 (이 브라우저에만) ----------
export const store = {
  load() {
    try { return JSON.parse(localStorage.getItem(RESULT_STORE) || "[]") } catch { return [] }
  },
  save(rows) { localStorage.setItem(RESULT_STORE, JSON.stringify(rows)) },
  clear() { localStorage.removeItem(RESULT_STORE) },
  loadConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_STORE) || "null") } catch { return null }
  },
  saveConfig(c) { localStorage.setItem(CONFIG_STORE, JSON.stringify(c)) },
}

// ---------- 모델 호출 ----------
async function post(url, headers, body, label) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ""
    try { detail = (await res.text()).slice(0, 200) } catch {}
    throw new Error(`${label} ${res.status}: ${detail}`)
  }
  return res.json()
}
const uniqHosts = (urls) => [...new Set(urls.filter(Boolean).map((u) => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") } catch { return null }
}).filter(Boolean))]

const CALLERS = {
  async openai(prompt, m, key) {
    const j = await post("https://api.openai.com/v1/responses",
      { authorization: `Bearer ${key}` },
      { model: m.model ?? "gpt-4o", input: prompt, ...(m.webSearch === false ? {} : { tools: [{ type: "web_search" }] }) },
      "OpenAI")
    const texts = [], cites = []
    for (const item of j.output ?? []) {
      for (const c of item.content ?? []) {
        if (typeof c.text === "string") texts.push(c.text)
        for (const a of c.annotations ?? []) if (a.url) cites.push(a.url)
      }
    }
    if (!texts.length && typeof j.output_text === "string") texts.push(j.output_text)
    return { text: texts.join("\n").trim(), citations: uniqHosts(cites) }
  },

  async gemini(prompt, m, key) {
    const model = m.model ?? "gemini-2.5-flash"
    const j = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {},
      { contents: [{ parts: [{ text: prompt }] }], ...(m.webSearch === false ? {} : { tools: [{ google_search: {} }] }) },
      "Gemini")
    const cand = j.candidates?.[0]
    const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? ""
    const cites = (cand?.groundingMetadata?.groundingChunks ?? []).map((c) => c.web?.uri)
    return { text: text.trim(), citations: uniqHosts(cites) }
  },

  async anthropic(prompt, m, key) {
    // 브라우저에서 직접 호출하려면 Anthropic 이 요구하는 허용 헤더가 필요하다.
    const j = await post("https://api.anthropic.com/v1/messages", {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }, {
      model: m.model ?? "claude-sonnet-4-5",
      max_tokens: m.maxTokens ?? 1500,
      messages: [{ role: "user", content: prompt }],
      ...(m.webSearch === false ? {} : { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }),
    }, "Anthropic")
    const texts = [], cites = []
    for (const b of j.content ?? []) {
      if (b.type === "text" && b.text) {
        texts.push(b.text)
        for (const c of b.citations ?? []) if (c.url) cites.push(c.url)
      }
      if (b.type === "web_search_tool_result") for (const r of b.content ?? []) if (r.url) cites.push(r.url)
    }
    return { text: texts.join("\n").trim(), citations: uniqHosts(cites) }
  },
}

/** 키 하나로 실제 호출이 되는지 확인한다(짧은 질의 1회). */
export async function testKey(providerId, key) {
  const m = { id: providerId, webSearch: false }
  const { text } = await CALLERS[providerId]('"OK" 라고만 답해줘.', m, key)
  return Boolean(text)
}

// ---------- 측정 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 브라우저에서 측정을 돌린다.
 * onProgress({done, total, model, question, repeat, ok, message}) 로 진행 상황을 알린다.
 */
export async function runMeasurement({ config, onProgress, signal }) {
  const k = keys.load()
  const models = config.models.filter((m) => k[m.provider ?? m.id])
  if (!models.length) throw new Error("사용할 수 있는 키가 없습니다. 설정에서 키를 먼저 넣어주세요.")

  const aliasIndex = buildAliasIndex({
    [config.brand]: config.brandAliases ?? [],
    ...(config.competitorAliases ?? {}),
  })
  const suffix = config.rankedListSuffix ??
    '\n\n가장 적합한 순서대로 회사 5곳만, 다른 설명 없이 "1. 이름" 형식의 번호 목록으로만 답해줘.'
  const N = config.repeats ?? 5
  const total = models.length * config.questions.length * N
  const run_id = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
  const ts = new Date().toISOString()
  const rows = []
  let done = 0

  for (const m of models) {
    const provider = m.provider ?? m.id
    for (const q of config.questions) {
      for (let r = 1; r <= N; r += 1) {
        if (signal?.aborted) return rows
        let ok = false
        let message = ""
        try {
          const { text, citations } = await CALLERS[provider](q.prompt + suffix, m, k[provider])
          const measured = measureResponse(text, { brand: config.brand, aliasIndex })
          if (measured) {
            measured.citations = [...new Set([...(measured.citations ?? []), ...citations])]
            rows.push({
              run_id, ts, protocol: config.protocol ?? "browser",
              brand: config.brand, model: m.id, question: q.id, repeat: r,
              web_search: m.webSearch !== false, ...measured,
            })
            ok = true
          } else {
            message = "빈 응답"
          }
        } catch (e) {
          message = e.message
        }
        done += 1
        onProgress?.({ done, total, model: m.name ?? m.id, question: q.short ?? q.id, repeat: r, ok, message })
        if (config.spacingMs) await sleep(config.spacingMs)
      }
    }
  }
  return rows
}

/** 기본 설정 — 브랜드와 질문만 바꾸면 어떤 브랜드든 측정된다. */
export function defaultConfig() {
  return {
    brand: "",
    brandAliases: [],
    repeats: 3,
    spacingMs: 0,
    protocol: "browser",
    models: [
      { id: "chatgpt", name: "ChatGPT", provider: "openai", model: "gpt-4o", webSearch: true },
      { id: "gemini", name: "Gemini", provider: "gemini", model: "gemini-2.5-flash", webSearch: true },
      { id: "claude", name: "Claude", provider: "anthropic", model: "claude-sonnet-4-5", webSearch: true },
    ],
    questions: [
      { id: "q1", short: "카테고리 추천", prompt: "" },
      { id: "q2", short: "문제 서술", prompt: "" },
    ],
  }
}
