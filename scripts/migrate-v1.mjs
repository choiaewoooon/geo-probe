#!/usr/bin/env node
// v1 results/<stamp>/raw 를 읽어 data/history.jsonl 의 첫 시점으로 편입한다.
// 재측정 없이 과거 데이터를 추세에 살린다. 이미 들어간 run_id 는 건너뛴다.
import fs from "node:fs"
import path from "node:path"
import { collectRows, appendHistory, readHistory } from "../src/analyze.mjs"

const cwd = process.cwd()
const HISTORY = path.join(cwd, "data", "history.jsonl")
const configPath = path.resolve(process.argv[3] ?? process.env.GEO_CONFIG ?? path.join(cwd, "geo.config.json"))
const resultsDir = path.resolve(process.argv[2] ?? path.join(cwd, "results"))

if (!fs.existsSync(configPath)) {
  console.error(`설정이 없습니다: ${configPath}`)
  process.exit(1)
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
const existing = new Set(readHistory(HISTORY).map((r) => r.run_id))

const dirs = fs.existsSync(resultsDir)
  ? fs.readdirSync(resultsDir).filter((d) => fs.existsSync(path.join(resultsDir, d, "raw"))).sort()
  : []

if (!dirs.length) {
  console.log(`마이그레이션할 결과가 없습니다: ${path.relative(cwd, resultsDir)}`)
  process.exit(0)
}

let total = 0
for (const d of dirs) {
  if (existing.has(d)) {
    console.log(`  건너뜀 (이미 있음): ${d}`)
    continue
  }
  // run_id(2026-07-13-16-33) → ISO 타임스탬프
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/)
  const ts = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z` : new Date().toISOString()
  const rows = collectRows(path.join(resultsDir, d), config, { run_id: d, ts })
  if (!rows.length) {
    console.log(`  건너뜀 (유효 응답 0): ${d}`)
    continue
  }
  appendHistory(HISTORY, rows)
  total += rows.length
  console.log(`  편입: ${d} → ${rows.length}행 (${ts})`)
}
console.log(`\n완료. ${total}행을 ${path.relative(cwd, HISTORY)} 에 추가했습니다.`)
