// 원문 디렉터리 → 측정 행 → history.jsonl 누적 + CSV + report.md
// v1 호환: rankOf/median/brandRegex/analyze/toCsv 를 계속 export 한다.
import fs from "node:fs"
import path from "node:path"
import { measureResponse, buildAliasIndex, parseEntries } from "./parse.mjs"
import { summarize, median, frac } from "./metrics.mjs"

export { median }
export { parseEntries, extractCitations, normalizeBrand } from "./parse.mjs"

// --- v1 호환 API -------------------------------------------------------------
export function brandRegex(brand, aliases = []) {
  const terms = [brand, ...aliases].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(terms.join("|"), "i")
}
export function rankOf(text, re) {
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s*[.)]\s*(.+)$/)
    if (m && re.test(m[2])) return Number(m[1])
  }
  return re.test(String(text ?? "")) ? 0 : null
}

// --- v2 ----------------------------------------------------------------------

/** runDir/raw/<model>/<question>-run<r>.txt 전부를 읽어 측정 행 배열로. */
export function collectRows(runDir, config, meta = {}) {
  const aliasIndex = buildAliasIndex({
    [config.brand]: config.brandAliases ?? [],
    ...(config.competitorAliases ?? {}),
  })
  const run_id = meta.run_id ?? path.basename(runDir)
  const ts = meta.ts ?? new Date().toISOString()
  const rows = []

  for (const model of config.models) {
    for (const q of config.questions) {
      const dir = path.join(runDir, "raw", model.id)
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.startsWith(`${q.id}-run`) && f.endsWith(".txt")).sort()
        : []
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), "utf8")
        const m = measureResponse(text, { brand: config.brand, aliasIndex })
        if (!m) continue // 빈 응답 = 무효, 유효 응답 수에서 제외
        // 검색 모델이 돌려준 근거 URL(사이드카)을 본문에서 뽑은 것과 합친다.
        const sidecar = path.join(dir, f.replace(/\.txt$/, ".cite.json"))
        if (fs.existsSync(sidecar)) {
          try {
            const extra = JSON.parse(fs.readFileSync(sidecar, "utf8"))
            const hosts = (Array.isArray(extra) ? extra : []).map((u) => {
              try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") } catch { return null }
            })
            m.citations = [...new Set([...m.citations, ...hosts.filter(Boolean)])]
          } catch { /* 손상된 사이드카는 무시 */ }
        }
        rows.push({
          run_id,
          ts,
          protocol: config.protocol ?? "v1",
          brand: config.brand,
          model: model.id,
          question: q.id,
          repeat: Number(f.match(/run(\d+)/)?.[1] ?? 0),
          web_search: model.webSearch ?? false,
          ...m,
        })
      }
    }
  }
  return rows
}

/** 예정 응답 수 — 측정 완결성의 분모. */
/**
 * 추적할 브랜드 목록. `trackBrands` 가 있으면 그 목록을, 없으면 config.brand 하나를 본다.
 * 별칭은 competitorAliases 에서 가져오므로 브랜드마다 설정을 복제할 필요가 없다.
 *
 * 질문은 애초에 브랜드명을 감추고 던지므로, 같은 응답 묶음을 브랜드만 바꿔 다시 채점하는 것이
 * 정당하다. 프로브를 브랜드 수만큼 반복하지 않아도 판 전체를 같은 표본 위에서 비교할 수 있다.
 */
export function trackTargets(config) {
  const names = config.trackBrands?.length ? config.trackBrands : [config.brand]
  return names.map((name) => ({
    ...config,
    brand: name,
    brandAliases: name === config.brand
      ? (config.brandAliases ?? config.competitorAliases?.[name] ?? [])
      : (config.competitorAliases?.[name] ?? []),
  }))
}

export function expectedCount(config) {
  return config.models.length * config.questions.length * (config.repeats ?? 5)
}

/** 한 측정 응답의 고유키. 같은 응답이 두 번 들어가면 추세가 조용히 오염된다. */
export const rowKey = (r) => `${r.brand}|${r.run_id}|${r.model}|${r.question}|${r.repeat}`

/**
 * history.jsonl 에 append (append-only, 재생성 가능).
 * 이미 있는 (brand,run_id,model,question,repeat) 는 건너뛴다 —
 * analyze 를 재실행해도 중복 누적되지 않게.
 */
