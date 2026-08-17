#!/usr/bin/env node
// geo-probe — 브랜드의 생성형 AI 발견성(GEO)을 반복 측정한다.
//   run [--quick] [--config p]  측정 + 분석 (기본)
//   probe                       측정만 (원문 저장)
//   analyze <dir>               저장된 원문 → 지표
//   trend                       history.jsonl → 추세 요약
//   export                      대시보드용 summary.json 생성
import fs from "node:fs"
import path from "node:path"
import { ask } from "../src/providers.mjs"
import {
  collectRows, expectedCount, appendHistory, readHistory, toCsv, report,
} from "../src/analyze.mjs"
import { summarize } from "../src/metrics.mjs"

const HISTORY = path.join(process.cwd(), "data", "history.jsonl")

function flag(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1]?.startsWith("--") ? true : process.argv[i + 1] ?? true)
}
const has = (name) => process.argv.includes(`--${name}`)

function loadEnv() {
  const p = path.join(process.cwd(), ".env")
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
}

function loadConfig() {
  const explicit = flag("config")
  const p = path.resolve(
    typeof explicit === "string" ? explicit : process.env.GEO_CONFIG ?? path.join(process.cwd(), "geo.config.json"),
  )
  if (!fs.existsSync(p)) {
    throw new Error(`${path.relative(process.cwd(), p)} 이 없습니다. geo.config.example.json 을 복사해 시작하세요.`)
  }
  return JSON.parse(fs.readFileSync(p, "utf8"))
}

// 퀵모드: 1모델 · 2질문 · n=2 · 간격 0 → 30초 내. 데모/스모크 테스트용.
function applyQuick(config) {
  return {
    ...config,
    models: config.models.slice(0, 1),
    questions: config.questions.slice(0, 2),
    repeats: 2,
    spacingMs: 0,
    _quick: true,
  }
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
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
          const { text, citations } = await ask(q.prompt + suffix, model)
          fs.writeFileSync(path.join(dir, `${q.id}-run${r}.txt`), text)
          // 검색이 켜진 모델은 근거 URL을 함께 돌려준다. 원문과 나란히 보관해 인용 지표에 쓴다.
          if (citations?.length) {
            fs.writeFileSync(path.join(dir, `${q.id}-run${r}.cite.json`), JSON.stringify(citations, null, 1))
          }
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

function doAnalyze(config, runDir, { append = true } = {}) {
  const run_id = path.basename(runDir)
  const rows = collectRows(runDir, config, { run_id, ts: new Date().toISOString() })
  fs.writeFileSync(path.join(runDir, "measurements.csv"), toCsv(rows))
  fs.writeFileSync(path.join(runDir, "report.md"), report(config, runDir, rows))
  if (append && !config._quick) appendHistory(HISTORY, rows)
  console.log(`\n분석 완료 → ${path.relative(process.cwd(), runDir)}/report.md`)
  console.log(fs.readFileSync(path.join(runDir, "report.md"), "utf8"))
  if (config._quick) console.log("※ 퀵모드 결과는 history.jsonl 에 누적하지 않습니다(표본이 작아 추세를 왜곡).")
  return rows
}

/** 대시보드가 읽는 정적 산출물. 브랜드별로 요약을 굽는다. */
function doExport(config) {
  const all = readHistory(HISTORY)
  if (!all.length) throw new Error(`${path.relative(process.cwd(), HISTORY)} 가 비어 있습니다. 먼저 run 하세요.`)
  const brands = [...new Set(all.map((r) => r.brand))]
  const out = {
    generatedAt: new Date().toISOString(),
    brands: brands.map((b) => {
      const rows = all.filter((r) => r.brand === b)
      const runs = new Set(rows.map((r) => r.run_id)).size
      return summarize(rows, {
        brand: b,
        expected: expectedCount(config) * runs,
        ownDomains: config.ownDomains ?? [],
      })
    }),
    methodology: {
      repeats: config.repeats ?? 5,
      questions: config.questions.map((q) => ({ id: q.id, short: q.short, prompt: q.prompt })),
      models: config.models.map((m) => ({ id: m.id, name: m.name, model: m.model, webSearch: m.webSearch ?? false, collectedVia: m.collectedVia ?? null })),
      rankedListSuffix: config.rankedListSuffix ?? null,
      notes: [
        "고정된 추적 질문군에 대한 관찰이며 실제 시장 점유율이 아니다.",
        "소표본이므로 방향성 관찰용. 신뢰구간·유의성을 산출하지 않는다.",
        "모델별 웹검색 조건이 달라 모델 간 절대 비교를 하지 않는다.",
        "인용 도메인은 '응답에 표시된 출처'이며 노출의 원인으로 단정하지 않는다.",
        "미언급 응답은 순위 통계에서 제외한다(최하위 치환 금지).",
      ],
    },
  }
  const dest = path.join(process.cwd(), "web", "public", "summary.json")
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(out, null, 2))
  console.log(`대시보드 데이터 생성 → ${path.relative(process.cwd(), dest)} (브랜드 ${brands.length}, 행 ${all.length})`)
}

function doTrend(config) {
  const all = readHistory(HISTORY)
  if (!all.length) return console.log("history.jsonl 이 비어 있습니다.")
  for (const b of [...new Set(all.map((r) => r.brand))]) {
    const rows = all.filter((r) => r.brand === b)
    const s = summarize(rows, { brand: b, expected: rows.length, ownDomains: config.ownDomains ?? [] })
    console.log(`\n■ ${b} — 가시성 ${s.status.visibility} · 결과 일관성 ${s.status.reproducibility} · 방향 ${s.status.direction}`)
    for (const p of s.trend) {
      console.log(`  ${p.run_id}  언급 ${p.mentions}/${p.V} (${p.rate}%)  이동평균 ${p.movingRate}%  중위 ${p.medianRank ?? "—"}`)
    }
  }
}

async function main() {
  loadEnv()
  const cmd = process.argv[2]?.startsWith("--") ? "run" : process.argv[2] ?? "run"
  let config = loadConfig()
  if (has("quick")) config = applyQuick(config)

  if (cmd === "probe" || cmd === "run") {
    const runDir = path.join(process.cwd(), "results", stamp())
    fs.mkdirSync(runDir, { recursive: true })
    console.log(`\ngeo-probe · ${config.brand} · ${config.models.length}모델 × ${config.questions.length}질문 × ${config.repeats ?? 5}회${config._quick ? " (퀵모드)" : ""}`)
    await probe(config, runDir)
    if (cmd === "run") doAnalyze(config, runDir)
    else console.log(`\n원문 저장: ${path.relative(process.cwd(), runDir)}`)
    return
  }
  if (cmd === "analyze") {
    const dir = process.argv[3]
    if (!dir || dir.startsWith("--")) throw new Error("사용: geo-probe analyze <results/디렉터리>")
    doAnalyze(config, path.resolve(dir))
    return
  }
  if (cmd === "trend") return doTrend(config)
  if (cmd === "export") return doExport(config)
  throw new Error(`알 수 없는 명령: ${cmd} (run · probe · analyze · trend · export)`)
}

main().catch((e) => {
  console.error(`\n[geo-probe] ${e.message}`)
  process.exit(1)
})
