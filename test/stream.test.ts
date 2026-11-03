import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createStreamConverter } from "../src/stream"

// Fixtures omit unrelated SDK telemetry fields; converter inputs retain their native wire shape.
function message(value: unknown): SDKMessage { return value as SDKMessage }
function event(value: unknown, parent: string | null = null): SDKMessage {
  return message({ type: "stream_event", parent_tool_use_id: parent, event: value })
}
function assistant(id: string, content: unknown[], parent: string | null = null): SDKMessage {
  return message({ type: "assistant", parent_tool_use_id: parent, message: { id, content } })
}
function result(extra: Record<string, unknown> = {}): SDKMessage {
  return message({ type: "result", subtype: "success", is_error: false, result: "done", stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    modelUsage: {}, ...extra })
}
function start(id: string) {
  return event({ type: "message_start", message: { id, model: "claude" } })
}

describe("createStreamConverter", () => {
  test("interruption retains completed native outcomes and closes only unresolved tool calls", () => {
    const converter = createStreamConverter()
    converter.push(assistant("a", [
      { type: "tool_use", id: "done", name: "Bash", input: {} },
      { type: "tool_use", id: "pending", name: "Write", input: {} },
    ]))
    const completed = converter.push(message({ type: "user", parent_tool_use_id: null, message: { content: [
      { type: "tool_result", tool_use_id: "done", content: "Completed before interruption" },
    ] } }))
    expect(completed[0]).toMatchObject({ toolCallId: "done", isError: false })
    const interrupted = converter.interrupt("Provider unloaded.")
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]).toMatchObject({ toolCallId: "pending", isError: true, result: expect.stringContaining("No final native result was received") })
    expect(converter.interrupt("Provider unloaded.")).toEqual([])
    expect(converter.push(result())).toEqual([])
    expect(converter.finish()).toEqual([])
  })

  const editOutput = {
    filePath: "/project/example.txt", originalFile: "before\n", userModified: true,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-before", "+actual change"] }],
  }

  test("carries authoritative diffs in the active provider namespace without changing canonical tool data", () => {
    const converter = createStreamConverter({ providerID: "full-claude-agent-secondary", directory: "/project" })
    const input = { file_path: "/project/example.txt", old_string: "before", new_string: "proposed change" }
    expect(converter.push(assistant("a", [{ type: "tool_use", id: "edit", name: "Edit", input }]))).toMatchObject([
      { type: "tool-call", toolName: "Edit", input: JSON.stringify(input), providerExecuted: true,
        providerMetadata: { "full-claude-agent-secondary": { parentToolUseId: null } } },
    ])
    const parts = converter.push(message({ type: "user", parent_tool_use_id: null, tool_use_result: editOutput,
      message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "Native edit completed" }] } }))
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "tool-result", toolName: "Edit", result: "Native edit completed", isError: false,
      providerMetadata: { "full-claude-agent-secondary": { experimental: { fileDiffs: [{ file: "example.txt", additions: 1, deletions: 1, status: "modified" }] } } } })
    const rendered = JSON.stringify(parts[0])
    expect(rendered).toContain("+actual change")
    expect(rendered).not.toContain("proposed change")
    expect(parts.some((part) => part.type === "text-delta")).toBe(false)
  })

  test.each(["Edit", "Write"])("does not attach diff metadata to denied %s calls", (name) => {
    const converter = createStreamConverter({ providerID: "full-claude-agent", directory: "/project" })
    converter.push(assistant("a", [{ type: "tool_use", id: "edit", name, input: {} }]))
    const parts = converter.push(message({ type: "user", parent_tool_use_id: null, tool_use_result: { ...editOutput, type: "update", content: "actual change\n" },
      message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "Denied", is_error: true }] } }))
    expect(parts).toEqual([{ type: "tool-result", toolCallId: "edit", toolName: name, result: "Denied", isError: true }])
  })

  test("does not attribute a shared structured result to multiple tool results", () => {
    const converter = createStreamConverter({ providerID: "full-claude-agent", directory: "/project" })
    converter.push(assistant("a", ["first", "second"].map((id) => ({ type: "tool_use", id, name: "Edit", input: {} }))))
    const parts = converter.push(message({ type: "user", parent_tool_use_id: null, tool_use_result: editOutput,
      message: { content: ["first", "second"].map((id) => ({ type: "tool_result", tool_use_id: id, content: "done" })) } }))
    expect(parts).toHaveLength(2)
    for (const part of parts) expect(part).not.toHaveProperty("providerMetadata")
  })

  test("keeps native subagent diffs attached to their namespaced tool ID", () => {
    const converter = createStreamConverter({ providerID: "full-claude-agent", directory: "/project" })
    const call = converter.push(assistant("child", [{ type: "tool_use", id: "edit", name: "Edit", input: {} }], "agent"))[0]!
    const parts = converter.push(message({ type: "user", parent_tool_use_id: "agent", tool_use_result: editOutput,
      message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "done" }] } }))
    if (call.type !== "tool-call" || parts[0]?.type !== "tool-result") throw new Error("Missing native tool events")
    expect(parts[0].toolCallId).toBe(call.toolCallId)
    expect(parts[0].providerMetadata).toMatchObject({ "full-claude-agent": { experimental: { fileDiffs: [{ file: "example.txt" }] } } })
  })

  test("streams reasoning and text with distinct block IDs across Stop-hook continuation", () => {
    const converter = createStreamConverter()
    const parts = ["first", "continued"].flatMap((id) => [
      start(id),
      event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Think" } }),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "Answer" } }),
      event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "!" } }),
      event({ type: "content_block_stop", index: 1 }),
      event({ type: "message_stop" }),
    ].flatMap((item) => converter.push(item)))
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(0)
    const starts = parts.filter((part) => part.type === "text-start" || part.type === "reasoning-start")
    expect(new Set(starts.map((part) => part.id)).size).toBe(4)
    expect(parts.filter((part) => part.type === "reasoning-delta").map((part) => part.delta)).toEqual(["Think", "Think"])
    expect(converter.push(result()).map((part) => part.type)).toEqual(["finish"])
    expect(converter.finish()).toEqual([])
  })

  test("uses full messages as fallback without repeating streamed text or fallback messages", () => {
    const converter = createStreamConverter()
    converter.push(start("streamed"))
    converter.push(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "hello" } }))
    converter.push(event({ type: "content_block_stop", index: 0 }))
    const full = assistant("streamed", [{ type: "text", text: "hello" }, { type: "tool_use", id: "call", name: "Read", input: { file_path: "x" } }])
    expect(converter.push(full).map((part) => part.type)).toEqual(["tool-call"])
    expect(converter.push(full)).toEqual([])
    const fallback = assistant("fallback", [{ type: "thinking", thinking: "plan" }, { type: "text", text: "done" }])
    expect(converter.push(fallback).map((part) => part.type)).toEqual([
      "reasoning-start", "reasoning-delta", "reasoning-end", "text-start", "text-delta", "text-end",
    ])
    expect(converter.push(fallback)).toEqual([])
  })

  test("converts native tool calls and user tool results, including errors", () => {
    const converter = createStreamConverter()
    expect(converter.push(assistant("a", [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "missing" } }]))).toMatchObject([
      { type: "tool-call", toolCallId: "read", toolName: "Read", input: '{"file_path":"missing"}', providerExecuted: true },
    ])
    const response = message({ type: "user", parent_tool_use_id: null, message: { content: [
      { type: "tool_result", tool_use_id: "read", content: [{ type: "text", text: "not found" }], is_error: true },
    ] } })
    expect(converter.push(response)).toEqual([
      { type: "tool-result", toolCallId: "read", toolName: "Read", result: [{ type: "text", text: "not found" }], isError: true },
    ])
    expect(converter.push(response)).toEqual([])
  })

  test("falls back after message_start alone and preserves identical blocks in one message", () => {
    const converter = createStreamConverter()
    converter.push(start("fallback"))
    const full = assistant("fallback", [{ type: "text", text: "same" }, { type: "text", text: "same" }])
    const parts = converter.push(full)
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["same", "same"])
    expect(converter.push(full)).toEqual([])
  })

  test("reports unmatched tool results rather than inventing a tool name", () => {
    const parts = createStreamConverter().push(message({ type: "user", parent_tool_use_id: null, message: { content: [
      { type: "tool_result", tool_use_id: "missing", content: "orphan" },
    ] } }))
    expect(parts[0]?.type).toBe("error")
    if (parts[0]?.type === "error") expect(String(parts[0].error)).toContain("missing")
  })

  test("isolates interleaved child streams and namespaces child tools and results", () => {
    const converter = createStreamConverter()
    converter.push(start("root"))
    converter.push(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "root" } }))
    expect(converter.push(event({ type: "message_start", message: { id: "child" } }, "agent"))).toEqual([])
    expect(converter.push(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "private" } }, "agent"))).toEqual([])
    const rootCall = converter.push(assistant("root", [{ type: "tool_use", id: "same", name: "Read", input: {} }]))[0]!
    const childCall = converter.push(assistant("child", [{ type: "text", text: "private" }, { type: "tool_use", id: "same", name: "Bash", input: {} }], "agent"))[0]!
    expect(rootCall.type).toBe("tool-call")
    expect(childCall.type).toBe("tool-call")
    if (rootCall.type !== "tool-call" || childCall.type !== "tool-call") throw new Error("Missing tool calls")
    expect(childCall.toolCallId).not.toBe(rootCall.toolCallId)
    expect(converter.push(message({ type: "user", parent_tool_use_id: "agent", message: { content: [
      { type: "tool_result", tool_use_id: "same", content: "ok" },
    ] } }))).toMatchObject([{ type: "tool-result", toolCallId: childCall.toolCallId, toolName: "Bash", result: "ok" }])
    expect(converter.push(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " continues" } }))).toMatchObject([
      { type: "text-delta", delta: " continues" },
    ])
  })

  test("reports independent per-turn usage despite increasing cumulative modelUsage", () => {
    const first = createStreamConverter().push(result({ modelUsage: {
      a: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 400 },
      b: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
    } }))
    const second = createStreamConverter().push(result({
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 },
      modelUsage: {
        a: { inputTokens: 150, outputTokens: 260, cacheReadInputTokens: 370, cacheCreationInputTokens: 480 },
        b: { inputTokens: 11, outputTokens: 22, cacheReadInputTokens: 33, cacheCreationInputTokens: 44 },
      },
    }))
    expect(first).toMatchObject([{ type: "finish", usage: {
      inputTokens: { total: 17, noCache: 10, cacheRead: 3, cacheWrite: 4 }, outputTokens: { total: 20 },
    } }])
    expect(second).toMatchObject([{ type: "finish", usage: {
      inputTokens: { total: 20, noCache: 5, cacheRead: 7, cacheWrite: 8 }, outputTokens: { total: 6 },
    } }])
  })

  test("uses per-turn result usage without modelUsage and preserves length stop reason", () => {
    expect(createStreamConverter().push(result({ stop_reason: "max_tokens" }))).toMatchObject([
      { type: "finish", usage: { inputTokens: { total: 17 }, outputTokens: { total: 20 } }, finishReason: { unified: "length" } },
    ])
  })

  test.each([
    { subtype: "error_during_execution", errors: ["execution failed"] },
    { subtype: "error_max_turns", errors: [] },
    { subtype: "success", is_error: true, result: "billing failed" },
  ])("reports SDK failures and finishes with error: %j", (extra) => {
    const converter = createStreamConverter()
    const parts = converter.push(result(extra))
    expect(parts[0]).toMatchObject({ type: "error", error: expect.any(Error) })
    expect(parts[1]).toMatchObject({ type: "finish", finishReason: { unified: "error" } })
    expect(converter.push(result())).toEqual([])
  })

  test("reports assistant and plugin diagnostics without pretending the query finished", () => {
    const converter = createStreamConverter()
    const parts = converter.push(message({ type: "system", subtype: "init", plugin_errors: [
      { plugin: "broken", type: "hook-load-failed", message: "missing script" },
    ] }))
    if (parts[0]?.type === "error") expect(String(parts[0].error)).toContain("broken (hook-load-failed): missing script")
    expect(parts).toMatchObject([{ type: "error", error: expect.any(Error) }])
    expect(converter.push(message({ type: "assistant", error: "authentication_failed" }))).toMatchObject([
      { type: "error", error: expect.any(Error) },
    ])
    expect(converter.push(result()).at(-1)?.type).toBe("finish")
  })

  test("preserves the native API diagnostic when the assistant error category is unknown", () => {
    const detail = "API Error: 400 messages.3.content.0.tool_result: content cannot be empty if `is_error` is true"
    const parts = createStreamConverter().push(message({ type: "assistant", error: "unknown", parent_tool_use_id: null,
      message: { id: "error", content: [{ type: "text", text: detail }] } }))
    expect(parts[0]?.type).toBe("error")
    if (parts[0]?.type === "error") expect(String(parts[0].error)).toContain(detail)
  })

  test("reports premature iterator completion without fabricating a finish", () => {
    const converter = createStreamConverter()
    converter.push(start("incomplete"))
    converter.push(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } }))
    expect(converter.finish().map((part) => part.type)).toEqual(["text-end", "error"])
    expect(converter.finish()).toEqual([])
  })
})
