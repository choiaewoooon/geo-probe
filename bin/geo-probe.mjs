#!/usr/bin/env node
// geo-probe — 브랜드의 생성형 AI 발견성(GEO)을 반복 측정한다.
//   probe    설정대로 모델×질문×반복 질의 → 원문 저장
//   analyze  저장된 원문 → 언급률·중위 순위 데이터셋 + report.md
//   run      probe 후 analyze
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ask } from "../src/providers.mjs"
import { analyze, toCsv } from "../src/analyze.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function loadEnv() {
  const p = path.join(process.cwd(), ".env")
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
}
function loadConfig() {
  const p = path.resolve(process.env.GEO_CONFIG ?? path.join(process.cwd(), "geo.config.json"))
  if (!fs.existsSync(p)) throw new Error(`${path.relative(process.cwd(), p)} 이 없습니다. geo.config.example.json 을 복사해 시작하세요.`)
  return JSON.parse(fs.readFileSync(p, "utf8"))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")

async function probe(config, runDir) {
  const suffix = config.rankedListSuffix ?? '\n\n가장 적합한 순서대로 회사 5곳만, 다른 설명 없이 "1. 이름" 형식의 번호 목록으로만 답해줘.'
  const N = config.repeats ?? 5
  for (const model of config.models) {
    for (const q of config.questions) {
      const dir = path.join(runDir, "raw", model.id)
      fs.mkdirSync(dir, { recursive: true })
      process.stdout.write(`  ${model.id} · ${q.id} `)
      for (let r = 1; r <= N; r += 1) {
        try {
          const { text } = await ask(q.prompt + suffix, model)
          fs.writeFileSync(path.join(dir, `${q.id}-run${r}.txt`), text)
          process.stdout.write(text.trim() ? "." : "·")
        } catch (e) {
          fs.writeFileSync(path.join(dir, `${q.id}-run${r}.txt`), "")
          process.stdout.write("x")
          if (process.env.GEO_DEBUG) console.error(`\n    ${e.message}`)
        }
        if (r < N) await sleep(config.spacingMs ?? 8000)
      }
      process.stdout.write(` ${N}\n`)
    }
  }
}

function report(config, runDir, result) {
  const nameOf = Object.fromEntries(config.models.map((m) => [m.id, m.name]))
  const cell = (mid, qid) => {
    const c = result.cells[mid]?.[qid]
    if (!c || !c.n) return "n/a"
    if (!c.mentions) return `미언급 (0/${c.n})`
    return `${c.medianRank}위 (${c.mentions}/${c.n})`
  }
  const header = `| 질문 | ${config.models.map((m) => nameOf[m.id]).join(" | ")} |`
  const sep = `|---|${config.models.map(() => "---").join("|")}|`
  const lines = config.questions.map((q) => `| ${q.id.toUpperCase()} · ${q.short ?? q.prompt.slice(0, 20)} | ${config.models.map((m) => cell(m.id, q.id)).join(" | ")} |`)
  const firstPlace = result.rows.filter((r) => r.rank === 1).length
  const total = result.rows.filter((r) => r.rank !== null || true).length
  const md = `# GEO 측정 리포트 · ${config.brand}

> 조사일 ${stamp()} · 반복 n=${config.repeats ?? 5} · 셀 = 언급된 회차의 최초 순위 중위값 (괄호 = 반복 중 언급 횟수)

${header}
${sep}
${lines.join("\n")}

- 총 ${total}개 실행 중 **1위 등장 ${firstPlace}회**
- 웹 검색 사용 여부가 모델마다 다를 수 있어(설정에 기록) 절대 비교가 아닌 단일 시점 관찰입니다.
- 원문·데이터셋: \`${path.relative(process.cwd(), runDir)}/\`
`
  return md
}

async function main() {
  loadEnv()
  const cmd = process.argv[2] ?? "run"
  const config = loadConfig()
  const arg = process.argv[3]

  if (cmd === "probe" || cmd === "run") {
    const runDir = path.join(process.cwd(), "results", stamp())
    fs.mkdirSync(runDir, { recursive: true })
    console.log(`\ngeo-probe · ${config.brand} · ${config.models.length}모델 × ${config.questions.length}질문 × ${config.repeats ?? 5}회`)
    await probe(config, runDir)
    if (cmd === "run") doAnalyze(config, runDir)
    else console.log(`\n원문 저장: ${path.relative(process.cwd(), runDir)}\n다음: npm run analyze -- ${path.relative(process.cwd(), runDir)}`)
    return
  }
  if (cmd === "analyze") {
    if (!arg) throw new Error("사용: npm run analyze -- <results/디렉터리>")
    doAnalyze(config, path.resolve(arg))
    return
  }
  throw new Error(`알 수 없는 명령: ${cmd} (probe · analyze · run)`)
}

function doAnalyze(config, runDir) {
  const result = analyze(runDir, config)
  fs.writeFileSync(path.join(runDir, "measurements.csv"), toCsv(result.rows))
  fs.writeFileSync(path.join(runDir, "report.md"), report(config, runDir, result))
  console.log(`\n분석 완료 → ${path.relative(process.cwd(), runDir)}/report.md`)
  console.log(fs.readFileSync(path.join(runDir, "report.md"), "utf8"))
}

main().catch((e) => {
  console.error(`\n[geo-probe] ${e.message}`)
  process.exit(1)
})
