import { APICallError } from "@ai-sdk/provider"
import type { SDKAssistantMessageError, SDKMessage, SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"

export type NativeDiagnostics = {
  code?: SDKAssistantMessageError
  detail?: string
  rateLimit?: SDKRateLimitInfo
}

export type NativeStatus = { error?: Error; rateLimit?: SDKRateLimitInfo }

export function classifyNativeResult(
  result: SDKResultMessage,
  diagnostics: NativeDiagnostics = {},
  latestRateLimit: SDKRateLimitInfo | undefined = diagnostics.rateLimit,
): NativeStatus {
  const rateLimit = latestRateLimit
  const status = result.subtype === "success" ? result.api_error_status ?? undefined : undefined
  const httpError = status !== undefined && status >= 400
  if (result.subtype === "success" && !result.is_error && !httpError) return { rateLimit }

  const text = ((result.subtype === "success" ? result.result : result.errors.join("\n")).trim() || diagnostics.detail?.trim() || "")
    .replaceAll("Please run /login", "Run `claude auth login` in a terminal with this profile's CLAUDE_CONFIG_DIR.")
  const failure = status !== undefined && status >= 500
    ? (status === 529 ? "Claude request was overloaded (HTTP 529)." : `Claude request failed with HTTP ${status}.`) +
      ` Claude Code could not finish the request.${text ? ` ${text}` : ""}`
    : text
  const rejected = diagnostics.rateLimit?.status === "rejected" ? diagnostics.rateLimit : undefined
  const limited = diagnostics.code === "rate_limit" || (rejected !== undefined && status === 429)
  const window = rejected?.rateLimitType?.replaceAll("_", " ")
  const limit = limited && !failure
    ? `Claude Code subscription limit reached${window ? ` (${window})` : ""}.`
    : failure
  const resetDate = limited && rejected?.resetsAt ? new Date(rejected.resetsAt * 1000) : undefined
  const reset = resetDate ? ` Resets at ${resetDate.toISOString()}.` : ""
  const billing = diagnostics.code === "billing_error" ? " Check your Claude plan and extra-usage settings." : ""
  const message = limit + reset + billing || (status
    ? `Claude Code could not finish its reply (HTTP ${status})`
    : "Claude Code could not finish its reply")
  const error = httpError ? new APICallError({
    message,
    url: "claude-agent-sdk",
    requestBodyValues: undefined,
    statusCode: status,
    responseHeaders: resetDate ? { "retry-after": resetDate.toUTCString() } : undefined,
    isRetryable: false,
  }) : new Error(message)
  return { error, rateLimit }
}

export function createNativeStatus() {
  const diagnostics: NativeDiagnostics = {}
  return {
    observe(message: SDKMessage): void {
      if (message.type === "rate_limit_event") diagnostics.rateLimit = message.rate_limit_info
      if (message.type === "assistant" && message.parent_tool_use_id === null && message.error) {
        diagnostics.code = message.error
        diagnostics.detail = message.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim() || undefined
      }
    },
    snapshot(): NativeDiagnostics {
      return { ...diagnostics, ...(diagnostics.rateLimit ? { rateLimit: { ...diagnostics.rateLimit } } : {}) }
    },
    // Query-wide snapshots supply metadata without attributing a query-wide rejection to this request.
    finish(result: SDKResultMessage, latestRateLimit?: SDKRateLimitInfo): NativeStatus {
      return classifyNativeResult(result, diagnostics, latestRateLimit ?? diagnostics.rateLimit)
    },
  }
}
