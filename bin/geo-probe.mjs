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
  collectRows, expectedCount, appendHistory, readHistory, toCsv, report, trackTargets,
} from "../src/analyze.mjs"
import { summarize, categories, categoryTrend } from "../src/metrics.mjs"

/**
 * 이력 파일. 데이터셋마다 분리할 수 있다.
 *
 * 🔒 하나에 몰아 쓰면 공개 쇼케이스 측정과 지원 중인 회사 측정이 같은 파일에 섞인다.
 * .gitignore 가 data/ 를 통째로 막고 있는 이유가 그것인데, 그러면 CI 가 회차를
 * 쌓을 수가 없다. 설정에 historyFile 을 두면 공개 데이터셋만 추적 대상으로
 * 열어 둘 수 있다.
 */
const historyPath = (config) => path.resolve(
  flagStr("history") ?? process.env.GEO_HISTORY
  ?? (config?.historyFile ? path.join(process.cwd(), config.historyFile)
      : path.join(process.cwd(), "data", "history.jsonl")),
)

function flag(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1]?.startsWith("--") ? true : process.argv[i + 1] ?? true)
}
const has = (name) => process.argv.includes(`--${name}`)
const flagStr = (name) => { const v = flag(name); return typeof v === "string" ? v : null }

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
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"))
  } catch (e) {
    throw new Error(`${path.relative(process.cwd(), p)} 을 읽지 못했습니다 (JSON 오류): ${e.message}`)
  }
  validateConfig(cfg, p)
  return cfg
}

/**
 * 설정 검증. 없으면 전부 "Cannot read properties of undefined (reading 'length')"
 * 하나로 떨어져서 무엇이 빠졌는지 알 수 없었다.
 */
function validateConfig(c, p) {
  const where = path.relative(process.cwd(), p)
  const bad = []
  if (!Array.isArray(c.questions) || !c.questions.length) bad.push("questions: 질문을 최소 하나 넣으세요")
  else {
    c.questions.forEach((q, i) => {
      if (!q?.id) bad.push(`questions[${i}].id 가 없습니다`)
      if (!q?.prompt) bad.push(`questions[${i}].prompt 가 없습니다`)
    })
  }
  if (!Array.isArray(c.models) || !c.models.length) bad.push("models: 모델을 최소 하나 넣으세요")
  else {
    c.models.forEach((m, i) => {
      if (!m?.id) bad.push(`models[${i}].id 가 없습니다`)
      if (!m?.provider) bad.push(`models[${i}].provider 가 없습니다 (openai · gemini · anthropic · command)`)
      if (m?.provider === "command" && !Array.isArray(m.command)) {
        bad.push(`models[${i}].command 는 배열이어야 합니다 (예: ["sh", "scripts/mock-model.sh"])`)
      }
    })
  }
  // brand 는 trackBrands 가 있으면 없어도 된다. 둘 다 없으면 무엇을 채점할지 모른다.
  if (!c.brand && !(Array.isArray(c.trackBrands) && c.trackBrands.length)) {
    bad.push("brand 또는 trackBrands 중 하나는 있어야 채점 대상이 정해집니다")
  }
  if (bad.length) {
    throw new Error(`${where} 설정에 문제가 있습니다.\n  - ${bad.join("\n  - ")}`)
  }
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
// 분 단위였을 때 같은 분에 두 번 돌리면 run_id 가 겹쳐 두 번째 회차가 통째로
// dedup 에 걸려 사라졌다(rowKey 에 run_id 가 들어간다). 초까지 쓴다.
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")

async function probe(config, runDir) {
  let firstError = null
  let failed = 0
  let ok = 0
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
          ok += 1
        } catch (e) {
          fs.writeFileSync(path.join(dir, `${q.id}-run${r}.txt`), "")
          process.stdout.write("x")
          // 첫 실패 원인은 GEO_DEBUG 없이도 알려준다. 키가 없는 채로 6분을 기다린 뒤
          // "완결성 0%" 리포트만 받는 게 지금까지의 동작이었다.
          if (!firstError) { firstError = e.message; console.error(`\n    ${e.message}`) }
          else if (process.env.GEO_DEBUG) console.error(`\n    ${e.message}`)
          failed += 1
          continue // 실패한 호출에는 rate-limit 간격을 지킬 이유가 없다
        }
        if (r < N) await sleep(config.spacingMs ?? 8000)
      }
      process.stdout.write(` ${N}\n`)
    }
  }
  return { ok, failed, firstError }
}

function doAnalyze(config, runDir, { append = true } = {}) {
  const run_id = path.basename(runDir)
  const ts = new Date().toISOString()
  const targets = trackTargets(config)

  // 리포트와 CSV 는 대표 브랜드(첫 대상) 기준으로 남긴다. 이력에는 전부 쌓는다.
  let primary = null
  for (const cfg of targets) {
    const rows = collectRows(runDir, cfg, { run_id, ts })
    if (!primary) {
      primary = rows
      fs.writeFileSync(path.join(runDir, "measurements.csv"), toCsv(rows))
      fs.writeFileSync(path.join(runDir, "report.md"), report(cfg, runDir, rows))
    }
    if (append && !config._quick) appendHistory(historyPath(config), rows)
  }

  console.log(`\n분석 완료 → ${path.relative(process.cwd(), runDir)}/report.md`)
  if (targets.length > 1) {
    console.log(`추적 브랜드 ${targets.length}개를 같은 응답으로 채점했습니다: ${targets.map((t) => t.brand).join(", ")}`)
  }
  console.log(fs.readFileSync(path.join(runDir, "report.md"), "utf8"))
  if (config._quick) console.log("※ 퀵모드 결과는 history.jsonl 에 누적하지 않습니다(표본이 작아 추세를 왜곡).")
  return primary
}

