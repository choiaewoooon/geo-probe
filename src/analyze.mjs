// 순위 파싱·집계 — 번호 목록 응답에서 브랜드 최초 순위를 뽑아 언급률·중위 순위를 낸다.
import fs from "node:fs"
import path from "node:path"

export function brandRegex(brand, aliases = []) {
  const terms = [brand, ...aliases].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(terms.join("|"), "i")
}

// 번호 목록에서 브랜드가 있는 항목의 번호 = 최초 순위. 없으면 null. 목록이 아니면 등장 여부만(0).
export function rankOf(text, re) {
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*[.)]\s*(.+)$/)
    if (m && re.test(m[2])) return Number(m[1])
  }
  return re.test(text) ? 0 : null
}

export function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// runDir/raw/<modelId>/<questionId>-run<r>.txt 를 읽어 셀별 통계 산출.
export function analyze(runDir, config) {
  const re = brandRegex(config.brand, config.brandAliases)
  const rows = [] // long-format 실행별 행
  const cells = {} // modelId -> questionId -> {n,mentions,medianRank,ranks}
  for (const model of config.models) {
    cells[model.id] = {}
    for (const q of config.questions) {
      const dir = path.join(runDir, "raw", model.id)
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.startsWith(`${q.id}-run`) && f.endsWith(".txt")).sort()
        : []
      const ranks = []
      let mentions = 0
      let n = 0
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), "utf8").trim()
        if (!text) continue
        n += 1
        const runNo = Number(f.match(/run(\d+)/)?.[1] ?? 0)
        const r = rankOf(text, re)
        if (r !== null) {
          mentions += 1
          if (r > 0) ranks.push(r)
        }
        rows.push({ model: model.id, question: q.id, run: runNo, rank: r, web_search: model.webSearch ?? false })
      }
      cells[model.id][q.id] = { n, mentions, medianRank: median(ranks), ranks }
    }
  }
  return { rows, cells }
}

export function toCsv(rows) {
  const head = ["model", "question", "run", "rank", "web_search"]
  const body = rows.map((r) => head.map((k) => (r[k] === null || r[k] === undefined ? "" : r[k])).join(","))
  return [head.join(","), ...body].join("\n") + "\n"
}
