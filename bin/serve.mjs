#!/usr/bin/env node
// 로컬 서버 — 대시보드(정적)와 실행 API를 한 포트에서 제공한다.
// 브라우저에서 측정·굽기를 실행하고 진행 로그를 실시간으로 본다.
//
// 안전장치(로컬 전용 도구지만 최소한은 지킨다):
//   - 127.0.0.1 에만 바인딩 (외부에서 접근 불가)
//   - 실행 가능한 명령은 화이트리스트 3개(run/quick/export)뿐, 임의 인자 주입 불가
//   - config 는 configs/ 안의 실제 파일명만 허용 (경로 이탈 차단)
//   - 동시에 한 작업만 실행
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const WEB = path.join(ROOT, "web", "public")
const CONFIGS = path.join(ROOT, "configs")
const PORT = Number(process.env.PORT ?? 4178)

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" }

let job = null // { kind, config, startedAt, lines[], done, code }
const clients = new Set()

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

function listConfigs() {
  if (!fs.existsSync(CONFIGS)) return []
  return fs.readdirSync(CONFIGS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CONFIGS, f), "utf8"))
        return {
          file: f,
          brand: c.brand,
          models: (c.models ?? []).map((m) => ({ name: m.name, provider: m.provider })),
          questions: (c.questions ?? []).length,
          repeats: c.repeats ?? 5,
          estimateMin: Math.ceil(((c.models ?? []).length * (c.questions ?? []).length * ((c.repeats ?? 5) - 1) * (c.spacingMs ?? 8000)) / 60000),
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// 저장을 허용하는 키 이름 화이트리스트. 임의 환경변수 주입을 막는다.
const ALLOWED_KEYS = { openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }

/**
 * .env 를 읽어 { NAME: value } 로. 이 값은 파일 갱신에만 쓰고 응답으로 절대 내보내지 않는다.
 */
function readEnvFile() {
  const p = path.join(ROOT, ".env")
  const out = {}
  if (!fs.existsSync(p)) return out
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return out
}

/**
 * 키를 저장한다. 빈 문자열이 오면 그 키를 삭제한다.
 * 파일 권한은 0600(소유자만 읽기/쓰기)으로 강제한다.
 */
function saveKeys(patch) {
  const p = path.join(ROOT, ".env")
  const env = readEnvFile()
  const changed = []
  for (const [slot, name] of Object.entries(ALLOWED_KEYS)) {
    if (!(slot in patch)) continue
    const raw = String(patch[slot] ?? "").trim()
    if (!raw) {
      if (name in env) { delete env[name]; changed.push(`${slot} 삭제`) }
      continue
    }
    // 값에 개행이 섞이면 .env 형식이 깨지므로 차단
    if (/[\n\r]/.test(raw)) return { error: `${slot}: 줄바꿈이 포함된 값은 저장할 수 없습니다.` }
    env[name] = raw
    changed.push(`${slot} 저장`)
  }
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
  fs.writeFileSync(p, body, { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* 파일시스템이 지원 안 하면 무시 */ }

  // 현재 프로세스에도 즉시 반영 → 서버 재시작 없이 바로 측정 가능
  for (const [slot, name] of Object.entries(ALLOWED_KEYS)) {
    if (!(slot in patch)) continue
    if (env[name]) process.env[name] = env[name]
    else delete process.env[name]
  }
  return { ok: true, changed }
}

/** 어떤 provider 키가 준비됐는지 — 값은 절대 노출하지 않는다. */
function keyStatus() {
  // .env 를 읽되 값은 버리고 이름만 본다.
  const envPath = path.join(ROOT, ".env")
  const names = new Set(Object.keys(process.env))
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/)
      if (m && m[2].trim()) names.add(m[1])
    }
  }
  return {
    openai: names.has("OPENAI_API_KEY"),
    gemini: names.has("GEMINI_API_KEY"),
    anthropic: names.has("ANTHROPIC_API_KEY"),
  }
}

function historyStat() {
  const p = path.join(ROOT, "data", "history.jsonl")
  if (!fs.existsSync(p)) return { rows: 0, runs: 0, lastRun: null }
  const rows = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const runs = [...new Set(rows.map((r) => r.run_id))].sort()
  return { rows: rows.length, runs: runs.length, lastRun: runs.at(-1) ?? null }
}

