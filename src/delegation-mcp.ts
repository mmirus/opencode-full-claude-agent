import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { createDelegation } from "./delegation.js"

export const DELEGATION_SERVER = "full_claude_opencode"
export const DELEGATION_INSTRUCTIONS = `For a user-requested subagent on another provider, use mcp__${DELEGATION_SERVER}__list_models to find the exact provider/model reference, then mcp__${DELEGATION_SERVER}__delegate. Discovery returns the newest model in each family by default, with effort variants nested under that model. Use the base model unless the user requests a variant. To find an explicitly requested older generation, search with all:true. Never guess a model ID or substitute a different model when the requested model is unavailable. Delegation runs in the foreground and returns the child session ID, selected model, and reply. Include all task context in the prompt; the child starts fresh. Use native Agent for ordinary Claude subagents, especially workflows that depend on native SubagentStop hooks. OpenCode delegation does not produce a native Agent transcript or SubagentStop event in this Claude session. Do not launch delegated work through a shell CLI or run background delegation.`

export interface ActiveDelegation {
  createHost: (signal: AbortSignal) => ReturnType<typeof createDelegation>
  signal: AbortSignal
}

function metadata(extra: unknown) {
  if (!extra || typeof extra !== "object") throw new Error("MCP invocation context is unavailable")
  const value = extra as { signal?: unknown; _meta?: Record<string, unknown> }
  if (!(value.signal instanceof AbortSignal)) throw new Error("MCP invocation has no cancellation signal")
  return { signal: value.signal, toolUseID: value._meta?.["claudecode/toolUseId"] }
}

export function createDelegationMcp(active: () => ActiveDelegation | undefined) {
  const execute = async <T extends object>(extra: unknown, operation: (host: ReturnType<typeof createDelegation>, toolUseID: string) => Promise<T>) => {
    try {
      const turn = active()
      if (!turn) throw new Error("OpenCode delegation requires an active foreground Claude turn")
      const request = metadata(extra)
      if (typeof request.toolUseID !== "string" || !request.toolUseID.trim()) {
        throw new Error("Claude did not provide its MCP tool-use ID; update Claude Code before using OpenCode model discovery or delegation")
      }
      const signal = AbortSignal.any([turn.signal, request.signal])
      signal.throwIfAborted()
      const result = await operation(turn.createHost(signal), request.toolUseID)
      signal.throwIfAborted()
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: Object.fromEntries(Object.entries(result)) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : typeof error === "string" ? error : ""
      return { isError: true, content: [{ type: "text" as const, text: reason.trim() || "OpenCode delegation failed" }] }
    }
  }
  return createSdkMcpServer({
    name: DELEGATION_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions: DELEGATION_INSTRUCTIONS,
    tools: [
      tool("list_models", "Search OpenCode chat models. Defaults to the newest model in each family, newest first, with variants nested under each model. Use all:true for older versions and offset for another page.", {
        query: z.string().optional(),
        provider: z.string().optional().describe("Provider ID or display name; case-insensitive exact match"),
        all: z.boolean().optional().describe("Include older versions of each model family"),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }, (input, extra) => execute(extra, (host, toolUseID) => host.listModels(input, toolUseID)), { annotations: { readOnlyHint: true } }),
      tool("delegate", "Run a foreground OpenCode subagent using an exact model reference from list_models. Returns its session ID and reply. Native Claude subagent hooks do not run for this host-managed child.", {
        model: z.string().min(1).describe("Exact provider/model or provider/model#variant reference"),
        prompt: z.string().min(1).describe("Complete task and context for the new child session"),
        description: z.string().min(1).describe("Short task label"),
        agent: z.string().min(1).optional().describe("OpenCode subagent type; defaults to general"),
      }, (input, extra) => execute(extra, (host, toolUseID) => {
        return host.delegate(input, toolUseID)
      }), { annotations: { readOnlyHint: false } }),
    ],
  })
}