export function appendHistory(historyPath, rows) {
  if (!rows.length) return 0
  fs.mkdirSync(path.dirname(historyPath), { recursive: true })
  const seen = new Set(readHistory(historyPath).map(rowKey))
  const fresh = rows.filter((r) => !seen.has(rowKey(r)))
  if (!fresh.length) return 0
  fs.appendFileSync(historyPath, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n")
  return fresh.length
}

/** 이미 중복이 쌓인 파일을 정리한다(첫 등장만 남김). */
export function dedupeHistory(historyPath) {
  const all = readHistory(historyPath)
  const seen = new Set()
  const kept = all.filter((r) => {
    const k = rowKey(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  fs.writeFileSync(historyPath, kept.map((r) => JSON.stringify(r)).join("\n") + "\n")
  return { before: all.length, after: kept.length }
}

export function readHistory(historyPath) {
  if (!fs.existsSync(historyPath)) return []
  return fs
    .readFileSync(historyPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function toCsv(rows) {
  const head = ["run_id", "ts", "brand", "model", "question", "repeat", "mentioned", "rank", "listed", "web_search"]
  const body = rows.map((r) => head.map((k) => (r[k] === null || r[k] === undefined ? "" : r[k])).join(","))
  return [head.join(","), ...body].join("\n") + "\n"
}

/** v1 시그니처 유지 — 기존 호출부가 깨지지 않게. */
export function analyze(runDir, config) {
  const rows = collectRows(runDir, config)
  const cells = {}
  for (const model of config.models) {
    cells[model.id] = {}
    for (const q of config.questions) {
      const rs = rows.filter((r) => r.model === model.id && r.question === q.id)
      const ranks = rs.filter((r) => r.rank !== null).map((r) => r.rank)
      cells[model.id][q.id] = {
        n: rs.length,
        mentions: rs.filter((r) => r.mentioned).length,
        medianRank: median(ranks),
        ranks,
      }
    }
  }
  return { rows, cells }
}

/** 리포트 — 셀 표 + 경쟁 구도 + 완결성. 소수점 없이, k/N 병기. */
export function report(config, runDir, rows) {
  const s = summarize(rows, {
    brand: config.brand,
    expected: expectedCount(config),
    ownDomains: config.ownDomains ?? [],
  })
  const nameOf = Object.fromEntries(config.models.map((m) => [m.id, m.name]))
  const cell = (mid, qid) => {
    const rs = rows.filter((r) => r.model === mid && r.question === qid)
    if (!rs.length) return "n/a"
    const men = rs.filter((r) => r.mentioned).length
    if (!men) return `미언급 (0/${rs.length})`
    const mr = median(rs.filter((r) => r.rank !== null).map((r) => r.rank))
    return mr === null ? `언급 (${men}/${rs.length})` : `${mr}위 (${men}/${rs.length})`
  }

  const sov = s.shareOfVoice.slice(0, 8)
    .map((b, i) => `| ${i + 1} | ${b.name === config.brand ? `**${b.name}**` : b.name} | ${b.appearances} | ${b.sov}% | ${b.medianRank ?? "—"} |`)
    .join("\n")

  const sub = s.substitution.brands.slice(0, 5)
    .map((b) => `- ${b.name}: ${b.n}건 · ${b.rate}%`)
    .join("\n") || "- (자사 미언급 응답 없음)"

  return `# GEO 측정 리포트 · ${config.brand}

> ${s.trend.at(-1)?.ts ?? ""} · 반복 n=${config.repeats ?? 5}
> 가시성 **${s.status.visibility}** · 결과 일관성 **${s.status.reproducibility}** · 방향 **${s.status.direction}**

## 요약

| 지표 | 값 |
|---|---|
| 추천 언급률 | ${s.visibility.mentionLabel} |
| Top 3 추천률 | ${s.visibility.top3Label} |
| 언급 시 중위 순위 | ${s.visibility.medianRank ?? "산출 불가"}${s.visibility.rankedN ? ` (${s.visibility.rankedN}건 기준)` : ""} |
| 추적 질문군 내 응답 점유율 | ${s.shareOfVoice.find((b) => b.name === config.brand)?.sov ?? 0}% |
| 결과 일관성 | ${s.visibility.reproducibility ?? "-"}% |
| **측정 완결성** | ${s.completeness.validRate}% · ${s.completeness.validLabel} |

## 질문 × 모델

| 질문 | ${config.models.map((m) => nameOf[m.id]).join(" | ")} |
|---|${config.models.map(() => "---").join("|")}|
${config.questions.map((q) => `| ${q.id.toUpperCase()} · ${q.short ?? q.prompt.slice(0, 20)} | ${config.models.map((m) => cell(m.id, q.id)).join(" | ")} |`).join("\n")}

## 경쟁 구도 (추적 질문군 내 응답 점유율)

| # | 브랜드 | 등장 | 점유율 | 중위 순위 |
|---|---|---:|---:|---:|
${sov}

## 자사 미언급 시 등장한 브랜드 (${s.substitution.missedN}건 기준)

${sub}

## 먼저 손볼 질문

${s.priorities.slice(0, 3).map((p, i) => `${i + 1}. **${p.question}**: 언급 ${p.mentionLabel}${p.topSubstitute ? ` · 대체 1위 ${p.topSubstitute.name}(${p.topSubstitute.rate}%)` : ""}`).join("\n")}

## 한계

- 고정된 추적 질문군에 대한 관찰이며 **실제 시장 점유율이 아니다.**
- n=${config.repeats ?? 5} 소표본 → 방향성 관찰용. 신뢰구간·유의성을 붙이지 않는다.
- 모델별 웹검색 조건이 달라(설정에 기록) 모델 간 절대 비교는 하지 않는다.
- 인용 도메인은 '응답에 표시된 출처'이며 노출의 원인으로 단정하지 않는다.
- 원문·데이터셋: \`${path.relative(process.cwd(), runDir)}/\`
`
}
