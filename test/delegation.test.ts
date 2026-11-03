import { describe, expect, mock, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createDelegation } from "../src/delegation"

const input = { model: "openai-work/chat-pro#high", prompt: "Review the fixture", description: "Review fixture" }

function fixture() {
  const models: { providerID: string; id: string; name: string; type?: string; variants: { id: string }[]; modelID?: string; options?: { account: string; apiKey: string }; cost?: { input: number } }[] = [
    { providerID: "openai-work", id: "chat-pro", modelID: "upstream-pro", name: "Chat Pro", variants: [{ id: "high" }], options: { account: "work", apiKey: "synthetic-secret" }, cost: { input: 123 } },
    { providerID: "openai-personal", id: "chat-pro", name: "Chat Pro", type: "chat", variants: [] },
    { providerID: "other", id: "image", name: "Image Pro", type: "image", variants: [] },
    { providerID: "other", id: "decision", name: "Decision Pro", type: "decision", variants: [] },
  ]
  const modelList = mock(async () => ({ data: models }))
  const providerList = mock(async () => ({ data: [{ id: "openai-work", name: "Example Business" }, { id: "openai-personal", name: "Example Personal" }] }))
  const execute = mock(async (_input: unknown, _context: unknown): Promise<unknown> => ({ output: { status: "completed", sessionID: "session-child", output: "Reviewed" } }))
  const search = mock(async (_input: unknown, _context: unknown): Promise<unknown> => ({ output: {
    providers: [{ id: "openai-work", name: "Example Business", models: [{ id: "openai-work/chat-pro", name: "Chat Pro", released: 123, status: "active", variants: ["high"], cost: { input: 123 }, options: { apiKey: "synthetic-secret" } }] }], total: 1, next: null,
  } }))
  const toolList = mock(async () => [{ id: "subagent", execute }, { id: "opencode_models", execute: search }])
  const context = mock(async () => [{ type: "assistant", id: "msg_first" }, { type: "user", id: "msg_user" }, { type: "assistant", id: "msg_current" }])
  const get = mock(async () => ({ agent: "review" as string | undefined }))
  const interrupt = mock(async (_input: unknown) => {})
  const remove = mock(async (_input: unknown) => {})
  const ctx = { model: { list: modelList }, provider: { list: providerList }, tool: { list: toolList }, session: { context, get, interrupt, remove } } as unknown as Plugin.Context
  const controller = new AbortController()
  return { ...createDelegation(ctx, "session-parent", controller.signal), ctx, controller, modelList, providerList, execute, search, toolList, context, get, interrupt, remove }
}

