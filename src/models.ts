import { constants } from "node:fs"
import { access, readFile, realpath, stat } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"
import { query, type AccountInfo, type ModelInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { makeEnvironment, type Profile } from "./config.js"
import { digest } from "./prompt.js"
import type { QueryFactory, Storage } from "./runtime.js"

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])
export interface CatalogModel { id: string; name: string; efforts: string[]; resolvedModel?: string }
export interface ProbeResult { models: ModelInfo[]; identity?: string; version?: string }
export type ModelProbe = (profile: Profile, directory: string, signal: AbortSignal) => Promise<ProbeResult>

export function normalizeModels(models: readonly ModelInfo[]): CatalogModel[] {
  const result = new Map<string, CatalogModel>()
  for (const model of models) {
    if (!model || typeof model.value !== "string" || !model.value.trim() || /[\0\r\n]/.test(model.value) || model.value === "default" || result.has(model.value)) continue
    result.set(model.value, {
      id: model.value,
      name: typeof model.displayName === "string" && model.displayName.trim() ? model.displayName : model.value,
      efforts: model.supportsEffort === false ? [] : [...new Set((Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : []).filter((effort) => EFFORTS.has(effort)))],
      ...(typeof model.resolvedModel === "string" && model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    })
  }
  return [...result.values()]
}

export function selectModels(profile: Profile, catalog: readonly CatalogModel[]): CatalogModel[] {
  if (!profile.models) return catalog.length ? structuredClone([...catalog]) : ["sonnet", "opus", "haiku"].map((id) => ({ id, name: id, efforts: [] }))
  return profile.models.map((id) => {
    const exact = catalog.find((model) => model.id === id)
    const resolved = catalog.filter((model) => model.resolvedModel === id)
    const model = exact ?? (resolved.length === 1 ? resolved[0] : undefined)
    return model ? { ...structuredClone(model), id } : { id, name: id, efforts: [] }
  })
}

export async function probeClaudeModels(profile: Profile, directory: string, signal: AbortSignal,
  factory: QueryFactory = query, timeoutMs = 30_000): Promise<ProbeResult> {
  signal.throwIfAborted()
  const stop = Promise.withResolvers<void>()
  const interrupted = Promise.withResolvers<never>()
  const controller = new AbortController()
  const abort = () => { controller.abort(signal.reason); interrupted.reject(signal.reason) }
  signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    const error = new Error("Claude model discovery timed out")
    controller.abort(error)
    interrupted.reject(error)
  }, timeoutMs)
  void interrupted.promise.catch(() => {})
  let native: ReturnType<QueryFactory> | undefined
  let pump: Promise<void> | undefined
  try {
    async function* prompt(): AsyncGenerator<SDKUserMessage> { await stop.promise }
    native = factory({ prompt: prompt(), options: {
      cwd: directory, env: makeEnvironment(profile), pathToClaudeCodeExecutable: profile.binaryPath ?? "claude",
      settingSources: [], settings: { disableAllHooks: true }, plugins: [], skills: [], tools: [],
      strictMcpConfig: true, mcpServers: {}, permissionMode: "dontAsk", persistSession: false, abortController: controller,
    } })
    const current = native
    pump = (async () => { for await (const _message of current) { /* Initialization is read through the SDK control response. */ } })()
    void pump.catch(() => {})
    const init = await Promise.race([native.initializationResult(), interrupted.promise,
      pump.then(() => { throw new Error("Claude exited before model discovery completed") })])
    if (!Array.isArray(init.models)) throw new Error("Claude did not return a model catalog")
    return { models: init.models, identity: init.account ? digest(init.account) : undefined, version: init.claude_code_version }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    stop.resolve()
    native?.close()
    controller.abort()
    await pump?.catch(() => {})
  }
}

async function binding(profile: Profile, directory: string) {
  const configDir = await realpath(profile.configDir).catch(() => resolve(profile.configDir))
  const cwd = await realpath(directory).catch(() => resolve(directory))
  const environment = makeEnvironment(profile)
  environment.CLAUDE_CONFIG_DIR = configDir
  const fingerprint = async (path: string, identityOnly = false) => {
    try {
      const text = await readFile(path, "utf8")
      if (!identityOnly) return digest(text)
      const data = JSON.parse(text)
      return digest([data.oauthAccount, data.primaryApiKey, data.apiKeyHelper, data.apiProvider, data.customApiKeyResponses])
    } catch (error) { return (error as NodeJS.ErrnoException).code ?? "unreadable" }
  }
  const files = await Promise.all([
    fingerprint(join(configDir, ".credentials.json")), fingerprint(join(configDir, "settings.json")),
    fingerprint(join(configDir, ".claude.json"), true), fingerprint(`${configDir}.json`, true),
    fingerprint(join(cwd, ".claude", "settings.json")), fingerprint(join(cwd, ".claude", "settings.local.json")),
    ...["GOOGLE_APPLICATION_CREDENTIALS", "AWS_SHARED_CREDENTIALS_FILE"].flatMap((key) => environment[key] ? [fingerprint(environment[key]!)] : []),
  ])
  const binary = profile.binaryPath ?? "claude"
  let executable = binary
  if (!binary.includes("/")) {
    for (const path of (environment.PATH ?? "").split(delimiter)) {
      const candidate = join(path, binary)
      if (await access(candidate, constants.X_OK).then(() => true).catch(() => false)) { executable = candidate; break }
    }
  }
  const executableState = await stat(executable).then((value) => [value.size, value.mtimeMs]).catch(() => null)
  return digest([profile.id, configDir, cwd, executable, executableState, Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)), files])
}

