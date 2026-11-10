import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 for two isolated, paid native turns.")
  process.exit(0)
}

const root = process.env.FULL_CLAUDE_THINKING_RESUME_ROOT ?? createTempDirectory("full-claude-thinking-")
const cwd = join(root, "project")
const config = join(root, "config")
const observer = join(root, "observer")
const provider = join(root, "provider")
const bodies = join(root, "api-bodies")
for (const dir of [cwd, config, observer, provider, bodies, join(cwd, ".claude")]) mkdirSync(dir, { recursive: true, mode: 0o700 })
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const source = fileURLToPath(new URL("../src/", import.meta.url))
assert.match(readFileSync(join(source, "runtime.ts"), "utf8"), /["']thinking-display["']\s*:\s*["']summarized["']/, "Runtime display-only implementation is not ready")
const configDir = resolve(process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
const model = process.env.FULL_CLAUDE_THINKING_MODEL ?? "haiku"
const frames = join(root, "frames.jsonl")
const parts = join(root, "parts.jsonl")
save("observer/package.json", { name: "thinking-smoke-observer", type: "module", exports: { ".": "./index.ts" } })
writeFileSync(join(observer, "index.ts"), `import { Plugin } from "@opencode/plugin";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { appendFileSync } from "node:fs";
export default fromPromise(Plugin.define({id:"thinking-smoke-observer",async setup(ctx) {
  await ctx.session.hook("title", event => {event.result="Thinking summary smoke"});
  await ctx.tool.hook("execute.before", () => {throw new Error("Host tool execution forbidden")});
  appendFileSync(${JSON.stringify(join(root, "observer-loaded"))}, "loaded\\n", {mode:0o600});
}}));`, { mode: 0o600 })
save("provider/package.json", { name: "thinking-smoke-provider", type: "module", exports: { ".": "./index.ts" } })
writeFileSync(join(provider, "index.ts"), `import { appendFileSync } from "node:fs";
import { Runtime } from ${JSON.stringify(join(source, "runtime.ts"))};
import { NativeTaskStore } from ${JSON.stringify(join(source, "tasks.ts"))};
const run=Runtime.prototype.run;
Runtime.prototype.run=function(request){return run.call(this,{...request,emit(part){appendFileSync(${JSON.stringify(parts)},JSON.stringify({sessionID:request.sessionID,part})+"\\n",{mode:0o600});request.emit(part)}})};
const connect=NativeTaskStore.prototype.connect;
NativeTaskStore.prototype.connect=function(owner,stop){const connection=connect.call(this,owner,stop);return {...connection,observe(message){appendFileSync(${JSON.stringify(frames)},JSON.stringify({owner,message})+"\\n",{mode:0o600});return connection.observe(message)}}};
export {default} from ${JSON.stringify(join(source, "index.ts"))};`, { mode: 0o600 })
save("project/opencode.json", { plugins: [observer, { package: provider, options: { profiles: { thinkingsmoke: {
  configDir, binaryPath: "claude", models: [model], env: { OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
} } } }] })
const password = randomBytes(32).toString("base64url")
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "opencode.sqlite"), OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_SIMULATE: "0", OPENCODE_PASSWORD: password }
delete env.OPENCODE_CONFIG
delete env.OPENCODE_SERVER_PASSWORD
const abort = new AbortController()
let server: ReturnType<typeof spawn> | undefined
let exited: Promise<void> | undefined
const kill = (signal: NodeJS.Signals) => { if (server?.pid) try { process.kill(-server.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error } }
const timer = setTimeout(() => { abort.abort(new Error("Thinking smoke exceeded 240 seconds")); kill("SIGKILL") }, 240_000)
const interrupt = () => { abort.abort(); kill("SIGKILL") }
process.once("SIGINT", interrupt)
process.once("SIGTERM", interrupt)
const jsonl = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []
const port = await new Promise<number>((done, reject) => {
  const socket = createServer(); socket.once("error", reject)
  socket.listen(0, "127.0.0.1", () => { const address = socket.address(); assert(address && typeof address !== "string"); socket.close(error => error ? reject(error) : done(address.port)) })
})
const url = `http://127.0.0.1:${port}`
const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
const client = OpenCode.make({ baseUrl: url, headers })
async function until(label: string, check: () => Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms
  while (true) { abort.signal.throwIfAborted(); if (await check()) return; assert(Date.now() < deadline, label); await Bun.sleep(150) }
}
async function capture(sessionID: string, sample: string) {
  const socket = join(root, "tui.sock")
  const captureEnv = { ...env, OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: ["-*"], highlights: false, animations: false,
    attention: { notifications: false, sound: false }, session: { sidebar: "hide", grouping: "none" }, tabs: { mode: "off" } }) }
  const tmux = (...args: string[]) => spawnSync("nix", ["shell", "nixpkgs#tmux", "-c", "tmux", "-S", socket, ...args], { cwd, env: captureEnv, encoding: "utf8", timeout: 30_000 })
  try {
    const started = tmux("new-session", "-d", "-s", "capture", "-x", "200", "-y", "110", `exec opencode --server ${quote(url)} --session ${quote(sessionID)} ${quote(cwd)}`)
    assert.equal(started.status, 0, started.stderr)
    await until("Actual TUI did not render the session", async () => { const text = tmux("capture-pane", "-p", "-t", "capture", "-S", "-").stdout; writeFileSync(join(root, "tui-default.txt"), text, { mode: 0o600 }); return text.includes("Thought") || text.includes(sample) })
    const initial = readFileSync(join(root, "tui-default.txt"), "utf8")
    save("tui-state.json", { summaryVisibleInitially: initial.includes(sample), sample })
    if (!initial.includes(sample)) {
      const row = initial.split("\n").findIndex(line => line.includes("+ Thought")) + 1
      assert(row > 0, "Collapsed native reasoning row is missing")
      tmux("send-keys", "-t", "capture", "-l", `\x1b[<0;10;${row}M\x1b[<0;10;${row}m`)
      await until("Expanded TUI did not render native reasoning", async () => { const text = tmux("capture-pane", "-p", "-t", "capture", "-S", "-").stdout; writeFileSync(join(root, "tui-expanded.txt"), text, { mode: 0o600 }); return text.includes(sample) })
    }
  } finally { tmux("kill-server") }
}
console.log(`Thinking summary artifacts (private): ${root}`)
try {
  const native = spawnSync("claude", ["--version"], { env: { ...env, CLAUDE_CONFIG_DIR: configDir }, encoding: "utf8", timeout: 10_000 })
  const host = spawnSync("opencode", ["--version"], { env, encoding: "utf8", timeout: 10_000 })
  assert.equal(native.status, 0); assert.equal(host.status, 0)
  save("versions.json", { claude: native.stdout.trim(), opencode: host.stdout.trim() })
  const out = openSync(join(root, "server.stdout.log"), "w", 0o600)
  const err = openSync(join(root, "server.stderr.log"), "w", 0o600)
  try { server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env, detached: true, stdio: ["ignore", out, err] }) }
  finally { closeSync(out); closeSync(err) }
  exited = new Promise<void>(done => { server!.once("error", error => abort.abort(error)); server!.once("close", () => done()) })
  save("server.json", { url, pid: server.pid })
  await until("Owned server did not become ready", async () => { try { return (await fetch(`${url}/api/info`, { headers, signal: AbortSignal.timeout(1_000) })).ok } catch { return false } })
  const results = []
  const prompt = "Do not use any tools. A warehouse ships exactly 137 boxes using small crates holding 4 boxes and large crates holding 9 boxes. It uses exactly 23 crates total. Each large crate costs $7 and each small crate costs $3. What is the total crate cost? Reply with only the dollar amount."
  for (const disabled of [false, true]) {
    save("project/.claude/settings.local.json", disabled ? { alwaysThinkingEnabled: false } : {})
    const label = disabled ? "disabled" : "default"
    const resumed = existsSync(join(root, `${label}-context.json`))
    const session = resumed ? { id: JSON.parse(readFileSync(join(root, `${label}-session.json`), "utf8")).sessionID } : await client.session.create({ location: { directory: cwd }, title: "Thinking summary smoke", model: { providerID: "full-claude-agent-thinkingsmoke", id: model } }, { signal: abort.signal })
    save(`${label}-session.json`, { sessionID: session.id, prompt, disabled })
    await client.model.list({ location: { directory: cwd } }, { signal: abort.signal })
    assert(existsSync(join(root, "observer-loaded")), "Host observer failed to load")
    if (!resumed) {
      await client.session.prompt({ sessionID: session.id, text: prompt }, { signal: abort.signal })
      await client.experimental.session.wait({ sessionID: session.id }, { signal: abort.signal })
    }
    const history = await client.session.context({ sessionID: session.id }, { signal: abort.signal })
    save(`${label}-context.json`, history)
    const assistant = history.findLast(message => message.type === "assistant")
    assert(assistant?.type === "assistant" && !assistant.error && assistant.finish === "stop", `${label}: assistant failed`)
    assert.equal(history.filter(message => message.type === "user").length, 1)
    assert(!assistant.content.some(part => part.type === "tool"), "Unexpected native or host tool")
    const reasoning = assistant.content.filter(part => part.type === "reasoning")
    const nativeFrames = jsonl(frames).filter(record => record.owner.sessionID === session.id).map(record => record.message)
    const nativeThinking = nativeFrames.filter(message => message.type === "assistant").flatMap(message => message.message.content).filter(part => part.type === "thinking")
    const emitted = jsonl(parts).filter(record => record.sessionID === session.id).map(record => record.part)
    const requests = readdirSync(bodies).filter(name => name.endsWith(".request.json")).map(name => ({ name, body: JSON.parse(readFileSync(join(bodies, name), "utf8")) }))
    save(`${label}-requests.json`, requests)
    const nativeID = nativeFrames.find(message => message.session_id)?.session_id
    const primary = jsonl(join(bodies, "index.jsonl")).filter(record => record.session_id === nativeID && record.query_source === "sdk")
    assert.equal(primary.length, 1, "Expected exactly one primary native request")
    const request = requests.find(item => item.name === primary[0].request_file)?.body
    assert(request, "Native request body was not recorded")
    const alwaysOn = request.model === "claude-haiku-5-5"
    assert.equal(request.thinking?.type, disabled && !alwaysOn ? "disabled" : "adaptive")
    if (!disabled) assert.equal(request.thinking.display, "summarized")
    const result = { label, sessionID: session.id, nativeID, nativeThinkingAlwaysOn: alwaysOn, thinking: request.thinking, outputConfig: request.output_config, reasoningParts: reasoning.length, nativeThinkingBlocks: nativeThinking.length,
      emittedReasoningStarts: emitted.filter(part => part.type === "reasoning-start").length,
      models: nativeFrames.filter(message => message.type === "assistant").map(message => message.message.model),
      nativeDisplays: nativeFrames.filter(message => message.thinking_display).map(message => message.thinking_display) }
    results.push(result)
    save("results.json", results)
    assert.equal(reasoning.length, nativeThinking.length, "Partial and final native thinking were duplicated or lost")
    assert.equal(result.emittedReasoningStarts, reasoning.length, "Reasoning stream and persisted blocks differ")
    for (let index = 0; index < reasoning.length; index++) assert.equal(reasoning[index]!.text, nativeThinking[index].thinking)
    if (disabled && !alwaysOn) assert.equal(reasoning.length, 0, "Native thinking-disabled setting was ignored")
    if (!disabled) {
      assert(reasoning.length > 0, "Default fixture did not emit a thinking summary")
      assert(reasoning[0]!.text.trim(), "Default native thinking block was empty")
      await capture(session.id, reasoning[0]!.text.trim().split(/\s+/).slice(0, 5).join(" "))
    }
    console.log(JSON.stringify(result))
  }
} finally {
  kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  await exited
  clearTimeout(force); clearTimeout(timer); kill("SIGKILL")
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt)
}
