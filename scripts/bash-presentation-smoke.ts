import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { createTempDirectory } from "./support/temp.js"
import { NativeTasks } from "../src/task-rpc.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 for isolated, paid Haiku turns.")
  process.exit(0)
}

const resumeRoot = process.env.FULL_CLAUDE_BASH_RESUME_ROOT
const root = resumeRoot ?? createTempDirectory("full-claude-bash-")
const lifecycle = process.env.FULL_CLAUDE_BASH_LIFECYCLE === "1"
const cwd = join(root, "project")
const config = join(root, "config")
const fixture = join(root, "native-plugin")
const observer = join(root, "host-observer")
const providerObserver = join(root, "provider-observer")
for (const directory of [cwd, config, join(cwd, ".claude"), join(fixture, ".claude-plugin"), join(fixture, "hooks"), observer, providerObserver]) mkdirSync(directory, { recursive: true, mode: 0o700 })
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const configDir = resolve(process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
const marker = join(cwd, "executions.txt")
const denied = join(cwd, "denied.txt")
const written = join(cwd, "native-write.txt")
const hookLog = join(root, "hooks.jsonl")
const hostLog = join(root, "host-executions.jsonl")
const loadedLog = join(root, "observer-loaded.jsonl")
const streamLog = join(root, "stream-parts.jsonl")
const framesLog = join(root, "native-frames.jsonl")
const source = fileURLToPath(new URL("../src/", import.meta.url))
save("native-plugin/.claude-plugin/plugin.json", { name: "bash-presentation-smoke", version: "1.0.0" })
writeFileSync(join(root, "hook.cjs"), `const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify(input) + "\\n", {mode: 0o600});
if (input.hook_event_name === "PreToolUse" && input.tool_name === "Bash" && input.tool_input.command.includes("ORIGINAL_FIRST")) {
  console.log(JSON.stringify({hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: {...input.tool_input, command: input.tool_input.command.replaceAll("ORIGINAL_FIRST", "HOOK_FIRST")}}}));
}
`, { mode: 0o600 })
const hook = { matcher: "Bash|Write", hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(join(root, "hook.cjs"))}`, timeout: 10 }] }
save("native-plugin/hooks/hooks.json", { hooks: { PreToolUse: [hook], PostToolUse: [hook] } })
save("project/.claude/settings.local.json", { permissions: { ask: ["Bash", "Write"] } })
save("host-observer/package.json", { name: "bash-smoke-host-observer", type: "module", exports: { ".": "./index.ts" } })
writeFileSync(join(observer, "index.ts"), `import { Plugin } from "@opencode/plugin";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { appendFileSync } from "node:fs";
export default fromPromise(Plugin.define({id: "bash-smoke-host-observer", async setup(ctx) {
  await ctx.session.hook("title", event => {event.result = "Bash presentation smoke"});
  await ctx.tool.hook("execute.before", event => {appendFileSync(${JSON.stringify(hostLog)}, JSON.stringify(event) + "\\n", {mode:0o600}); throw new Error("Host execution forbidden in native smoke");});
  appendFileSync(${JSON.stringify(loadedLog)}, JSON.stringify({loaded:true}) + "\\n", {mode:0o600});
}}));
`, { mode: 0o600 })
save("provider-observer/package.json", { name: "bash-smoke-provider-observer", type: "module", exports: { ".": "./index.ts" } })
writeFileSync(join(providerObserver, "index.ts"), `import { appendFileSync } from "node:fs";
import { Runtime } from ${JSON.stringify(join(source, "runtime.ts"))};
import { NativeTaskStore } from ${JSON.stringify(join(source, "tasks.ts"))};
const run = Runtime.prototype.run;
Runtime.prototype.run = function(request) {
  return run.call(this, {...request, emit(part) {
    appendFileSync(${JSON.stringify(streamLog)}, JSON.stringify({sessionID:request.sessionID, part}) + "\\n", {mode:0o600});
    request.emit(part);
  }});
};
const connect = NativeTaskStore.prototype.connect;
NativeTaskStore.prototype.connect = function(owner, stopTask) {
  const connection = connect.call(this, owner, stopTask);
  return {...connection, observe(message) {
    appendFileSync(${JSON.stringify(framesLog)}, JSON.stringify({owner, message}) + "\\n", {mode:0o600});
    return connection.observe(message);
  }};
};
export { default } from ${JSON.stringify(join(source, "index.ts"))};
`, { mode: 0o600 })
save("project/opencode.json", { $schema: "https://opencode.ai/config.json", plugins: [observer, { package: providerObserver, options: { profiles: {
  bashsmoke: { configDir, binaryPath: "claude", models: ["haiku"], plugins: [fixture] },
} } }] })
const password = randomBytes(32).toString("base64url")
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "opencode.sqlite"),
  OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_SIMULATE: "0", OPENCODE_PASSWORD: password }
delete env.OPENCODE_CONFIG
delete env.OPENCODE_SERVER_PASSWORD
const abort = new AbortController()
let server: ReturnType<typeof spawn> | undefined
let exited: Promise<void> | undefined
let client: ReturnType<typeof OpenCode.make> | undefined
let sessionID: string | undefined
let generation = 0
let serverURL = ""
let pendingNativeCommand: string | undefined
const kill = (signal: NodeJS.Signals) => {
  if (!server?.pid) return
  try { process.kill(-server.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
}
const timer = setTimeout(() => { abort.abort(new Error("Bash presentation smoke exceeded 240 seconds")); kill("SIGKILL") }, 240_000)
const interrupt = () => { abort.abort(new Error("Bash presentation smoke interrupted")); kill("SIGKILL") }
process.once("SIGINT", interrupt)
process.once("SIGTERM", interrupt)
const stop = async () => {
  kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  await exited
  clearTimeout(force)
  kill("SIGKILL")
}
const jsonl = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []
const hooks = () => jsonl(hookLog)
const streamParts = () => jsonl(streamLog).filter(record => record.sessionID === sessionID).map(record => record.part)
const tools = (history: any[]) => history.flatMap(message => message.type === "assistant" ? message.content.filter((part: any) => part.type === "tool") : [])
async function start() {
  generation++
  const port = await new Promise<number>((done, reject) => {
    const socket = createServer()
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      assert(address && typeof address !== "string")
      socket.close(error => error ? reject(error) : done(address.port))
    })
  })
  const url = `http://127.0.0.1:${port}`
  serverURL = url
  const out = openSync(join(root, `server-${generation}.stdout.log`), "w", 0o600)
  const err = openSync(join(root, `server-${generation}.stderr.log`), "w", 0o600)
  try { server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env, detached: true, stdio: ["ignore", out, err] }) }
  finally { closeSync(out); closeSync(err) }
  exited = new Promise<void>(done => { server!.once("error", error => abort.abort(error)); server!.once("close", () => done()) })
  const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
  const deadline = Date.now() + 30_000
  while (true) {
    abort.signal.throwIfAborted()
    try { if ((await fetch(`${url}/api/info`, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_000)]) })).ok) break } catch {}
    assert(Date.now() < deadline, "Owned server did not become ready")
    await Bun.sleep(150)
  }
  client = OpenCode.make({ baseUrl: url, headers })
  save(`server-${generation}.json`, { url, pid: server.pid })
}
async function turn(label: string, text: string) {
  await client!.session.prompt({ sessionID: sessionID!, text }, { signal: abort.signal })
  await client!.experimental.session.wait({ sessionID: sessionID! }, { signal: abort.signal })
  const history = await client!.session.context({ sessionID: sessionID! }, { signal: abort.signal })
  save(`${label}-context.json`, history)
  const assistant = history.findLast(message => message.type === "assistant")
  assert(assistant?.type === "assistant" && !assistant.error && assistant.finish === "stop", `${label}: assistant failed`)
  return history
}
async function until<T>(label: string, action: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  while (true) {
    abort.signal.throwIfAborted()
    const value = await action()
    if (value !== undefined) return value
    assert(Date.now() < deadline, label)
    await Bun.sleep(150)
  }
}
async function captureTUI(label: string, required: string[]) {
  if (process.env.FULL_CLAUDE_TUI_CAPTURE !== "1") return
  const socket = join(root, `tui-${label}.sock`)
  const captureEnv = { ...env, OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: ["-*"], highlights: false, animations: false,
    attention: { notifications: false, sound: false }, session: { sidebar: "hide", grouping: "none" }, tabs: { mode: "off" } }) }
  const tmux = (...args: string[]) => spawnSync("nix", ["shell", "nixpkgs#tmux", "-c", "tmux", "-S", socket, ...args], { cwd, env: captureEnv, encoding: "utf8", timeout: 30_000 })
  try {
    const started = tmux("new-session", "-d", "-s", "capture", "-x", "200", "-y", "110", `exec opencode --server ${quote(serverURL)} --session ${quote(sessionID!)} ${quote(cwd)}`)
    assert.equal(started.status, 0, started.stderr)
    await until("Actual TUI did not render provenance labels", async () => {
      const captured = tmux("capture-pane", "-p", "-t", "capture", "-S", "-")
      writeFileSync(join(root, `tui-${label}.txt`), captured.stdout, { mode: 0o600 })
      return required.every(text => captured.stdout.includes(text)) ? true : undefined
    }, 30_000)
  } finally { tmux("kill-server") }
}
function validateNative(history: any[], expectedBash: number, expectedWrite: number) {
  const inputs = hooks().filter(input => input.hook_event_name === "PreToolUse")
  const transcriptPath = inputs[0]?.transcript_path
  assert(transcriptPath, "Native hooks did not record a transcript path")
  const records = jsonl(transcriptPath)
  save("native-transcript.json", records)
  const transcriptCalls = records.filter(record => record.type === "assistant").flatMap(record => record.message?.content ?? []).filter(part => part.type === "tool_use")
  const frameCalls = jsonl(framesLog).filter(record => record.owner.sessionID === sessionID && record.message.type === "assistant")
    .flatMap(record => record.message.message.content).filter(part => part.type === "tool_use")
  const calls = [...new Map([...transcriptCalls, ...frameCalls].map(call => [call.id, call])).values()]
  const historyTools = tools(history)
  assert.equal(calls.filter(call => call.name === "Bash").length, expectedBash)
  assert.equal(calls.filter(call => call.name === "Write").length, expectedWrite)
  assert.equal(inputs.filter(input => input.tool_name === "Bash").length, expectedBash, "Native Bash PreToolUse count differs from SDK calls")
  assert.equal(inputs.filter(input => input.tool_name === "Write").length, expectedWrite)
  assert.equal(historyTools.length, expectedBash + expectedWrite, "Unexpected or replayed host tool records")
  for (const call of calls) {
    const part = historyTools.find(part => part.id === call.id)
    assert(part, `Native SDK identity ${call.id} was lost`)
    assert.equal(part.executed, true, "Tool was not marked provider-executed")
    assert.equal(part.name, call.name === "Bash" ? "shell" : call.name)
    if (pendingNativeCommand !== undefined && call.input.command === pendingNativeCommand) continue
    if (call.name === "Bash") {
      const presentation = part.native?.presentation
      assert.equal(presentation?.sdkName, "Bash")
      assert.deepEqual(presentation.sdkInput, call.input)
      assert.deepEqual(presentation.displayInput, { ...call.input, command: `# Requested by Claude\n${call.input.command}` })
      assert.deepEqual(part.state.input, presentation.displayInput, "Host card did not receive the labelled display input")
      const rawCall = streamParts().find(part => part.type === "tool-call" && part.toolCallId === call.id)
      assert(rawCall || resumeRoot, `Missing raw call ${call.id}`)
      if (rawCall) assert.deepEqual(JSON.parse(rawCall.input), presentation.displayInput)
      const posts = hooks().filter(input => input.hook_event_name === "PostToolUse" && input.tool_name === "Bash" && input.tool_use_id === call.id)
      const observation = presentation.nativeObservation
      if (posts.length) {
        assert.equal(posts.length, 1)
        assert(observation, `Native PostToolUse observation was lost for ${call.id}`)
        assert.equal(observation.source, "PostToolUse")
        assert.equal(observation.command, posts[0].tool_input.command)
      } else assert.equal(observation, null, "An unobserved command was labelled observed")
      const rawResult = streamParts().find(part => part.type === "tool-result" && part.toolCallId === call.id)
      assert(rawResult || resumeRoot, `Missing raw result ${call.id}`)
      const nativeResult = jsonl(framesLog).filter(record => record.owner.sessionID === sessionID)
        .flatMap(record => record.message.type === "user" ? record.message.message.content : [])
        .find(part => part.type === "tool_result" && part.tool_use_id === call.id)
        ?? (resumeRoot ? records.flatMap(record => record.message?.content ?? []).find(part => part.type === "tool_result" && part.tool_use_id === call.id) : undefined)
      assert(nativeResult, `Missing SDK result ${call.id}`)
      if (rawResult) assert.equal(rawResult.isError, nativeResult.is_error ?? false, "Native error flag changed during presentation")
      if (typeof nativeResult.content === "string") {
        const prefix = `${observation ? `Native command (observed): ${posts[0].tool_input.command}` : "Native command not observed"}\n\n--- Native output ---\n`
        assert.equal(presentation.resultPrefix, prefix)
        assert.equal(presentation.resultKind, "native-output")
        if (rawResult) assert.equal(rawResult.result, prefix + nativeResult.content, "Presented output differs from the SDK result")
        const displayed = part.state.status === "error" ? part.state.error.message
          : part.state.content.map((item: any) => item.type === "text" ? item.text : "").join("")
        assert.equal(displayed, prefix + nativeResult.content)
      }
    } else assert.deepEqual(part.state.input, call.input)
  }
  assert.equal(jsonl(hostLog).length, 0, "Host tool executor was invoked")
  assert(jsonl(loadedLog).length >= generation, "Host execution observer did not load after restart")
  return { records, calls, historyTools }
}
async function lifecycleChecks() {
  const rpc = () => client!.rpc(NativeTasks)
  const options = () => ({ location: { directory: cwd }, signal: abort.signal })
  const launched = join(cwd, "background-start.txt")
  const ended = join(cwd, "background-end.txt")
  const outputMarker = `NATIVE_OUTPUT_${randomBytes(8).toString("hex")}`
  const backgroundCommand = `printf 'BEGIN\\n' > ${quote(launched)}; printf '${outputMarker}\\n'; sleep 120; printf 'END\\n' > ${quote(ended)}`
  const began = join(cwd, "foreground-start.txt")
  const finished = join(cwd, "foreground-end.txt")
  const cancelCommand = `printf 'BEGIN\\n' > ${quote(began)}; sleep 120; printf 'END\\n' > ${quote(finished)}`
  pendingNativeCommand = cancelCommand
  await client!.session.prompt({ sessionID: sessionID!, text: `Isolated lifecycle test. First call native Bash once with run_in_background=true and command exactly: ${backgroundCommand}\nAfter Bash returns its native task ID, call native Bash once more with run_in_background=false and command exactly: ${cancelCommand}\nDo not poll, stop the task, call TaskOutput, or use any other tools. The harness will stop the background task and interrupt the foreground command.` }, { signal: abort.signal })
  await until("Foreground command did not actually begin", async () => existsSync(began) ? true : undefined)
  const background = await client!.session.context({ sessionID: sessionID! }, { signal: abort.signal })
  save("background-context.json", background)
  const validated = validateNative(background, 2, 0)
  const call = validated.calls.find(call => call.input.command === backgroundCommand)
  assert(call, "Native background command was not called")
  assert.equal(call.input.command, backgroundCommand)
  assert.equal(call.input.run_in_background, true)
  const post = hooks().filter(input => input.hook_event_name === "PostToolUse" && input.tool_use_id === call.id)
  assert.equal(post.length, 1, "Background launch lost its native PostToolUse observation")
  assert.deepEqual(post[0].tool_input, call.input)
  assert.equal(readFileSync(launched, "utf8"), "BEGIN\n")
  assert(!existsSync(ended), "Background task finished before lifecycle assertions")
  const task = await until("Native background task was not running", async () => {
    const result = await rpc().list({ sessionID: sessionID! }, options())
    assert.equal(result.tasks.length, 1)
    return result.tasks.find(task => task.state === "running")
  })
  assert(task.taskID && task.canStop && !task.ambient)
  const nativeResult = jsonl(framesLog).find(record => record.owner.sessionID === sessionID && record.message.type === "user" && record.message.tool_use_result?.backgroundTaskId === task.taskID)
  assert(nativeResult, "Registry task ID was not supplied by native Bash")
  assert.equal(nativeResult.owner.providerID, "full-claude-agent-bashsmoke")
  assert.equal(nativeResult.owner.nativeID, post[0].session_id)
  assert(nativeResult.message.message.content.some((part: any) => part.type === "tool_result" && part.tool_use_id === call.id), "Background result belongs to another Bash call")
  const output = await until("Native output did not contain the command marker", async () => {
    const result = await rpc().output({ sessionID: sessionID!, id: task.id }, options())
    return result.available && result.text.includes(outputMarker) ? result : undefined
  })
  save("background-running.json", { task, output, nativeResult, post: post[0] })
  assert.equal((await rpc().stop({ sessionID: sessionID!, id: task.id }, options())).requested, true)
  const terminal = await until("Native stop did not reach a terminal task state", async () => {
    const result = await rpc().list({ sessionID: sessionID! }, options())
    return result.tasks.find(item => item.id === task.id && ["stopped", "failed", "completed"].includes(item.state))
  })
  assert.equal(terminal.canStop, false)
  assert(!existsSync(ended), "Stopped task ran its completion marker")
  save("background-stopped.json", terminal)

  await client!.session.interrupt({ sessionID: sessionID!, resume: false }, { signal: abort.signal })
  await client!.experimental.session.wait({ sessionID: sessionID! }, { signal: abort.signal })
  const cancelled = await client!.session.context({ sessionID: sessionID! }, { signal: abort.signal })
  save("cancelled-context.json", cancelled)
  assert(!existsSync(finished), "Interrupted foreground command completed")
  const cancelPart = tools(cancelled).find(part => part.native?.presentation?.sdkInput?.command === cancelCommand)
  assert(cancelPart, "Cancelled native command lost its host record")
  assert.notEqual(cancelPart.state.status, "completed", "Interrupted command was falsely marked completed")
  const raw = streamParts().find(part => part.type === "tool-result" && part.toolCallId === cancelPart.id)
  if (raw) {
    assert.equal(raw.isError, true)
    assert.match(String(raw.result), /interrupt|cancel|abort/i)
  } else {
    assert.equal(cancelPart.state.status, "error")
    assert.equal(cancelPart.state.error.type, "aborted")
    assert.match(cancelPart.state.error.message, /interrupt|cancel|abort/i)
  }
  const nativeID = hooks()[0].session_id
  await stop()
  await start()
  const restartOnly = process.env.FULL_CLAUDE_LIFECYCLE_RESTART_ONLY === "1"
  const resumed = restartOnly ? await client!.session.context({ sessionID: sessionID! }, { signal: abort.signal })
    : await turn("lifecycle-resumed", "The lifecycle test is over. Do not use tools or retry any command. Reply exactly LIFECYCLE_RESUME_OK.")
  save("lifecycle-resumed-context.json", resumed)
  if (!restartOnly) assert(resumed.some(message => message.type === "assistant" && message.content.some((part: any) => part.type === "text" && part.text.includes("LIFECYCLE_RESUME_OK"))))
  assert.equal(tools(resumed).length, 2, "Restart replayed a native tool call")
  assert.equal(resumed.filter(message => message.type === "user").length, restartOnly ? 1 : 2)
  assert.equal(readFileSync(launched, "utf8"), "BEGIN\n")
  assert.equal(readFileSync(began, "utf8"), "BEGIN\n")
  assert(!existsSync(ended) && !existsSync(finished))
  assert(hooks().every(input => input.session_id === nativeID), "Restart changed native session identity")
  assert.equal(jsonl(hostLog).length, 0)
  assert(cancelPart.native.presentation.nativeObservation == null, "Interrupted command received a false native observation")
  const cancelNativeResult = jsonl(framesLog).flatMap(record => record.message.type === "user" ? record.message.message.content : [])
    .find(part => part.type === "tool_result" && part.tool_use_id === cancelPart.id)
  if (raw) {
    assert.equal(cancelPart.native.presentation.resultKind, cancelNativeResult ? "native-output" : "adapter-status")
    assert.match(String(raw.result), /^Native command not observed\n\n--- (?:Adapter status|Native output) ---\n/)
  }
  const restoredCancel = tools(resumed).find(part => part.id === cancelPart.id)
  assert.deepEqual(restoredCancel, cancelPart, "Restart rewrote the cancelled tool record")
  save("success.json", { status: restartOnly ? "partial" : "passed", sessionID, nativeSessionID: nativeID, turns: restartOnly ? 1 : 2, nativeFollowupTested: !restartOnly,
    cancellationRawResult: !!raw, checks: ["background launch observed, not completion", "native task ID and output", "native Stop RPC", "foreground execution began before cancellation", "cancelled host tool is error, not completed", "restart persisted history without replay"] })
}
console.log(`Bash presentation artifacts (private): ${root}`)
try {
  const version = spawnSync("opencode", ["--version"], { cwd, env, encoding: "utf8", timeout: 10_000 })
  assert.equal(version.status, 0)
  assert.match(version.stdout.trim(), /^(?:opencode v)?2\.2\.7$/)
  const nativeVersion = spawnSync("claude", ["--version"], { cwd, env: { ...env, CLAUDE_CONFIG_DIR: configDir }, encoding: "utf8", timeout: 10_000 })
  assert.equal(nativeVersion.status, 0)
  save("versions.json", { opencode: version.stdout.trim(), claude: nativeVersion.stdout.trim() })
  await start()
  const session = resumeRoot ? { id: JSON.parse(readFileSync(join(root, "run.json"), "utf8")).sessionID } : await client!.session.create({ location: { directory: cwd }, title: "Bash presentation smoke",
    model: { providerID: "full-claude-agent-bashsmoke", id: "haiku" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] }, { signal: abort.signal })
  sessionID = session.id
  await client!.model.list({ location: { directory: cwd } }, { signal: abort.signal })
  save("plugins.json", await client!.plugin.list({ location: { directory: cwd } }, { signal: abort.signal }))
  assert(existsSync(loadedLog), "Host execution observer failed to load before paid turn")
  save("run.json", { root, cwd, configDir, sessionID, model: "full-claude-agent-bashsmoke/haiku", maxTurns: lifecycle ? 2 : 3 })
  if (lifecycle && resumeRoot && existsSync(join(root, "cancelled-context.json"))) {
    const cancelled = JSON.parse(readFileSync(join(root, "cancelled-context.json"), "utf8"))
    const interrupted = tools(cancelled).find(part => part.state.error?.type === "aborted")
    assert(interrupted)
    pendingNativeCommand = interrupted.native.presentation.sdkInput.command
    const before = await client!.session.context({ sessionID: sessionID! }, { signal: abort.signal })
    const savedFollowup = existsSync(join(root, "lifecycle-followup-context.json"))
      ? JSON.parse(readFileSync(join(root, "lifecycle-followup-context.json"), "utf8")) as any[] : undefined
    const recheck = !!savedFollowup
    assert.equal(before.filter(message => message.type === "user").length, recheck ? 2 : 1, "Retained fixture received an unexpected user turn")
    assert.equal(tools(before).length, 2)
    const nativeID = hooks()[0]?.session_id
    assert(nativeID)
    const hooksBefore = hooks()
    assert(hooksBefore.every(input => input.session_id === nativeID))
    const priorFrames = jsonl(framesLog)
    const cancelledResultIndex = priorFrames.findLastIndex(record => record.owner.sessionID === sessionID && record.message.type === "result" && record.message.terminal_reason === "aborted_tools")
    if (recheck) assert(cancelledResultIndex >= 0, "Saved cancellation result is missing")
    const frameCount = recheck ? cancelledResultIndex + 1 : priorFrames.length
    const restartOnly = process.env.FULL_CLAUDE_LIFECYCLE_RESTART_ONLY === "1"
    const replyMarker = recheck ? /Reply exactly (LIFECYCLE_RESUME_OK_[a-f0-9]+)\./.exec(savedFollowup!.findLast(message => message.type === "user")?.text ?? "")?.[1]
      : `LIFECYCLE_RESUME_OK_${randomBytes(8).toString("hex")}`
    assert(replyMarker)
    if (!restartOnly && !recheck) save("native-followup-attempt.json", { nativeID, frameCount, hooksBefore, toolRecordsBefore: tools(before), replyMarker })
    const resumed = restartOnly || recheck ? before : await turn("lifecycle-followup", `The cancellation test is over. Do not use tools or retry any command. Reply exactly ${replyMarker}.`)
    if (!restartOnly) {
      const assistant = resumed.findLast(message => message.type === "assistant")
      assert(assistant?.type === "assistant")
      assert.equal(assistant.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join(""), replyMarker)
      const newFrames = jsonl(framesLog).slice(frameCount)
      const resultFrames = newFrames.filter(record => record.message.type === "result" && record.message.result === replyMarker)
      assert.equal(resultFrames.length, 1, "Follow-up did not produce exactly one marker-matched native SDK result")
      assert(newFrames.filter(record => record.message.type === "result" && record.message.result !== replyMarker)
        .every(record => record.message.origin?.kind === "task-notification" && record.message.num_turns === 0 && !record.message.is_error), "An unrelated foreground SDK result arrived during the follow-up")
      assert.equal(resultFrames[0].message.subtype, "success")
      assert.equal(resultFrames[0].message.session_id, nativeID, "Follow-up did not resume the original native session")
      assert(newFrames.every(record => record.owner.sessionID === sessionID && record.owner.nativeID === nativeID && record.owner.providerID === "full-claude-agent-bashsmoke"), "Follow-up frames belong to another session or profile")
      assert.equal(newFrames.filter(record => record.message.type === "assistant").flatMap(record => record.message.message.content).filter(part => part.type === "tool_use").length, 0, "Follow-up executed a native tool")
      save("native-followup.json", { nativeSessionID: nativeID, replyMarker, result: resultFrames[0].message, owner: resultFrames[0].owner, newNativeToolCalls: 0 })
    }
    validateNative(resumed, 2, 0)
    assert.deepEqual(tools(resumed), tools(cancelled), "Follow-up changed or replayed existing tool records")
    assert.deepEqual(hooks(), hooksBefore, "Follow-up ran a native tool hook")
    assert.deepEqual(tools(resumed).find(part => part.id === interrupted.id), interrupted)
    assert.equal(interrupted.state.status, "error")
    assert(interrupted.native.presentation.nativeObservation == null)
    assert.equal(resumed.filter(message => message.type === "user").length, restartOnly ? 1 : 2)
    assert.equal(readFileSync(join(cwd, "background-start.txt"), "utf8"), "BEGIN\n")
    assert.equal(readFileSync(join(cwd, "foreground-start.txt"), "utf8"), "BEGIN\n")
    assert(!existsSync(join(cwd, "background-end.txt")) && !existsSync(join(cwd, "foreground-end.txt")))
    const running = JSON.parse(readFileSync(join(root, "background-running.json"), "utf8"))
    const stopped = JSON.parse(readFileSync(join(root, "background-stopped.json"), "utf8"))
    assert.equal(stopped.state, "stopped")
    assert.equal(stopped.taskID, running.nativeResult.message.tool_use_result.backgroundTaskId)
    assert.equal(stopped.canStop, false)
    assert.equal((await client!.rpc(NativeTasks).list({ sessionID: sessionID! }, { location: { directory: cwd }, signal: abort.signal })).tasks[0]?.state, "stopped")
    save("lifecycle-resumed-context.json", resumed)
    save("success.json", { status: restartOnly ? "partial" : "passed", sessionID, nativeSessionID: nativeID, turns: restartOnly ? 1 : 2, recoverySubmittedPrompts: restartOnly || recheck ? 0 : 1, nativeFollowupTested: !restartOnly, cancellationRawResult: false,
      checks: ["background launch observed, not completion", "native task ID and output", "native Stop RPC reached stopped", "foreground execution began before cancellation", "cancelled host tool is error, not completed", "restart persisted cancelled history without replay",
        ...(!restartOnly ? ["native follow-up resumed original session", "marker reply with exactly two user messages", "existing two tool records and native hooks unchanged"] : [])] })
    console.log(`${restartOnly ? "PARTIAL: restart persistence only; native follow-up not exercised" : "PASS: native background launch/Stop, cancellation, restart, and native follow-up without replay"}. Artifacts: ${root}`)
  } else if (lifecycle) {
    await lifecycleChecks()
    console.log(`${process.env.FULL_CLAUDE_LIFECYCLE_RESTART_ONLY === "1" ? "PARTIAL: restart persistence only; native follow-up not exercised" : "PASS: native Bash background launch, Stop RPC, cancellation, restart, and follow-up"}. Artifacts: ${root}`)
  } else if (resumeRoot && existsSync(join(root, "denied-context.json"))) {
    const history = await client!.session.context({ sessionID: sessionID! }, { signal: abort.signal })
    const validated = validateNative(history, 3, 1)
    assert.equal(readFileSync(marker, "utf8"), "HOOK_FIRST\nSECOND\n")
    assert(!existsSync(denied))
    const rejected = validated.historyTools.at(-1)
    assert.equal(rejected.state.status, "error")
    assert.equal(rejected.native.presentation.nativeObservation, null)
    assert.equal(history.filter(message => message.type === "user").length, 3)
    assert(hooks().every(input => input.session_id === hooks()[0].session_id))
    await captureTUI("denied", ["# Requested by Claude", "MUST_NOT_EXECUTE", "Native command not observed", "--- Native output ---"])
    save("success.json", { status: "passed", sessionID, turns: 3, recoverySubmittedPrompts: 0, nativeBashAttempts: 3, executedBash: 2, nativeWrite: 1, hostExecutions: 0, restart: true,
      checks: ["hook-modified command observation", "original SDK input and decorated host input", "SDK result text and isError", "native Write", "restart without replay", "denied command unobserved and unexecuted", "actual success and denial TUI captures"] })
    console.log(`PASS: native Bash provenance, SDK results, restart, denial, and actual TUI captures. Artifacts: ${root}`)
  } else {
    const command1 = `printf '%s\\n' ORIGINAL_FIRST >> ${quote(marker)}; printf 'SDK_FIRST_OUTPUT\\n'`
    const first = resumeRoot ? await client!.session.context({ sessionID: sessionID! }, { signal: abort.signal }) : await turn("first", `Isolated integration test. Call native Bash exactly once with this exact command: ${command1}. Then call native Write exactly once to create ${written} containing NATIVE_WRITE. Use no other tools. Do not retry any call. Reply FIRST_DONE.`)
    assert.equal(readFileSync(marker, "utf8"), "HOOK_FIRST\n", "Native hook command modification did not execute exactly once")
    assert.match(readFileSync(written, "utf8"), /NATIVE_WRITE/)
    validateNative(first, 1, 1)
    await captureTUI("success", ["# Requested by Claude", "ORIGINAL_FIRST", "Native command (observed)", "HOOK_FIRST", "--- Native output ---", "SDK_FIRST_OUTPUT"])
    const firstNativeID = hooks()[0].session_id
    assert(hooks().some(input => input.hook_event_name === "PostToolUse" && input.tool_name === "Bash" && input.tool_input.command.includes("HOOK_FIRST")), "Native PostToolUse did not see modified Bash")
    assert(!hooks().some(input => input.tool_name === "shell"), "Presentation name leaked to native hooks")
    await stop()
    await start()
    const command2 = `printf '%s\\n' SECOND >> ${quote(marker)}`
    const second = await turn("resumed", `Continue the same transcript. Do not repeat any earlier tool call. Call native Bash exactly once with this exact command: ${command2}. Use no other tools and do not retry. Reply SECOND_DONE.`)
    assert.equal(readFileSync(marker, "utf8"), "HOOK_FIRST\nSECOND\n", "Restart replayed or duplicated Bash")
    validateNative(second, 2, 1)
    assert(hooks().every(input => input.session_id === firstNativeID), "Restart did not resume the same native session")
    assert.equal(second.filter(message => message.type === "user").length, 2, "Host replayed user prompts")
    await client!.session.update({ sessionID: sessionID!, permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "deny" }] }, { signal: abort.signal })
    const command3 = `printf '%s\\n' MUST_NOT_EXECUTE >> ${quote(denied)}`
    const third = await turn("denied", `Permission integration test. Attempt native Bash exactly once with this exact command: ${command3}. A denial is expected. Do not retry, work around the denial, or use any other tool. Report DENIED_EXPECTED after the attempt.`)
    assert(!existsSync(denied), "Denied Bash executed")
    assert.equal(readFileSync(marker, "utf8"), "HOOK_FIRST\nSECOND\n")
    const validated = validateNative(third, 3, 1)
    const last = validated.historyTools.at(-1)
    assert.equal(last.name, "shell")
    assert.equal(last.state.status, "error", "Denied Bash was rendered as success")
    const rejected = validated.calls.find(call => call.input.command === command3)
    assert(rejected, "Model never attempted the denied command")
    assert(validated.records.flatMap(record => record.message?.content ?? []).some(part => part.type === "tool_result" && part.tool_use_id === rejected.id && part.is_error), "Native transcript lost denial failure")
    assert.equal(third.filter(message => message.type === "user").length, 3)
    await captureTUI("denied", ["# Requested by Claude", "MUST_NOT_EXECUTE", "Native command not observed", "--- Native output ---"])
    const assistants = third.filter(message => message.type === "assistant")
    save("usage.json", { hostReportedCostUSD: assistants.reduce((total, message) => total + (message.cost ?? 0), 0),
      turns: assistants.length, tokens: assistants.map(message => message.tokens),
      nativeAssistantResponses: new Set(validated.records.filter(record => record.type === "assistant").map(record => record.message.id)).size })
    save("success.json", { status: "passed", sessionID, nativeSessionID: firstNativeID, turns: 3, nativeBashAttempts: 3, executedBash: 2, nativeWrite: 1, hostExecutions: 0, restart: true,
      checks: ["hook-modified Bash exactly once", "native Bash hooks", "stock shell history with native SDK identity/input", "Write remains native", "owned server restart resumes without replay", "denied Bash retains native and host failure without execution"] })
    console.log(`PASS: native Bash presentation, hooks, restart, denial, and native Write. Artifacts: ${root}`)
  }
  save("native-usage.json", jsonl(framesLog).filter(record => record.owner.sessionID === sessionID && record.message.type === "result")
    .map(record => ({ sessionID: record.message.session_id, subtype: record.message.subtype, sdkReportedCostUSD: record.message.total_cost_usd,
      usage: record.message.usage, modelUsage: record.message.modelUsage })))
  if (existsSync(join(root, "failure.json"))) unlinkSync(join(root, "failure.json"))
} catch (error) {
  save("failure.json", { status: "failed", sessionID, message: String(error), stack: error instanceof Error ? error.stack : undefined })
  console.error(`FAIL: ${String(error)}\nArtifacts: ${root}`)
  process.exitCode = 1
} finally {
  if (!abort.signal.aborted && client && sessionID) await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(3_000) }).catch(() => {})
  clearTimeout(timer)
  abort.abort()
  await stop()
  process.removeListener("SIGINT", interrupt)
  process.removeListener("SIGTERM", interrupt)
}
