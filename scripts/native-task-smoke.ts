import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { NativeTasks } from "../src/task-rpc.js"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to test native task visibility on an isolated server.")
  process.exit(0)
}

const root = createTempDirectory("full-claude-native-task-")
chmodSync(root, 0o700)
const cwd = join(root, "project")
const config = join(root, "config")
const observer = join(root, "observer")
for (const directory of [cwd, config, observer]) mkdirSync(directory, { mode: 0o700 })
const save = (name: string, data: unknown) => writeFileSync(join(root, name), JSON.stringify(data, null, 2), { mode: 0o600 })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const source = fileURLToPath(new URL("../src/", import.meta.url))
const frames = join(root, "sdk-frames.jsonl")
// The private wrapper observes the store boundary without replacing SDK calls or frames.
save("observer/package.json", { name: "native-task-smoke-observer", type: "module", exports: "./index.ts" })
writeFileSync(join(observer, "index.ts"), `
import { appendFileSync } from "node:fs"
import { NativeTaskStore } from ${JSON.stringify(join(source, "tasks.ts"))}
const log = (value) => appendFileSync(${JSON.stringify(frames)}, JSON.stringify(value) + "\\n", { mode: 0o600 })
const original = NativeTaskStore.prototype.connect
const list = NativeTaskStore.prototype.list
NativeTaskStore.prototype.list = function(sessionID) {
  const tasks = list.call(this, sessionID)
  log({ type: "smoke_list", sessionID, tasks, undefinedFields: tasks.map((task) => Object.keys(task).filter((key) => task[key] === undefined)) })
  return tasks
}
NativeTaskStore.prototype.connect = function(owner, stopTask) {
  log({ type: "smoke_connection", owner })
  const connection = original.call(this, owner, stopTask && (async (taskID) => {
    log({ type: "smoke_stop_call", taskID })
    await stopTask(taskID)
    log({ type: "smoke_stop_return", taskID })
  }))
  return { ...connection, observe(message) { log(message); return connection.observe(message) } }
}
export { default } from ${JSON.stringify(join(source, "index.ts"))}
`, { mode: 0o600 })
save("project/opencode.json", { plugins: [{ package: observer, options: { profiles: {
  smoke: { configDir: resolve(process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")), binaryPath: "claude", models: ["haiku"] },
} } }] })
const launches = join(cwd, "launches.txt")
const marker = `NATIVE_TASK_OUTPUT_${randomBytes(8).toString("hex")}`
const command = `printf 'LAUNCHED\\n' >> ${quote(launches)}; printf '${marker}\\n'; sleep 120`
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
const timer = setTimeout(() => { abort.abort(new Error("Native task smoke timed out")); kill("SIGKILL") }, 180_000)
const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
const client = OpenCode.make({ baseUrl: url, headers })
const rpc = client.rpc(NativeTasks)
const options = { location: { directory: cwd }, signal: abort.signal }
const ready = Promise.withResolvers<void>()
const idle = Promise.withResolvers<void>()
void ready.promise.catch(() => {})
void idle.promise.catch(() => {})
abort.signal.addEventListener("abort", () => { ready.reject(abort.signal.reason); idle.reject(abort.signal.reason) }, { once: true })
let pump: Promise<void> | undefined
let sessionID: string | undefined
let phase = "server startup"
const records = (): any[] => existsSync(frames) ? readFileSync(frames, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
async function until<T>(label: string, action: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  while (true) {
    abort.signal.throwIfAborted()
    const value = await action()
    if (value !== undefined) return value
    assert(Date.now() < deadline, label)
    await Bun.sleep(200)
  }
}
console.log(`Native task artifacts (private): ${root}`)
try {
  await until("Owned OpenCode server did not become ready", async () => {
    try {
      const response = await fetch(`${url}/api/info`, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_000)]) })
      if (response.ok) return true
    } catch {}
  }, 30_000)
  pump = (async () => {
    for await (const event of client.event.subscribe({ types: ["session.execution.succeeded", "session.execution.failed"], signal: abort.signal })) {
      if (event.type === "server.connected") { ready.resolve(); continue }
      if (event.data.sessionID !== sessionID) continue
      appendFileSync(join(root, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 })
      if (event.type === "session.execution.failed") throw new Error("Foreground execution failed")
      if (event.type === "session.execution.succeeded") idle.resolve()
    }
  })().catch((error) => { if (!abort.signal.aborted) { ready.reject(error); idle.reject(error); abort.abort(error) } })
  await ready.promise
  phase = "session creation"
  const session = await client.session.create({ location: options.location, title: "Native task visibility smoke",
    model: { providerID: "full-claude-agent-smoke", id: "haiku" },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }, { signal: abort.signal })
  sessionID = session.id
  save("run.json", { root, sessionID, command, marker, port })
  assert.deepEqual(await rpc.list({ sessionID }, options), { tasks: [] })
  phase = "foreground prompt"
  await client.session.prompt({ sessionID, text: `This is an isolated native Bash task visibility test. Call native Bash exactly once, with run_in_background=true, description="Native task visibility smoke", and command exactly: ${command}\nAfter Bash returns the background task ID, immediately end your foreground response with NATIVE_TASK_LAUNCHED. Do not wait, poll, read files, call TaskOutput, launch agents, run any additional command, or stop the task. The test harness will inspect output and stop the task through SDK RPC without another user message.` }, { signal: abort.signal })
  await idle.promise
  phase = "running task list after host idle"
  const task = await until("Native background task was not running after host idle", async () => {
    const result = await rpc.list({ sessionID: sessionID! }, options)
    save("latest-list.json", result)
    assert(result.tasks.length <= 1, "More than one native task was launched")
    return result.tasks.find((task) => task.state === "running")
  })
  assert(task.taskID && task.description.trim(), "Task ID or description missing")
  assert.equal(task.ambient, false)
  assert.equal(task.canStop, true)
  save("running.json", task)
  phase = "native output RPC"
  const output = await until("Native output RPC did not return the marker", async () => {
    const output = await rpc.output({ sessionID: sessionID!, id: task.id }, options)
    save("latest-output.json", output)
    return output.available && output.text.includes(marker) ? output : undefined
  })
  assert.equal(output.truncated, false)
  const before = records()
  const connection = before.find((frame) => frame.type === "smoke_connection")
  assert(connection, "SDK observation wrapper did not connect")
  const results = before.filter((frame) => frame.type === "user" && frame.tool_use_result?.backgroundTaskId === task.taskID)
  assert.equal(results.length, 1, "Expected exactly one native Bash background result")
  const text = results[0].message.content.filter((part: any) => part.type === "tool_result").map((part: any) => part.content).join("\n")
  const outputFile = /Output is being written to: (.+?\.output)(?:\.|\s|$)/.exec(text)?.[1]
  assert(outputFile, "Native Bash did not provide the expected output path")
  assert.equal(basename(outputFile), `${task.taskID}.output`)
  assert.equal(basename(dirname(outputFile)), "tasks")
  assert.equal(basename(dirname(dirname(outputFile))), connection.owner.nativeID)
  assert(statSync(outputFile).isFile(), "Native output is not a regular file")
  assert.equal(readFileSync(launches, "utf8"), "LAUNCHED\n")
  phase = "native stop RPC"
  const stop = await rpc.stop({ sessionID, id: task.id }, options)
  save("stop.json", stop)
  assert.equal(stop.requested, true)
  phase = "native terminal state after stop"
  const stopped = await until("Native stop did not produce a terminal task state", async () => {
    const result = await rpc.list({ sessionID: sessionID! }, options)
    save("latest-list.json", result)
    return result.tasks.find((item) => item.id === task.id && ["stopped", "failed", "completed"].includes(item.state))
  })
  const observed = records()
  assert.equal(observed.filter((frame) => frame.type === "smoke_stop_call" && frame.taskID === task.taskID).length, 1)
  assert.equal(observed.filter((frame) => frame.type === "smoke_stop_return" && frame.taskID === task.taskID).length, 1)
  const terminal = observed.filter((frame) => frame.type === "system" && frame.task_id === task.taskID &&
    (frame.subtype === "task_notification" || frame.subtype === "task_updated" && ["killed", "stopped", "failed", "completed"].includes(frame.patch?.status)))
  assert(terminal.length, "Terminal state did not come from a native SDK event")
  if (terminal.some((frame) => frame.status === "stopped" || ["killed", "stopped"].includes(frame.patch?.status))) assert.equal(stopped.state, "stopped")
  assert.equal(stopped.canStop, false)
  assert.equal(readFileSync(launches, "utf8"), "LAUNCHED\n")
  const history = await client.session.context({ sessionID }, { signal: abort.signal })
  save("context.json", history)
  assert.equal(history.filter((message) => message.type === "user").length, 1, "Task inspection or stopping submitted another user prompt")
  const calls = observed.flatMap((frame) => frame.type === "assistant" ? frame.message.content : []).filter((part: any) => part.type === "tool_use")
  assert.equal(calls.length, 1, "Model made extra tool calls")
  assert.equal(calls[0].name, "Bash")
  assert.equal(calls[0].input.command, command)
  assert.equal(calls[0].input.run_in_background, true)
  const taskFrames = observed.filter((frame) => frame.type === "system" && (frame.subtype.startsWith("task_") || frame.subtype === "background_tasks_changed"))
  save("success.json", { sessionID, running: task, terminal: stopped, nativeOutputFile: outputFile, launchCount: 1, userPrompts: 1,
    stopCalls: 1, registryEmissionCount: taskFrames.filter((frame) => frame.subtype === "background_tasks_changed").length, taskFrames })
  console.log(`PASS: one native Bash task stayed running after host idle; RPC read output and stopped it (${stopped.state}).`)
} catch (error) {
  save("failure.json", { phase, message: String(error), stack: error instanceof Error ? error.stack : undefined })
  console.error(error)
  process.exitCode = 1
} finally {
  abort.abort()
  clearTimeout(timer)
  await pump
  kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  await exited
  clearTimeout(force)
  kill("SIGKILL")
}
