import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime, type NativeQuery, type QueryFactory, type RunRequest, type Storage } from "../src/runtime"
import type { Profile } from "../src/config"
import { historyBoundary, type HistoryEntry } from "../src/prompt"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { DELEGATION_SERVER } from "../src/delegation-mcp"
import { createInteractions } from "../src/interactions"
import type { Plugin } from "@opencode/plugin"

class Queue<T> {
  private values: T[] = []
  private readers: Array<(value: IteratorResult<T>) => void> = []
  private ended = false
  push(value: T) {
    if (this.ended) throw new Error("Queue is closed")
    const reader = this.readers.shift()
    if (reader) reader({ done: false, value })
    else this.values.push(value)
  }
  end() {
    this.ended = true
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined })
  }
  next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! })
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.readers.push(resolve))
  }
  async take() {
    const item = await this.next()
    if (item.done) throw new Error("Queue ended before expected item")
    return item.value
  }
}

class MemoryStorage implements Storage {
  values = new Map<string, unknown>()
  writes: Array<{ key: string; value: any }> = []
  async get(key: string) { return structuredClone(this.values.get(key)) }
  async set(key: string, value: any) {
    this.values.set(key, structuredClone(value))
    this.writes.push({ key, value: structuredClone(value) })
  }
  record(id = "session"): any { return this.values.get(`session/${id}`) }
}

class FakeQuery implements NativeQuery {
  input = new Queue<SDKUserMessage>()
  output = new Queue<{ message: SDKMessage; read: ReturnType<typeof Promise.withResolvers<void>> }>()
  initialized = Promise.withResolvers<Awaited<ReturnType<NativeQuery["initializationResult"]>>>()
  interrupted = Promise.withResolvers<void>()
  interruptGate = Promise.withResolvers<void>()
  didClose = Promise.withResolvers<void>()
  closed = 0
  interruptCount = 0
  inputs: SDKUserMessage[] = []
  constructor(readonly args: Parameters<QueryFactory>[0], initialize: boolean) {
    if (initialize) this.initialized.resolve({} as Awaited<ReturnType<NativeQuery["initializationResult"]>>)
    void this.consumeInput()
  }
  private async consumeInput() {
    for await (const item of this.args.prompt) {
      this.inputs.push(item)
      this.input.push(item)
    }
    this.output.end()
  }
  initializationResult() { return this.initialized.promise }
  async interrupt() {
    this.interruptCount++
    this.interrupted.resolve()
    await this.interruptGate.promise
  }
  close() { this.closed++; this.output.end(); this.didClose.resolve() }
  send(message: unknown) {
    const read = Promise.withResolvers<void>()
    this.output.push({ message: message as SDKMessage, read })
    return read.promise
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = await this.output.next()
      if (item.done) return
      yield item.value.message
      item.value.read.resolve()
    }
  }
}

