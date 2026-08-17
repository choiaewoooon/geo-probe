// 모델 호출 추상화 — 각 provider는 async ask(prompt, model) → { text, citations[] } 를 구현한다.
//
// 웹 검색: 실제 사용자가 보는 답변은 대부분 검색이 붙은 답변이고, 콘텐츠 개선의 효과도
// 검색 기반 답변에서 먼저 나타난다. 그래서 model.webSearch !== false 이면 각 provider의
// 검색 도구를 켠다. 검색이 켜지면 응답이 근거로 든 URL도 함께 회수해 인용 지표에 쓴다.
import { spawn } from "node:child_process"

function envKey(name) {
  const v = process.env[name]
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다 (설정 탭 또는 .env)`)
  return v
}
const useSearch = (m) => m.webSearch !== false // 기본값 ON

async function post(url, headers, body, label) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`${label} ${res.status}: ${detail}`)
  }
  return res.json()
}

const uniq = (arr) => [...new Set(arr.filter(Boolean))]

// --- OpenAI: Responses API + web_search 툴 -----------------------------------
async function openai(prompt, m) {
  const body = {
    model: m.model ?? "gpt-4o",
    input: prompt,
    ...(useSearch(m) ? { tools: [{ type: "web_search" }] } : {}),
  }
  const j = await post("https://api.openai.com/v1/responses",
    { authorization: `Bearer ${envKey("OPENAI_API_KEY")}` }, body, "OpenAI")

  const texts = []
  const cites = []
  for (const item of j.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === "string") texts.push(c.text)
      for (const a of c.annotations ?? []) if (a.url) cites.push(a.url)
    }
  }
  // 신형 SDK 편의 필드도 지원
  if (!texts.length && typeof j.output_text === "string") texts.push(j.output_text)
  return { text: texts.join("\n").trim(), citations: uniq(cites) }
}

// --- Gemini: generateContent + google_search 그라운딩 -------------------------
async function gemini(prompt, m) {
  const model = m.model ?? "gemini-2.5-flash"
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    ...(useSearch(m) ? { tools: [{ google_search: {} }] } : {}),
  }
  const j = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${envKey("GEMINI_API_KEY")}`,
    {}, body, "Gemini")

  const cand = j.candidates?.[0]
  const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? ""
  const cites = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .concat((cand?.groundingMetadata?.groundingSupports ?? []).flatMap((s) => s.web?.uri ?? []))
  return { text: text.trim(), citations: uniq(cites) }
}

// --- Anthropic: messages + web_search 툴 --------------------------------------
async function anthropic(prompt, m) {
  const body = {
    model: m.model ?? "claude-sonnet-4-5",
    max_tokens: m.maxTokens ?? 1500,
    messages: [{ role: "user", content: prompt }],
    ...(useSearch(m) ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: m.maxSearches ?? 3 }] } : {}),
  }
  const j = await post("https://api.anthropic.com/v1/messages", {
    "x-api-key": envKey("ANTHROPIC_API_KEY"),
    "anthropic-version": "2023-06-01",
  }, body, "Anthropic")

  const texts = []
  const cites = []
  for (const b of j.content ?? []) {
    if (b.type === "text" && b.text) {
      texts.push(b.text)
      for (const c of b.citations ?? []) if (c.url) cites.push(c.url)
    }
    if (b.type === "web_search_tool_result") {
      for (const r of b.content ?? []) if (r.url) cites.push(r.url)
    }
  }
  return { text: texts.join("\n").trim(), citations: uniq(cites) }
}

// --- 임의 CLI 명령 (mock·개인 래퍼) -------------------------------------------
// stdin 은 반드시 닫는다. cdx 같은 래퍼는 stdin 을 읽으므로, 열어둔 채 두면
// EOF 를 기다리며 영원히 멈춘다(2026-07-26 실측: 첫 호출에서 무한 대기).
function command(prompt, m) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = m.command
    const child = spawn(cmd, [...args, prompt], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    let done = false
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg) } }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(out.trim() ? resolve : reject,
        out.trim() ? { text: out.trim(), citations: [] } : new Error(`command 시간 초과(${(m.timeoutMs ?? 180_000) / 1000}초)`))
    }, m.timeoutMs ?? 180_000)

    child.stdout.on("data", (c) => { out += c })
    child.stderr.on("data", (c) => { err += c })
    child.on("error", (e) => finish(reject, new Error(`command 실행 실패: ${e.message}`)))
    child.on("close", (code) => {
      if (out.trim()) return finish(resolve, { text: out.trim(), citations: [] })
      finish(reject, new Error(`command 실패(code ${code}): ${err.trim().slice(0, 200)}`))
    })
  })
}

const providers = { openai, gemini, anthropic, command }

export async function ask(prompt, model) {
  const fn = providers[model.provider]
  if (!fn) throw new Error(`알 수 없는 provider: ${model.provider} (openai·gemini·anthropic·command 중 하나)`)
  const r = await fn(prompt, model)
  return { text: r.text ?? "", citations: r.citations ?? [] }
}
