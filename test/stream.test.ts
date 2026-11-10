import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createStreamConverter } from "../src/stream"
import { createBashProvenance } from "../src/bash-provenance"

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

async function observedResult(frame: SDKMessage, id: string, command: string, parent: string | null = null): Promise<SDKMessage> {
  const provenance = createBashProvenance("session")
  provenance.observe(message({ ...assistant("observed", [{ type: "tool_use", id, name: "Bash", input: { command: "requested" } }], parent), session_id: "session" }))
  const hook = provenance.hooks.PostToolUse?.[0]?.hooks[0]
  if (!hook) throw new Error("Missing PostToolUse observer")
  await hook({ hook_event_name: "PostToolUse", session_id: "session", cwd: ".", transcript_path: "transcript",
    tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: "native result" }, id,
  { signal: new AbortController().signal })
  const snapshot = provenance.observe(message({ ...frame, session_id: "session" }))
  provenance.close()
  return snapshot
}

describe("Bash shell presentation", () => {
  test.each([false, true])("uses PostToolUse evidence without inferring completion or denial from isError=%s", async (is_error) => {
    const converter = createStreamConverter({ providerID: "profile", directory: "." })
    const input = { command: "requested", timeout: 42, run_in_background: true }
    const call = converter.push(assistant("a", [{ type: "tool_use", id: "call", name: "Bash", input }]))[0]
    expect(call).toMatchObject({ input: JSON.stringify({ ...input, command: "# Requested by Claude\nrequested" }) })
    const observation = { command: "actual\ncommand", source: "PostToolUse" }
    const frame = await observedResult(message({ type: "user", parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "call", content: "launched in background", is_error }] } }), "call", observation.command)
    const before = JSON.stringify(frame)
    const outputs = converter.push(frame)
    const prefix = "Native command (observed): actual\ncommand\n\n--- Native output ---\n"
    expect(outputs).toEqual([{
      type: "tool-result", toolCallId: "call", toolName: "shell", isError: is_error,
      result: `${prefix}launched in background`,
      providerMetadata: { profile: { presentation: {
        sdkName: "Bash", sdkInput: input, displayInput: { ...input, command: "# Requested by Claude\nrequested" },
        nativeObservation: observation, resultKind: "native-output", resultPrefix: prefix,
      } } },
    }])
    expect(JSON.stringify(frame)).toBe(before)
    expect(converter.push(frame)).toEqual([])
    expect(converter.interrupt("Interrupted.")).toEqual([])
  })

  test.each([
    [{ type: "text", text: "native text" }, { type: "image", source: { type: "base64", data: "image" } }],
    [{ type: "text", text: "native text", citations: [{ start: 0 }] }],
    { native: { values: [1, null, true] } },
  ].map((content) => ({ content })))("preserves rich Bash JSON without text annotation: %j", async ({ content }) => {
    for (const observed of [false, true]) {
      const converter = createStreamConverter()
      const input = { command: "requested" }
      converter.push(assistant("a", [{ type: "tool_use", id: "call", name: "Bash", input }]))
      const observation = { command: "actual", source: "PostToolUse" }
      const raw = message({ type: "user", parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "call", content, is_error: true }] } })
      const frame = observed ? await observedResult(raw, "call", observation.command) : raw
      const before = JSON.stringify(frame)
      expect(converter.push(frame)).toEqual([{
        type: "tool-result", toolCallId: "call", toolName: "shell", result: content, isError: true,
        providerMetadata: { "full-claude-agent": { presentation: {
          sdkName: "Bash", sdkInput: input, displayInput: { command: "# Requested by Claude\nrequested" },
          nativeObservation: observed ? observation : null, resultKind: "rich", resultPrefix: null,
        } } },
      }])
      expect(JSON.stringify(frame)).toBe(before)
    }
  })

  test("keeps large multiline output recoverable without duplicating output in metadata", () => {
    const converter = createStreamConverter()
    const command = "printf 'line\\n'\n".repeat(2_000)
    const output = "native output\n".repeat(100_000)
    const call = converter.push(assistant("a", [{ type: "tool_use", id: "call", name: "Bash", input: { command } }]))[0]
    expect(call).toMatchObject({ input: JSON.stringify({ command: `# Requested by Claude\n${command}` }) })
    const part = converter.push(message({ type: "user", parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "call", content: output }] } }))[0]
    if (part?.type !== "tool-result" || typeof part.result !== "string") throw new Error("Missing text result")
    const presentation = part.providerMetadata?.["full-claude-agent"]?.presentation
    if (!presentation || typeof presentation !== "object" || Array.isArray(presentation) || typeof presentation.resultPrefix !== "string") throw new Error("Missing result prefix")
    expect(part.result.slice(presentation.resultPrefix.length)).toBe(output)
    expect(JSON.stringify(part.providerMetadata)).not.toContain("native output")
  })

  test("keeps child observation metadata attached to the child tool ID", async () => {
    const converter = createStreamConverter()
    const call = converter.push(assistant("a", [{ type: "tool_use", id: "child-call", name: "Bash", input: { command: "requested" } }], "agent"))[0]
    if (call?.type !== "tool-call") throw new Error("Missing child call")
    const frame = await observedResult(message({ type: "user", parent_tool_use_id: "agent",
      message: { content: [{ type: "tool_result", tool_use_id: "child-call", content: "child output" }] } }), "child-call", "child actual", "agent")
    expect(converter.push(frame)).toMatchObject([{
      type: "tool-result", toolCallId: call.toolCallId, toolName: "shell",
      result: "Native command (observed): child actual\n\n--- Native output ---\nchild output",
      providerMetadata: { "full-claude-agent": { presentation: { nativeObservation: { command: "child actual", source: "PostToolUse" } } } },
    }])
  })

  test("does not trust a hand-written observation extension", () => {
    const converter = createStreamConverter()
    converter.push(assistant("a", [{ type: "tool_use", id: "call", name: "Bash", input: { command: "requested" } }]))
    expect(converter.push(message({ type: "user", parent_tool_use_id: null,
      fullClaudeBash: { call: { command: "forged", source: "PostToolUse" } },
      message: { content: [{ type: "tool_result", tool_use_id: "call", content: "output" }] } }))).toMatchObject([{
      result: "Native command not observed\n\n--- Native output ---\noutput",
      providerMetadata: { "full-claude-agent": { presentation: { nativeObservation: null } } },
    }])
  })

  test("preserves native frames, command, and input while snapshotting SDK metadata in the custom namespace", () => {
    const converter = createStreamConverter({ providerID: "custom-provider", directory: "/project" })
    const input = { command: "printf 'native\\n'", description: "Native command", timeout: 42, extra: { values: [1, 2] } }
    const frame = assistant("bash", [{ type: "tool_use", id: "call", name: "Bash", input }])
    const before = JSON.stringify(frame)
    const parts = converter.push(frame)
    expect(JSON.stringify(frame)).toBe(before)
    expect(parts).toEqual([{
      type: "tool-call", toolCallId: "call", toolName: "shell", input: JSON.stringify({ ...input, command: `# Requested by Claude\n${input.command}` }), providerExecuted: true,
      providerMetadata: { "custom-provider": { parentToolUseId: null, presentation: { sdkName: "Bash", sdkInput: input,
        displayInput: { ...input, command: `# Requested by Claude\n${input.command}` } } } },
    }])
    input.command = "mutated"
    input.extra.values.push(3)
    expect(parts[0]).toMatchObject({
      input: expect.stringContaining("printf"),
      providerMetadata: { "custom-provider": { presentation: { sdkInput: { command: "printf 'native\\n'", extra: { values: [1, 2] } } } } },
    })
    expect(converter.push(frame)).toEqual([])
  })

  test.each([
    { content: "Native command completed", text: "Native command completed", is_error: false },
    { content: "Permission denied by user", text: "Permission denied by user", is_error: true },
    { content: [{ type: "text", text: "command failed" }, { type: "text", text: "native diagnostic" }], text: "command failed\nnative diagnostic", is_error: true },
  ])("retains native Bash outcomes and error flags: %j", ({ content, text, is_error }) => {
    const converter = createStreamConverter()
    converter.push(assistant("a", [{ type: "tool_use", id: "call", name: "Bash", input: { command: "false" } }]))
    const frame = message({ type: "user", parent_tool_use_id: null, tool_use_result: { stdout: "native", exitCode: 7 },
      message: { content: [{ type: "tool_result", tool_use_id: "call", content, is_error }] } })
    const before = JSON.stringify(frame)
    const outputs = converter.push(frame)
    expect(outputs).toMatchObject([{
      type: "tool-result", toolCallId: "call", toolName: "shell", isError: is_error,
      result: `Native command not observed\n\n--- Native output ---\n${text}`,
      providerMetadata: { "full-claude-agent": { presentation: {
        sdkName: "Bash", sdkInput: { command: "false" }, displayInput: { command: "# Requested by Claude\nfalse" },
        nativeObservation: null, resultKind: "native-output",
        resultPrefix: "Native command not observed\n\n--- Native output ---\n",
      } } },
    }])
    expect(JSON.stringify(frame)).toBe(before)
    expect(converter.push(frame)).toEqual([])
    expect(converter.interrupt("Interrupted.")).toEqual([])
  })

  test.each([false, true])("labels normalized Bash text arrays without changing isError=%s", async (is_error) => {
    for (const observed of [false, true]) {
      const converter = createStreamConverter()
      converter.push(assistant("array", [{ type: "tool_use", id: "call", name: "Bash", input: { command: "requested" } }]))
      const raw = message({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "call",
        content: [{ type: "text", text: "first line" }, { type: "text", text: "second line" }], is_error }] } })
      const frame = observed ? await observedResult(raw, "call", "native command") : raw
      const before = JSON.stringify(frame)
      const [output] = converter.push(frame)
      if (output?.type !== "tool-result") throw new Error("Missing Bash result")
      const prefix = `${observed ? "Native command (observed): native command" : "Native command not observed"}\n\n--- Native output ---\n`
      expect(output.result).toBe(`${prefix}first line\nsecond line`)
      expect(output.isError).toBe(is_error)
      expect(output.providerMetadata?.["full-claude-agent"]?.presentation).toMatchObject({
        resultKind: "native-output", resultPrefix: prefix,
        nativeObservation: observed ? { command: "native command", source: "PostToolUse" } : null,
      })
      expect(JSON.stringify(frame)).toBe(before)
    }
  })

  test("keeps completed Bash results and interrupts only unresolved root and child calls", () => {
    const converter = createStreamConverter()
    converter.push(assistant("root", [
      { type: "tool_use", id: "done", name: "Bash", input: { command: "pwd" } },
      { type: "tool_use", id: "same", name: "Bash", input: { command: "sleep 10" } },
    ]))
    const child = assistant("child", [{ type: "tool_use", id: "same", name: "Bash", input: { command: "sleep 20" } }], "agent")
    const childCall = converter.push(child)[0]
    expect(childCall).toMatchObject({ type: "tool-call", toolName: "shell",
      providerMetadata: { "full-claude-agent": { parentToolUseId: "agent", presentation: { sdkName: "Bash" } } } })
    if (childCall?.type !== "tool-call") throw new Error("Missing child call")
    expect(childCall.toolCallId).not.toBe("same")
    expect(converter.push(child)).toEqual([])
    expect(converter.push(message({ type: "user", parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "done", content: "completed" }] } })))
      .toMatchObject([{ type: "tool-result", toolCallId: "done", toolName: "shell", result: "Native command not observed\n\n--- Native output ---\ncompleted", isError: false }])
    const interrupted = converter.interrupt("Interrupted.")
    expect(interrupted).toMatchObject(["same", childCall.toolCallId].map((toolCallId) => ({
      type: "tool-result", toolCallId, toolName: "shell", isError: true,
      result: "Native command not observed\n\n--- Adapter status ---\nInterrupted. No final native result was received for this tool. Check its outcome before retrying.",
      providerMetadata: { "full-claude-agent": { presentation: {
        sdkName: "Bash", nativeObservation: null, resultKind: "adapter-status",
        resultPrefix: "Native command not observed\n\n--- Adapter status ---\n",
      } } },
    })))
    expect(converter.interrupt("Interrupted.")).toEqual([])
  })

  test("matches child and root results independently when SDK tool IDs collide", () => {
    const converter = createStreamConverter()
    for (const parent of [null, "agent"]) {
      converter.push(assistant(`message-${parent}`, [{ type: "tool_use", id: "same", name: "Bash", input: { command: "pwd" } }], parent))
    }
    for (const parent of ["agent", null]) {
      const frame = message({ type: "user", parent_tool_use_id: parent,
        message: { content: [{ type: "tool_result", tool_use_id: "same", content: `output-${parent}` }] } })
      expect(converter.push(frame)).toMatchObject([{
        type: "tool-result", toolCallId: parent === null ? "same" : `child:${JSON.stringify([parent, "same"])}`,
        toolName: "shell", result: `Native command not observed\n\n--- Native output ---\noutput-${parent}`, isError: false,
        providerMetadata: { "full-claude-agent": { presentation: { nativeObservation: null } } },
      }])
      expect(converter.push(frame)).toEqual([])
    }
    expect(converter.interrupt("Interrupted.")).toEqual([])
  })

  test.each([null, [], {}, { command: 42 }, "pwd"].map((input) => ({ input })))("keeps malformed Bash input native: %j", ({ input }) => {
    const converter = createStreamConverter()
    expect(converter.push(assistant("a", [{ type: "tool_use", id: "call", name: "Bash", input }])))
      .toEqual([{ type: "tool-call", toolCallId: "call", toolName: "Bash", input: JSON.stringify(input), providerExecuted: true,
        providerMetadata: { "full-claude-agent": { parentToolUseId: null } } }])
    expect(converter.interrupt("Interrupted.")[0]).toMatchObject({ toolName: "Bash" })
  })

  test.each(["Write", "Read", "Edit", "Agent", "Other"])("keeps %s native even when input contains command", (name) => {
    const converter = createStreamConverter()
    const input = { command: "pwd", file_path: "file", content: "body" }
    expect(converter.push(assistant("a", [{ type: "tool_use", id: "call", name, input }])))
      .toEqual([{ type: "tool-call", toolCallId: "call", toolName: name, input: JSON.stringify(input), providerExecuted: true,
        providerMetadata: { "full-claude-agent": { parentToolUseId: null } } }])
    expect(converter.interrupt("Interrupted.")[0]).toMatchObject({ toolName: name })
  })

  test("preserves authoritative native Write diffs without attaching file diffs to mapped Bash", () => {
    const converter = createStreamConverter({ providerID: "custom-provider", directory: "/project" })
    const nativeResult = { type: "create", filePath: "/project/file.txt", content: "actual content\n", structuredPatch: [] }
    for (const name of ["Bash", "Write"]) {
      const input = { command: "pwd", file_path: "/project/file.txt", content: "requested content\n" }
      const call = converter.push(assistant(name, [{ type: "tool_use", id: name, name, input }]))[0]
      expect(call).toMatchObject({ toolName: name === "Bash" ? "shell" : "Write" })
      const outputs = converter.push(message({ type: "user", parent_tool_use_id: null, tool_use_result: nativeResult,
        message: { content: [{ type: "tool_result", tool_use_id: name, content: "native result" }] } }))
      if (name === "Bash") {
        expect(outputs).toMatchObject([{ type: "tool-result", toolCallId: name, toolName: "shell", result: "Native command not observed\n\n--- Native output ---\nnative result", isError: false }])
        expect(JSON.stringify(outputs)).not.toContain("fileDiffs")
      } else {
        expect(outputs).toMatchObject([{ type: "tool-result", toolName: "Write", result: "native result", isError: false,
          providerMetadata: { "custom-provider": { experimental: { fileDiffs: [{ file: "file.txt", additions: 1, deletions: 0, status: "added" }] } } } }])
        expect(JSON.stringify(outputs)).toContain("+actual content")
        expect(JSON.stringify(outputs)).not.toContain("requested content")
      }
    }
  })
})

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
      { type: "tool-result", toolCallId: "read", toolName: "Read", result: "not found", isError: true },
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

  test("reports plugin diagnostics but defers transient assistant errors until the result", () => {
    const converter = createStreamConverter()
    const parts = converter.push(message({ type: "system", subtype: "init", plugin_errors: [
      { plugin: "broken", type: "hook-load-failed", message: "missing script" },
    ] }))
    if (parts[0]?.type === "error") expect(String(parts[0].error)).toContain("broken (hook-load-failed): missing script")
    expect(parts).toMatchObject([{ type: "error", error: expect.any(Error) }])
    expect(converter.push(message({ ...assistant("retry", [{ type: "text", text: "Please run /login" }]), error: "authentication_failed" }))).toEqual([])
    const terminal = converter.push(result())
    expect(terminal).toMatchObject([{ type: "finish", finishReason: { unified: "stop" } }])
  })

  test("preserves the native API diagnostic when the assistant error category is unknown", () => {
    const detail = "API Error: 400 messages.3.content.0.tool_result: content cannot be empty if `is_error` is true"
    const converter = createStreamConverter()
    expect(converter.push(message({ type: "assistant", error: "unknown", parent_tool_use_id: null,
      message: { id: "error", content: [{ type: "text", text: detail }] } }))).toEqual([])
    const parts = converter.push(result({ subtype: "error_during_execution", errors: ["", "  "] }))
    expect(parts[0]?.type).toBe("error")
    if (parts[0]?.type === "error") expect(String(parts[0].error)).toContain(detail)
    expect(parts[1]).toMatchObject({ type: "finish", finishReason: { unified: "error" } })
  })

  test.each([429, 529])("success-shaped HTTP %s results emit a non-retryable terminal error", (status) => {
    const parts = createStreamConverter().push(result({ api_error_status: status, result: "Native request failed" }))
    expect(parts).toMatchObject([
      { type: "error", error: { statusCode: status, isRetryable: false } },
      { type: "finish", finishReason: { unified: "error" } },
    ])
  })

  test("a child diagnostic cannot fail a successful parent result", () => {
    const converter = createStreamConverter()
    expect(converter.push(message({ ...assistant("child-error", [{ type: "text", text: "child quota exhausted" }], "agent"), error: "rate_limit" }))).toEqual([])
    expect(converter.push(result())).toMatchObject([{ type: "finish", finishReason: { unified: "stop" } }])
  })

  test.each([
    { name: "plain", content: "native failure", expected: "native failure" },
    { name: "large text blocks", content: [{ type: "text", text: "failure\n".repeat(100_000) }, { type: "text", text: "tail" }], expected: `${"failure\n".repeat(100_000)}\ntail` },
    { name: "mixed blocks", content: [{ type: "text", text: "failed" }, { type: "image", source: { type: "base64", data: "image" } }], expected: [{ type: "text", text: "failed" }, { type: "image", source: { type: "base64", data: "image" } }] },
  ])("normalizes $name tool failures while preserving isError and terminal classification", ({ content, expected }) => {
    for (const failed of [false, true]) {
      const converter = createStreamConverter()
      converter.push(assistant("tool", [{ type: "tool_use", id: "call", name: "Read", input: {} }]))
      const outputs = converter.push(message({ type: "user", parent_tool_use_id: null, message: { content: [
        { type: "tool_result", tool_use_id: "call", content, is_error: true },
      ] } }))
      expect(outputs).toHaveLength(1)
      expect(outputs[0]).toMatchObject({ type: "tool-result", toolCallId: "call", toolName: "Read", isError: true })
      if (outputs[0]?.type !== "tool-result") throw new Error("Missing native tool result")
      expect<unknown>(outputs[0].result).toEqual(expected)
      const terminal = converter.push(result(failed ? { api_error_status: 529 } : {}))
      expect(terminal.filter((part) => part.type === "error")).toHaveLength(failed ? 1 : 0)
      expect(terminal.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: failed ? "error" : "stop" } })
    }
  })

  test("reports premature iterator completion without fabricating a finish", () => {
    const converter = createStreamConverter()
    converter.push(start("incomplete"))
    converter.push(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } }))
    expect(converter.finish().map((part) => part.type)).toEqual(["text-end", "error"])
    expect(converter.finish()).toEqual([])
  })
})
