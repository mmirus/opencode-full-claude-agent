import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Model } from "@opencode/schema/model"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to run the paid queued-checkpoint Haiku smoke test.")
  process.exit(0)
}

const root = createTempDirectory("full-claude-checkpoint-")
const cwd = join(root, "project")
const config = join(root, "opencode-config")
mkdirSync(cwd, { mode: 0o700 })
mkdirSync(config, { mode: 0o700 })
const expand = (value: string) => resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value)
const configDir = expand(process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
const plugin = fileURLToPath(new URL("../", import.meta.url))
const database = join(root, "opencode.sqlite")
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 })
save("project/opencode.json", {
  $schema: "https://opencode.ai/config.json",
  plugins: [{ package: plugin, options: { profiles: {
    checkpoint: { configDir, binaryPath: "claude", models: ["haiku"] },
  } } }],
})
const password = randomBytes(32).toString("base64url")
const env: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCODE_CONFIG_DIR: config,
  OPENCODE_DB: database,
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_CONFIG_PROJECT_DISABLE: "0",
  OPENCODE_DISABLE_PROJECT_CONFIG: "0",
  OPENCODE_SIMULATE: "0",
  OPENCODE_PASSWORD: password,
}
delete env.OPENCODE_CONFIG
delete env.OPENCODE_SERVER_PASSWORD
const abort = new AbortController()
const ready = Promise.withResolvers<void>()
const queued = Promise.withResolvers<void>()
void ready.promise.catch(() => {})
void queued.promise.catch(() => {})
const stop = (reason: Error) => {
  abort.abort(reason)
  ready.reject(reason)
  queued.reject(reason)
}
const timer = setTimeout(() => stop(new Error("Queued-checkpoint smoke exceeded 90 seconds")), 90_000)
const interrupt = () => stop(new Error("Queued-checkpoint smoke interrupted"))
process.once("SIGINT", interrupt)
process.once("SIGTERM", interrupt)
let server: ReturnType<typeof spawn> | undefined
let exited: Promise<void> | undefined
let serverExited = false
let pump: Promise<void> | undefined
let sessionID: string | undefined
let client: ReturnType<typeof OpenCode.make> | undefined
const kill = (signal: NodeJS.Signals) => {
  if (!server?.pid) return
  try { process.kill(-server.pid, signal) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
}
const killOnAbort = () => kill("SIGKILL")
abort.signal.addEventListener("abort", killOnAbort, { once: true })
const nonce = randomUUID().replaceAll("-", "")
const first = `FIRST_${nonce}`
const second = `SECOND_${nonce}`
const firstPrompt = `Do not use tools, read files, or modify files. Reply exactly ${first}, with no other text.`
const secondPrompt = `Do not use tools, read files, or modify files. Reply exactly ${second}, with no other text.`
const observed: { type: string; data?: unknown }[] = []
console.log(`Queued-checkpoint artifacts (private): ${root}`)

try {
  const versionResult = spawnSync("opencode", ["--version"], { cwd, env, encoding: "utf8", timeout: 10_000 })
  save("version.json", { status: versionResult.status, stdout: versionResult.stdout, stderr: versionResult.stderr })
  assert.equal(versionResult.status, 0, "opencode --version failed")
  const version = versionResult.stdout.trim()
  assert.match(version, /^(?:opencode v)?2\.2\.5$/, "This repro targets installed stock OpenCode 2.2.5")
  const port = await new Promise<number>((done, reject) => {
    const socket = createServer()
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      assert(address && typeof address !== "string")
      socket.close((error) => error ? reject(error) : done(address.port))
    })
  })
  const url = `http://127.0.0.1:${port}`
  const out = openSync(join(root, "server.stdout.log"), "w", 0o600)
  const err = openSync(join(root, "server.stderr.log"), "w", 0o600)
  try {
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd, env, detached: true, stdio: ["ignore", out, err],
    })
  } finally { closeSync(out); closeSync(err) }
  exited = new Promise<void>((done) => {
    server!.once("error", (error) => stop(error))
    server!.once("close", (code, signal) => {
      serverExited = true
      save("server-exit.json", { code, signal })
      done()
    })
  })
  const endpoint = { url, auth: { type: "basic" as const, username: "opencode", password } }
  const headers = Service.headers(endpoint)
  const readinessEnd = Date.now() + 30_000
  let listening = false
  while (Date.now() < readinessEnd) {
    abort.signal.throwIfAborted()
    assert(!serverExited, "Owned server exited before readiness")
    try {
      const response = await fetch(`${url}/api/info`, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_000)]) })
      assert(response.status !== 401 && response.status !== 403, "Owned server rejected its password")
      if (response.ok) { save("server-info.json", await response.json()); listening = true; break }
    } catch (error) { if (error instanceof assert.AssertionError) throw error }
    await new Promise((done) => setTimeout(done, 150))
  }
  assert(listening, "Owned server did not become ready within 30 seconds")
  client = OpenCode.make({ baseUrl: url, headers })
  let sent = false
  pump = (async () => {
    for await (const event of client!.event.subscribe({
      types: ["session.step.started", "session.step.ended", "session.step.failed", "session.execution.started", "session.execution.succeeded", "session.execution.failed"],
      signal: abort.signal,
    })) {
      if (event.type === "server.connected") { ready.resolve(); continue }
      if (!("sessionID" in event.data) || event.data.sessionID !== sessionID) continue
      observed.push(event)
      appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 })
      if (event.type !== "session.step.started" || sent) continue
      sent = true
      save("queue-trigger.json", { event, firstPrompt, secondPrompt, delivery: "queue" })
      try {
        const receipt = await client!.session.prompt({ sessionID: sessionID!, text: secondPrompt, delivery: "queue" }, { signal: abort.signal })
        save("second-receipt.json", receipt)
        queued.resolve()
      } catch (error) { queued.reject(error); throw error }
    }
  })().catch((error) => { if (!abort.signal.aborted) stop(error) })
  await ready.promise
  const session = await client.session.create({
    location: { directory: cwd }, title: "Queued checkpoint admission smoke",
    model: Model.Ref.parse("full-claude-agent-checkpoint/haiku"),
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  }, { signal: abort.signal })
  sessionID = session.id
  save("run.json", { version, url, serverPID: server.pid, database, cwd, plugin, configDir, sessionID, first, second })
  save("first-receipt.json", await client.session.prompt({ sessionID, text: firstPrompt }, { signal: abort.signal }))
  await queued.promise
  let waitError: unknown
  try { await client.experimental.session.wait({ sessionID }, { signal: abort.signal }) }
  catch (error) { waitError = error; save("wait-error.json", { message: String(error) }) }
  const history = await client.session.context({ sessionID }, { signal: abort.signal })
  save("context.json", history)
  const serialized = JSON.stringify(history) + readFileSync(join(root, "server.stderr.log"), "utf8")
  assert(!/previous Claude turn has not been checkpointed/i.test(serialized), "Queued follow-up hit the previous-Claude-turn checkpoint admission guard")
  if (waitError) throw waitError
  const users = history.filter((message) => message.type === "user")
  const assistants = history.filter((message) => message.type === "assistant")
  assert.equal(users.length, 2, "Expected exactly two host user messages; no replay")
  assert.deepEqual(users.map((message) => message.text), [firstPrompt, secondPrompt], "Host user prompts were duplicated or changed")
  assert.equal(assistants.length, 2, "Expected exactly two assistant messages")
  for (const [index, marker] of [first, second].entries()) {
    const message = assistants[index]!
    assert(!message.error && message.finish === "stop", `Assistant ${index + 1} did not complete: ${JSON.stringify(message.error)}`)
    assert(!message.content.some((part) => part.type === "tool"), `Assistant ${index + 1} called tools`)
    assert.equal(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim(), marker)
  }
  assert.equal(observed.filter((event) => event.type === "session.step.started").length, 2, "Expected exactly two host steps; no replay")
  assert(!serverExited, "Owned server exited during the repro")
  save("success.json", { status: "passed", sessionID, checks: ["event-triggered queued follow-up", "two completed no-tools assistant replies", "exact second marker", "no checkpoint admission error", "two host user messages and two steps without replay"] })
  console.log(`PASS: queued checkpoint admission. Artifacts: ${root}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  save("failure.json", { status: "failed", sessionID, message, stack: error instanceof Error ? error.stack : undefined })
  console.error(`FAIL: ${message}\nArtifacts: ${root}`)
  process.exitCode = 1
} finally {
  if (!abort.signal.aborted && client && sessionID) {
    await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(3_000) }).catch(() => {})
  }
  abort.signal.removeEventListener("abort", killOnAbort)
  abort.abort()
  clearTimeout(timer)
  await pump
  kill("SIGTERM")
  let grace: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([exited, new Promise((done) => { grace = setTimeout(done, 2_000) })]) }
  finally { if (grace) clearTimeout(grace); kill("SIGKILL") }
  await exited
  process.removeListener("SIGINT", interrupt)
  process.removeListener("SIGTERM", interrupt)
}