const profile = (id = "one"): Profile => ({ id, name: id, configDir: join(tmpdir(), `claude-${id}`), plugins: [], models: ["sonnet"] })
const user = (text: string): LanguageModelV3Prompt[number] => ({ role: "user", content: [{ type: "text", text }] })
const history: HistoryEntry[] = [
  { id: "u", type: "user", content: "first" },
  { id: "a", type: "assistant", model: { providerID: "one" }, finish: "stop",
    content: [{ type: "text", text: "answer" }, { type: "tool", result: "original" }] },
]
const result = (uuid: string) => ({ type: "result", subtype: "success", user_message_uuid: uuid,
  is_error: false, result: "done", stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
const assistant = (id: string, text: string) => ({ type: "assistant", parent_tool_use_id: null,
  message: { id, content: [{ type: "text", text }] } })

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function harness(storage = new MemoryStorage(), initialize = true, onNotice?: (messages: SDKMessage[]) => Promise<void>) {
  const queries: FakeQuery[] = []
  const opened = new Queue<FakeQuery>()
  const notices: SDKMessage[][] = []
  const runtime = new Runtime(storage, (args) => {
    const query = new FakeQuery(args, initialize)
    queries.push(query)
    opened.push(query)
    return query
  }, async (_id, messages) => { notices.push(messages); await onNotice?.(messages) })
  cleanups.push(async () => {
    for (const query of queries) { query.interruptGate.resolve(); query.close() }
    await runtime.dispose()
  })
  function request(overrides: Partial<RunRequest> = {}) {
    const parts: LanguageModelV3StreamPart[] = []
    const controller = new AbortController()
    const value: RunRequest = { sessionID: "session", directory: process.cwd(), profile: profile(), model: "sonnet",
      prompt: [user("first")], history: history.slice(0, 1), signal: controller.signal, emit: (part) => { parts.push(part) },
      interactions: () => ({ canUseTool: async () => ({ behavior: "allow", updatedInput: {} }) }), ...overrides }
    return { value, parts, controller }
  }
  function run(overrides: Partial<RunRequest> = {}) {
    const req = request(overrides)
    const done = runtime.run(req.value)
    void done.catch(() => {})
    return { ...req, done }
  }
  return { runtime, storage, queries, opened, notices, request, run }
}

describe("Runtime", () => {
  test("reload disposal preserves the interrupted native tool result and fails the turn explicitly", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send({ type: "assistant", parent_tool_use_id: null, message: { id: "running", content: [
      { type: "tool_use", id: "wait", name: "Bash", input: { command: "sleep 20" } },
    ] } })
    const disposing = h.runtime.dispose()
    await q.interrupted.promise
    q.interruptGate.resolve()
    await q.send({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "wait", is_error: true, content: "Command stopped while running" },
    ] } })
    await q.send(result(input.uuid!))
    await disposing
    expect(run.parts).toContainEqual(expect.objectContaining({ type: "tool-result", toolCallId: "wait", isError: true, result: "Command stopped while running" }))
    await expect(run.done).rejects.toThrow("unloaded")
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test.each(["result", "process exit", "interrupt failure"])("reload settles a displayed tool without claiming a native result after %s", async (ending) => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send({ type: "assistant", parent_tool_use_id: null, message: { id: "running", content: [
      { type: "tool_use", id: "edit", name: "Write", input: { file_path: "/fixture/file", content: "test" } },
    ] } })
    const disposing = h.runtime.dispose()
    await q.interrupted.promise
    if (ending === "interrupt failure") q.interruptGate.reject(new Error("Native interrupt failed"))
    else {
      q.interruptGate.resolve()
      if (ending === "result") await q.send(result(input.uuid!))
      else q.close()
    }
    await disposing
    await expect(run.done).rejects.toThrow("unloaded")
    const outputs = run.parts.filter((part) => part.type === "tool-result")
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ toolCallId: "edit", isError: true, result: expect.stringContaining("No final native result was received") })
    expect(outputs[0]?.providerMetadata).toBeUndefined()
    expect(run.parts.some((part) => part.type === "finish")).toBe(false)
    expect(h.storage.record().outcome).toBe(ending === "result" ? "settled" : "uncertain")
    expect(q.inputs).toHaveLength(1)
    if (ending !== "result") {
      const restarted = harness(h.storage)
      await expect(restarted.run().done).rejects.toThrow("Automatic replay could repeat tool side effects")
      expect(restarted.queries).toHaveLength(0)
    }
  }, 2000)

  test("reload during native initialization rejects without submitting a prompt", async () => {
    const h = harness(undefined, false)
    const run = h.run()
    const q = await h.opened.take()
    await h.runtime.dispose()
    await expect(run.done).rejects.toThrow("unloaded")
    expect(q.inputs).toHaveLength(0)
    expect(h.storage.record().outcome).toBe("ready")
  }, 2000)

  test("reload during stored-session loading cannot launch a native process afterward", async () => {
    const h = harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    h.storage.get = async () => { entered.resolve(); await release.promise; return undefined }
    const run = h.run()
    await entered.promise
    await h.runtime.dispose()
    release.resolve()
    await expect(run.done).rejects.toThrow("unloaded")
    expect(h.queries).toHaveLength(0)
    expect(h.storage.writes).toHaveLength(0)
  }, 2000)

  test("reload during pending persistence prevents submission and restores the prompt cursor", async () => {
    const h = harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const save = h.storage.set.bind(h.storage)
    h.storage.set = async (key, value) => {
      await save(key, value)
      if (value.outcome === "pending") { entered.resolve(); await release.promise }
    }
    const run = h.run()
    const q = await h.opened.take()
    await entered.promise
    await h.runtime.dispose()
    release.resolve()
    await expect(run.done).rejects.toThrow("unloaded")
    expect(q.inputs).toHaveLength(0)
    expect(h.storage.record().outcome).toBe("ready")
    expect(h.storage.record().users).toEqual([])
  }, 2000)

  test("routes native reviewer permissions after foreground settlement to the owning session", async () => {
    const h = harness()
    const calls: string[] = []
    const first = h.run({ interactions: () => ({ canUseTool: async (name, input) => {
      calls.push(name)
      return { behavior: "allow", updatedInput: input }
    } }) })
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const controller = new AbortController()
    const decision = await q.args.options.canUseTool!("Read", { file_path: "/fixture/review.ts" },
      { signal: controller.signal, toolUseID: "background-review-read", requestId: "background-permission", agentID: "reviewer" })
    expect(decision?.behavior).toBe("allow")
    expect(calls).toEqual(["Read"])
  }, 2000)

  test.each(["allow", "deny", "callback abort", "dispose", "process exit"])("background permissions preserve %s behavior after foreground settlement", async (outcome) => {
    const h = harness()
    const asked = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<void>()
    const calls: string[] = []
    let releases = 0
    const ctx = { permission: { assert: async ({ sessionID }: { sessionID: string }) => {
      calls.push(sessionID)
      asked.resolve()
      await reply.promise
    } } } as unknown as Plugin.Context
    const first = h.run({ interactions: (signal) => ({ ...createInteractions(ctx, "session", signal), dispose: () => { releases++ } }) })
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    first.controller.abort()
    const callback = new AbortController()
    const decision = q.args.options.canUseTool!("Write", { file_path: "/fixture/result" },
      { signal: callback.signal, toolUseID: "background-write", requestId: "permission", agentID: "reviewer" })
    await asked.promise
    expect(calls).toEqual(["session"])
    if (outcome === "allow") reply.resolve()
    if (outcome === "deny") reply.reject(new Error("Rejected by reviewer owner"))
    if (outcome === "callback abort") callback.abort()
    if (outcome === "dispose") await h.runtime.dispose()
    if (outcome === "process exit") q.close()
    expect(await decision).toMatchObject({ behavior: outcome === "allow" ? "allow" : "deny" })
    reply.resolve()
    if (outcome === "dispose" || outcome === "process exit") {
      expect(releases).toBe(1)
      expect(await q.args.options.canUseTool!("Read", { file_path: "/fixture/result" },
        { signal: new AbortController().signal, toolUseID: "late", requestId: "late" })).toMatchObject({ behavior: "deny" })
      expect(calls).toHaveLength(1)
    }
  }, 2000)

  test.each([true, false])("permission lifetime follows reviewer ownership (%s) during foreground settlement", async (reviewer) => {
    const h = harness()
    const asked = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<void>()
    const ctx = { permission: { assert: async () => { asked.resolve(); await reply.promise } } } as unknown as Plugin.Context
    const first = h.run({ interactions: (signal) => createInteractions(ctx, "session", signal) })
    const q = await h.opened.take()
    const input = await q.input.take()
    const decision = q.args.options.canUseTool!("Read", { file_path: "/fixture/review" },
      { signal: new AbortController().signal, toolUseID: "review", requestId: "review", ...(reviewer ? { agentID: "reviewer" } : {}) })
    await asked.promise
    await q.send(result(input.uuid!))
    await first.done
    first.controller.abort()
    reply.resolve()
    expect(await decision).toMatchObject({ behavior: reviewer ? "allow" : "deny" })
  }, 2000)

  test("concurrent native accounts keep idle permission requests in their owning host sessions", async () => {
    const h = harness()
    const calls: string[] = []
    const ctx = { permission: { assert: async ({ sessionID }: { sessionID: string }) => {
      calls.push(sessionID)
      if (sessionID === "ses_second") throw new Error("Second account denied")
    } } } as unknown as Plugin.Context
    const first = h.run({ interactions: (signal) => createInteractions(ctx, "session", signal) })
    const q1 = await h.opened.take()
    await q1.send(result((await q1.input.take()).uuid!))
    await first.done
    const second = h.run({ sessionID: "ses_second", profile: profile("two"),
      interactions: (signal) => createInteractions(ctx, "ses_second", signal) })
    const q2 = await Promise.race([h.opened.take(), second.done.then(() => { throw new Error("Second account ended without opening") })])
    await q2.send(result((await q2.input.take()).uuid!))
    await second.done
    const decisions = await Promise.all([q1, q2].map((q) => q.args.options.canUseTool!("Read", { file_path: "/fixture/review" },
      { signal: new AbortController().signal, toolUseID: "read", requestId: "read", agentID: "reviewer" })))
    expect(calls).toEqual(["session", "ses_second"])
    expect(decisions).toMatchObject([{ behavior: "allow" }, { behavior: "deny", message: "Second account denied" }])
    expect(q1.args.options.env?.CLAUDE_CONFIG_DIR).not.toBe(q2.args.options.env?.CLAUDE_CONFIG_DIR)
  }, 2000)

  test("native factory failure releases its permission context", async () => {
    let releases = 0
    let scope: AbortSignal | undefined
    const h = harness()
    const runtime = new Runtime(h.storage, () => { throw new Error("Factory failed") })
    const req = h.request({ interactions: (signal) => {
      scope = signal
      return { canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), dispose: () => { releases++ } }
    } })
    await expect(runtime.run(req.value)).rejects.toThrow("Factory failed")
    expect(scope?.aborted).toBe(true)
    expect(releases).toBe(1)
    await runtime.dispose()
    expect(releases).toBe(1)
  }, 2000)

  test("admits a queued follow-up after the previous host reply completes without waiting for execution idle", async () => {
    const h = harness()
    const firstUser = { id: "msg_user_first", type: "user", text: "first" }
    const first = h.run({ history: [firstUser] })
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send(assistant("native_first", "first answer"))
    await q.send(result(input.uuid!))
    await first.done
    const completedHistory = [firstUser,
      { id: "msg_assistant_first", type: "assistant", model: { providerID: "one", id: "sonnet" }, finish: "stop", content: [{ type: "text", text: "first answer" }] },
      { id: "msg_user_second", type: "user", text: "second" },
    ]
    const second = h.run({ history: completedHistory, prompt: [user("first"),
      { role: "assistant", content: [{ type: "text", text: "first answer" }] }, user("second")] })
    const next = await Promise.race([q.input.take(), second.done.then(() => { throw new Error("Follow-up ended before native submission") })])
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    expect(q.inputs).toHaveLength(2)
    await q.send(result(next.uuid!))
    await second.done
  }, 2000)

  test("MCP delegation uses each new turn's host and releases its signal after settlement", async () => {
    const h = harness()
    const signals: AbortSignal[] = []
    const host = (output: string): NonNullable<RunRequest["delegation"]> => (signal) => {
      signals.push(signal)
      return { listModels: async () => ({ models: [], total: 0, truncated: false, next: null }),
        delegate: async () => ({ sessionID: "ses_child", model: "example/model", output }) }
    }
    const first = h.run({ delegation: host("first") })
    const q = await h.opened.take()
    const input = await q.input.take()
    const server = q.args.options.mcpServers?.[DELEGATION_SERVER]
    if (!server || server.type !== "sdk") throw new Error("Missing SDK MCP server")
    expect(q.args.options.tools).toEqual({ type: "preset", preset: "claude_code" })
    expect(q.args.options.settingSources).toEqual(["user", "project", "local"])
    expect(q.args.options.settings).toEqual({ attribution: { pr: "*Posted via OpenCode*" } })
    const client = new Client({ name: "runtime-test", version: "1" })
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverTransport)
    await client.connect(transport)
    cleanups.push(async () => { await client.close(); await server.instance.close() })
    const call = () => client.callTool({ name: "delegate", arguments: { model: "example/model", prompt: "task", description: "task" }, _meta: { "claudecode/toolUseId": "toolu_test" } })
    expect((await call()).structuredContent).toMatchObject({ output: "first" })
    await q.send(result(input.uuid!))
    await first.done
    expect(signals[0]!.aborted).toBe(true)
    expect((await call()).isError).toBe(true)
    await h.runtime.checkpoint("session", async () => history)
    const second = h.run({ history, prompt: [user("first"), user("second")], delegation: host("second") })
    const next = await q.input.take()
    expect((await call()).structuredContent).toMatchObject({ output: "second" })
    expect(signals[1]!.aborted).toBe(false)
    await q.send(result(next.uuid!))
    await second.done
    expect(signals[1]!.aborted).toBe(true)
    expect(h.queries).toHaveLength(1)
  }, 2000)

  test("persists the submission descriptor before enqueue and retains it after settlement", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    const pending = structuredClone(h.storage.record())
    expect(pending.version).toBe(2)
    expect(pending.checkpoint).toEqual({ uuid: input.uuid, providerID: "one", preparedHostPrefix: historyBoundary(history.slice(0, 1)) })
    expect(pending.pendingUUID).toBe(input.uuid)
    await q.send(result(input.uuid!))
    await run.done
    expect(h.storage.record().checkpoint).toEqual(pending.checkpoint)
    expect(h.storage.record().pendingUUID).toBeUndefined()
    await h.runtime.checkpoint("session", async () => [...history, { id: "u2", type: "user", content: "second" }])
    expect(h.storage.record()).toMatchObject({ outcome: "ready", boundary: historyBoundary(history), users: pending.users, nativeID: pending.nativeID })
    expect(h.storage.record().checkpoint).toBeUndefined()
  }, 2000)

  test("resumes a version 2 settled record in a fresh Runtime without replaying the first prompt", async () => {
    const first = harness()
    const run = first.run()
    const q = await first.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await run.done
    const settled = structuredClone(first.storage.record())
    await first.runtime.dispose()
    const second = harness(first.storage)
    const resumed = second.run({ history, prompt: [user("first"), user("second")] })
    const nextQuery = await second.opened.take()
    const next = await nextQuery.input.take()
    expect(nextQuery.args.options.resume).toBe(settled.nativeID)
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    const ready = first.storage.writes.find((write) => write.value.outcome === "ready")!.value
    expect(ready.users).toEqual(settled.users)
    expect(ready.nativeID).toBe(settled.nativeID)
    expect(ready.checkpoint).toBeUndefined()
    await nextQuery.send(result(next.uuid!))
    await resumed.done
    expect(nextQuery.inputs).toHaveLength(1)
  }, 2000)

  test.each(["ready", "settled"])("handles legacy version 1 %s records without replay", async (outcome) => {
    const first = harness()
    const run = first.run()
    const q = await first.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await run.done
    if (outcome === "ready") await first.runtime.checkpoint("session", async () => history)
    const saved = structuredClone(first.storage.record())
    saved.version = 1
    delete saved.checkpoint
    await first.storage.set("session/session", saved)
    await first.runtime.dispose()
    const second = harness(first.storage)
    const resumed = second.run({ history, prompt: [user("first"), user("second")] })
    if (outcome === "settled") {
      await expect(resumed.done).rejects.toThrow("legacy Claude session")
      expect(second.queries).toHaveLength(0)
      expect(first.storage.record()).toEqual(saved)
      return
    }
    const nextQuery = await second.opened.take()
    const next = await nextQuery.input.take()
    expect(nextQuery.args.options.resume).toBe(saved.nativeID)
    expect(first.storage.record().version).toBe(2)
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    await nextQuery.send(result(next.uuid!))
    await resumed.done
  }, 2000)

  test.each(["missing", "incomplete", "wrong provider", "user"])("blocks an immediate %s reply without scanning to a later matching assistant", async (kind) => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const settled = structuredClone(h.storage.record())
    const candidate = structuredClone(history[1]!)
    if (kind === "incomplete") delete candidate.finish
    if (kind === "wrong provider") candidate.model = { providerID: "other" }
    if (kind === "user") candidate.type = "user"
    const invalid = kind === "missing" ? history.slice(0, 1) : [history[0]!, candidate, { ...history[1]!, id: "later" }]
    await expect(h.run({ history: invalid, prompt: [user("first"), user("second")] }).done).rejects.toThrow("missing or incomplete")
    expect(h.storage.record()).toEqual(settled)
    expect(q.inputs).toHaveLength(1)
    expect(h.queries).toHaveLength(1)
  }, 2000)

  test.each([false, true])("reconciles a prepared empty host assistant only with its saved ID (replacement: %s)", async (replacement) => {
    const h = harness()
    const placeholder: HistoryEntry = { ...history[1]!, content: [] }
    delete placeholder.finish
    const first = h.run({ history: [history[0]!, placeholder] })
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    expect(h.storage.record().checkpoint.assistantID).toBe(placeholder.id)
    const completed = [history[0]!, { ...history[1]!, id: replacement ? "replacement" : placeholder.id }]
    if (replacement) {
      await expect(h.runtime.checkpoint("session", async () => completed)).rejects.toThrow("missing or incomplete")
      expect(h.storage.record().outcome).toBe("settled")
    } else {
      await h.runtime.checkpoint("session", async () => completed)
      expect(h.storage.record().outcome).toBe("ready")
    }
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("rejects an edited prepared raw prefix, including an unfinished assistant omitted from historyBoundary", async () => {
    const h = harness()
    const unfinished = { id: "draft", type: "assistant", model: { providerID: "one" }, content: "draft" }
    const prepared = [history[0]!, unfinished]
    const first = h.run({ history: prepared })
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    expect(h.storage.record().checkpoint.preparedHostPrefix).toHaveLength(2)
    const edited = [history[0]!, { ...unfinished, content: "edited" }, history[1]!]
    await expect(h.run({ history: edited, prompt: [user("first"), user("second")] }).done).rejects.toThrow("submitted prompt boundary")
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("rejects edits to the submitted user before the first host checkpoint", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const settled = structuredClone(h.storage.record())
    const edited = [{ ...history[0]!, content: "edited" }, history[1]!]
    await expect(h.run({ history: edited, prompt: [user("first"), user("second")] }).done).rejects.toThrow("submitted prompt boundary")
    expect(h.storage.record()).toEqual(settled)
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("rejects an edited old boundary while reconciling a later settled turn", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const secondHistory = [...history, { id: "u2", type: "user", content: "second" }]
    const second = h.run({ history: secondHistory, prompt: [user("first"), user("second")] })
    await q.send(result((await q.input.take()).uuid!))
    await second.done
    const edited = [...secondHistory, { ...history[1]!, id: "a2" }]
    edited[1] = { ...history[1]!, content: "edited" }
    await expect(h.run({ history: edited, prompt: [user("first"), user("second"), user("third")] }).done).rejects.toThrow("saved boundary")
    expect(q.inputs).toHaveLength(2)
  }, 2000)

  test("interrupting a native turn aborts active host delegation before draining Claude", async () => {
    const h = harness()
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const first = h.run({ delegation: (signal) => ({ listModels: async () => ({ models: [], total: 0, truncated: false, next: null }),
      delegate: async () => {
        started.resolve()
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { cancelled.resolve(); reject(signal.reason) }, { once: true }))
        return { sessionID: "ses_child", model: "example/model", output: "not returned" }
      },
    }) })
    const q = await h.opened.take()
    const input = await q.input.take()
    const server = q.args.options.mcpServers?.[DELEGATION_SERVER]
    if (!server || server.type !== "sdk") throw new Error("Missing SDK MCP server")
    const client = new Client({ name: "runtime-test", version: "1" })
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverTransport)
    await client.connect(transport)
    cleanups.push(async () => { await client.close(); await server.instance.close() })
    const call = client.callTool({ name: "delegate", arguments: { model: "example/model", prompt: "task", description: "task" }, _meta: { "claudecode/toolUseId": "toolu_test" } })
    await started.promise
    first.controller.abort(new Error("Parent stopped"))
    await cancelled.promise
    expect((await call).isError).toBe(true)
    await q.interrupted.promise
    q.interruptGate.resolve()
    await q.send(result(input.uuid!))
    await expect(first.done).rejects.toThrow("Parent stopped")
  }, 2000)

  test("isolates concurrent profiles, environments, native IDs, and persisted records", async () => {
    const h = harness()
    const inherited = process.env.CLAUDE_CONFIG_DIR
    const a = h.run({ sessionID: "a", profile: profile("a") })
    const b = h.run({ sessionID: "b", profile: profile("b") })
    const queries = [await h.opened.take(), await h.opened.take()]
    expect(new Set(queries.map((q) => q.args.options.sessionId)).size).toBe(2)
    expect(queries.map((q) => q.args.options.env?.CLAUDE_CONFIG_DIR).sort()).toEqual([
      profile("a").configDir, profile("b").configDir,
    ])
    expect(queries[0]!.args.options.env).not.toBe(queries[1]!.args.options.env)
    for (const q of queries) {
      const input = await q.input.take()
      await q.send(result(input.uuid!))
    }
    await Promise.all([a.done, b.done])
    expect(h.storage.record("a").nativeID).not.toBe(h.storage.record("b").nativeID)
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(inherited)
  }, 2000)

  test.each(["configDir", "binaryPath", "plugins", "id", "directory", "env"])("rejects changed immutable binding: %s", async (field) => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    await h.runtime.checkpoint("session", async () => history)
    const changed: Partial<RunRequest> = { prompt: [user("first"), user("second")] }
    if (field === "directory") {
      changed.directory = mkdtempSync(join(tmpdir(), "claude-runtime-binding-"))
      const directory = changed.directory
      cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }) })
    }
    else changed.profile = { ...profile(), [field]: field === "plugins" ? ["/different-plugin"] : field === "env" ? { EXAMPLE: "changed" } : "/different" }
    await expect(h.run(changed).done).rejects.toThrow("another Claude configuration or working directory")
    expect(h.queries).toHaveLength(1)
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("reuses one native query for foreground prompts and sends no historical replay", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send(result(input.uuid!))
    await first.done
    await h.runtime.checkpoint("session", async () => history)
    const second = h.run({ history, prompt: [user("first"),
      { role: "assistant", content: [{ type: "text", text: "answer" }] }, user("second")] })
    const next = await q.input.take()
    expect(next.uuid).not.toBe(input.uuid)
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    await q.send(result(next.uuid!))
    await second.done
    expect(h.queries).toHaveLength(1)
    expect(h.storage.writes.map((write) => write.value.outcome)).toEqual(["pending", "settled", "ready", "pending", "settled"])
  }, 2000)

  test("Stop-style assistant continuations remain one turn until the result", async () => {
    const h = harness()
    const run = h.run()
    let settled = false
    void run.done.then(() => { settled = true })
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send(assistant("one", "first answer"))
    await q.send({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } })
    await q.send(assistant("two", "hook continuation"))
    expect(settled).toBe(false)
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(0)
    expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["first answer", "hook continuation"])
    await q.send(result(input.uuid!))
    await run.done
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
  }, 2000)

  test("reconciles a completed host reply before accepting another prompt", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const second = h.run({ history, prompt: [user("first"), user("second")] })
    const next = await q.input.take()
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    expect(h.storage.writes.at(-2)!.value.outcome).toBe("ready")
    await q.send(result(next.uuid!))
    await second.done
  }, 2000)

  test("checkpoint storage rejection leaves the session settled and blocks the next prompt", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const settled = structuredClone(h.storage.record())
    const save = h.storage.set.bind(h.storage)
    h.storage.set = async (key, value) => {
      if (value.outcome === "ready") throw new Error("checkpoint storage unavailable")
      await save(key, value)
    }
    await expect(h.runtime.checkpoint("session", async () => history)).rejects.toThrow("checkpoint storage unavailable")
    expect(h.storage.record()).toEqual(settled)
    await expect(h.run({ history, prompt: [user("first"), user("second")] }).done).rejects.toThrow("checkpoint storage unavailable")
    expect(h.storage.record()).toEqual(settled)
    expect(q.inputs).toHaveLength(1)
    expect(h.queries).toHaveLength(1)
    expect(h.storage.writes.filter((write) => write.value.outcome === "pending")).toHaveLength(1)
    h.storage.set = save
    const retry = h.run({ history, prompt: [user("first"), user("second")] })
    const next = await q.input.take()
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    await q.send(result(next.uuid!))
    await retry.done
  }, 2000)

  test("fetches checkpoint history inside the lock after the settled record finishes saving", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    const saving = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const save = h.storage.set.bind(h.storage)
    h.storage.set = async (key, value) => {
      await save(key, value)
      if (value.outcome === "settled") { saving.resolve(); await release.promise }
    }
    const resultRead = q.send(result(input.uuid!))
    await saving.promise
    let fetched = false
    let currentHistory: HistoryEntry[] = []
    const checkpoint = h.runtime.checkpoint("session", async () => {
      fetched = true
      return currentHistory
    })
    expect(fetched).toBe(false)
    currentHistory = history
    release.resolve()
    await resultRead
    await first.done
    await checkpoint
    expect(fetched).toBe(true)
    expect(h.storage.record().boundary).toEqual(historyBoundary(history))
    expect(h.storage.record().outcome).toBe("ready")
  }, 2000)

  test("a stale checkpoint callback cannot checkpoint a newer submission", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const secondHistory = [...history, { id: "u2", type: "user", content: "second" }]
    const second = h.run({ history: secondHistory, prompt: [user("first"), user("second")] })
    let fetched = false
    const stale = h.runtime.checkpoint("session", async () => {
      fetched = true
      return [...secondHistory, { ...history[1]!, id: "a2" }]
    })
    const input = await q.input.take()
    const descriptor = structuredClone(h.storage.record().checkpoint)
    await q.send(result(input.uuid!))
    await second.done
    await stale
    expect(fetched).toBe(false)
    expect(h.storage.record().outcome).toBe("settled")
    expect(h.storage.record().checkpoint).toEqual(descriptor)
    await h.runtime.checkpoint("session", async () => [...secondHistory, { ...history[1]!, id: "a2" }])
    expect(h.storage.record().outcome).toBe("ready")
  }, 2000)

  test("abort during delayed reconciliation persistence submits nothing and a retry sends only the new prompt", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const save = h.storage.set.bind(h.storage)
    h.storage.set = async (key, value) => {
      if (value.outcome === "ready") { entered.resolve(); await release.promise }
      await save(key, value)
    }
    const second = h.run({ history, prompt: [user("first"), user("second")] })
    await entered.promise
    second.controller.abort(new Error("Cancelled during reconciliation"))
    expect(q.inputs).toHaveLength(1)
    release.resolve()
    await expect(second.done).rejects.toThrow("Cancelled during reconciliation")
    expect(q.inputs).toHaveLength(1)
    expect(q.interruptCount).toBe(0)
    expect(h.storage.record().outcome).toBe("ready")
    const retry = h.run({ history, prompt: [user("first"), user("second")] })
    const input = await q.input.take()
    expect(input.message.content).toEqual([{ type: "text", text: "second" }])
    await q.send(result(input.uuid!))
    await retry.done
  }, 2000)

  test.each(["model", "effort"])("rejects live %s changes without restarting the query", async (field) => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    await h.runtime.checkpoint("session", async () => history)
    const changed = field === "model" ? { model: "opus" } : { effort: "high" as const }
    await expect(h.run({ history, prompt: [user("first"), user("second")], ...changed }).done).rejects.toThrow("Changing model or effort")
    expect(h.queries).toHaveLength(1)
    expect(q.inputs).toHaveLength(1)
    expect(q.closed).toBe(0)
  }, 2000)

  test("resumes the persisted native ID in a new Runtime after checkpoint", async () => {
    const first = harness()
    const run = first.run()
    const q = await first.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await run.done
    await first.runtime.checkpoint("session", async () => history)
    const nativeID = first.storage.record().nativeID
    await first.runtime.dispose()
    const second = harness(first.storage)
    const resumed = second.run({ history, prompt: [user("first"), user("second")] })
    const nextQuery = await second.opened.take()
    expect(nextQuery.args.options.resume).toBe(nativeID)
    expect(nextQuery.args.options.sessionId).toBeUndefined()
    const next = await nextQuery.input.take()
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    await nextQuery.send(result(next.uuid!))
    await resumed.done
  }, 2000)

  test("cancellation interrupts and drains the result before submitting the next prompt", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    first.controller.abort()
    await q.interrupted.promise
    await q.send(assistant("draining", "must not emit"))
    expect(q.inputs).toHaveLength(1)
    expect(first.parts).toEqual([])
    await q.send(result(input.uuid!))
    const checkpoint = h.runtime.checkpoint("session", async () => history)
    const second = h.run({ history, prompt: [user("first"), user("second")] })
    expect(q.inputs).toHaveLength(1)
    q.interruptGate.resolve()
    await expect(first.done).rejects.toThrow()
    await checkpoint
    const next = await q.input.take()
    expect(next.uuid).not.toBe(input.uuid)
    await q.send(result(next.uuid!))
    await second.done
    expect(h.queries).toHaveLength(1)
  }, 2000)

  test("interrupt timeout remains uncertain when close flushes a buffered matching result", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    const close = q.close.bind(q)
    let flushed: Promise<void> | undefined
    q.close = () => {
      if (!q.closed) flushed = q.send(result(input.uuid!))
      close()
    }
    run.controller.abort()
    await q.interrupted.promise
    await expect(run.done).rejects.toThrow("Claude did not finish cancellation within 10 seconds")
    expect(flushed).toBeDefined()
    await flushed
    expect(q.closed).toBeGreaterThanOrEqual(1)
    expect(h.storage.record().outcome).toBe("uncertain")
    expect(h.storage.writes.some((write) => write.value.outcome === "settled")).toBe(false)
    expect(run.parts.filter((part) => part.type === "finish")).toEqual([])
    await expect(h.run({ prompt: [user("first"), user("second")] }).done).rejects.toThrow("uncertain outcome")
    expect(q.inputs).toHaveLength(1)
  }, 15_000)

  test("an already-aborted request has no process or storage side effects", async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(h.run({ signal: controller.signal }).done).rejects.toThrow()
    expect(h.queries).toHaveLength(0)
    expect(h.storage.writes).toEqual([])
    expect(h.storage.values.size).toBe(0)
  }, 2000)

  test("abort during pending storage.set restores the previous cursor without enqueue or interrupt", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    await h.runtime.checkpoint("session", async () => history)
    const previous = structuredClone(h.storage.record())
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const save = h.storage.set.bind(h.storage)
    h.storage.set = async (key, value) => {
      await save(key, value)
      if (value.outcome === "pending") { entered.resolve(); await release.promise }
    }
    const second = h.run({ history, prompt: [user("first"), user("second")] })
    await entered.promise
    second.controller.abort()
    expect(q.inputs).toHaveLength(1)
    expect(q.interruptCount).toBe(0)
    release.resolve()
    await expect(second.done).rejects.toThrow()
    expect(q.inputs).toHaveLength(1)
    expect(q.interruptCount).toBe(0)
    expect(h.storage.record()).toEqual(previous)
    const retry = h.run({ history, prompt: [user("first"), user("second")] })
    const input = await q.input.take()
    expect(input.message.content).toEqual([{ type: "text", text: "second" }])
    await q.send(result(input.uuid!))
    await retry.done
  }, 2000)

  test("aborting during startup storage lookup launches no process and writes no record", async () => {
    const storage = new MemoryStorage()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    storage.get = async () => { entered.resolve(); await release.promise; return undefined }
    const h = harness(storage)
    const run = h.run()
    await entered.promise
    run.controller.abort()
    release.resolve()
    await expect(run.done).rejects.toThrow()
    expect(h.storage.writes).toEqual([])
    expect(h.queries).toHaveLength(0)
  }, 2000)

  test.each(["pending", "uncertain"])("refuses persisted %s turns without replay", async (outcome) => {
    const storage = new MemoryStorage()
    await storage.set("session/session", { version: 1, outcome, pendingUUID: "unfinished" })
    const h = harness(storage)
    await expect(h.run().done).rejects.toThrow("Automatic replay could repeat tool side effects")
    expect(h.queries).toHaveLength(0)
    expect(storage.writes).toHaveLength(1)
  }, 2000)

  test.each(["assistant", "tool"])("rejects edited %s content at the full checkpoint boundary", async (kind) => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    await h.runtime.checkpoint("session", async () => history)
    const edited = structuredClone(history)
    if (kind === "assistant") edited[1] = { ...edited[1]!, content: "edited" }
    else (edited[1]!.content as Array<Record<string, unknown>>)[1]!.result = "edited"
    await expect(h.run({ history: edited, prompt: [user("first"), user("second")] }).done).rejects.toThrow("saved boundary")
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("initialization failure closes the query without submitting input or settling a turn", async () => {
    const h = harness(new MemoryStorage(), false)
    const run = h.run()
    const q = await h.opened.take()
    q.initialized.reject(new Error("initialization failed"))
    await expect(run.done).rejects.toThrow("initialization failed")
    expect(q.closed).toBeGreaterThanOrEqual(1)
    expect(q.inputs).toEqual([])
    expect(run.parts.filter((part) => part.type === "finish")).toEqual([])
    expect(h.storage.writes.some((write) => write.value.outcome === "settled")).toBe(false)
  }, 2000)

  test("a result received during startup cannot settle an unsubmitted turn", async () => {
    const h = harness(new MemoryStorage(), false)
    const run = h.run()
    const q = await h.opened.take()
    await q.send({ ...result("startup-background"), user_message_uuid: undefined })
    expect(q.inputs).toHaveLength(0)
    expect(run.parts).toEqual([])
    expect(h.storage.writes.some((write) => write.value.outcome === "settled")).toBe(false)
    q.initialized.resolve({} as Awaited<ReturnType<NativeQuery["initializationResult"]>>)
    const input = await q.input.take()
    expect(h.storage.record().outcome).toBe("pending")
    await q.send(result(input.uuid!))
    await run.done
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
  }, 2000)

  test("a reader failure during initialization prevents later prompt submission", async () => {
    const h = harness(new MemoryStorage(), false)
    const run = h.run()
    const q = await h.opened.take()
    void q.send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["startup failed"] })
    await q.didClose.promise
    q.initialized.resolve({} as Awaited<ReturnType<NativeQuery["initializationResult"]>>)
    await expect(run.done).rejects.toThrow("Claude startup failed")
    expect(q.inputs).toHaveLength(0)
    expect(h.storage.writes.some((write) => write.value.outcome === "pending")).toBe(false)
    expect(h.storage.record().outcome).toBe("ready")
  }, 2000)

  test("init plugin errors before submission reject the turn without executing the prompt", async () => {
    const h = harness(new MemoryStorage(), false)
    const run = h.run()
    const q = await h.opened.take()
    void q.send({ type: "system", subtype: "init", plugin_errors: [
      { plugin: "broken-plugin", type: "hook-load-failed", message: "missing hook script" },
    ] })
    await q.didClose.promise
    q.initialized.resolve({} as Awaited<ReturnType<NativeQuery["initializationResult"]>>)
    await expect(run.done).rejects.toThrow("Claude plugin loading failed: broken-plugin: missing hook script")
    expect(q.inputs).toHaveLength(0)
    expect(h.storage.writes.some((write) => write.value.outcome === "pending")).toBe(false)
    expect(h.storage.record().outcome).toBe("ready")
    expect(run.parts.filter((part) => part.type === "finish")).toEqual([])
  }, 2000)

  test.each(["absent", "different"])("matches user_message_uuids when the singular UUID is %s", async (singular) => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    const message: Record<string, unknown> = result("another-turn")
    if (singular === "absent") delete message.user_message_uuid
    message.user_message_uuids = ["another-turn", input.uuid]
    await q.send(message)
    await run.done
    expect(h.storage.record().outcome).toBe("settled")
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
  }, 2000)

  test("rejects results without attribution rather than settling the active turn", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    await q.input.take()
    const message: Record<string, unknown> = result("unused")
    delete message.user_message_uuid
    void q.send(message)
    await expect(run.done).rejects.toThrow("without a prompt UUID")
    expect(h.storage.record().outcome).toBe("uncertain")
    expect(run.parts.filter((part) => part.type === "finish")).toEqual([])
    expect(q.closed).toBe(1)
  }, 2000)

  test("a pending and then rejected background callback does not block or kill the reader", async () => {
    const entered = Promise.withResolvers<void>()
    const rejectNotice = Promise.withResolvers<void>()
    const logged = Promise.withResolvers<void>()
    const errorLog = spyOn(console, "error").mockImplementation(() => { logged.resolve() })
    try {
      const h = harness(new MemoryStorage(), true, async () => {
        entered.resolve()
        await rejectNotice.promise
      })
      const run = h.run()
      const q = await h.opened.take()
      const input = await q.input.take()
      await q.send(result("background"))
      await entered.promise
      await q.send(assistant("foreground", "reader continues"))
      expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["reader continues"])
      rejectNotice.reject(new Error("notice failed"))
      await logged.promise
      await q.send(result(input.uuid!))
      await run.done
      expect(h.storage.record().outcome).toBe("settled")
      expect(q.closed).toBe(0)
      expect(errorLog).toHaveBeenCalledTimes(1)
    } finally { errorLog.mockRestore() }
  }, 2000)

  test("an unmatched result UUID is background activity and cannot settle the foreground turn", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send(result("another-turn"))
    expect(h.notices).toHaveLength(1)
    expect(h.storage.record().outcome).toBe("pending")
    expect(run.parts).toEqual([])
    await q.send(assistant("actual", "foreground"))
    await q.send(result(input.uuid!))
    await run.done
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
  }, 2000)

  test("disposal closes all native processes and rejects subsequent runs", async () => {
    const h = harness()
    for (const sessionID of ["one", "two"]) {
      const run = h.run({ sessionID })
      const q = await h.opened.take()
      await q.send(result((await q.input.take()).uuid!))
      await run.done
    }
    await h.runtime.dispose()
    expect(h.queries.map((q) => q.closed)).toEqual([1, 1])
    await expect(h.run().done).rejects.toThrow("unloaded")
  }, 2000)
})
