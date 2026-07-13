// 모델 호출 추상화 — API 키 기반(openai·gemini·anthropic) + 개인 CLI용 command 어댑터.
// 각 provider는 async ask(prompt, model) → { text } 를 구현한다.
import { execFile } from "node:child_process"

function envKey(name) {
  const v = process.env[name]
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다 (.env 참고)`)
  return v
}

async function openai(prompt, m) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${envKey("OPENAI_API_KEY")}` },
    body: JSON.stringify({ model: m.model ?? "gpt-4o", messages: [{ role: "user", content: prompt }], temperature: m.temperature ?? 1 }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return { text: j.choices?.[0]?.message?.content ?? "" }
}

async function gemini(prompt, m) {
  const model = m.model ?? "gemini-1.5-pro"
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${envKey("GEMINI_API_KEY")}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return { text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "" }
}

async function anthropic(prompt, m) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": envKey("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: m.model ?? "claude-sonnet-4-5", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return { text: j.content?.map((b) => b.text).join("") ?? "" }
}

// 개인 CLI 래퍼 등 임의 명령. model.command = ["/path/to/cli", "arg1", ...] → 마지막 인자로 prompt 추가.
function command(prompt, m) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = m.command
    execFile(cmd, [...args, prompt], { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(`command 실패: ${err.message}`))
      resolve({ text: stdout.trim() })
    })
  })
}

const providers = { openai, gemini, anthropic, command }

export async function ask(prompt, model) {
  const fn = providers[model.provider]
  if (!fn) throw new Error(`알 수 없는 provider: ${model.provider} (openai·gemini·anthropic·command 중 하나)`)
  return fn(prompt, model)
}
