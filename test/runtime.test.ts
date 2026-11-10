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
import { emptyUsage, type BackgroundResponse } from "../src/background"

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
    let frame = message as Record<string, unknown>
    if (!("session_id" in frame)) frame = { ...frame, session_id: this.args.options.sessionId ?? this.args.options.resume }
    message = frame
    if ((frame.type === "assistant" || frame.type === "stream_event") && frame.parent_tool_use_id === null &&
      !("user_message_uuid" in frame) && this.inputs.length) {
      message = { ...frame, user_message_uuid: this.inputs.at(-1)!.uuid }
    }
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

const bashCall = (id: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent,
  message: { id: `assistant-${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command: "printf requested" } }] } })
const bashResult = (id: string, parent: string | null = null) => ({ type: "user", parent_tool_use_id: parent,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Final SDK output" }] } })

async function observeBash(query: FakeQuery, nativeID: string, id: string, command: string) {
  const callback = query.args.options.hooks?.PostToolUse?.[0]?.hooks[0]
  if (!callback) throw new Error("Missing read-only Bash observer")
  expect(await callback({ hook_event_name: "PostToolUse", session_id: nativeID, transcript_path: "/native/transcript",
    cwd: process.cwd(), tool_name: "Bash", tool_use_id: id, tool_input: { command },
    tool_response: "Hook response before other native post-hooks" }, id, { signal: new AbortController().signal })).toEqual({})
}

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
  test("buffers native command observations with their result and uses final SDK output", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send({ ...bashCall("buffered"), user_message_uuid: undefined })
    await observeBash(q, h.storage.record().nativeID, "buffered", "printf observed")
    await q.send(bashResult("buffered"))
    expect(run.parts).toEqual([])
    await observeBash(q, h.storage.record().nativeID, "buffered", "printf stale")
    await q.send(result(input.uuid!))
    await run.done
    const output = run.parts.find(part => part.type === "tool-result")!
    expect(output.result).toEqual(expect.stringContaining("Native command (observed): printf observed"))
    expect(output.result).toEqual(expect.stringContaining("--- Native output ---\nFinal SDK output"))
    expect(JSON.stringify(output)).not.toContain("Hook response before other native post-hooks")
    expect(JSON.stringify(output)).not.toContain("printf stale")
  }, 2000)

  test("child Bash observations retain child ownership and cannot label the root call", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send(bashCall("root"))
    await q.send(bashCall("child", "native-agent"))
    await observeBash(q, h.storage.record().nativeID, "child", "printf child-observed")
    await q.send(bashResult("child", "native-agent"))
    await q.send(bashResult("root"))
    await q.send(result(input.uuid!))
    await run.done
    const outputs = run.parts.filter(part => part.type === "tool-result")
    expect(outputs).toMatchObject([
      { toolCallId: 'child:["native-agent","child"]', result: expect.stringContaining("Native command (observed): printf child-observed") },
      { toolCallId: "root", result: expect.stringContaining("Native command not observed") },
    ])
  }, 2000)

  test("native command observations are isolated between profile queries using the same tool ID", async () => {
    const h = harness()
    const left = h.run({ sessionID: "left", profile: profile("left") })
    const lq = await h.opened.take()
    const li = await lq.input.take()
    const right = h.run({ sessionID: "right", profile: profile("right") })
    const rq = await h.opened.take()
    const ri = await rq.input.take()
    await lq.send(bashCall("shared"))
    await rq.send(bashCall("shared"))
    await observeBash(lq, h.storage.record("left").nativeID, "shared", "printf left")
    await observeBash(rq, h.storage.record("right").nativeID, "shared", "printf right")
    await lq.send(bashResult("shared"))
    await rq.send(bashResult("shared"))
    await lq.send(result(li.uuid!))
    await rq.send(result(ri.uuid!))
    await Promise.all([left.done, right.done])
    const lo = left.parts.find(part => part.type === "tool-result")!
    const ro = right.parts.find(part => part.type === "tool-result")!
    expect(lo.result).toEqual(expect.stringContaining("Native command (observed): printf left"))
    expect(ro.result).toEqual(expect.stringContaining("Native command (observed): printf right"))
    expect(lo.providerMetadata).toHaveProperty("left")
    expect(ro.providerMetadata).toHaveProperty("right")
  }, 2000)

  test("late callbacks from a disposed query cannot annotate a resumed query", async () => {
    const first = harness()
    const run = first.run()
    const oldQuery = await first.opened.take()
    const initial = await oldQuery.input.take()
    await oldQuery.send(bashCall("reused"))
    await observeBash(oldQuery, first.storage.record().nativeID, "reused", "printf old")
    await oldQuery.send(bashResult("reused"))
    await oldQuery.send(result(initial.uuid!))
    await run.done
    await first.runtime.checkpoint("session", async () => history)
    await first.runtime.dispose()
    const second = harness(first.storage)
    const resumed = second.run({ history, prompt: [user("first"), user("second")] })
    const newQuery = await second.opened.take()
    const next = await newQuery.input.take()
    await newQuery.send(bashCall("reused"))
    await observeBash(oldQuery, first.storage.record().nativeID, "reused", "printf late-old-query")
    await newQuery.send(bashResult("reused"))
    await newQuery.send(result(next.uuid!))
    await resumed.done
    const output = resumed.parts.find(part => part.type === "tool-result")!
    expect(output.result).toEqual(expect.stringContaining("Native command not observed"))
    expect(JSON.stringify(output)).not.toContain("late-old-query")
    expect(newQuery.inputs).toHaveLength(1)
  }, 2000)

  test("cancelled observations are drained without contaminating a follow-up", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send(bashCall("cancelled"))
    first.controller.abort()
    await q.interrupted.promise
    await observeBash(q, h.storage.record().nativeID, "cancelled", "printf cancelled-native")
    await q.send(bashResult("cancelled"))
    await q.send(result(input.uuid!))
    q.interruptGate.resolve()
    await expect(first.done).rejects.toThrow()
    expect(first.parts.some(part => part.type === "tool-result")).toBe(false)
    await h.runtime.checkpoint("session", async () => history)
    const second = h.run({ history, prompt: [user("first"), user("second")] })
    const next = await q.input.take()
    await q.send(bashCall("follow-up"))
    await observeBash(q, h.storage.record().nativeID, "cancelled", "printf late-cancelled")
    await q.send(bashResult("follow-up"))
    await q.send(result(next.uuid!))
    await second.done
    const output = second.parts.find(part => part.type === "tool-result")!
    expect(output.result).toEqual(expect.stringContaining("Native command not observed"))
    expect(JSON.stringify(output)).not.toContain("cancelled")
    expect(q.inputs).toHaveLength(2)
  }, 2000)

  async function completedSession() {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await run.done
    await h.runtime.checkpoint("session", async () => history)
    const response: BackgroundResponse = { id: "cached-report", providerID: "one", nativeID: h.storage.record().nativeID,
      binding: h.storage.record().binding, text: "The complete saved report.", usage: {
        inputTokens: { total: 13, noCache: 13, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 21, text: undefined, reasoning: undefined },
      } }
    const wake: HistoryEntry = { id: "wake", type: "synthetic", text: "Full Claude Agent background response available.",
      metadata: { fullClaudeAgentBackground: response } }
    return { h, q, response, wake }
  }

  test("a fresh runtime delivers a cached report without opening a query", async () => {
    const { h, response, wake } = await completedSession()
    const restarted = harness(h.storage)
    const run = restarted.run({ history: [...history, wake] })
    await run.done
    expect(restarted.queries).toEqual([])
    expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([response.text])
    expect(run.parts.filter((part) => part.type === "text-start" || part.type === "text-end")).toEqual([
      { type: "text-start", id: `background-${response.id}`, providerMetadata: { one: { backgroundResponseID: response.id } } },
      { type: "text-end", id: `background-${response.id}`, providerMetadata: { one: { backgroundResponseID: response.id } } },
    ])
    expect(run.parts.filter((part) => part.type === "finish")).toEqual([expect.objectContaining({ usage: response.usage })])
    expect(h.storage.record().delivery).toEqual([response])
  }, 2000)

  test.each([429, 529])("query-wide rejection metadata does not invent request ownership for HTTP %s", async (status) => {
    const h = harness()
    const run = h.run({ profile: profile("actual-profile") })
    const q = await h.opened.take()
    const input = await q.input.take()
    const rateLimit = { status: "rejected", rateLimitType: "five_hour", resetsAt: 2_000_000_000 }
    await q.send({ type: "rate_limit_event", rate_limit_info: rateLimit })
    expect(run.parts).toEqual([])
    await q.send({ ...result(input.uuid!), api_error_status: status, result: "Native failure" })
    await run.done
    expect(run.parts).toMatchObject([
      { type: "error", error: { statusCode: status, isRetryable: false } },
      { type: "finish", finishReason: { unified: "error" }, providerMetadata: { "actual-profile": { rateLimit } } },
    ])
    const error = run.parts.find((part) => part.type === "error")
    if (error?.type !== "error") throw new Error("Missing terminal error")
    expect((error.error as { responseHeaders?: unknown }).responseHeaders).toBeUndefined()
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("transient root diagnostics and a query-wide rejected limit cannot turn success into failure", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send({ ...assistant("retry", "Transient overload"), error: "server_error" })
    const rateLimit = { status: "rejected", rateLimitType: "seven_day", resetsAt: 2_000_000_000 }
    await q.send({ type: "rate_limit_event", rate_limit_info: rateLimit })
    expect(run.parts).toEqual([])
    await q.send(result(input.uuid!))
    await run.done
    expect(run.parts).toMatchObject([{ type: "finish", finishReason: { unified: "stop" }, providerMetadata: { one: { rateLimit } } }])
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("query quota snapshots stay isolated across profiles and clear when a query restarts", async () => {
    const h = harness()
    const first = h.run()
    const q1 = await h.opened.take()
    const input1 = await q1.input.take()
    const rateLimit = { status: "allowed_warning", utilization: 0.95, rateLimitType: "five_hour" }
    await q1.send({ type: "rate_limit_event", rate_limit_info: rateLimit })
    const second = h.run({ sessionID: "other-session", profile: profile("two") })
    const q2 = await h.opened.take()
    await q2.send(result((await q2.input.take()).uuid!))
    await second.done
    expect(second.parts.find((part) => part.type === "finish")).not.toHaveProperty("providerMetadata")
    await q1.send(result(input1.uuid!))
    await first.done
    expect(first.parts.find((part) => part.type === "finish")).toMatchObject({ providerMetadata: { one: { rateLimit } } })
    await h.runtime.checkpoint("session", async () => history)
    q1.close()
    await q1.didClose.promise
    const resumed = h.run({ history, prompt: [user("first"), user("second")] })
    const q3 = await h.opened.take()
    await q3.send(result((await q3.input.take()).uuid!))
    await resumed.done
    expect(resumed.parts.find((part) => part.type === "finish")).not.toHaveProperty("providerMetadata")
    expect(q3.inputs).toHaveLength(1)
  }, 2000)

  test("autonomous root diagnostics and query quota survive in the background notice", async () => {
    const { h, q } = await completedSession()
    const rateLimit = { status: "rejected", rateLimitType: "five_hour", resetsAt: 2_000_000_000 }
    await q.send({ type: "rate_limit_event", rate_limit_info: rateLimit })
    await q.send({ ...assistant("background-error", "Native quota detail"), error: "rate_limit", user_message_uuid: undefined })
    await q.send({ ...result("unused"), user_message_uuid: undefined, uuid: "failed-background", api_error_status: 429, result: "" })
    expect(h.notices.flat()).toMatchObject([{
      uuid: "failed-background", fullClaudeStatus: { diagnostics: { code: "rate_limit", detail: "Native quota detail" }, rateLimit },
    }])
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test.each([false, true])("cached failure preserves metadata and submits only a mixed real user (mixed: %s)", async (mixed) => {
    const { h, response, wake } = await completedSession()
    const rateLimit = { status: "rejected" as const, rateLimitType: "five_hour" as const, resetsAt: 2_000_000_000 }
    const failed: BackgroundResponse = { ...response, text: "Claude background activity failed: Quota exhausted",
      error: { message: "Quota exhausted", statusCode: 429 }, rateLimit }
    const failedWake = { ...wake, metadata: { fullClaudeAgentBackground: failed } }
    const restarted = harness(h.storage)
    const run = restarted.run({ history: [...history, failedWake, ...(mixed ? [{ id: "follow-up", type: "user", content: "Continue" }] : [])],
      prompt: mixed ? [user("first"), user("Continue")] : [user("first")] })
    if (mixed) {
      const q = await restarted.opened.take()
      const input = await q.input.take()
      expect(input.message.content).toEqual([{ type: "text", text: "Continue" }])
      expect(run.parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-end"])
      await q.send(assistant("continued", "New answer"))
      await q.send(result(input.uuid!))
      await run.done
      expect(q.inputs).toHaveLength(1)
      expect(run.parts.filter((part) => part.type === "error")).toEqual([])
      expect(run.parts.filter((part) => part.type === "finish")).toMatchObject([{ finishReason: { unified: "stop" } }])
    } else {
      await run.done
      expect(restarted.queries).toEqual([])
      expect(run.parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-end", "error", "finish"])
      expect(run.parts[3]).toMatchObject({ type: "error", error: { statusCode: 429, isRetryable: false } })
      expect(run.parts[4]).toMatchObject({ type: "finish", finishReason: { unified: "error" }, providerMetadata: { one: { rateLimit } } })
    }
    expect(run.parts[0]).toMatchObject({ providerMetadata: { one: { backgroundResponseID: response.id, rateLimit } } })
    expect(run.parts[1]).toMatchObject({ type: "text-delta", delta: failed.text })
    expect(h.storage.record().delivery).toEqual([failed])
  }, 2000)

  test.each(["load", "claim"])("disposal during a paused cached delivery %s rejects without emitting", async (phase) => {
    const { h, wake } = await completedSession()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    if (phase === "load") {
      const get = h.storage.get.bind(h.storage)
      h.storage.get = async (key) => {
        const saved = await get(key)
        entered.resolve()
        await release.promise
        return saved
      }
    } else {
      const set = h.storage.set.bind(h.storage)
      h.storage.set = async (key, value) => {
        await set(key, value)
        if (value.delivery) { entered.resolve(); await release.promise }
      }
    }
    const restarted = harness(h.storage)
    const run = restarted.run({ history: [...history, wake] })
    await entered.promise
    await restarted.runtime.dispose()
    release.resolve()
    await expect(run.done).rejects.toThrow("unloaded")
    expect(run.parts).toEqual([])
    expect(restarted.queries).toEqual([])
  }, 2000)

  test("distinct report IDs with identical text are each delivered once", async () => {
    const { h, q, response, wake } = await completedSession()
    const second = { ...wake, id: "second-wake", metadata: { fullClaudeAgentBackground: { ...response, id: "second-report" } } }
    const run = h.run({ history: [...history, wake, second] })
    await run.done
    expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([response.text, response.text])
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test.each(["identical", "substring"])("saving only the first report acknowledges only its ID when the second report text is %s", async (kind) => {
    const { h, q, response, wake } = await completedSession()
    const secondResponse = { ...response, id: "second-report", text: kind === "identical" ? response.text : response.text.slice(4) }
    const secondWake = { ...wake, id: "second-wake", metadata: { fullClaudeAgentBackground: secondResponse } }
    const preparedHistory = [...history, wake, secondWake]
    const run = h.request({ history: preparedHistory })
    run.value.emit = (part) => {
      run.parts.push(part)
      if (part.type === "text-start" && part.id === `background-${secondResponse.id}`) throw new Error("host stream closed before second report")
    }
    await expect(h.runtime.run(run.value)).rejects.toThrow("host stream closed before second report")
    const saved = [...preparedHistory, { id: "first-report-only", type: "assistant", model: { providerID: "one" }, finish: "stop",
      content: [{ type: "text", text: response.text, native: { backgroundResponseID: response.id } }] }]
    await h.runtime.checkpoint("session", async () => saved)
    expect(h.storage.record().delivery).toEqual([secondResponse])
    const restarted = harness(h.storage)
    const retry = restarted.run({ history: saved })
    await retry.done
    expect(retry.parts.filter((part) => part.type === "text-start")).toEqual([
      expect.objectContaining({ id: `background-${secondResponse.id}`, providerMetadata: { one: { backgroundResponseID: secondResponse.id } } }),
    ])
    expect(retry.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([secondResponse.text])
    expect(restarted.queries).toEqual([])
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test.each(["missing marker", "unknown marker", "partial text", "extra text"])("a saved host reply with %s does not acknowledge a cached report", async (kind) => {
    const { h, response, wake } = await completedSession()
    await h.run({ history: [...history, wake] }).done
    const native = kind === "missing marker" ? undefined : { backgroundResponseID: kind === "unknown marker" ? "unknown-report" : response.id }
    const text = kind === "partial text" ? response.text.slice(0, -1) : kind === "extra text" ? `${response.text} Extra` : response.text
    const saved = [...history, wake, { id: "unacknowledged-report", type: "assistant", model: { providerID: "one" }, finish: "stop",
      content: [{ type: "text", text, ...(native ? { native } : {}) }] }]
    await h.runtime.checkpoint("session", async () => saved)
    expect(h.storage.record().delivery).toEqual([response])
    const restarted = harness(h.storage)
    const retry = restarted.run({ history: saved })
    await retry.done
    expect(retry.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([response.text])
    expect(restarted.queries).toEqual([])
  }, 2000)

  test("a failed background notice batch is retained and retried without another SDK result", async () => {
    const retried = Promise.withResolvers<void>()
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    let attempts = 0
    try {
      const h = harness(new MemoryStorage(), true, async () => {
        if (attempts++ === 0) throw new Error("publisher temporarily unavailable")
        retried.resolve()
      })
      const run = h.run()
      const q = await h.opened.take()
      const input = await q.input.take()
      await q.send({ ...result("autonomous-cycle"), uuid: "retry-result", result: "Report must survive rejection" })
      await q.send(result(input.uuid!))
      await run.done
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([retried.promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Failed background notice was not retried within 3 seconds")), 3000)
        })])
      } finally { clearTimeout(timer) }
      expect(attempts).toBe(2)
      expect(h.notices).toHaveLength(2)
      expect(h.notices[1]).toEqual(h.notices[0])
      expect(h.notices[1]![0]).toMatchObject({ uuid: "retry-result", result: "Report must survive rejection" })
      expect(q.inputs).toHaveLength(1)
    } finally { errorLog.mockRestore() }
  }, 4000)

  test("a root cycle started during a pending turn rejects an unattributed result explicitly", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    await q.input.take()
    await q.send({ ...assistant("unstamped", "Cannot safely attribute"), user_message_uuid: undefined })
    void q.send({ ...result("unused"), user_message_uuid: undefined })
    await expect(run.done).rejects.toThrow("without a prompt UUID")
    expect(run.parts).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.storage.record().outcome).toBe("uncertain")
  }, 2000)

  test("disposal cancels a failed background notice retry", async () => {
    const logged = Promise.withResolvers<void>()
    const errorLog = spyOn(console, "error").mockImplementation(() => { logged.resolve() })
    let attempts = 0
    try {
      const h = harness(new MemoryStorage(), true, async () => {
        attempts++
        throw new Error("publisher unavailable")
      })
      const run = h.run()
      const q = await h.opened.take()
      await q.send(result((await q.input.take()).uuid!))
      await run.done
      await q.send({ ...result("autonomous-cycle"), uuid: "pending-retry" })
      await logged.promise
      q.close()
      await h.runtime.dispose()
      await Bun.sleep(1200)
      expect(attempts).toBe(1)
    } finally { errorLog.mockRestore() }
  }, 2000)

  test("an unattributed cycle started while idle remains background when a typed user arrives mid-cycle", async () => {
    const { h, q } = await completedSession()
    await q.send({ ...assistant("idle-cycle", "Autonomous answer"), user_message_uuid: undefined })
    const run = h.run({ history: [...history, { id: "second", type: "user", content: "Typed follow-up" }],
      prompt: [user("first"), user("Typed follow-up")] })
    const input = await q.input.take()
    await q.send({ ...result("unused"), uuid: "idle-result", user_message_uuid: undefined, result: "Autonomous answer" })
    expect(run.parts).toEqual([])
    expect(h.notices.flat()).toEqual([expect.objectContaining({ uuid: "idle-result", result: "Autonomous answer" })])
    expect(h.storage.record().outcome).toBe("pending")
    await q.send(assistant("typed-answer", "Typed answer"))
    await q.send(result(input.uuid!))
    await run.done
    expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Typed answer"])
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
    expect(q.inputs).toHaveLength(2)
  }, 2000)

  test("duplicate and already checkpointed wakes never enqueue another SDK prompt", async () => {
    const { h, q, response, wake } = await completedSession()
    const duplicated = { ...wake, id: "duplicate-wake" }
    const delivered = h.run({ history: [...history, wake, duplicated] })
    await delivered.done
    expect(delivered.parts.filter((part) => part.type === "text-delta")).toHaveLength(1)
    const saved = [...history, wake, duplicated, { id: "report-reply", type: "assistant", model: { providerID: "one" },
      finish: "stop", content: [{ type: "text", text: response.text, native: { backgroundResponseID: response.id } }] }]
    await h.runtime.checkpoint("session", async () => saved)
    expect(h.storage.record().delivery).toBeUndefined()
    const stale = h.run({ history: saved })
    await stale.done
    expect(stale.parts.filter((part) => part.type === "text-delta")).toEqual([])
    expect(stale.parts.filter((part) => part.type === "finish")).toHaveLength(1)
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("a report mixed with a real user submits only that user once and finishes once", async () => {
    const { h, q, response, wake } = await completedSession()
    const run = h.run({ history: [...history, wake, { id: "second", type: "user", content: "Actual follow-up" }],
      prompt: [user("first"), { role: "assistant", content: [{ type: "text", text: "answer" }] }, user("Actual follow-up")] })
    const input = await q.input.take()
    expect(input.message.content).toEqual([{ type: "text", text: "Actual follow-up" }])
    await q.send(assistant("follow-up-answer", "New answer"))
    await q.send(result(input.uuid!))
    await run.done
    expect(q.inputs).toHaveLength(2)
    expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([response.text, "New answer"])
    expect(run.parts.filter((part) => part.type === "finish")).toEqual([expect.objectContaining({ usage: {
      inputTokens: { total: 14, noCache: 14, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 23 },
    } })])
  }, 2000)

  test.each(["providerID", "nativeID", "binding"] as const)("rejects a cached report with a different %s before emission", async (field) => {
    const { h, q, response, wake } = await completedSession()
    const run = h.run({ history: [...history, { ...wake, metadata: { fullClaudeAgentBackground: { ...response, [field]: "other" } } }] })
    await expect(run.done).rejects.toThrow("another Claude session or configuration")
    expect(run.parts).toEqual([])
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("a failed delivery claim emits no answer and submits no SDK prompt", async () => {
    const { h, q, wake } = await completedSession()
    const set = h.storage.set.bind(h.storage)
    h.storage.set = async (key, value) => {
      if (value.delivery) throw new Error("delivery storage unavailable")
      await set(key, value)
    }
    const run = h.run({ history: [...history, wake] })
    await expect(run.done).rejects.toThrow("delivery storage unavailable")
    expect(run.parts).toEqual([])
    expect(q.inputs).toHaveLength(1)
    expect(h.storage.record().delivery).toBeUndefined()
  }, 2000)

  test.each(["partial", "cancelled", "cancelled during emission"])("a %s host delivery retains the complete report for a fresh-runtime retry", async (kind) => {
    const { h, q, response, wake } = await completedSession()
    const run = h.request({ history: [...history, wake] })
    if (kind === "partial") run.value.emit = (part) => {
      run.parts.push(part)
      if (part.type === "text-delta") throw new Error("host stream closed")
    }
    else if (kind === "cancelled during emission") run.value.emit = (part) => {
      run.parts.push(part)
      if (part.type === "text-delta") run.controller.abort(new Error("delivery cancelled"))
    }
    else {
      const set = h.storage.set.bind(h.storage)
      h.storage.set = async (key, value) => {
        await set(key, value)
        if (value.delivery) run.controller.abort(new Error("delivery cancelled"))
      }
    }
    await expect(h.runtime.run(run.value)).rejects.toThrow(kind === "partial" ? "host stream closed" : "delivery cancelled")
    expect(run.parts.filter((part) => part.type === "finish")).toEqual([])
    expect(h.storage.record().delivery).toEqual([response])
    expect(q.inputs).toHaveLength(1)
    const saved = [...history, wake, { id: "partial-reply", type: "assistant", model: { providerID: "one" },
      finish: "stop", content: [{ type: "text", text: "The complete", native: { backgroundResponseID: response.id } }] }]
    await h.runtime.checkpoint("session", async () => saved)
    expect(h.storage.record().delivery).toEqual([response])
    const restarted = harness(h.storage)
    const retry = restarted.run({ history: saved })
    await retry.done
    expect(restarted.queries).toEqual([])
    expect(retry.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([response.text])
    expect(retry.parts.filter((part) => part.type === "finish")).toHaveLength(1)
  }, 2000)

  test("autonomous root frames while a typed request is pending are delivered only through the background notice", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send({ ...assistant("autonomous", "Saved background answer"), user_message_uuid: undefined })
    await q.send({ ...result("autonomous-cycle"), uuid: "autonomous-result", result: "Saved background answer" })
    expect(run.parts).toEqual([])
    expect(h.notices.flat()).toEqual([expect.objectContaining({ uuid: "autonomous-result", result: "Saved background answer" })])
    await q.send(assistant("typed", "Typed answer"))
    await q.send(result(input.uuid!))
    await run.done
    expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Typed answer"])
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("a synthetic SDK cycle can absorb the typed user UUID before its result", async () => {
    const h = harness()
    const run = h.run()
    const q = await h.opened.take()
    const input = await q.input.take()
    await q.send({ ...assistant("synthetic-start", "Combined "), user_message_uuid: "synthetic-cycle" })
    expect(run.parts).toEqual([])
    await q.send({ ...assistant("absorbed", "answer"), user_message_uuid: undefined, user_message_uuids: ["synthetic-cycle", input.uuid] })
    await q.send({ ...result("synthetic-cycle"), user_message_uuids: ["synthetic-cycle", input.uuid] })
    await run.done
    expect(run.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Combined ", "answer"])
    expect(run.parts.filter((part) => part.type === "finish")).toHaveLength(1)
    expect(h.notices).toEqual([])
    expect(q.inputs).toHaveLength(1)
  }, 2000)

  test("delivers a completed native background answer without another Claude submission", async () => {
    const h = harness()
    const first = h.run()
    const q = await h.opened.take()
    await q.send(result((await q.input.take()).uuid!))
    await first.done
    await q.send(assistant("research-answer", "The research is complete."))
    await q.send({ ...result("native-notification"), uuid: "background-result", result: "The research is complete." })
    const delivery = h.run({ history: [...history, { id: "wake", type: "synthetic", text: "Deliver native background response",
      metadata: { fullClaudeAgentBackground: { id: "background-result", providerID: "one", nativeID: h.storage.record().nativeID,
        binding: h.storage.record().binding, text: "The research is complete.", usage: emptyUsage() } } }] })
    await delivery.done
    expect(delivery.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["The research is complete."])
    expect(q.inputs).toHaveLength(1)
  }, 2000)

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
    expect(run.parts).toContainEqual(expect.objectContaining({ type: "tool-call", toolCallId: "wait", toolName: "shell", providerExecuted: true }))
    expect(run.parts).toContainEqual(expect.objectContaining({ type: "tool-result", toolCallId: "wait", toolName: "shell", isError: true,
      result: "Native command not observed\n\n--- Native output ---\nCommand stopped while running" }))
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

  test.each([false, true])("mapped Bash history continues without replay after runtime restart=%s", async (restart) => {
    const first = harness()
    const run = first.run()
    const q = await first.opened.take()
    const initial = await q.input.take()
    const nativeInput = { command: "printf once", description: "One native command" }
    await q.send({ type: "assistant", parent_tool_use_id: null, message: { id: "bash-answer", content: [
      { type: "tool_use", id: "native-bash", name: "Bash", input: nativeInput },
    ] } })
    await observeBash(q, first.storage.record().nativeID, "native-bash", "printf modified")
    await q.send({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "native-bash", content: "once" },
    ] } })
    await q.send(result(initial.uuid!))
    await run.done
    const call = run.parts.find((part) => part.type === "tool-call")!
    const output = run.parts.find((part) => part.type === "tool-result")!
    expect(call).toMatchObject({ toolName: "shell", providerExecuted: true })
    expect(JSON.parse(call.input).command).toBe("# Requested by Claude\nprintf once")
    expect(output.toolName).toBe("shell")
    expect(output.result).toContain("Native command (observed): printf modified")
    expect(output.result).toContain("--- Native output ---\nonce")
    const displayInput = JSON.parse(call.input)
    const saved: HistoryEntry[] = [history[0]!, {
      id: "bash-host-answer", type: "assistant", model: { providerID: "one" }, finish: "stop",
      content: [{ type: "tool", id: call.toolCallId, tool: call.toolName, input: displayInput,
        state: { status: "completed", output: output.result }, native: call.providerMetadata?.one }],
    }]
    await first.runtime.checkpoint("session", async () => saved)
    const nativeID = first.storage.record().nativeID
    const active = restart ? harness(first.storage) : first
    if (restart) await first.runtime.dispose()
    const prompt: LanguageModelV3Prompt = [user("first"),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId,
        toolName: call.toolName, input: displayInput }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId,
        toolName: call.toolName, output: { type: "text", value: String(output.result) } }] },
      user("second"),
    ]
    const resumed = active.run({ history: [...saved, { id: "u2", type: "user", content: "second" }], prompt })
    const nextQuery = restart ? await active.opened.take() : q
    const next = await nextQuery.input.take()
    expect(next.message.content).toEqual([{ type: "text", text: "second" }])
    if (restart) expect(nextQuery.args.options.resume).toBe(nativeID)
    await nextQuery.send(result(next.uuid!))
    await resumed.done
    expect(nextQuery.inputs).toHaveLength(restart ? 1 : 2)
    expect(resumed.parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(first.storage.record().nativeID).toBe(nativeID)
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
