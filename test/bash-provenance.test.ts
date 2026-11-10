import { describe, expect, test } from "bun:test"
import type { HookInput, PostToolUseHookInput, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { bashObservation, createBashProvenance } from "../src/bash-provenance"

function assistant(id = "bash-1", parent: string | null = null, name = "Bash", session = "native"): SDKMessage {
  return { type: "assistant", session_id: session, parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input: { command: "requested" } }] } } as SDKMessage
}

function result(id = "bash-1", parent: string | null = null, extra: Record<string, unknown> = {}): SDKUserMessage {
  return { type: "user", session_id: "native", parent_tool_use_id: parent,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "native output", ...extra }] },
    tool_use_result: { stdout: "rich output", metadata: { preserve: true } } } as SDKUserMessage
}

function hook(id = "bash-1", command: unknown = "final native input", extra: Record<string, unknown> = {}): PostToolUseHookInput {
  return { hook_event_name: "PostToolUse", session_id: "native", cwd: "/project", transcript_path: "/private/transcript",
    tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: { stdout: "not eventual output" },
    ...extra } as PostToolUseHookInput
}

function setup(session = "native") {
  const observer = createBashProvenance(session)
  const callback = observer.hooks.PostToolUse![0]!.hooks[0]!
  return { ...observer, fire: (input: HookInput = hook(), id: string | undefined = "bash-1", signal = new AbortController().signal) =>
    callback(input, id, { signal }) }
}

