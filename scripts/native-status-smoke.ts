import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { createTempDirectory } from "./support/temp.js"

const root = createTempDirectory("full-claude-native-status-")
const cwd = join(root, "project")
const config = join(root, "config")
const fixture = join(root, "fixture")
for (const directory of [cwd, config, fixture]) mkdirSync(directory, { mode: 0o700 })
const repository = fileURLToPath(new URL("../", import.meta.url))
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const cases = ["diagnostic-success", "429", "529", "tools", "rate"]
const providerID = "full-claude-agent-fixture-profile"
symlinkSync(join(repository, "node_modules"), join(fixture, "node_modules"), "dir")
save("fixture/package.json", { name: "native-status-private-fixture", type: "module", exports: { ".": "./index.ts" } })
writeFileSync(join(fixture, "index.ts"), `
import { Plugin, Model, Provider } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
import { createStreamConverter } from ${JSON.stringify(join(repository, "src/stream.ts"))}
const providerID = ${JSON.stringify(providerID)}
const cases = ${JSON.stringify(cases)}
const record = (value) => appendFileSync(${JSON.stringify(join(root, "invocations.jsonl"))}, JSON.stringify(value) + "\\n", { mode: 0o600 })
const assistant = (id, content, extra = {}) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content }, ...extra })
const result = (extra = {}) => ({ type: "result", subtype: "success", is_error: false, result: "done", stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, ...extra })
export default Plugin.define({ id: "native-status-private-fixture", async setup(ctx) {
  await ctx.provider.transform((editor) => {
    const id = Provider.ID.make(providerID)
    editor.add({ info: { ...Provider.Info.empty(id), name: "Private fixture", activation: "enabled", package: "aisdk:native-status-private-fixture", settings: { cache: { warming: false } } },
      models: cases.map((name) => ({ ...Model.Info.default(id, Model.ID.make(name)), name, limit: { context: 0, output: 0 }, capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [] })) })
  })
  await ctx.aisdk.hook("sdk", (event) => {
    if (event.package !== "native-status-private-fixture") return
    event.sdk = { languageModel: (modelId) => ({ specificationVersion: "v3", provider: providerID, modelId, supportedUrls: {},
      async doGenerate() { throw new Error("Fixture requires streaming") },
      async doStream(options) {
        record({ modelId, sessionID: options.headers?.["x-opencode-session-id"], tools: options.tools?.map((tool) => tool.name) ?? [] })
        const converter = createStreamConverter({ providerID, directory: ctx.location.directory })
        const messages = []
        if (modelId === "diagnostic-success") {
          messages.push(assistant("diagnostic", [{ type: "text", text: "TRANSIENT_DIAGNOSTIC_MUST_NOT_RENDER" }], { error: "server_error" }))
          messages.push(assistant("recovered", [{ type: "text", text: "RECOVERED_SUCCESS" }]))
        }
        if (modelId === "429") {
          messages.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 2000000000 } })
          messages.push(assistant("limit", [{ type: "text", text: "native quota diagnostic" }], { error: "rate_limit" }))
        }
        if (modelId === "tools") {
          messages.push(assistant("calls", [{ type: "tool_use", id: "native-ok", name: "Read", input: { file_path: "/not-executed" } }, { type: "tool_use", id: "native-fail", name: "Write", input: { file_path: "/not-executed" } }]))
          messages.push({ type: "user", parent_tool_use_id: null, message: { content: [
            { type: "tool_result", tool_use_id: "native-ok", content: [{ type: "text", text: "readable first" }, { type: "text", text: "readable second" }] },
            { type: "tool_result", tool_use_id: "native-fail", is_error: true, content: [{ type: "text", text: "native permission denied" }] },
          ] } })
        }
        const rate = modelId === "rate" ? { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.85, resetsAt: 2000000000 } : undefined
        if (rate) messages.push(assistant("rate", [{ type: "text", text: "RATE_METADATA_SUCCESS" }]))
        messages.push(result(modelId === "429" || modelId === "529" ? { api_error_status: Number(modelId), result: "controlled native failure" } : {}))
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          for (const message of messages) for (const part of converter.push(message, rate)) {
            if (part.type === "finish") record({ finishModel: modelId, providerMetadata: part.providerMetadata })
            controller.enqueue(part)
          }
          for (const part of converter.finish()) controller.enqueue(part)
          controller.close()
        } }) }
      },
    }) }
  }, { providerID })
  await ctx.session.hook("context", (event) => { event.tools = {}; delete event.options.maxTokens }, { providerID })
  await ctx.session.hook("retry", (event) => { record({ retry: true }); event.decision = { retry: false } }, { providerID })
  await ctx.session.hook("title", (event) => { event.result = "Private native status fixture" }, { providerID })
} })
`, { mode: 0o600 })
save("project/opencode.json", { plugins: [{ package: fixture }] })
const password = randomBytes(32).toString("base64url")
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "opencode.sqlite"), OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_SIMULATE: "0", OPENCODE_PASSWORD: password }
delete env.OPENCODE_CONFIG
delete env.OPENCODE_SERVER_PASSWORD
const version = spawnSync("opencode", ["--version"], { env, encoding: "utf8" }).stdout.trim()
assert.match(version, /^(?:opencode v)?2\.2\.7$/)
const sdk = JSON.parse(readFileSync(join(repository, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version
save("versions.json", { opencode: version, claudeAgentSDK: sdk, claude: spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim() })
const port = await new Promise<number>((resolve, reject) => {
  const socket = createServer(); socket.once("error", reject)
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address(); assert(address && typeof address !== "string")
    socket.close((error) => error ? reject(error) : resolve(address.port))
  })
})
const out = openSync(join(root, "server.stdout.log"), "w", 0o600)
const err = openSync(join(root, "server.stderr.log"), "w", 0o600)
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env, detached: true, stdio: ["ignore", out, err] })
closeSync(out); closeSync(err)
const exited = new Promise<void>((resolve) => server.once("close", () => resolve()))
const kill = (signal: NodeJS.Signals) => {
  if (!server.pid) return
  try { process.kill(-server.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
}
const abort = new AbortController()
const timer = setTimeout(() => { abort.abort(new Error("Native status smoke timed out")); kill("SIGKILL") }, 90_000)
const url = `http://127.0.0.1:${port}`
const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
const client = OpenCode.make({ baseUrl: url, headers })
console.log(`Native status fixture artifacts (private): ${root}`)
try {
  const deadline = Date.now() + 30_000
  while (true) {
    abort.signal.throwIfAborted()
    try { if ((await fetch(`${url}/api/info`, { headers, signal: AbortSignal.timeout(1_000) })).ok) break } catch {}
    assert(Date.now() < deadline, "Owned server did not become ready")
    await Bun.sleep(100)
  }
  const outcomes = []
  for (const name of cases) {
    const session = await client.session.create({ location: { directory: cwd }, title: name, model: { providerID, id: name }, permissions: [{ action: "*", resource: "*", effect: "deny" }] }, { signal: abort.signal })
    await client.session.prompt({ sessionID: session.id, text: `Run controlled fixture ${name}` }, { signal: abort.signal })
    let waitError: string | undefined
    try { await client.experimental.session.wait({ sessionID: session.id }, { signal: abort.signal }) } catch (error) { waitError = String(error) }
    const history = await client.session.context({ sessionID: session.id }, { signal: abort.signal })
    save(`${name}.json`, { history, waitError })
    assert.equal(history.filter((message) => message.type === "user").length, 1)
    const assistants = history.filter((message) => message.type === "assistant")
    assert.equal(assistants.length, 1)
    const assistant = assistants[0]!
    const serialized = JSON.stringify(assistant)
    if (name === "429" || name === "529") {
      assert(assistant.error, `${name}: host did not persist failure`)
      assert.match(serialized, name === "429" ? /controlled native failure/ : /overloaded.*529/)
      assert.equal("status" in assistant.error ? assistant.error.status : undefined, Number(name))
      assert.notEqual(assistant.finish, "stop")
    } else {
      assert(!assistant.error, `${name}: unexpected host failure`)
      assert.equal(assistant.finish, "stop")
    }
    if (name === "diagnostic-success") {
      assert.match(serialized, /RECOVERED_SUCCESS/)
      assert(!serialized.includes("TRANSIENT_DIAGNOSTIC_MUST_NOT_RENDER"))
    }
    if (name === "tools") {
      const tools = assistant.content.filter((part) => part.type === "tool")
      assert.equal(tools.length, 2)
      assert(tools.every((part) => part.executed))
      const completed = tools.find((part) => part.id === "native-ok")
      assert.equal(completed?.state.status, "completed")
      if (completed?.state.status === "completed") assert.deepEqual(completed.state.content, [{ type: "text", text: "readable first\nreadable second" }])
      const failed = tools.find((part) => part.id === "native-fail")
      assert.equal(failed?.state.status, "error")
      if (failed?.state.status === "error") assert.equal(failed.state.error.message, "native permission denied")
    }
    if (name === "rate") assert.deepEqual(assistant.native?.rateLimit, { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.85, resetsAt: 2000000000 })
    outcomes.push({ name, sessionID: session.id, finish: assistant.finish, error: assistant.error, waitError })
  }
  const invocations = readFileSync(join(root, "invocations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const models = invocations.filter((entry) => entry.modelId)
  assert.equal(models.length, cases.length, "Implicit model retry or extra model invocation")
  for (const name of cases) assert.equal(models.filter((entry) => entry.modelId === name).length, 1)
  assert(models.every((entry) => entry.tools.length === 0), "Host tools were offered to fixture model")
  assert.deepEqual(invocations.find((entry) => entry.finishModel === "rate")?.providerMetadata, {
    [providerID]: { rateLimit: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.85, resetsAt: 2000000000 } },
  })
  save("success.json", { status: "passed", version, sdk, outcomes, invocations })
  console.log(`PASS: ${cases.length} zero-Claude host cases; one model invocation per user; no host tools. Artifacts: ${root}`)
} catch (error) {
  save("failure.json", { message: String(error), stack: error instanceof Error ? error.stack : undefined })
  console.error(`FAIL: ${String(error)}\nArtifacts: ${root}`)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  abort.abort()
  kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  await exited
  clearTimeout(force)
  kill("SIGKILL")
}
