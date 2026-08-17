// command provider 회귀 — stdin 을 닫지 않으면 stdin 을 읽는 래퍼(cdx 등)에서 무한 대기한다.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ask } from "../src/providers.mjs"

test("command: stdin 을 읽는 명령이어도 멈추지 않는다", async () => {
  // cat 은 stdin 이 열려 있으면 EOF 를 기다리며 영원히 멈춘다.
  const r = await ask("무시됨", {
    provider: "command",
    command: ["/bin/sh", "-c", "cat; echo '1. 결과'"],
    timeoutMs: 5000,
  })
  assert.match(r.text, /1\. 결과/)
})

test("command: 실패하면 stderr 를 담아 명확히 실패한다", async () => {
  await assert.rejects(
    () => ask("x", { provider: "command", command: ["/bin/sh", "-c", "echo 문제발생 >&2; exit 3"], timeoutMs: 5000 }),
    (e) => e.message.includes("문제발생") && e.message.includes("code 3"),
  )
})

test("command: 시간 초과 시 프로세스를 죽이고 에러를 낸다", async () => {
  await assert.rejects(
    () => ask("x", { provider: "command", command: ["/bin/sh", "-c", "sleep 30"], timeoutMs: 700 }),
    (e) => e.message.includes("시간 초과"),
  )
})

test("ask: 모든 provider 응답에 citations 배열이 보장된다", async () => {
  const r = await ask("x", { provider: "command", command: ["/bin/echo", "hi"], timeoutMs: 5000 })
  assert.ok(Array.isArray(r.citations))
})
