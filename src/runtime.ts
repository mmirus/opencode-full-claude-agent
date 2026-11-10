import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { query, type AccountInfo, type ModelInfo, type Options, type Query, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { makeEnvironment, type Profile } from "./config.js"
import { assertHistory, digest, historyBoundary, newContent, userFingerprints, type HistoryEntry } from "./prompt.js"
import { createStreamConverter } from "./stream.js"
import { createDelegationMcp, DELEGATION_INSTRUCTIONS, DELEGATION_SERVER, type ActiveDelegation } from "./delegation-mcp.js"
import { addUsage, backgroundError, backgroundParts, backgroundResponse, emptyUsage, type BackgroundOwner, type BackgroundResponse, type BackgroundResult } from "./background.js"
import { classifyNativeResult, createNativeStatus } from "./native-status.js"
import { createBashProvenance } from "./bash-provenance.js"
import type { NativeTaskStore } from "./tasks.js"

export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: any): Promise<void>
}
export interface NativeQuery extends AsyncIterable<SDKMessage> {
  initializationResult(): ReturnType<Query["initializationResult"]>
  interrupt(): Promise<unknown>
  close(): void
  stopTask?(taskID: string): Promise<void>
}
export type QueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => NativeQuery
export interface RunRequest {
  sessionID: string
  directory: string
  profile: Profile
  model: string
  effort?: Options["effort"]
  prompt: LanguageModelV3Prompt
  history: readonly HistoryEntry[]
  signal: AbortSignal
  emit(part: LanguageModelV3StreamPart): void
  interactions(signal: AbortSignal): { canUseTool: NonNullable<Options["canUseTool"]>; dispose?(): void }
  delegation?: ActiveDelegation["createHost"]
}
interface RecordState {
  version: 2
  binding: string
  nativeID: string
  users: string[]
  boundary: string[]
  outcome: "ready" | "pending" | "settled" | "uncertain"
  pendingUUID?: string
  delivery?: BackgroundResponse[]
  checkpoint?: {
    uuid: string
    providerID: string
    preparedHostPrefix: string[]
    assistantID?: string
  }
}
type StoredRecord = Omit<RecordState, "version"> & { version: number }
interface Turn {
  uuid: string
  request: RunRequest
  converter: ReturnType<typeof createStreamConverter>
  done: ReturnType<typeof Promise.withResolvers<void>>
  aborted: boolean
  unloaded?: Error
  submitted: boolean
  previous: RecordState
  interrupting?: Promise<void>
  operations: AbortController
}
interface Entry {
  providerID: string
  record: RecordState
  native?: NativeQuery
  input?: ReadableStreamDefaultController<SDKUserMessage>
  turn?: Turn
  failure?: unknown
  pump?: Promise<void>
  launch?: string
  stopping?: Promise<void>
  permissions?: AbortController
  notices: SDKMessage[]
  notifying?: Promise<void>
  noticeRetry?: ReturnType<typeof setTimeout>
  noticeFailures?: number
  autonomousReady?: boolean
  rateLimit?: SDKRateLimitInfo
  cycle?: { autonomous: boolean; uuids?: string[]; status: ReturnType<typeof createNativeStatus>; frames: Array<{ message: SDKMessage; beforeAbort: boolean }> }
}

const timeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally { clearTimeout(timer) }
}

