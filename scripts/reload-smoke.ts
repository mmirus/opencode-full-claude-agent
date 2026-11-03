import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to test reload interruption on an isolated server.")
  process.exit(0)
}

const root = createTempDirectory("full-claude-reload-")
const cwd = join(root, "project")
const config = join(root, "config")
mkdirSync(cwd)
mkdirSync(config)
const started = join(cwd, "started.txt")
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const projectConfig = { plugins: [{ package: fileURLToPath(new URL("../", import.meta.url)), options: { profiles: {
  reload: { name: "Before reload", configDir: resolve(process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")), binaryPath: "claude", models: ["haiku"] },
} } }] }
save("project/opencode.json", projectConfig)
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
const timer = setTimeout(() => { abort.abort(new Error("Reload smoke timed out")); kill("SIGKILL") }, 120_000)
const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
const client = OpenCode.make({ baseUrl: url, headers })
console.log(`Reload artifacts (private): ${root}`)
try {
  const deadline = Date.now() + 30_000
  while (true) {
    abort.signal.throwIfAborted()
    try {
      const response = await fetch(`${url}/api/info`, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_000)]) })
      if (response.ok) break
    } catch {}
    assert(Date.now() < deadline, "Owned server did not become ready")
    await Bun.sleep(100)
  }
  const session = await client.session.create({ location: { directory: cwd }, title: "Reload interruption smoke",
    model: { providerID: "full-claude-agent-reload", id: "haiku" },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }, { signal: abort.signal })
  const sessionID = session.id
  save("run.json", { sessionID, root })
  await client.session.prompt({ sessionID, text: "This is an isolated interruption test. Use native Bash once to run exactly `printf 'started\\n' >> started.txt; sleep 90` in the foreground with timeout 120000. Do not run any other commands or tools. Do not retry if interrupted." }, { signal: abort.signal })
  const startDeadline = Date.now() + 45_000
  while (!existsSync(started)) {
    abort.signal.throwIfAborted()
    assert(Date.now() < startDeadline, "Native Bash did not start")
    await Bun.sleep(100)
  }
  save("before-reload.json", await client.session.context({ sessionID }, { signal: abort.signal }))
  projectConfig.plugins[0]!.options.profiles.reload.name = "After reload"
  save("project/opencode.json", projectConfig)
  await client.location.reload({ signal: abort.signal })
  try { await client.experimental.session.wait({ sessionID }, { signal: abort.signal }) }
  catch (error) { save("wait-error.json", { message: String(error) }) }
  const history = await client.session.context({ sessionID }, { signal: abort.signal })
  save("context.json", history)
  const serialized = JSON.stringify(history)
  assert(!serialized.includes("tool.result-missing"), "Reload was reported as a missing tool result")
  const assistant = history.findLast((message) => message.type === "assistant")
  assert(assistant?.type === "assistant")
  assert.match(JSON.stringify(assistant.error), /Full Claude Agent was unloaded/)
  const tools = assistant.content.filter((part) => part.type === "tool")
  assert(tools.length > 0, "No native tool was displayed")
  assert(tools.every((part) => part.state.status === "error" || part.state.status === "completed"), "Interrupted tool is still running")
  assert.match(JSON.stringify(tools), /stopped|interrupt|unloaded/i)
  assert.equal(readFileSync(started, "utf8").trim().split("\n").length, 1, "Interrupted command was replayed")
  await client.session.prompt({ sessionID, text: "Do not use tools or retry the interrupted command. Reply exactly RELOAD_RECOVERED." }, { signal: abort.signal })
  await client.experimental.session.wait({ sessionID }, { signal: abort.signal })
  const resumed = await client.session.context({ sessionID }, { signal: abort.signal })
  save("resumed.json", resumed)
  const reply = resumed.findLast((message) => message.type === "assistant")
  assert(reply?.type === "assistant" && !reply.error, "Explicit follow-up failed after a settled interruption")
  assert.match(reply.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), /RELOAD_RECOVERED/)
  assert.equal(readFileSync(started, "utf8").trim().split("\n").length, 1, "Follow-up replayed the interrupted command")
  save("success.json", { sessionID, explicitUnloadError: true, nativeToolSettled: true, explicitFollowupSucceeded: true, commandRuns: 1 })
  console.log("PASS: reload reports interruption, settles native tool output, and resumes only on explicit follow-up without replay.")
} catch (error) {
  save("failure.json", { message: String(error) })
  console.error(error)
  process.exitCode = 1
} finally {
  abort.abort()
  clearTimeout(timer)
  kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  await exited
  clearTimeout(force)
  kill("SIGKILL")
}
