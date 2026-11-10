import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import type { SDKMessage, SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { nativeFileDiff } from "./native-diff.js"
import { createNativeStatus } from "./native-status.js"
import { normalizeNativeContent } from "./native-content.js"
import { bashResultPresentation, nativeToolPresentation, type BashPresentation } from "./tool-presentation.js"
import { bashObservation } from "./bash-provenance.js"

type Part = LanguageModelV3StreamPart
type Block = { kind: "text" | "reasoning"; id: string }
type Turn = { messageId: string; blocks: Map<number, Block> }

function resultUsage(message: SDKResultMessage): LanguageModelV3Usage {
  // usage covers this turn's main agent loop and excludes subagent calls.
  // modelUsage is cumulative across streaming-input turns and resumed sessions.
  const noCache = message.usage.input_tokens
  const cacheRead = message.usage.cache_read_input_tokens
  const cacheWrite = message.usage.cache_creation_input_tokens
  return {
    inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
    outputTokens: {
      total: message.usage.output_tokens,
      text: undefined,
      reasoning: undefined,
    },
  }
}

/** Converts one foreground turn through its SDK result; query execution and cancellation belong to the caller. */
export function createStreamConverter(options = { providerID: "full-claude-agent", directory: "." }) {
  const turns = new Map<string | null, Turn>()
  const streamed = new Map<string, Set<Block["kind"]>>()
  const completed = new Set<string>()
  const tools = new Map<string, { nativeName: string; presentationName: string; presentation?: BashPresentation }>()
  const results = new Set<string>()
  let serial = 0
  let ended = false
  let closed = false
  const status = createNativeStatus()
  const scopeKey = (parent: string | null, id: string) => JSON.stringify([parent, id])
  const toolId = (parent: string | null, id: string) => parent === null ? id : `child:${JSON.stringify([parent, id])}`
  const closeBlocks = (turn: Turn): Part[] => {
    const parts: Part[] = []
    for (const block of turn.blocks.values()) parts.push({ type: `${block.kind}-end`, id: block.id })
    turn.blocks.clear()
    return parts
  }

  return {
    push(message: SDKMessage, latestRateLimit?: SDKRateLimitInfo): Part[] {
      if (ended || closed) return []
      status.observe(message)
      const parts: Part[] = []
      if (message.type === "system" && message.subtype === "init") {
        for (const error of message.plugin_errors ?? []) {
          parts.push({ type: "error", error: new Error(`Claude plugin ${error.plugin} (${error.type}): ${error.message}`) })
        }
      }
      if (message.type === "stream_event") {
        const parent = message.parent_tool_use_id
        const event = message.event
        // Subagents have independent message/block indices and must not write into the root answer.
        if (parent !== null) return parts
        if (event.type === "message_start") {
          const previous = turns.get(parent)
          if (previous) parts.push(...closeBlocks(previous))
          turns.set(parent, { messageId: event.message.id, blocks: new Map() })
          parts.push({ type: "response-metadata", id: event.message.id, modelId: event.message.model })
        }
        const turn = turns.get(parent)
        if (!turn) return parts
        if (event.type === "content_block_start") {
          const content = event.content_block
          const kind = content.type === "text" ? "text" : content.type === "thinking" ? "reasoning" : undefined
          if (kind) {
            const block: Block = { kind, id: `block-${serial++}` }
            turn.blocks.set(event.index, block)
            const key = scopeKey(parent, turn.messageId)
            const kinds = streamed.get(key) ?? new Set<Block["kind"]>()
            kinds.add(kind)
            streamed.set(key, kinds)
            parts.push({ type: `${kind}-start`, id: block.id })
            const text = content.type === "text" ? content.text : content.type === "thinking" ? content.thinking : ""
            if (text) parts.push({ type: `${kind}-delta`, id: block.id, delta: text })
          }
        }
        if (event.type === "content_block_delta") {
          const block = turn.blocks.get(event.index)
          if (block?.kind === "text" && event.delta.type === "text_delta") {
            parts.push({ type: "text-delta", id: block.id, delta: event.delta.text })
          }
          if (block?.kind === "reasoning" && event.delta.type === "thinking_delta") {
            parts.push({ type: "reasoning-delta", id: block.id, delta: event.delta.thinking })
          }
        }
        if (event.type === "content_block_stop") {
          const block = turn.blocks.get(event.index)
          if (block) parts.push({ type: `${block.kind}-end`, id: block.id })
          turn.blocks.delete(event.index)
        }
        if (event.type === "message_stop") parts.push(...closeBlocks(turn))
      }
      if (message.type === "assistant") {
        if (message.error) {
          return parts
        }
        const parent = message.parent_tool_use_id
        const key = scopeKey(parent, message.message.id)
        const occurrences = new Map<string, number>()
        for (const content of message.message.content) {
          if (content.type === "tool_use") {
            const id = toolId(parent, content.id)
            if (tools.has(id)) continue
            const input = JSON.stringify(content.input)
            const { presentationName, presentation } = nativeToolPresentation(content.name, input)
            tools.set(id, { nativeName: content.name, presentationName, presentation })
            parts.push({ type: "tool-call", toolCallId: id, toolName: presentationName,
              input: presentation ? JSON.stringify(presentation.displayInput) : input, providerExecuted: true,
              providerMetadata: { [options.providerID]: { parentToolUseId: parent, ...(presentation ? { presentation } : {}) } } })
          }
          if (parent !== null) continue
          const kind = content.type === "text" ? "text" : content.type === "thinking" ? "reasoning" : undefined
          if (!kind || streamed.get(key)?.has(kind)) continue
          const signature = JSON.stringify(content)
          const occurrence = occurrences.get(signature) ?? 0
          occurrences.set(signature, occurrence + 1)
          const fingerprint = JSON.stringify([key, signature, occurrence])
          if (completed.has(fingerprint)) continue
          completed.add(fingerprint)
          const id = `block-${serial++}`
          const text = content.type === "text" ? content.text : content.type === "thinking" ? content.thinking : ""
          parts.push({ type: `${kind}-start`, id }, { type: `${kind}-delta`, id, delta: text }, { type: `${kind}-end`, id })
        }
      }
      if (message.type === "user" && Array.isArray(message.message.content)) {
        const outputs = message.message.content.filter((content) => content.type === "tool_result")
        for (const content of message.message.content) {
          if (content.type !== "tool_result") continue
          const id = toolId(message.parent_tool_use_id, content.tool_use_id)
          if (results.has(id)) continue
          const tool = tools.get(id)
          if (!tool) {
            parts.push({ type: "error", error: new Error(`Claude tool result has no matching tool call: ${id}`) })
            continue
          }
          results.add(id)
          const diff = !content.is_error && outputs.length === 1
            ? nativeFileDiff(tool.nativeName, message.tool_use_result, options.directory)
            : undefined
          const normalized = normalizeNativeContent(content.content)
          const displayed = tool.presentation
            ? bashResultPresentation(tool.presentation, normalized, bashObservation(message, content.tool_use_id))
            : undefined
          parts.push({ type: "tool-result", toolCallId: id, toolName: tool.presentationName,
            result: displayed?.result ?? normalized, isError: content.is_error ?? false,
            ...(diff || displayed ? { providerMetadata: { [options.providerID]: {
              ...(diff ? { experimental: { fileDiffs: [diff] } } : {}),
              ...(displayed ? { presentation: displayed.presentation } : {}),
            } } } : {}) })
        }
      }
      if (message.type === "result") {
        ended = true
        for (const turn of turns.values()) parts.push(...closeBlocks(turn))
        const outcome = status.finish(message, latestRateLimit)
        const failed = !!outcome.error
        if (outcome.error) parts.push({ type: "error", error: outcome.error })
        parts.push({ type: "finish", usage: resultUsage(message), finishReason: {
          unified: failed ? "error" : message.stop_reason === "max_tokens" ? "length" : "stop",
          raw: failed ? message.subtype : message.stop_reason ?? undefined,
        }, ...(outcome.rateLimit ? { providerMetadata: { [options.providerID]: { rateLimit: JSON.parse(JSON.stringify(outcome.rateLimit)) } } } : {}) })
      }
      return parts
    },
    interrupt(reason: string): Part[] {
      if (closed) return []
      closed = true
      const parts: Part[] = [...turns.values()].flatMap(closeBlocks)
      for (const [id, tool] of tools) {
        if (results.has(id)) continue
        results.add(id)
        const result = `${reason} No final native result was received for this tool. Check its outcome before retrying.`
        const displayed = tool.presentation ? bashResultPresentation(tool.presentation, result, undefined, true) : undefined
        parts.push({ type: "tool-result", toolCallId: id, toolName: tool.presentationName, isError: true,
          result: displayed?.result ?? result,
          ...(displayed ? { providerMetadata: { [options.providerID]: { presentation: displayed.presentation } } } : {}) })
      }
      return parts
    },
    /** Call when the SDK iterator ends normally, not when the caller cancels it. */
    finish(): Part[] {
      if (ended || closed) return []
      closed = true
      const parts = [...turns.values()].flatMap(closeBlocks)
      parts.push({ type: "error", error: new Error("Claude SDK stream ended without a result message") })
      return parts
    },
  }
}