describe("delegation models", () => {
  test("returns exact base refs with nested full variant refs without options or costs", async () => {
    const f = fixture()
    expect(await f.listModels({}, "native-search")).toEqual({
      models: [
        { model: "openai-work/chat-pro", name: "Chat Pro", providerID: "openai-work", providerName: "Example Business", released: 123, status: "active", variants: [input.model] },
      ], total: 1, truncated: false, next: null,
    })
    expect(f.modelList).not.toHaveBeenCalled()
    expect(f.providerList).not.toHaveBeenCalled()
  })

  test("uses native newest-family selection rather than flattening 46 raw matches", async () => {
    const f = fixture()
    const model = (await f.modelList()).data[0]!
    f.modelList.mockResolvedValue({ data: ["gpt-5.6-sol", "gpt-6-sol"].map((id) => ({ ...model, id, name: id, variants: Array.from({ length: 22 }, (_, i) => ({ id: `variant-${i}` })) })) })
    f.modelList.mockClear()
    f.search.mockResolvedValue({ output: { providers: [{ id: "openai", name: "OpenAI", models: [{ id: "openai/gpt-6.1-sol", name: "GPT 6.1 Sol", released: 999, status: "active", variants: ["high"] }] }], total: 1, next: null } })
    const result = await f.listModels({ query: "Sol" }, "native-search")
    expect(result.models.map((model) => model.model)).toEqual(["openai/gpt-6.1-sol"])
    expect(f.search.mock.calls[0]![0]).toEqual({ type: "chat", query: "Sol" })
    expect(f.modelList).not.toHaveBeenCalled()
  })

  test("forwards explicit historical search and pagination with actual invocation context", async () => {
    const f = fixture()
    const query = { query: "gpt-5.6-sol", provider: "OPENAI-WORK", all: true, limit: 7, offset: 3 }
    await f.listModels(query, "native-search")
    expect(f.search).toHaveBeenCalledWith({ type: "chat", ...query }, {
      sessionID: "session-parent", agent: "review", messageID: "msg_current", id: "native-search",
      signal: f.controller.signal, progress: expect.any(Function),
    })
    expect(f.context).toHaveBeenCalledWith({ sessionID: "session-parent" })
    expect(f.get).toHaveBeenCalledWith({ sessionID: "session-parent" })
    f.get.mockResolvedValue({ agent: undefined })
    await f.listModels({ all: false, offset: 0 }, "next-search")
    expect(f.search.mock.calls[1]![0]).toEqual({ type: "chat", all: false, offset: 0 })
    expect(f.search.mock.calls[1]![1]).toMatchObject({ agent: "build", id: "next-search" })
  })

  test("preserves host order and pagination without letting variants consume model slots", async () => {
    const f = fixture()
    const variants = Array.from({ length: 30 }, (_, i) => `effort-${i}`)
    const models = Array.from({ length: 20 }, (_, i) => ({ id: `z-work/chat-${20 - i}`, name: "Chat", released: 100 - i, status: "deprecated", variants }))
    f.search.mockResolvedValue({ output: { providers: [{ id: "z-work", name: "Work", models }], total: 25, next: 20 } })
    const result = await f.listModels({}, "native-search")
    expect(result).toMatchObject({ total: 25, truncated: true, next: 20 })
    expect(result.models).toHaveLength(20)
    expect(result.models.map((model) => model.model)).toEqual(models.map((model) => model.id))
    expect(result.models[0]!.variants).toEqual(variants.map((variant) => `z-work/chat-20#${variant}`))
    f.search.mockResolvedValue({ output: { providers: [{ id: "z", name: "Z", models: [{ ...models[0], id: "z/new" }] }, { id: "a", name: "A", models: [{ ...models[0], id: "a/old" }] }], total: 25, next: null } })
    expect(await f.listModels({ offset: 23 }, "last-search")).toMatchObject({ models: [{ model: "z/new" }, { model: "a/old" }], total: 25, next: null, truncated: false })
  })

  test("accepts an empty native page", async () => {
    const f = fixture()
    f.search.mockResolvedValue({ output: { providers: [], total: 0, next: null } })
    expect(await f.listModels({}, "native-search")).toEqual({ models: [], total: 0, next: null, truncated: false })
  })

  test("fails explicitly when native model search is unavailable", async () => {
    const f = fixture()
    f.toolList.mockResolvedValue([{ id: "models", execute: f.search }])
    await expect(f.listModels({}, "native-search")).rejects.toThrow("OpenCode model search tool is unavailable")
    expect(f.search).not.toHaveBeenCalled()
  })

  test("requires real assistant and native call IDs", async () => {
    const f = fixture()
    await expect(f.listModels({}, " ")).rejects.toThrow("native tool-use ID")
    f.context.mockResolvedValue([{ type: "user", id: "msg_user" }])
    await expect(f.listModels({}, "native-search")).rejects.toThrow("assistant message")
    expect(f.search).not.toHaveBeenCalled()
  })

  test.each([new Error("Denied"), { message: "Unavailable" }, "Search failed", new Error(" "), undefined])("surfaces nonempty native search errors %j", async (error) => {
    const f = fixture()
    f.search.mockRejectedValue(error)
    await expect(f.listModels({}, "native-search")).rejects.toThrow(typeof error === "string" ? error : error?.message.trim() || "OpenCode delegation failed")
  })

  test.each([undefined, {}, { providers: [], total: -1, next: null }, { providers: [], total: 0 }, { providers: [], total: 0, next: "20" }])("rejects malformed native output %j", async (output) => {
    const f = fixture()
    f.search.mockResolvedValue({ output })
    await expect(f.listModels({}, "native-search")).rejects.toThrow("invalid model search result")
  })

  test.each([
    { id: "wrong/chat-pro" }, { id: "chat-pro" }, { id: "openai-work/chat-pro#high" },
    { name: 42 }, { released: "today" }, { status: null }, { variants: ["high#extra"] }, { variants: [""] },
  ])("rejects malformed native model entry %j", async (change) => {
    const f = fixture()
    f.search.mockResolvedValue({ output: { providers: [{ id: "openai-work", name: "Work", models: [{ id: "openai-work/chat-pro", name: "Chat", released: 123, status: "active", variants: ["high"], ...change }] }], total: 1, next: null } })
    await expect(f.listModels({}, "native-search")).rejects.toThrow("invalid model search result")
  })
})

