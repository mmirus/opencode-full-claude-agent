import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to test native background permissions on an isolated server.")
  process.exit(0)
}

const root = createTempDirectory("full-claude-background-")
const cwd = join(root, "project")
const config = join(root, "config")
mkdirSync(join(cwd, ".claude"), { recursive: true })
mkdirSync(config)
const gate = join(root, "foreground-finished")
const allowed = join(cwd, "allowed.txt")
const denied = join(cwd, "denied.txt")
const hookLog = join(root, "hooks.jsonl")
const save = (name: string, data: unknown) => writeFileSync(join(root, name), JSON.stringify(data, null, 2), { mode: 0o600 })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
writeFileSync(join(root, "gate.sh"), `#!/bin/sh
cat >> ${quote(hookLog)}
printf '\\n' >> ${quote(hookLog)}
while [ ! -f ${quote(gate)} ]; do sleep 0.1; done
`)
save("project/.claude/settings.local.json", {
  permissions: { ask: ["Write"] },
  hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: `sh ${quote(join(root, "gate.sh"))}`, timeout: 150 }] }] },
})
save("project/opencode.json", {
  plugins: [{ package: fileURLToPath(new URL("../", import.meta.url)), options: { profiles: {
    background: { configDir: resolve(process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")), binaryPath: "claude", models: ["haiku"] },
  } } }],
})
const password = randomBytes(32).toString("base64url")
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "opencode.sqlite"),
  OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "0",
  OPENCODE_SIMULATE: "0", OPENCODE_PASSWORD: password }
