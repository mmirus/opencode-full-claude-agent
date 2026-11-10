import { describe, expect, test } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import type { SDKAssistantMessageError, SDKMessage, SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { classifyNativeResult, createNativeStatus } from "../src/native-status"

function result(extra: Record<string, unknown> = {}): SDKResultMessage {
  return { type: "result", subtype: "success", is_error: false, result: "done", ...extra } as SDKResultMessage
}

function assistant(error: SDKAssistantMessageError, parent: string | null = null, detail = ""): SDKMessage {
  return { type: "assistant", parent_tool_use_id: parent, error, message: { content: [{ type: "text", text: detail }] } } as SDKMessage
}

function limit(info: SDKRateLimitInfo): SDKMessage {
  return { type: "rate_limit_event", rate_limit_info: info } as SDKMessage
}

describe("native terminal status", () => {
  test("defers assistant diagnostics and preserves success after native recovery", () => {
    const status = createNativeStatus()
    expect(status.observe(assistant("authentication_failed"))).toBeUndefined()
    expect(status.observe(assistant("overloaded"))).toBeUndefined()
    expect(status.finish(result()).error).toBeUndefined()
  })

  test("rewrites native login instructions and retains structured HTTP status", () => {
    const status = createNativeStatus()
    status.observe(assistant("authentication_failed"))
    const error = status.finish(result({ is_error: true, api_error_status: 401, result: "Please run /login" })).error
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ statusCode: 401, isRetryable: false })
    expect(error?.message).toBe("Run `claude auth login` in a terminal with this profile's CLAUDE_CONFIG_DIR.")
  })

  test.each([400, 429, 500, 529])("fails success-shaped HTTP %d without allowing host retries", (code) => {
    const error = classifyNativeResult(result({ api_error_status: code, result: "" })).error
    expect(error).toBeInstanceOf(APICallError)
    expect(error).toMatchObject({ statusCode: code, isRetryable: false })
    if (code === 529) expect(error?.message).toBe("Claude request was overloaded (HTTP 529). Claude Code could not finish the request.")
    if (code === 500) expect(error?.message).toContain("Claude request failed with HTTP 500.")
  })

  test("appends billing guidance only to a failed terminal result", () => {
    const status = createNativeStatus()
    status.observe(assistant("billing_error"))
    expect(status.finish(result()).error).toBeUndefined()
    expect(status.finish(result({ is_error: true, result: "Insufficient credits." })).error?.message)
      .toBe("Insufficient credits. Check your Claude plan and extra-usage settings.")
  })

  test("retains warning metadata without failing the request", () => {
    const status = createNativeStatus()
    const warning: SDKRateLimitInfo = { status: "allowed_warning", utilization: 0.9, resetsAt: 1800000000 }
    status.observe(limit(warning))
    expect(status.finish(result())).toEqual({ rateLimit: warning })
  })

  test("uses rejected limit reset seconds and HTTP-date retry metadata on terminal 429", () => {
    const status = createNativeStatus()
    const rejected: SDKRateLimitInfo = { status: "rejected", rateLimitType: "five_hour", resetsAt: 1800000000,
      overageStatus: "rejected", overageDisabledReason: "out_of_credits" }
    status.observe(limit(rejected))
    const outcome = status.finish(result({ api_error_status: 429, result: "" }))
    expect(outcome.rateLimit).toEqual(rejected)
    expect(outcome.error?.message).toBe("Claude Code subscription limit reached (five hour). Resets at 2027-01-15T08:00:00.000Z.")
    expect(outcome.error).toMatchObject({ statusCode: 429, isRetryable: false,
      responseHeaders: { "retry-after": "Fri, 15 Jan 2027 08:00:00 GMT" } })
  })

  test("a rejected limit alone does not override clean terminal success", () => {
    const status = createNativeStatus()
    status.observe(limit({ status: "rejected", resetsAt: 1800000000 }))
    expect(status.finish(result()).error).toBeUndefined()
  })

  test("a later allowed limit clears rejected request diagnostics", () => {
    const status = createNativeStatus()
    status.observe(limit({ status: "rejected", resetsAt: 1800000000 }))
    status.observe(limit({ status: "allowed_warning" }))
    const outcome = status.finish(result({ api_error_status: 429, result: "Native failure" }))
    expect(outcome.error?.message).toBe("Native failure")
    expect(outcome.error).toMatchObject({ responseHeaders: undefined })
    expect(outcome.rateLimit).toEqual({ status: "allowed_warning" })
  })

  test("query snapshots provide metadata without request rejection diagnostics", () => {
    const status = createNativeStatus()
    const snapshot: SDKRateLimitInfo = { status: "rejected", resetsAt: 1800000000 }
    const outcome = status.finish(result({ api_error_status: 429, result: "Native failure" }), snapshot)
    expect(outcome.rateLimit).toEqual(snapshot)
    expect(outcome.error?.message).toBe("Native failure")
    expect(outcome.error).toMatchObject({ responseHeaders: undefined })
  })

  test("ignores child assistant diagnostics", () => {
    const status = createNativeStatus()
    status.observe(assistant("billing_error", "child"))
    expect(status.finish(result({ is_error: true, result: "Failure" })).error?.message).toBe("Failure")
  })

  test("normal SDK error subtypes fail even when is_error is false", () => {
    const outcome = classifyNativeResult(result({ subtype: "error_max_turns", is_error: false, errors: ["Turn limit", "Stopped"] }))
    expect(outcome.error?.message).toBe("Turn limit\nStopped")
    expect(APICallError.isInstance(outcome.error)).toBe(false)
  })

  test("empty SDK failures receive a diagnostic fallback without parsing status from text", () => {
    expect(classifyNativeResult(result({ subtype: "error_during_execution", errors: [] })).error?.message)
      .toBe("Claude Code could not finish its reply")
    const error = classifyNativeResult(result({ is_error: true, result: "HTTP 529" })).error
    expect(error?.message).toBe("HTTP 529")
    expect(APICallError.isInstance(error)).toBe(false)
  })

  test("root assistant detail is a fallback only for empty failed results", () => {
    const status = createNativeStatus()
    status.observe(assistant("invalid_request", null, "  Native diagnostic  "))
    expect(status.finish(result()).error).toBeUndefined()
    expect(status.finish(result({ is_error: true, result: "  Terminal diagnostic  " })).error?.message)
      .toBe("Terminal diagnostic")
    expect(status.finish(result({ is_error: true, result: " \n " })).error?.message).toBe("Native diagnostic")
    expect(status.finish(result({ subtype: "error_during_execution", errors: [" ", "\n"] })).error?.message)
      .toBe("Native diagnostic")
  })

  test("login instructions in assistant fallback identify the selected profile environment", () => {
    const status = createNativeStatus()
    status.observe(assistant("authentication_failed", null, "Please run /login"))
    expect(status.finish(result({ is_error: true, result: "" })).error?.message)
      .toBe("Run `claude auth login` in a terminal with this profile's CLAUDE_CONFIG_DIR.")
  })

  test("whitespace-only terminal and assistant diagnostics use the generic fallback", () => {
    const status = createNativeStatus()
    status.observe(assistant("unknown", null, " \n "))
    expect(status.finish(result({ is_error: true, result: " \n " })).error?.message)
      .toBe("Claude Code could not finish its reply")
  })

  test("snapshot copies request diagnostics and does not share rate-limit objects", () => {
    const status = createNativeStatus()
    status.observe(assistant("rate_limit", null, "Limit diagnostic"))
    status.observe(limit({ status: "rejected", resetsAt: 1800000000 }))
    const snapshot = status.snapshot()
    expect(snapshot).toEqual({ code: "rate_limit", detail: "Limit diagnostic",
      rateLimit: { status: "rejected", resetsAt: 1800000000 } })
    snapshot.code = "billing_error"
    snapshot.detail = "Different diagnostic"
    snapshot.rateLimit!.status = "allowed"
    expect(status.snapshot()).toMatchObject({ code: "rate_limit", detail: "Limit diagnostic", rateLimit: { status: "rejected" } })
  })
})