describe("foreground delegation", () => {
  test("uses core executor, actual assistant and actor, exact profile ref, and native call ID", async () => {
    const f = fixture()
    expect(await f.delegate(input, "native-call")).toEqual({ sessionID: "session-child", model: input.model, output: "Reviewed" })
    expect(f.execute).toHaveBeenCalledWith({ ...input, agent: "general", background: false }, {
      sessionID: "session-parent", agent: "review", messageID: "msg_current", id: "native-call",
      signal: f.controller.signal, progress: expect.any(Function),
    })
    expect(f.context).toHaveBeenCalledWith({ sessionID: "session-parent" })
    expect(f.get).toHaveBeenCalledWith({ sessionID: "session-parent" })
    expect(f.providerList).not.toHaveBeenCalled()
    const context = f.execute.mock.calls[0]![1] as { progress: (value: unknown) => Promise<void> }
    await expect(context.progress({ status: "running" })).resolves.toBeUndefined()
    expect(f.interrupt).not.toHaveBeenCalled()
  })

  test("allows a selected agent and falls back only for the current actor", async () => {
    const f = fixture()
    f.get.mockResolvedValue({ agent: undefined })
    await f.delegate({ ...input, agent: "explore", model: "openai-personal/chat-pro" }, "native-call")
    expect(f.execute.mock.calls[0]![0]).toMatchObject({ agent: "explore", model: "openai-personal/chat-pro", background: false })
    expect(f.execute.mock.calls[0]![1]).toMatchObject({ agent: "build" })
  })

  test.each(["missing", "openai-work/missing", "other/image", "other/decision", "openai-work/chat-pro#unknown", "openai-personal/chat-pro#high"])("rejects unavailable model or variant %s without fallback", async (model) => {
    const f = fixture()
    await expect(f.delegate({ ...input, model }, "native-call")).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
  })

  test("rejects a missing core tool", async () => {
    const f = fixture()
    f.toolList.mockResolvedValue([])
    await expect(f.delegate(input, "native-call")).rejects.toThrow("subagent tool is unavailable")
    expect(f.execute).not.toHaveBeenCalled()
  })

  test("does not invent assistant or native call IDs", async () => {
    const f = fixture()
    await expect(f.delegate(input, " ")).rejects.toThrow("native tool-use ID")
    f.context.mockResolvedValue([{ type: "user", id: "msg_user" }])
    await expect(f.delegate(input, "native-call")).rejects.toThrow("assistant message")
    expect(f.execute).not.toHaveBeenCalled()
  })

  test("reports manual backgrounding rather than claiming completion", async () => {
    const f = fixture()
    f.execute.mockResolvedValue({ output: { status: "running", sessionID: "session-child", output: "Still working" } })
    await expect(f.delegate(input, "native-call")).rejects.toThrow("running in the background (sessionID: session-child)")
    expect(f.interrupt).toHaveBeenCalledWith({ sessionID: "session-child", resume: false })
    expect(f.remove).not.toHaveBeenCalled()
  })

  test("reports a failed background-child interrupt with the child ID", async () => {
    const f = fixture()
    f.execute.mockResolvedValue({ output: { status: "running", sessionID: "session-child", output: "Still working" } })
    f.interrupt.mockRejectedValue(new Error("Host unavailable"))
    await expect(f.delegate(input, "native-call")).rejects.toThrow("Failed to interrupt delegated child (sessionID: session-child); interrupt this session before retrying: Host unavailable")
  })

  test.each([undefined, {}, { content: "reply" }, { output: {} }, { output: { status: "completed", sessionID: "", output: "reply" } }, { output: { status: "completed", sessionID: "child", output: 1 } }, { output: { status: "completed", sessionID: "child", output: " " } }, { output: { status: "failed", sessionID: "child", output: "failed" } }])("rejects malformed result %j", async (result) => {
    const f = fixture()
    f.execute.mockResolvedValue(result)
    await expect(f.delegate(input, "native-call")).rejects.toThrow("invalid completed result")
  })

  test.each([new Error("Permission denied"), { message: "Depth exceeded" }, "Core failure", new Error(" "), undefined])("surfaces nonempty executor errors %j", async (error) => {
    const f = fixture()
    f.execute.mockRejectedValue(error)
    const message = typeof error === "string" ? error : error?.message.trim() || "OpenCode delegation failed"
    await expect(f.delegate(input, "native-call")).rejects.toThrow(message)
  })
})

