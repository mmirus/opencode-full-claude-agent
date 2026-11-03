import { describe, expect, mock, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createInteractions } from "../src/interactions"
import { Effect, Schema } from "effect"

class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

function fixture() {
  const assert = mock(async (_input: unknown) => {})
  const execute = mock(async (_input: unknown, _context: unknown) => ({ output: { answers: [["A", "Other text"], ["Yes"]] } }))
  const list = mock(async () => [{ id: "question", execute }])
  const context = mock(async () => [{ type: "assistant", id: "msg_assistant-1" }, { type: "user", id: "msg_user-2" }, { type: "assistant", id: "msg_assistant-3" }])
  const get = mock(async () => ({ agent: "review" as string | undefined }))
  const ctx = { permission: { assert }, tool: { list }, session: { context, get } } as unknown as Plugin.Context
  const controller = new AbortController()
  const callback = new AbortController()
  const { canUseTool } = createInteractions(ctx, "session-1", controller.signal)
  const options = { signal: callback.signal, toolUseID: "native-call-1", requestId: "request-1" }
  return { assert, execute, list, context, get, controller, callback, options, canUseTool }
}

const input = {
  questions: [
    { header: "Choose", question: "Which?", options: [{ label: "A", description: "First" }], multiSelect: true },
    { header: "Confirm", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }], multiSelect: false },
  ],
}

