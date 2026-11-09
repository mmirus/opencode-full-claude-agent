import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { parseProfiles } from "../src/config.js"
import { normalizeModels, probeClaudeModels, selectModels, type CatalogModel } from "../src/models.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 for isolated model discovery without model prompts.")
  process.exit(0)
}

const parent = resolve(process.env.FULL_CLAUDE_TEMP_DIR ?? "/tmp/opencode")
mkdirSync(parent, { recursive: true })
const root = mkdtempSync(join(parent, "full-claude-model-discovery-"))
const cwd = join(root, "project")
const config = join(root, "config")
const plugin = join(root, "plugin")
for (const directory of [cwd, config, plugin]) mkdirSync(directory, { mode: 0o700 })
const source = fileURLToPath(new URL("../", import.meta.url))
cpSync(join(source, "src"), join(plugin, "src"), { recursive: true })
cpSync(join(source, "package.json"), join(plugin, "package.json"))
symlinkSync(join(source, "node_modules"), join(plugin, "node_modules"), "dir")
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const options = { profiles: {
  discovered: { configDir: process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), binaryPath: "claude" },
  pinned: { configDir: process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), binaryPath: "claude", models: ["haiku"] },
} }
const profiles = parseProfiles(options, cwd)
save("project/opencode.json", { $schema: "https://opencode.ai/config.json", plugins: [{ package: plugin, options }] })
const password = randomBytes(32).toString("base64url")
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "opencode.sqlite"),
  OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "0",
  OPENCODE_SIMULATE: "0", OPENCODE_PASSWORD: password }
delete env.OPENCODE_CONFIG
delete env.OPENCODE_SERVER_PASSWORD
const abort = new AbortController()
let binary = process.env.FULL_CLAUDE_OPENCODE_BINARY ?? "opencode"
let server: ReturnType<typeof spawn> | undefined
let exited: Promise<void> | undefined
let serverExited = false
const kill = (signal: NodeJS.Signals) => {
  if (!server?.pid) return
  try { process.kill(-server.pid, signal) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
}
const interrupt = () => abort.abort(new Error("Model discovery smoke interrupted"))
const killOnAbort = () => kill("SIGKILL")
abort.signal.addEventListener("abort", killOnAbort)
process.once("SIGINT", interrupt)
process.once("SIGTERM", interrupt)
const timer = setTimeout(() => abort.abort(new Error("Model discovery smoke exceeded 150 seconds")), 150_000)
const stopServer = async () => {
  kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  try { await exited } finally { clearTimeout(force); kill("SIGKILL"); server = undefined; exited = undefined }
}
const comparable = (models: readonly CatalogModel[]) => models.map(({ id, name, efforts }) => ({ id, name, efforts: [...efforts].sort() }))
  .sort((a, b) => a.id.localeCompare(b.id))

console.log(`Model discovery artifacts (private): ${root}`)
try {
  const executable = Bun.which(binary)
  assert(executable, `OpenCode executable not found: ${binary}`)
  binary = realpathSync(executable)
  const versionResult = spawnSync(binary, ["--version"], { cwd, env, encoding: "utf8", timeout: 10_000 })
  if (versionResult.error) throw versionResult.error
  assert.equal(versionResult.status, 0, "opencode --version failed")
  const version = versionResult.stdout.trim()
  assert(version.length > 0, "OpenCode returned an empty version")
  save("host-version.json", { binary, version })
  console.log(`Owned host executable: ${binary}; version: ${version}`)
  const direct = await probeClaudeModels(profiles[0]!, cwd, abort.signal)
  const models = normalizeModels(direct.models)
  assert(models.length > 0, "SDK returned no selectable models")
  assert(models.some((model) => /\d/.test(model.name)), "SDK returned no versioned display labels")
  assert(models.some((model) => model.id === "haiku"), "SDK did not offer the pinned Haiku alias")
  const expected = profiles.map((profile) => ({ providerID: profile.id, models: comparable(selectModels(profile, models)) }))
  save("sdk-models.json", comparable(models))
  const phases: string[] = []
  for (const phase of ["cold-start", "same-database-restart"]) {
    abort.signal.throwIfAborted()
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
    const out = openSync(join(root, `${phase}.stdout.log`), "w", 0o600)
    const err = openSync(join(root, `${phase}.stderr.log`), "w", 0o600)
    serverExited = false
    try {
      server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd, env, detached: true, stdio: ["ignore", out, err],
      })
    } finally { closeSync(out); closeSync(err) }
    exited = new Promise<void>((done) => {
      server!.once("error", (error) => { abort.abort(error); done() })
      server!.once("close", () => { serverExited = true; done() })
    })
    const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
    const deadline = Date.now() + 45_000
    while (true) {
      abort.signal.throwIfAborted()
      assert(!serverExited, "Owned server exited before readiness")
      try {
        const response = await fetch(`${url}/api/info`, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1_000)]) })
        assert(response.status !== 401 && response.status !== 403, "Owned server rejected its password")
        if (response.ok) break
      } catch (error) { if (error instanceof assert.AssertionError) throw error }
      assert(Date.now() < deadline, "Owned server did not become ready")
      await Bun.sleep(150)
    }
    const client = OpenCode.make({ baseUrl: url, headers })
    while (true) {
      abort.signal.throwIfAborted()
      assert(!serverExited, "Owned server exited during catalog verification")
      const listed = await client.model.list({ location: { directory: cwd } }, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      })
      const actual = expected.map(({ providerID }) => ({ providerID, models: comparable(listed.data
        .filter((model) => model.providerID === providerID)
        .map((model) => ({ id: model.id, name: model.name, efforts: model.variants.map((variant) => {
          assert.equal(variant.settings?.effort, variant.id, "Host effort settings differ from variant IDs")
          return variant.id
        }) }))) }))
      save(`${phase}-models.json`, actual)
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        assert.deepEqual(actual, expected)
        phases.push(phase)
        break
      }
      assert(Date.now() < deadline, `${phase}: host catalog does not exactly match SDK IDs, names, and efforts`)
      await Bun.sleep(200)
    }
    await stopServer()
  }
  const report = { status: "passed", opencodeVersion: version, claudeVersion: direct.version, modelPrompts: 0,
    phases, fableOffered: models.some((model) => /fable/i.test(`${model.id} ${model.name}`)), models: comparable(models), providers: expected }
  save("compatibility.json", report)
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  save("failure.json", { message: error instanceof Error ? error.message : String(error) })
  console.error(`FAIL: model discovery smoke. See private artifacts: ${root}`)
  process.exitCode = 1
} finally {
  await stopServer()
  abort.abort()
  clearTimeout(timer)
  abort.signal.removeEventListener("abort", killOnAbort)
  process.removeListener("SIGINT", interrupt)
  process.removeListener("SIGTERM", interrupt)
}