describe("Bash native input provenance", () => {
  test("registers assistant, observes final PostToolUse input, and snapshots the eventual rich result without mutation", async () => {
    const observer = setup()
    expect(Object.keys(observer.hooks)).toEqual(["PostToolUse"])
    expect(observer.hooks.PostToolUse![0]!.matcher).toBe("Bash")
    const request = assistant()
    const input = hook()
    const inputCopy = structuredClone(input)
    expect(observer.observe(request)).toBe(request)
    expect(await observer.fire(input)).toEqual({})
    expect(input).toEqual(inputCopy)
    const original = result()
    const originalCopy = structuredClone(original)
    const observed = observer.observe(original)
    expect(observed).not.toBe(original)
    expect(observed).toMatchObject(original)
    expect(original).toEqual(originalCopy)
    expect(Object.hasOwn(original, "fullClaudeBash")).toBe(false)
    expect(bashObservation(observed, "bash-1")).toEqual({ command: "final native input", source: "PostToolUse" })
    expect((observed as SDKMessage & { fullClaudeBash: unknown }).fullClaudeBash)
      .toEqual({ "bash-1": { command: "final native input", source: "PostToolUse" } })
    observer.close()
    expect(bashObservation(observed, "bash-1")?.command).toBe("final native input")
  })

  test.each([false, true])("output and error=%s do not establish execution without a hook (including denial)", (is_error) => {
    const observer = setup()
    observer.observe(assistant())
    const observed = observer.observe(result("bash-1", null, { is_error, content: "permission denied; command: invented" }))
    expect(bashObservation(observed, "bash-1")).toBeUndefined()
  })

  test("does not infer evidence from a failure hook or another native tool", async () => {
    const observer = setup()
    observer.observe(assistant())
    await observer.fire({ ...hook(), hook_event_name: "PostToolUseFailure", error: "failed" } as HookInput)
    await observer.fire(hook("bash-1", "wrong", { tool_name: "Write" }))
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
    observer.observe(assistant("write", null, "Write"))
    await observer.fire(hook("write"), "write")
    expect(bashObservation(observer.observe(result("write")), "write")).toBeUndefined()
  })

  test.each([
    { label: "different callback ID", input: hook(), id: "other" },
    { label: "missing callback ID", input: hook(), id: undefined },
    { label: "different input ID", input: hook("other"), id: "bash-1" },
    { label: "different session", input: hook("bash-1", "wrong", { session_id: "other" }), id: "bash-1" },
    { label: "non-string command", input: hook("bash-1", 42), id: "bash-1" },
    { label: "missing command", input: hook("bash-1", "wrong", { tool_input: {} }), id: "bash-1" },
  ])("ignores $label", async ({ input, id }) => {
    const observer = setup()
    observer.observe(assistant())
    const callback = observer.hooks.PostToolUse![0]!.hooks[0]!
    expect(await callback(input, id, { signal: new AbortController().signal })).toEqual({})
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
  })

  test("ignores callbacks before registration and never fills a buffered unknown result retroactively", async () => {
    const observer = setup()
    await observer.fire()
    observer.observe(assistant())
    const buffered = observer.observe(result())
    await observer.fire()
    expect(bashObservation(buffered, "bash-1")).toBeUndefined()
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
  })

  test("consumes results even if a runtime later filters abandoned frames", async () => {
    const observer = setup()
    observer.observe(assistant())
    await observer.fire()
    observer.observe(result())
    await observer.fire(hook("bash-1", "late"))
    observer.observe(assistant())
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
  })

  test("a result received before registration prevents ID reuse from reviving evidence", async () => {
    const observer = setup()
    observer.observe(result())
    observer.observe(assistant())
    await observer.fire()
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
  })

  test("duplicate assistant frames and identical hook callbacks retain evidence", async () => {
    const observer = setup()
    observer.observe(assistant())
    await observer.fire()
    observer.observe(assistant())
    await observer.fire()
    expect(bashObservation(observer.observe(result()), "bash-1")?.command).toBe("final native input")
  })

  test.each(["conflicting", undefined, null, 123])("conflicting or malformed callback %j permanently invalidates evidence", async (command) => {
    const observer = setup()
    observer.observe(assistant())
    await observer.fire()
    await observer.fire({ ...hook(), tool_input: { command } })
    await observer.fire()
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
  })

  test.each([false, true])("root/child ID collisions remain unknown, child first=%s", async (childFirst) => {
    const observer = setup()
    observer.observe(assistant("bash-1", childFirst ? "agent" : null))
    await observer.fire()
    observer.observe(assistant("bash-1", childFirst ? null : "agent"))
    await observer.fire()
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
    expect(bashObservation(observer.observe(result("bash-1", "agent")), "bash-1")).toBeUndefined()
  })

  test("distinct child calls correlate by raw ID and parent scope", async () => {
    const observer = setup()
    observer.observe(assistant("root"))
    observer.observe(assistant("child", "agent"))
    await observer.fire(hook("child", "child command"), "child")
    await observer.fire(hook("root", "root command"), "root")
    expect(bashObservation(observer.observe(result("child", "agent")), "child")?.command).toBe("child command")
    expect(bashObservation(observer.observe(result("root")), "root")?.command).toBe("root command")
  })

  test("a mismatched result scope consumes rather than misattributes evidence", async () => {
    const observer = setup()
    observer.observe(assistant("bash-1", "agent"))
    await observer.fire()
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
    expect(bashObservation(observer.observe(result("bash-1", "agent")), "bash-1")).toBeUndefined()
  })

  test("a same-ID non-Bash registration also invalidates evidence", async () => {
    const observer = setup()
    observer.observe(assistant())
    await observer.fire()
    observer.observe(assistant("bash-1", null, "Write"))
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
  })

  test("terminal SDK results do not clear pending background registrations", async () => {
    const observer = setup()
    observer.observe(assistant())
    const terminal = { type: "result", session_id: "native", subtype: "success", result: "background started" } as SDKMessage
    expect(observer.observe(terminal)).toBe(terminal)
    await observer.fire()
    expect(bashObservation(observer.observe(result()), "bash-1")?.command).toBe("final native input")
  })

  test("close and aborted callbacks cannot create evidence", async () => {
    const observer = setup()
    observer.observe(assistant())
    await observer.fire(hook(), "bash-1", AbortSignal.abort())
    expect(bashObservation(observer.observe(result()), "bash-1")).toBeUndefined()
    observer.observe(assistant("next"))
    await observer.fire(hook("next"), "next")
    observer.close()
    observer.close()
    expect(await observer.fire(hook("next"), "next")).toEqual({})
    const original = result("next")
    expect(observer.observe(original)).toBe(original)
    expect(bashObservation(original, "next")).toBeUndefined()
  })

  test("sessions and separate queries cannot borrow each other's observations", async () => {
    const first = setup()
    const second = setup()
    const otherSession = setup("other")
    first.observe(assistant())
    second.observe(assistant())
    otherSession.observe(assistant())
    await first.fire()
    await otherSession.fire()
    expect(bashObservation(second.observe(result()), "bash-1")).toBeUndefined()
    expect(bashObservation(otherSession.observe(result()), "bash-1")).toBeUndefined()
    expect(bashObservation(first.observe(result()), "bash-1")?.command).toBe("final native input")
  })

  test("query cap preserves existing calls but makes new calls unknown without evicting tombstones", async () => {
    const observer = setup()
    observer.observe(assistant("completed"))
    observer.observe(result("completed"))
    for (let i = 1; i < 4096; i++) observer.observe(assistant(`call-${i}`))
    observer.observe(assistant("overflow"))
    await observer.fire(hook("overflow"), "overflow")
    expect(bashObservation(observer.observe(result("overflow")), "overflow")).toBeUndefined()
    await observer.fire(hook("call-4095"), "call-4095")
    expect(bashObservation(observer.observe(result("call-4095")), "call-4095")).toBeDefined()
    observer.observe(assistant("completed"))
    await observer.fire(hook("completed"), "completed")
    expect(bashObservation(observer.observe(result("completed")), "completed")).toBeUndefined()
    observer.observe(assistant("after-completion"))
    await observer.fire(hook("after-completion"), "after-completion")
    expect(bashObservation(observer.observe(result("after-completion")), "after-completion")).toBeUndefined()
  })

  test("multiple results snapshot independently and duplicate raw IDs stay unknown", async () => {
    const observer = setup()
    observer.observe(assistant("one"))
    observer.observe(assistant("two"))
    await observer.fire(hook("one", "one command"), "one")
    await observer.fire(hook("two", "two command"), "two")
    const original = { ...result("one"), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "one", content: "one output" },
      { type: "tool_result", tool_use_id: "two", content: "two output" },
      { type: "tool_result", tool_use_id: "one", content: "duplicate" },
    ] } } as SDKUserMessage
    const observed = observer.observe(original)
    expect(bashObservation(observed, "one")).toBeUndefined()
    expect(bashObservation(observed, "two")?.command).toBe("two command")
  })

  test("only trusted snapshots supply evidence, including prototype-like raw tool IDs", async () => {
    const observer = setup()
    const forged = { ...result(), fullClaudeBash: { "bash-1": { command: "forged", source: "PostToolUse" } } }
    expect(bashObservation(forged, "bash-1")).toBeUndefined()
    observer.observe(assistant("__proto__"))
    await observer.fire(hook("__proto__", ""), "__proto__")
    const observed = observer.observe(result("__proto__"))
    expect(bashObservation(observed, "__proto__")).toEqual({ command: "", source: "PostToolUse" })
    expect(bashObservation(observed, "constructor")).toBeUndefined()
    const observation = bashObservation(observed, "__proto__")!
    expect(Object.isFrozen(observation)).toBe(true)
    expect(bashObservation({ ...observed }, "__proto__")).toBeUndefined()
  })
})