/** 대시보드가 읽는 정적 산출물. 브랜드별로 요약을 굽는다. */
function doExport(config) {
  const HIST = historyPath(config)
  const all = readHistory(HIST)
  if (!all.length) throw new Error(`${path.relative(process.cwd(), HIST)} 가 비어 있습니다. 먼저 run 하세요.`)
  const brands = [...new Set(all.map((r) => r.brand))]
  // 카테고리 집계는 응답 1건 = 1표다. 브랜드별로 복제된 행을 다 넣으면 N배로 부풀려지므로
  // 한 브랜드 몫(응답 전체와 1:1)만 넘긴다.
  const oneBrand = all.filter((r) => r.brand === brands[0])
  const latestRun = [...new Set(oneBrand.map((r) => r.run_id))].sort().at(-1)
  const latestRows = oneBrand.filter((r) => r.run_id === latestRun)

  const out = {
    generatedAt: new Date().toISOString(),
    dataset: config.dataset ?? null,
    // 카테고리 숫자는 최신 회차 기준이다. 전 이력을 합치면 최신 변화가 묻힌다.
    categories: categories(latestRows, {
      questions: config.questions,
      models: config.models,
    }),
    categoryTrend: categoryTrend(oneBrand, {
      questions: config.questions,
      models: config.models,
    }),
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
  console.log(`대시보드 데이터 생성 → ${path.relative(process.cwd(), dest)} (카테고리 ${out.categories.length}, 브랜드 ${brands.length}, 행 ${all.length})`)
}

function doTrend(config) {
  const all = readHistory(historyPath(config))
  if (!all.length) return console.log("이력 파일이 비어 있습니다.")
  for (const b of [...new Set(all.map((r) => r.brand))]) {
    const rows = all.filter((r) => r.brand === b)
    const s = summarize(rows, { brand: b, expected: rows.length, ownDomains: config.ownDomains ?? [] })
    console.log(`\n■ ${b} — 가시성 ${s.status.visibility} · 결과 일관성 ${s.status.reproducibility} · 방향 ${s.status.direction}`)
    for (const p of s.trend) {
      console.log(`  ${p.run_id}  언급 ${p.mentions}/${p.V} (${p.rate}%)  이동평균 ${p.movingRate}%  중위 ${p.medianRank ?? "—"}`)
    }
  }
}

const HELP = `geo-probe — 생성형 AI 답변에서 카테고리별 마인드쉐어를 측정한다.

  geo-probe run [--quick] [--config p]   측정 + 분석 (기본)
  geo-probe probe                        측정만 (원문 저장)
  geo-probe analyze <results/디렉터리>    저장된 원문 → 지표
  geo-probe trend                        data/history.jsonl → 추세 요약
  geo-probe export                       대시보드용 web/public/summary.json 생성

  --config <경로>   설정 파일 (기본 geo.config.json, 환경변수 GEO_CONFIG)
  --quick           1모델 × 2질문 × n=2 스모크 테스트. 이력에 쌓지 않는다
  --help            이 도움말

환경변수: GEO_DEBUG=1 로 호출 실패 원인 출력, PORT 로 serve 포트 변경.
대시보드가 읽는 데이터는 results/ 가 아니라 이력 파일(기본 data/history.jsonl)이다.
  --history <경로> 또는 설정의 historyFile 로 데이터셋마다 분리할 수 있다.`

async function main() {
  // --help 를 loadConfig 뒤에 두면 설정이 없는 신규 사용자가 도움말조차 못 본다.
  // 그리고 "--" 로 시작하는 인자를 전부 run 으로 해석하던 탓에 --help 가 유료 측정을 시작했다.
  if (has("help") || has("h") || process.argv[2] === "help") { console.log(HELP); return }

  loadEnv()
  const first = process.argv[2]
  const cmd = !first || first.startsWith("--") ? "run" : first
  let config = loadConfig()
  if (has("quick")) config = applyQuick(config)

  if (cmd === "probe" || cmd === "run") {
    const runDir = path.join(process.cwd(), "results", stamp())
    fs.mkdirSync(runDir, { recursive: true })
    console.log(`\ngeo-probe · ${config.brand} · ${config.models.length}모델 × ${config.questions.length}질문 × ${config.repeats ?? 5}회${config._quick ? " (퀵모드)" : ""}`)
    const res = await probe(config, runDir)
    if (!res.ok) {
      console.error(`\n[geo-probe] 유효한 응답을 하나도 받지 못했습니다 (${res.failed}회 전부 실패).`)
      if (res.firstError) console.error(`  첫 실패 원인: ${res.firstError}`)
      process.exitCode = 1
      return
    }
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