delete env.OPENCODE_CONFIG
delete env.OPENCODE_SERVER_PASSWORD
const port = await new Promise<number>((resolve, reject) => {
  const socket = createServer()
  socket.once("error", reject)
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address()
    assert(address && typeof address !== "string")
    socket.close((error) => error ? reject(error) : resolve(address.port))
  })
})
const url = `http://127.0.0.1:${port}`
const out = openSync(join(root, "server.stdout.log"), "w", 0o600)
const err = openSync(join(root, "server.stderr.log"), "w", 0o600)
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd, env, detached: true, stdio: ["ignore", out, err],
})
closeSync(out)
closeSync(err)
const abort = new AbortController()
const kill = (signal: NodeJS.Signals) => {
  if (!server.pid) return
  try { process.kill(-server.pid, signal) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
}
const exited = new Promise<void>((resolve) => server.once("close", () => resolve()))
server.once("error", (error) => abort.abort(error))
const timer = setTimeout(() => { abort.abort(new Error("Background permission smoke timed out")); kill("SIGKILL") }, 180_000)
const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
const client = OpenCode.make({ baseUrl: url, headers })
let pump: Promise<void> | undefined
let sessionID: string | undefined
const ready = Promise.withResolvers<void>()
const decisions = Promise.withResolvers<void>()
void ready.promise.catch(() => {})
void decisions.promise.catch(() => {})
abort.signal.addEventListener("abort", () => { ready.reject(abort.signal.reason); decisions.reject(abort.signal.reason) }, { once: true })
let idle = false
const asked: string[] = []
console.log(`Background permission artifacts (private): ${root}`)
try {
  const deadline = Date.now() + 30_000
  while (true) {
    abort.signal.throwIfAborted()
    try {
      const response = await fetch(`${url}/api/info`, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_000)]) })
      if (response.ok) break
    } catch {}
    assert(Date.now() < deadline, "Owned OpenCode server did not become ready")
    await Bun.sleep(100)
  }
  pump = (async () => {
    for await (const event of client.event.subscribe({ types: ["permission.asked", "session.execution.succeeded", "session.execution.failed"], signal: abort.signal })) {
      if (event.type === "server.connected") { ready.resolve(); continue }
      if (event.data.sessionID !== sessionID) continue
      appendFileSync(join(root, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 })
      if (event.type === "session.execution.failed") throw new Error("Parent execution failed")
      if (event.type === "session.execution.succeeded") {
        idle = true
        writeFileSync(gate, "finished")
      }
      if (event.type === "permission.asked") {
        assert(idle, "Permission was requested before foreground completion")
        assert(event.location, "Permission event has no Location")
        const resource = event.data.resources[0]
        assert(resource === allowed || resource === denied, `Unexpected permission resource: ${resource}`)
        asked.push(resource)
        await client.permission.reply({ sessionID: sessionID!, requestID: event.data.id,
          decision: resource === allowed ? "once" : "reject" }, { signal: abort.signal })
        if (asked.includes(allowed) && asked.includes(denied)) decisions.resolve()
      }
    }
  })().catch((error) => { if (!abort.signal.aborted) { ready.reject(error); decisions.reject(error) } })
  await ready.promise
  const session = await client.session.create({ location: { directory: cwd }, title: "Background permission smoke",
    model: { providerID: "full-claude-agent-background", id: "haiku" },
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "ask" }],
  }, { signal: abort.signal })
  sessionID = session.id
  save("run.json", { sessionID, root, allowed, denied })
  await client.session.prompt({ sessionID, text: `This is an isolated native background permission integration test. Launch exactly one native Agent with run_in_background=true and model=haiku. Give it this task: Use native Write to create ${allowed} containing BACKGROUND_APPROVED, then use native Write to create ${denied} containing MUST_NOT_EXIST. If a Write is denied, do not retry or use another tool. Do not read files or run commands. After both attempts, report the outcomes. You, the parent, must return BACKGROUND_LAUNCHED immediately after launching the Agent. Do not wait, poll, or call TaskOutput: a test gate releases the background Write only when your foreground turn ends. When the Agent later finishes, report its outcomes and include PARENT_BACKGROUND_REPORTED in that final report.` }, { signal: abort.signal })
  await decisions.promise
  const writeDeadline = Date.now() + 30_000
  while (!existsSync(allowed)) {
    abort.signal.throwIfAborted()
    assert(Date.now() < writeDeadline, "Approved background Write did not execute")
    await Bun.sleep(100)
  }
  assert.match(readFileSync(allowed, "utf8"), /BACKGROUND_APPROVED/)
  assert(!existsSync(denied), "Rejected background Write created a file")
  const history = await client.session.context({ sessionID }, { signal: abort.signal })
  save("context.json", history)
  assert(existsSync(hookLog), "Native PreToolUse hook did not execute")
  const hookInputs = readFileSync(hookLog, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
  assert(hookInputs.some((input) => input.tool_input?.file_path === allowed), "Approved Write did not run its native hook")
  assert(hookInputs.some((input) => input.tool_input?.file_path === denied), "Rejected Write did not run its native hook")
  const rejected = hookInputs.find((input) => input.tool_input?.file_path === denied)
  assert(rejected.agent_id, "Write was not executed by a native subagent")
  const transcript = join(dirname(rejected.transcript_path), rejected.session_id, "subagents", `agent-${rejected.agent_id}.jsonl`)
  const resultDeadline = Date.now() + 30_000
  while (true) {
    abort.signal.throwIfAborted()
    const records = existsSync(transcript) ? readFileSync(transcript, "utf8").split("\n").filter((line) => line.trim()).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    }) : []
    const result = records.flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : [])
      .find((part) => part.type === "tool_result" && part.tool_use_id === rejected.tool_use_id)
    if (result) { assert(result.is_error, "Native subagent did not record the rejection"); break }
    assert(Date.now() < resultDeadline, "Native subagent did not receive the rejected permission result")
    await Bun.sleep(100)
  }
  assert(!existsSync(denied), "Rejected background Write created a file after receiving its result")
  const reportDeadline = Date.now() + 60_000
  while (true) {
    abort.signal.throwIfAborted()
    const messages = await client.session.context({ sessionID }, { signal: abort.signal })
    const reports = messages.filter((message) => message.type === "assistant" && message.finish === "stop" &&
      message.content.some((part) => part.type === "text" && part.text.includes("PARENT_BACKGROUND_REPORTED")))
    if (reports.length) {
      assert.equal(reports.length, 1, "Native report was delivered more than once")
      assert.equal(messages.filter((message) => message.type === "user").length, 1, "Reporting required another user prompt")
      save("reported-context.json", messages)
      break
    }
    assert(Date.now() < reportDeadline, "Native background report did not reach OpenCode automatically")
    await Bun.sleep(100)
  }
  assert(!readFileSync(rejected.transcript_path, "utf8").includes("Full Claude Agent background response available."), "Host delivery wake was submitted to Claude")
  save("success.json", { sessionID, idle, asked, approvedFileCreated: true, deniedFileAbsent: true, nativeHooksRan: true, automaticAssistantReport: true })
  console.log("PASS: native background permissions and hooks work; the parent report reaches OpenCode automatically without another user prompt.")
} catch (error) {
  save("failure.json", { message: String(error) })
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync(gate, "cleanup")
  abort.abort()
  clearTimeout(timer)
  await pump
  kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  await exited
  clearTimeout(force)
  kill("SIGKILL")
}
