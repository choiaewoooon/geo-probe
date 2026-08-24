#!/usr/bin/env node
// 응답에 등장한 앱들의 아이콘을 받아 web/public/logos/ 에 캐시한다.
//
// 출처는 iTunes Search API — 여기 등장하는 이름은 대부분 실제 앱이라 App Store 아이콘이
// 가장 정확한 로고다. 파비콘은 서비스마다 품질이 들쭉날쭉해서 쓰지 않는다.
//
// 아이콘은 식별 목적(어느 앱 이야기인지)으로만 쓰고, 대시보드에서는 흑백으로 렌더한다.
// 잘못 매칭되는 이름은 configs/logo-overrides.json 으로 바로잡는다.
//
//   node scripts/fetch-logos.mjs [--summary web/public/summary.json] [--min 2]

import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const OUT = path.join(ROOT, "web", "public", "logos")
const OVERRIDES = path.join(ROOT, "configs", "logo-overrides.json")

const flag = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const SUMMARY = path.resolve(flag("summary", "web/public/summary.json"))
const MIN = Number(flag("min", 2))

// 한글만으로 된 이름은 ASCII 슬러그가 통째로 비어 ".png" 같은 파일이 된다. 코드포인트로 떨어뜨린다.
const slug = (name) => {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return s || "x" + [...name].map((c) => c.codePointAt(0).toString(16)).join("")
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 이 데이터셋에서 로고를 붙일 가치가 있는 이름들. */
function collectNames(summary) {
  const seen = new Map() // name -> 총 등장
  for (const c of summary.categories ?? []) {
    for (const e of c.entities ?? []) {
      seen.set(e.name, (seen.get(e.name) ?? 0) + e.appearances)
    }
  }
  for (const b of summary.brands ?? []) seen.set(b.brand, seen.get(b.brand) ?? 99)
  return [...seen.entries()]
    .filter(([, n]) => n >= MIN)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
}

async function lookup(term, country) {
  const url = "https://itunes.apple.com/search?" + new URLSearchParams({
    term, entity: "software", country, limit: "1",
  })
  const res = await fetch(url, { headers: { "user-agent": "geo-probe/1.0 (logo cache)" } })
  if (!res.ok) throw new Error(`itunes ${res.status}`)
  const j = await res.json()
  const hit = j.results?.[0]
  if (!hit) return null
  return { art: hit.artworkUrl100 ?? hit.artworkUrl60, matched: hit.trackName }
}

async function main() {
  if (!fs.existsSync(SUMMARY)) throw new Error(`${SUMMARY} 가 없습니다. 먼저 export 하세요.`)
  const summary = JSON.parse(fs.readFileSync(SUMMARY, "utf8"))
  const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, "utf8")) : {}
  fs.mkdirSync(OUT, { recursive: true })

  const indexPath = path.join(OUT, "index.json")
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {}

  const names = collectNames(summary)
  console.log(`로고 대상 ${names.length}개 (등장 ${MIN}회 이상)\n`)

  let got = 0, cached = 0, missed = 0
  for (const name of names) {
    const ov = overrides[name]
    if (ov === null) { console.log(`  skip   ${name} (override: 로고 없음)`); continue }
    const file = `${slug(name)}.png`
    const dest = path.join(OUT, file)

    if (fs.existsSync(dest) && index[name]) { cached += 1; continue }

    const term = typeof ov === "string" ? ov : ov?.term ?? name
    const country = ov?.country ?? "kr"
    try {
      let hit = await lookup(term, country)
      if (!hit && country !== "us") hit = await lookup(term, "us")
      if (!hit?.art) { missed += 1; console.log(`  MISS   ${name}`); await sleep(400); continue }

      const img = await fetch(hit.art)
      if (!img.ok) throw new Error(`art ${img.status}`)
      fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()))
      index[name] = { file: `logos/${file}`, matched: hit.matched, term, country }
      got += 1
      console.log(`  ok     ${name.padEnd(20)} ← ${hit.matched}`)
    } catch (e) {
      missed += 1
      console.log(`  FAIL   ${name}: ${e.message}`)
    }
    await sleep(400) // iTunes 는 분당 호출 제한이 있다.
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))
  console.log(`\n새로 받음 ${got} · 캐시 ${cached} · 실패 ${missed} → ${path.relative(ROOT, indexPath)}`)
  console.log("잘못 매칭된 이름은 configs/logo-overrides.json 에 적어 다시 실행하세요.")
  console.log('  예: { "Shuttle": "Shuttle Delivery Korea", "T-money": null }')
}

main().catch((e) => { console.error(`\n[fetch-logos] ${e.message}`); process.exit(1) })