export class Runtime {
  private entries = new Map<string, Entry>()
  private locks = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    private storage: Storage,
    private factory: QueryFactory = query,
    private backgroundNotice: (sessionID: string, messages: SDKMessage[], owner: BackgroundOwner) => Promise<void> = async () => {},
    private tasks?: NativeTaskStore,
    private models?: (profile: Profile, models: readonly ModelInfo[], account?: AccountInfo, binding?: string) => Promise<void>,
    private modelBinding?: (profile: Profile) => Promise<string>,
  ) {}

  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve()
    const done = Promise.withResolvers<void>()
    this.locks.set(id, done.promise)
    await prior
    try { return await action() } finally {
      done.resolve()
      if (this.locks.get(id) === done.promise) this.locks.delete(id)
    }
  }

  private key(id: string) { return `session/${id}` }
  private save(id: string, entry: Entry) { return this.storage.set(this.key(id), entry.record) }

  async run(request: RunRequest): Promise<void> {
    return this.locked(request.sessionID, async () => {
      if (this.disposed) throw new Error("Full Claude Agent was unloaded")
      request.signal.throwIfAborted()
      const configDir = await realpath(request.profile.configDir).catch(() => request.profile.configDir)
      const directory = await realpath(request.directory)
      request.signal.throwIfAborted()
      const binding = digest([request.profile.id, configDir, directory, request.profile.binaryPath, request.profile.plugins, request.profile.env])
      let entry = this.entries.get(request.sessionID)
      if (!entry) {
        const saved = await this.storage.get(this.key(request.sessionID)) as StoredRecord | undefined
        request.signal.throwIfAborted()
        if (saved && saved.version !== 1 && saved.version !== 2) throw new Error("Unsupported Full Claude Agent session record")
        if (saved?.outcome === "pending" || saved?.outcome === "uncertain") {
          throw new Error("The previous Claude turn did not settle. Automatic replay could repeat tool side effects. Start a new session and inspect the native transcript.")
        }
        if (saved?.version === 1 && saved.outcome === "settled") {
          throw new Error("This legacy Claude session has no recorded host checkpoint boundary. Start a new session; its completed actions will not be replayed.")
        }
        entry = { providerID: request.profile.id, record: saved ? { ...saved, version: 2 } : { version: 2, binding, nativeID: randomUUID(), users: [], boundary: [], outcome: "ready" }, notices: [] }
        this.entries.set(request.sessionID, entry)
      }
      if (entry.record.binding !== binding) {
        throw new Error("This session belongs to another Claude configuration or working directory. Start a new session for the selected configuration.")
      }
      if (entry.record.outcome === "uncertain") throw new Error("The previous Claude turn has an uncertain outcome. Start a new session.")
      if (entry.record.outcome === "settled") await this.reconcile(request.sessionID, entry, request.history)
      assertHistory(request.history, entry.record.boundary)
      const users = userFingerprints(request.prompt)
      if (entry.record.users.some((hash, index) => users[index] !== hash)) throw new Error("Full Claude Agent cannot resume edited or compacted history. Start a new session.")
      const boundary = new Set(entry.record.boundary)
      const delivery = new Map((entry.record.delivery ?? []).map((response) => [response.id, response]))
      for (const message of request.history) {
        const response = backgroundResponse(message)
        if (!response || boundary.has(digest(message))) continue
        if (response.binding !== binding || response.nativeID !== entry.record.nativeID || response.providerID !== request.profile.id) {
          throw new Error("Native background response belongs to another Claude session or configuration.")
        }
        delivery.set(response.id, response)
      }
      const responses = [...delivery.values()]
      const usage = responses.reduce((total, response) => addUsage(total, response.usage), emptyUsage())
      if (this.disposed) throw new Error("Full Claude Agent was unloaded")
      if (responses.length) {
        const settled: RecordState = { ...entry.record, delivery: responses, outcome: "settled", checkpoint: this.prepared(request) }
        await this.storage.set(this.key(request.sessionID), settled)
        entry.record = settled
        if (this.disposed) throw new Error("Full Claude Agent was unloaded")
        request.signal.throwIfAborted()
        for (const response of responses) for (const part of backgroundParts(response)) {
          request.signal.throwIfAborted()
          if (this.disposed) throw new Error("Full Claude Agent was unloaded")
          request.emit(part)
        }
      }
      if (users.length === entry.record.users.length && (responses.length || request.history.some((message) => backgroundResponse(message)))) {
        request.signal.throwIfAborted()
        if (this.disposed) throw new Error("Full Claude Agent was unloaded")
        const error = responses.map(backgroundError).find((error) => error !== undefined)
        if (error) request.emit({ type: "error", error })
        const rateLimit = responses.findLast((response) => response.rateLimit)?.rateLimit
        request.emit({ type: "finish", usage, finishReason: { unified: error ? "error" : "stop", raw: "background_delivery" },
          ...(rateLimit ? { providerMetadata: { [request.profile.id]: { rateLimit: JSON.parse(JSON.stringify(rateLimit)) } } } : {}) })
        return
      }
      const content = newContent(request.prompt, entry.record.users)
      if (responses.length) {
        const emit = request.emit
        request = { ...request, emit: (part) => emit(part.type === "finish" ? { ...part, usage: addUsage(usage, part.usage) } : part) }
      }
      const launch = digest([request.model, request.effort])
      if (entry.native && entry.launch !== launch) throw new Error("Changing model or effort on a live Full Claude Agent session requires a new session.")
      if (this.disposed) throw new Error("Full Claude Agent was unloaded")
      const turn: Turn = { uuid: randomUUID(), request, converter: createStreamConverter({ providerID: request.profile.id, directory }), done: Promise.withResolvers<void>(), aborted: false,
        submitted: false, previous: structuredClone(entry.record), operations: new AbortController() }
      // The iterator may fail while initialization is still pending.
      void turn.done.promise.catch(() => {})
      entry.turn = turn
      const abort = () => { void this.interrupt(request.sessionID, entry!, turn) }
      request.signal.addEventListener("abort", abort, { once: true })
      try {
        if (!entry.native) await this.open(request, entry, directory, launch)
        if (turn.unloaded) throw turn.unloaded
        request.signal.throwIfAborted()
        if (entry.failure || !entry.native) throw entry.failure ?? new Error("Claude stopped during initialization")
        entry.record = { ...entry.record, users: userFingerprints(request.prompt), pendingUUID: turn.uuid, outcome: "pending",
          checkpoint: { ...this.prepared(request), uuid: turn.uuid } }
        await this.save(request.sessionID, entry)
        if (turn.unloaded) throw turn.unloaded
        request.signal.throwIfAborted()
        try {
          entry.input!.enqueue({ type: "user", uuid: turn.uuid as `${string}-${string}-${string}-${string}-${string}`,
            message: { role: "user", content }, parent_tool_use_id: null })
          turn.submitted = true
        } catch (error) {
          entry.record = turn.previous
          await this.save(request.sessionID, entry)
          throw error
        }
        await turn.done.promise
        request.signal.throwIfAborted()
      } catch (error) {
        if (!turn.submitted) {
          entry.record = turn.previous
          await this.save(request.sessionID, entry)
        } else if (entry.record.outcome === "pending") {
          entry.record.outcome = "uncertain"
          await this.save(request.sessionID, entry)
        }
        throw turn.unloaded ?? error
      } finally {
        turn.operations.abort()
        request.signal.removeEventListener("abort", abort)
        await turn.interrupting
        if (entry.turn === turn) entry.turn = undefined
      }
    })
  }

  private async open(request: RunRequest, entry: Entry, directory: string, launch: string) {
    request.signal.throwIfAborted()
    const modelBinding = await this.modelBinding?.(request.profile)
    request.signal.throwIfAborted()
    if (this.disposed) throw new Error("Full Claude Agent was unloaded")
    const input = new ReadableStream<SDKUserMessage>({ start(controller) { entry.input = controller } })
    const env = makeEnvironment(request.profile)
    const delegation = request.delegation ? createDelegationMcp(() => {
      const turn = entry.turn
      if (!turn?.submitted || turn.aborted || !turn.request.delegation) return undefined
      return { createHost: turn.request.delegation, signal: AbortSignal.any([turn.request.signal, turn.operations.signal]) }
    }) : undefined
    // Native reviewers can request permissions after the foreground result; the native process owns this scope.
    const permissions = new AbortController()
    const interactions = request.interactions(permissions.signal)
    entry.permissions = permissions
    const provenance = createBashProvenance(entry.record.nativeID)
    let taskConnection: ReturnType<NativeTaskStore["connect"]> | undefined
    const cleanup = () => { provenance.close(); taskConnection?.close(); permissions.abort(); interactions.dispose?.() }
    const options: Options = {
      cwd: directory,
      env,
      ...(request.profile.binaryPath ? { pathToClaudeCodeExecutable: request.profile.binaryPath } : {}),
      ...(entry.record.users.length ? { resume: entry.record.nativeID } : { sessionId: entry.record.nativeID }),
      persistSession: true,
      model: request.model,
      effort: request.effort,
      // The SDK's typed thinking option also selects the native thinking mode.
      extraArgs: { "thinking-display": "summarized" },
      tools: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      settings: { attribution: { pr: "*Posted via OpenCode*" } },
      hooks: provenance.hooks,
      plugins: request.profile.plugins.map((path) => ({ type: "local", path })),
      ...(delegation ? { mcpServers: { [DELEGATION_SERVER]: delegation } } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: [
        "You are running inside OpenCode through Full Claude Agent. Use native Claude tools, skills, project instructions, and hooks. OpenCode displays your native tool activity. Use synchronous Agent calls when a workflow depends on SubagentStop. Await background work before reporting its outcome.",
        ...(delegation ? [DELEGATION_INSTRUCTIONS] : []),
      ].join("\n\n") },
      includePartialMessages: true,
      permissionMode: "default",
      canUseTool: (name, value, options) => {
        if (permissions.signal.aborted || this.disposed) return Promise.resolve({ behavior: "deny", message: "Claude permission owner is closed." })
        const turn = options.agentID ? undefined : entry.turn
        const signal = AbortSignal.any([permissions.signal, options.signal, ...(turn ? [turn.request.signal, turn.operations.signal] : [])])
        return interactions.canUseTool(name, value, { ...options, signal })
      },
    }
    let native: NativeQuery
    try { native = this.factory({ prompt: input, options }) }
    catch (error) { cleanup(); throw error }
    entry.native = native
    entry.rateLimit = undefined
    taskConnection = this.tasks?.connect({ sessionID: request.sessionID, providerID: request.profile.id, nativeID: entry.record.nativeID },
      native.stopTask ? (taskID) => native.stopTask!(taskID) : undefined)
    entry.launch = launch
    entry.failure = undefined
    entry.pump = this.read(request.sessionID, entry, native, cleanup, (message) => {
      taskConnection?.observe(message)
      return provenance.observe(message)
    })
    const cancelled = Promise.withResolvers<never>()
    const signal = AbortSignal.any([request.signal, entry.turn!.operations.signal])
    const onAbort = () => cancelled.reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      signal.throwIfAborted()
      const init = await timeout(Promise.race([native.initializationResult(), cancelled.promise]), 30_000, "Claude did not initialize within 30 seconds")
      if (Array.isArray(init.models)) void this.models?.(request.profile, init.models, init.account, modelBinding)
        .catch((error) => console.error("Full Claude Agent model catalog update failed", error))
    } catch (error) {
      native.close()
      await entry.pump
      entry.native = undefined
      throw error
    } finally { signal.removeEventListener("abort", onAbort) }
  }

  private async read(sessionID: string, entry: Entry, native: NativeQuery, cleanup: () => void, observe: (message: SDKMessage) => SDKMessage) {
    const emit = (turn: Turn, message: SDKMessage, beforeAbort = false) => {
      if (!turn.aborted || (turn.unloaded && beforeAbort)) for (const part of turn.converter.push(message, entry.rateLimit)) turn.request.emit(part)
      else if (turn.unloaded && message.type === "user") {
        for (const part of turn.converter.push(message)) if (part.type === "tool-result") turn.request.emit(part)
      }
    }
    const flush = (turn: Turn) => {
      for (const frame of entry.cycle?.frames.splice(0) ?? []) emit(turn, frame.message, frame.beforeAbort)
    }
    try {
      for await (const frame of native) {
        const message = observe(frame)
        if (message.type === "rate_limit_event") {
          entry.rateLimit = structuredClone(message.rate_limit_info)
          continue
        }
        if (message.type === "system" && message.subtype === "init" && message.plugin_errors?.length) {
          throw new Error(`Claude plugin loading failed: ${message.plugin_errors.map((error) => `${error.plugin}: ${error.message}`).join("; ")}`)
        }
        const turn = entry.turn
        if (message.type === "system" && message.subtype === "task_notification" && !entry.cycle) entry.autonomousReady = true
        if (message.type !== "result") {
          if (message.type === "assistant" || message.type === "stream_event" || message.type === "user") {
            const root = message.parent_tool_use_id === null
            if (root && message.type !== "user") {
              if (!entry.cycle) {
                entry.cycle = { frames: [], status: createNativeStatus(), autonomous: entry.autonomousReady === true || !turn?.submitted }
                entry.autonomousReady = false
              }
              const uuids = message.user_message_uuids?.length ? message.user_message_uuids : message.user_message_uuid ? [message.user_message_uuid] : undefined
              if (uuids) entry.cycle.uuids = uuids
              entry.cycle.status.observe(message)
            }
            if (turn?.submitted && entry.record.outcome === "pending" && entry.cycle?.uuids?.includes(turn.uuid)) {
              flush(turn)
              emit(turn, message)
            } else if (entry.cycle) entry.cycle.frames.push({ message, beforeAbort: !turn?.aborted })
          }
          continue
        }
        const attributed = turn && (message.user_message_uuid === turn.uuid || message.user_message_uuids?.includes(turn.uuid))
        if (turn?.submitted && !message.user_message_uuid && !message.user_message_uuids?.length &&
          (!(entry.cycle?.autonomous ?? entry.autonomousReady) || entry.cycle?.uuids?.includes(turn.uuid))) {
          throw new Error("Claude returned a result without a prompt UUID; this CLI cannot safely correlate concurrent native activity.")
        }
        if (!turn?.submitted || entry.record.outcome !== "pending" || !attributed) {
          const diagnostics = entry.cycle?.status.snapshot() ?? {}
          const outcome = classifyNativeResult(message, diagnostics, entry.rateLimit)
          if (outcome.error && turn && !turn.submitted) {
            throw new Error(`Claude startup failed: ${outcome.error.message}`, { cause: outcome.error })
          }
          entry.cycle = undefined
          entry.autonomousReady = false
          if (entry.record.users.length) {
            const notice: BackgroundResult = { ...message, fullClaudeStatus: { diagnostics, rateLimit: entry.rateLimit } }
            entry.notices.push(notice)
            this.notify(sessionID, entry)
          }
          continue
        }
        flush(turn)
        entry.cycle = undefined
        entry.autonomousReady = false
        emit(turn, message)
        if (message.type === "result") {
          entry.record.outcome = "settled"
          delete entry.record.pendingUUID
          await this.save(sessionID, entry)
          entry.turn = undefined
          if (turn.unloaded) {
            for (const part of turn.converter.interrupt(turn.unloaded.message)) turn.request.emit(part)
            turn.done.reject(turn.unloaded)
          } else turn.done.resolve()
        }
      }
      if (entry.turn) throw new Error("Claude process ended before completing the active turn")
    } catch (error) {
      native.close()
      entry.failure = error
      const turn = entry.turn
      entry.turn = undefined
      if (turn) {
        entry.record.outcome = turn.submitted ? "uncertain" : turn.previous.outcome
        await this.save(sessionID, entry).catch(() => {})
        if (turn.unloaded) for (const part of turn.converter.interrupt(turn.unloaded.message)) turn.request.emit(part)
        turn.done.reject(turn.unloaded ?? error)
      }
    } finally {
      cleanup()
      if (entry.native === native) entry.native = undefined
    }
  }

  private async interrupt(sessionID: string, entry: Entry, turn: Turn) {
    if (entry.turn !== turn) return
    turn.aborted = true
    turn.operations.abort()
    if (turn.interrupting) return turn.interrupting
    const native = entry.native
    turn.interrupting = (async () => {
        if (!turn.submitted) {
        turn.done.reject(turn.unloaded ?? turn.request.signal.reason ?? new Error("Cancelled before submission"))
        return
      }
      try {
        if (!native) throw new Error("Claude process unavailable during cancellation")
        await timeout(native.interrupt().then(() => turn.done.promise), 10_000, "Claude did not finish cancellation within 10 seconds")
      } catch (error) {
        if (entry.turn !== turn || entry.native !== native) return
        entry.record.outcome = "uncertain"
        entry.turn = undefined
        native?.close()
        await this.save(sessionID, entry).catch(() => {})
        if (turn.unloaded) for (const part of turn.converter.interrupt(turn.unloaded.message)) turn.request.emit(part)
        turn.done.reject(turn.unloaded ?? error)
      }
    })()
    return turn.interrupting
  }

  private notify(sessionID: string, entry: Entry) {
    if (entry.notifying) return
    if (entry.noticeRetry) clearTimeout(entry.noticeRetry)
    entry.noticeRetry = undefined
    entry.notifying = (async () => {
      while (entry.notices.length) {
        const messages = entry.notices.slice()
        try {
          await this.backgroundNotice(sessionID, messages, { providerID: entry.providerID, nativeID: entry.record.nativeID, binding: entry.record.binding })
          entry.notices.splice(0, messages.length)
          entry.noticeFailures = 0
        } catch (error) {
          console.error("Full Claude Agent background notice failed", error)
          entry.noticeFailures = (entry.noticeFailures ?? 0) + 1
          if (!this.disposed) entry.noticeRetry = setTimeout(() => {
            entry.noticeRetry = undefined
            this.notify(sessionID, entry)
          }, Math.min(1000 * 2 ** Math.min(entry.noticeFailures - 1, 5), 30_000))
          break
        }
      }
    })().finally(() => { entry.notifying = undefined })
  }

  async checkpoint(sessionID: string, getHistory: () => Promise<readonly HistoryEntry[]>) {
    const expected = this.entries.get(sessionID)?.record
    if (expected?.outcome !== "settled") return
    const uuid = expected.checkpoint?.uuid
    return this.locked(sessionID, async () => {
      const entry = this.entries.get(sessionID)
      if (!entry || entry.record.outcome !== "settled" || entry.record.checkpoint?.uuid !== uuid) return
      const history = await getHistory()
      await this.reconcile(sessionID, entry, history)
    })
  }

  private async reconcile(sessionID: string, entry: Entry, history: readonly HistoryEntry[]) {
    const checkpoint = entry.record.checkpoint
    if (!checkpoint) throw new Error("Claude's settled submission has no host checkpoint boundary. Start a new session; completed actions will not be replayed.")
    assertHistory(history, entry.record.boundary)
    const prefix = checkpoint.preparedHostPrefix
    if (history.length < prefix.length || prefix.some((hash, index) => digest(history[index]) !== hash)) {
      throw new Error("OpenCode history changed before Claude's submitted prompt boundary. Start a new session.")
    }
    // Only the immediate successor can belong to this submission; skipping incomplete replies could checkpoint a later step.
    const reply = history[prefix.length]
    const model = reply?.model
    if (!reply || reply.type !== "assistant" || !model || typeof model !== "object" || !("providerID" in model) ||
      model.providerID !== checkpoint.providerID || (checkpoint.assistantID !== undefined && reply.id !== checkpoint.assistantID) ||
      historyBoundary([reply]).length !== 1) {
      throw new Error("Claude's native response settled, but its matching OpenCode reply is missing or incomplete. No prompt was replayed.")
    }
    const ready: RecordState = { ...entry.record, boundary: historyBoundary(history.slice(0, prefix.length + 1)), outcome: "ready" }
    if (ready.delivery) {
      const parts = Array.isArray(reply.content) ? reply.content : []
      ready.delivery = ready.delivery.filter((response) => !parts.some((part) =>
        part.type === "text" && part.native?.backgroundResponseID === response.id && part.text === response.text))
      if (!ready.delivery.length) delete ready.delivery
    }
    delete ready.checkpoint
    await this.storage.set(this.key(sessionID), ready)
    entry.record = ready
  }

  private prepared(request: RunRequest): NonNullable<RecordState["checkpoint"]> {
    const last = request.history.at(-1)
    const model = last?.model as { providerID?: string } | undefined
    const placeholder = last?.type === "assistant" && model?.providerID === request.profile.id &&
      historyBoundary([last]).length === 0 && Array.isArray(last.content) && last.content.length === 0 ? last : undefined
    return { uuid: randomUUID(), providerID: request.profile.id,
      preparedHostPrefix: (placeholder ? request.history.slice(0, -1) : request.history).map(digest), assistantID: placeholder?.id }
  }

  private async stopEntry(entry: Entry) {
    if (entry.stopping) return entry.stopping
    entry.stopping = (async () => {
      if (!entry.native) return
      const native = entry.native
      try {
        entry.input?.close()
        await timeout(entry.pump ?? Promise.resolve(), 10_000, "Claude did not stop within 10 seconds")
      } finally { native.close(); entry.native = undefined }
    })()
    try { await entry.stopping } finally { entry.stopping = undefined }
  }

  async dispose() {
    this.disposed = true
    await Promise.allSettled([...this.entries.values()].map(async (entry) => {
      if (entry.noticeRetry) clearTimeout(entry.noticeRetry)
      entry.permissions?.abort()
      if (entry.turn) {
        entry.turn.unloaded = new Error("Full Claude Agent was unloaded during this turn. Native work was interrupted; check tool outcomes before retrying.")
        await this.interrupt(entry.turn.request.sessionID, entry, entry.turn)
      }
      await this.stopEntry(entry)
      await entry.notifying
    }))
    this.entries.clear()
  }
}