/** 화이트리스트된 작업만 실행한다. 사용자가 보낸 문자열이 인자로 흘러가지 않게 한다. */
function startJob(kind, configFile) {
  if (job && !job.done) return { error: "이미 실행 중인 작업이 있습니다." }

  let args
  if (kind === "export") {
    args = ["bin/geo-probe.mjs", "export"]
  } else if (kind === "run" || kind === "quick") {
    args = ["bin/geo-probe.mjs", "run"]
    if (kind === "quick") args.push("--quick")
  } else {
    return { error: `알 수 없는 작업: ${kind}` }
  }

  // config: configs/ 안의 실제 파일명과 정확히 일치할 때만 허용(경로 이탈 차단)
  if (configFile) {
    const allowed = listConfigs().map((c) => c.file)
    if (!allowed.includes(configFile)) return { error: `허용되지 않은 설정: ${configFile}` }
    args.push("--config", path.join("configs", configFile))
  }

  job = { kind, config: configFile ?? null, startedAt: new Date().toISOString(), lines: [], done: false, code: null }
  broadcast("start", { kind, config: configFile })

  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env })
  const push = (chunk, stream) => {
    const text = chunk.toString()
    job.lines.push(text)
    if (job.lines.length > 800) job.lines.splice(0, job.lines.length - 800)
    broadcast("log", { text, stream })
  }
  child.stdout.on("data", (c) => push(c, "out"))
  child.stderr.on("data", (c) => push(c, "err"))

  child.on("close", async (code) => {
    job.code = code
    // 측정이 성공했으면 대시보드 데이터까지 자동으로 굽는다(수동 단계 제거).
    if (code === 0 && kind !== "export") {
      broadcast("log", { text: "\n대시보드 데이터 생성 중…\n", stream: "out" })
      await new Promise((resolve) => {
        const ex = spawn(process.execPath, ["bin/geo-probe.mjs", "export"], { cwd: ROOT, env: process.env })
        ex.stdout.on("data", (c) => push(c, "out"))
        ex.stderr.on("data", (c) => push(c, "err"))
        ex.on("close", resolve)
      })
    }
    job.done = true
    broadcast("done", { code, kind, history: historyStat() })
  })

  return { ok: true }
}

function json(res, body, status = 200) {
  const s = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) })
  res.end(s)
}

/**
 * 이 서버는 인증이 없다. 브라우저가 켜져 있는 동안 사용자가 방문한 아무 사이트나
 * fetch 로 /api/keys 를 때려 .env 를 덮어쓰거나 /api/run 으로 유료 호출을 시작시킬 수 있다.
 * Content-Type: text/plain 이면 preflight 도 없어서 그냥 통과한다.
 * 응답은 CORS 가 막아 못 읽지만, 파괴와 과금은 그대로 일어난다.
 */
function sameOrigin(req) {
  const o = req.headers.origin
  if (!o) return true // curl·수동 호출은 CSRF 가 아니다
  return o === `http://localhost:${PORT}` || o === `http://127.0.0.1:${PORT}`
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === "/api/status") {
    return json(res, {
      configs: listConfigs(),
      keys: keyStatus(),
      history: historyStat(),
      job: job ? { kind: job.kind, config: job.config, startedAt: job.startedAt, done: job.done, code: job.code } : null,
    })
  }

  if (url.pathname === "/api/logs") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    res.write(`event: hello\ndata: ${JSON.stringify({ lines: job?.lines ?? [], running: Boolean(job && !job.done) })}\n\n`)
    clients.add(res)
    req.on("close", () => clients.delete(res))
    return
  }

  if (req.method === "POST" && !sameOrigin(req)) {
    return json(res, { error: "cross-origin 요청은 받지 않습니다." }, 403)
  }

  if (url.pathname === "/api/keys" && req.method === "POST") {
    let body = ""
    req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy() })
    req.on("end", () => {
      let p = {}
      try { p = JSON.parse(body || "{}") } catch { return json(res, { error: "잘못된 요청입니다." }, 400) }
      const r = saveKeys(p)
      // 응답에 키 값을 담지 않는다. 어떤 슬롯이 채워졌는지만.
      json(res, r.error ? r : { ok: true, changed: r.changed, keys: keyStatus() }, r.error ? 400 : 200)
    })
    return
  }

  if (url.pathname === "/api/run" && req.method === "POST") {
    let body = ""
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy() })
    req.on("end", () => {
      let p = {}
      try { p = JSON.parse(body || "{}") } catch {}
      const r = startJob(String(p.kind ?? ""), p.config ? String(p.config) : null)
      json(res, r, r.error ? 400 : 200)
    })
    return
  }

  // 정적 파일
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "")
  const file = path.join(WEB, rel)
  if (!file.startsWith(WEB + path.sep) && file !== WEB) { res.writeHead(403); return res.end("forbidden") }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("not found") }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" })
    res.end(buf)
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\ngeo-probe 대시보드 → http://localhost:${PORT}`)
  console.log(`  측정·굽기를 브라우저에서 실행할 수 있습니다. 종료: Ctrl+C\n`)
})