describe("delegation cancellation", () => {
  test("rejects pre-aborted calls without lookups", async () => {
    const f = fixture()
    f.controller.abort(new Error("Stopped"))
    await expect(f.delegate(input, "native-call")).rejects.toThrow("Stopped")
    await expect(f.listModels({}, "native-search")).rejects.toThrow("Stopped")
    expect(f.modelList).not.toHaveBeenCalled()
    expect(f.interrupt).not.toHaveBeenCalled()
  })

  for (const lookup of ["modelList", "toolList", "context", "get"] as const) {
    test(`checks cancellation after ${lookup}`, async () => {
      const f = fixture()
      const original = f[lookup].getMockImplementation()!
      f[lookup].mockImplementation((async () => {
        const result = await original()
        f.controller.abort(new Error("Stopped during lookup"))
        return result
      }) as never)
      await expect(f.delegate(input, "native-call")).rejects.toThrow("Stopped during lookup")
      expect(f.execute).not.toHaveBeenCalled()
      expect(f.interrupt).not.toHaveBeenCalled()
    })
  }

  test("rejects a pending lookup on abort", async () => {
    const f = fixture()
    const started = Promise.withResolvers<void>()
    f.modelList.mockImplementation(() => { started.resolve(); return new Promise(() => {}) })
    const pending = f.delegate(input, "native-call")
    await started.promise
    f.controller.abort(new Error("Stopped pending lookup"))
    await expect(pending).rejects.toThrow("Stopped pending lookup")
    expect(f.execute).not.toHaveBeenCalled()
  })

  test("passes cancellation to the executing child", async () => {
    const f = fixture()
    const started = Promise.withResolvers<void>()
    const cleaned = Promise.withResolvers<void>()
    f.interrupt.mockImplementation(async () => { cleaned.resolve() })
    let interrupted = false
    f.execute.mockImplementation(async (_input, context) => {
      const { signal, progress } = context as { signal: AbortSignal; progress: (update: unknown) => Promise<void> }
      await progress({ sessionID: "session-executing-child", status: "running" })
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { interrupted = true; reject(signal.reason) }, { once: true })
        started.resolve()
      })
    })
    const pending = f.delegate(input, "native-call")
    await started.promise
    f.controller.abort(new Error("Stopped child"))
    await expect(pending).rejects.toThrow("Stopped child")
    expect(interrupted).toBe(true)
    await cleaned.promise
    expect(f.interrupt).toHaveBeenCalledWith({ sessionID: "session-executing-child", resume: false })
    expect(f.remove).not.toHaveBeenCalled()
  })

  for (const outcome of ["resolve", "reject"] as const) {
    test(`interrupts the progress-reported child after prompt admission ${outcome}s following cancellation`, async () => {
      const f = fixture()
      const started = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      const executorFinalizers = Promise.withResolvers<void>()
      const cleaned = Promise.withResolvers<void>()
      const cleanup = Promise.withResolvers<void>()
      f.interrupt.mockImplementation(async () => { cleaned.resolve(); await cleanup.promise })
      f.execute.mockImplementation(async (_input, context) => {
        const { progress, signal } = context as { progress: (update: unknown) => Promise<void>; signal: AbortSignal }
        await progress({ sessionID: "session-prompt-admission", status: "running" })
        const cancellation = new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.resolve(); resolve() }, { once: true }))
        started.resolve()
        await cancellation
        await executorFinalizers.promise
        if (outcome === "reject") throw signal.reason
        return {}
      })
      const pending = f.delegate(input, "native-call")
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      await started.promise
      f.controller.abort(new Error("Stopped during admission"))
      await aborted.promise
      expect(settled).toBe(false)
      expect(f.interrupt).not.toHaveBeenCalled()
      executorFinalizers.resolve()
      await cleaned.promise
      expect(settled).toBe(false)
      expect(f.interrupt).toHaveBeenCalledTimes(1)
      expect(f.interrupt).toHaveBeenCalledWith({ sessionID: "session-prompt-admission", resume: false })
      expect(f.remove).not.toHaveBeenCalled()
      cleanup.resolve()
      await expect(pending).rejects.toThrow("Stopped during admission")
    })
  }

  test("rejects completion when the executor aborted the request", async () => {
    const f = fixture()
    f.execute.mockImplementation(async () => {
      f.controller.abort(new Error("Stopped at completion"))
      return { output: { status: "completed", sessionID: "session-child", output: "Reply" } }
    })
    await expect(f.delegate(input, "native-call")).rejects.toThrow("Stopped at completion")
    expect(f.interrupt).toHaveBeenCalledWith({ sessionID: "session-child", resume: false })
    expect(f.remove).not.toHaveBeenCalled()
  })

  for (const lookup of ["toolList", "context", "get", "search"] as const) {
    test(`checks model search cancellation after ${lookup}`, async () => {
      const f = fixture()
      const original = f[lookup].getMockImplementation()!
      f[lookup].mockImplementation((async () => {
        const result = await original(undefined, undefined)
        f.controller.abort(new Error("Stopped search"))
        return result
      }) as never)
      await expect(f.listModels({}, "native-search")).rejects.toThrow("Stopped search")
    })
  }
})