interface Entry {
  profile: Profile
  key?: string
  binding?: string
  models: CatalogModel[]
  identity?: string
  revision: number
  updates?: number
  refreshing?: Promise<void>
  writing?: Promise<void>
}

export class ModelCatalog {
  private entries: Map<string, Entry>
  private controller = new AbortController()
  private disposed = false
  private loading?: Promise<void>

  constructor(private storage: Storage, profiles: Profile[], private directory: string,
    private reload: () => Promise<void>, private probe: ModelProbe = probeClaudeModels) {
    this.entries = new Map(profiles.map((profile) => [profile.id, { profile, models: [], revision: 0 }]))
  }

  load(): Promise<void> {
    return this.loading ??= Promise.all([...this.entries.values()].map(async (entry) => {
      const key = await binding(entry.profile, this.directory)
      if (this.disposed) return
      entry.binding = key
      entry.key = `model-catalog/${entry.profile.id}/${key}`
      const saved = await this.storage.get(entry.key) as { version?: number; binding?: string; models?: CatalogModel[]; identity?: string } | undefined
      if (this.disposed || saved?.version !== 1 || saved.binding !== key || !Array.isArray(saved.models)) return
      entry.models = normalizeModels(saved.models.filter((model) => model && typeof model.id === "string" && Array.isArray(model.efforts))
        .map((model) => ({ value: model.id, displayName: model.name, description: "", resolvedModel: model.resolvedModel,
          supportedEffortLevels: model.efforts.filter((effort) => EFFORTS.has(effort)) as ModelInfo["supportedEffortLevels"] })))
      entry.identity = saved.identity
    })).then(() => {})
  }

  get(profileID: string): CatalogModel[] {
    const entry = this.entries.get(profileID)
    return entry ? selectModels(entry.profile, entry.models) : []
  }

  capture(profile: Profile) { return binding(profile, this.directory) }

  async refresh() {
    await this.load()
    await Promise.all([...this.entries.values()].map((entry) => {
      if (this.disposed) return
      if (entry.refreshing) return entry.refreshing
      const revision = entry.revision
      entry.refreshing = (async () => {
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = await this.capture(entry.profile)
            if (this.disposed || entry.revision !== revision) return
            if (entry.binding !== before) {
              entry.binding = before
              entry.key = `model-catalog/${entry.profile.id}/${before}`
              entry.models = []
              await this.reload()
            }
            const discovered = await this.probe(entry.profile, this.directory, this.controller.signal)
            const after = await this.capture(entry.profile)
            if (this.disposed || entry.revision !== revision) return
            if (before !== after) continue
            await this.store(entry, discovered.models, discovered.identity, revision)
            return
          }
          throw new Error("Claude account or configuration changed during model discovery")
        } catch (error) {
          if (!this.disposed) console.error(`Full Claude Agent model discovery failed for ${entry.profile.id}`, error)
        }
      })().finally(() => { entry.refreshing = undefined })
      return entry.refreshing
    }))
  }

  async update(profile: Profile, models: readonly ModelInfo[], account?: AccountInfo, expectedBinding?: string) {
    await this.load()
    const entry = this.entries.get(profile.id)
    if (!entry || this.disposed || entry.profile.configDir !== profile.configDir || entry.profile.binaryPath !== profile.binaryPath ||
      digest(entry.profile.env ?? {}) !== digest(profile.env ?? {})) return
    const update = entry.updates = (entry.updates ?? 0) + 1
    const current = await this.capture(profile)
    if (this.disposed || entry.updates !== update || (expectedBinding !== undefined && current !== expectedBinding)) return
    const revision = ++entry.revision
    entry.binding = current
    entry.key = `model-catalog/${entry.profile.id}/${current}`
    await this.store(entry, models, account ? digest(account) : undefined, revision)
  }

  private async store(entry: Entry, models: readonly ModelInfo[], identity: string | undefined, revision: number) {
    const next = normalizeModels(models)
    if (this.disposed || !entry.key || !next.length) return
    const key = entry.key
    const binding = entry.binding
    const writing = (entry.writing ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.disposed || entry.revision !== revision || entry.binding !== binding) return
      const changed = JSON.stringify(entry.models) !== JSON.stringify(next)
      await this.storage.set(key, JSON.parse(JSON.stringify({ version: 1, binding, models: next, identity })))
      if (this.disposed || entry.revision !== revision || entry.binding !== binding) return
      entry.models = next
      entry.identity = identity
      if (changed) await this.reload()
    })
    entry.writing = writing
    try { await writing } finally { if (entry.writing === writing) entry.writing = undefined }
  }

  async dispose() {
    this.disposed = true
    this.controller.abort(new Error("Full Claude Agent model discovery was unloaded"))
    await Promise.allSettled([...(this.loading ? [this.loading] : []), ...[...this.entries.values()].flatMap((entry) =>
      [...(entry.refreshing ? [entry.refreshing] : []), ...(entry.writing ? [entry.writing] : [])])])
  }
}