describe("native interactions", () => {
  test("maps question inputs, answer text, and actual executor identity", async () => {
    const f = fixture()
    expect(await f.canUseTool("AskUserQuestion", input, f.options)).toEqual({
      behavior: "allow", updatedInput: { ...input, answers: { "Which?": "A, Other text", "Continue?": "Yes" } },
    })
    expect(f.execute).toHaveBeenCalledWith({ questions: input.questions.map(({ multiSelect, ...question }) => ({ ...question, multiple: multiSelect })) }, {
      sessionID: "session-1", agent: "review", messageID: "msg_assistant-3", id: "native-call-1", signal: expect.any(AbortSignal), progress: expect.any(Function),
    })
    expect(f.assert).not.toHaveBeenCalled()
    expect(input).not.toHaveProperty("answers")
  })

  test("uses build when the session has no agent", async () => {
    const f = fixture()
    f.get.mockResolvedValue({ agent: undefined })
    await f.canUseTool("AskUserQuestion", input, f.options)
    expect(f.execute.mock.calls[0]![1]).toMatchObject({ agent: "build" })
  })

  test("denies questions without an assistant message rather than inventing an ID", async () => {
    const f = fixture()
    f.context.mockResolvedValue([{ type: "user", id: "user-1" }])
    expect(await f.canUseTool("AskUserQuestion", input, f.options)).toMatchObject({ behavior: "deny", message: expect.stringContaining("assistant message") })
    expect(f.execute).not.toHaveBeenCalled()
  })

  test("denies unavailable question tools and rejected questions", async () => {
    const f = fixture()
    f.list.mockResolvedValueOnce([])
    expect(await f.canUseTool("AskUserQuestion", input, f.options)).toMatchObject({ behavior: "deny" })
    f.execute.mockRejectedValueOnce(new Error("Question dismissed"))
    expect(await f.canUseTool("AskUserQuestion", input, f.options)).toMatchObject({ behavior: "deny", message: "Question dismissed" })
  })

  test.each([
    ["Bash", { command: "pwd" }, "shell", "pwd"],
    ["Read", { file_path: "/file" }, "read", "/file"],
    ...["Edit", "Write", "MultiEdit"].map((tool) => [tool, { file_path: "/file" }, "edit", "/file"] as const),
    ["NotebookEdit", { notebook_path: "/notebook" }, "edit", "/notebook"],
    ["ExitPlanMode", { plan: "Review" }, "claude.ExitPlanMode", "ExitPlanMode"],
    ["CustomTool", {}, "claude.CustomTool", "CustomTool"],
  ] as const)("routes %s through permission.assert", async (tool, nativeInput, action, resource) => {
    const f = fixture()
    expect(await f.canUseTool(tool, nativeInput, f.options)).toEqual({ behavior: "allow", updatedInput: nativeInput })
    expect(f.assert).toHaveBeenCalledWith({ sessionID: "session-1", action, resources: [resource], metadata: { toolName: tool, input: nativeInput } })
    expect(f.execute).not.toHaveBeenCalled()
  })

  test("returns permission denials with feedback", async () => {
    const f = fixture()
    f.assert.mockRejectedValueOnce(new Error("Do not run this command"))
    expect(await f.canUseTool("Bash", { command: "pwd" }, f.options)).toEqual({ behavior: "deny", message: "Do not run this command" })
  })

  test("supplies a nonempty native denial reason for OpenCode's plain rejection", async () => {
    const f = fixture()
    f.assert.mockImplementation(() => Effect.runPromise(Effect.die(new DeclinedError())))
    expect(await f.canUseTool("Write", { file_path: "/test", content: "test" }, f.options)).toEqual({
      behavior: "deny", message: "Tool request denied by OpenCode.",
    })
  })

  test.each(["", " \n\t"])("never sends blank denial feedback %j to Claude", async (message) => {
    const f = fixture()
    f.assert.mockRejectedValueOnce(new Error(message))
    expect(await f.canUseTool("Write", { file_path: "/test", content: "test" }, f.options)).toEqual({
      behavior: "deny", message: "Tool request denied by OpenCode.",
    })
  })

  for (const scope of ["controller", "callback"] as const) {
    test(`denies promptly on ${scope} abort and ignores late permission approval`, async () => {
      const f = fixture()
      let approve!: () => void
      f.assert.mockImplementation(() => new Promise<void>((resolve) => { approve = resolve }))
      const pending = f.canUseTool("Bash", { command: "pwd" }, f.options)
      await Promise.resolve()
      f[scope].abort()
      expect(await pending).toMatchObject({ behavior: "deny", message: "Tool request aborted" })
      approve()
      await Promise.resolve()
      expect(f.execute).not.toHaveBeenCalled()
    })
  }

  test("handles a late rejected permission without an unhandled rejection", async () => {
    const f = fixture()
    let reject!: (error: Error) => void
    f.assert.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const pending = f.canUseTool("Bash", { command: "pwd" }, f.options)
    await Promise.resolve()
    f.callback.abort()
    expect(await pending).toMatchObject({ behavior: "deny" })
    reject(new Error("Late rejection"))
    await Promise.resolve()
  })

  test("does not start work after a preexisting abort", async () => {
    const f = fixture()
    f.controller.abort()
    expect(await f.canUseTool("Bash", { command: "pwd" }, f.options)).toMatchObject({ behavior: "deny" })
    expect(f.assert).not.toHaveBeenCalled()
  })

  test("does not execute a question after cancellation during context lookup", async () => {
    const f = fixture()
    f.context.mockImplementation(async () => { f.callback.abort(); return [{ type: "assistant", id: "assistant-1" }] })
    expect(await f.canUseTool("AskUserQuestion", input, f.options)).toMatchObject({ behavior: "deny" })
    expect(f.execute).not.toHaveBeenCalled()
  })

  test("cancels an executing question and ignores late answers", async () => {
    const f = fixture()
    let finish!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    f.execute.mockImplementation(() => {
      started()
      return new Promise((resolve) => { finish = () => resolve({ output: { answers: [["Late"], ["Yes"]] } }) })
    })
    const pending = f.canUseTool("AskUserQuestion", input, f.options)
    await ready
    f.callback.abort()
    expect(await pending).toMatchObject({ behavior: "deny" })
    expect((f.execute.mock.calls[0]![1] as { signal: AbortSignal }).signal.aborted).toBe(true)
    finish()
    await Promise.resolve()
  })
})
