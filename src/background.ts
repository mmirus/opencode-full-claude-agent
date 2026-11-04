import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Plugin } from "@opencode/plugin"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { digest, type HistoryEntry } from "./prompt.js"
import { createStreamConverter } from "./stream.js"

const KEY = "fullClaudeAgentBackground"
const PREFIX = "background/"
export interface BackgroundOwner { providerID: string; nativeID: string; binding: string }
export interface BackgroundResponse extends BackgroundOwner {
  id: string
  text: string
  usage: LanguageModelV3Usage
}

export function backgroundResponse(message: HistoryEntry): BackgroundResponse | undefined {
  if (message.type !== "synthetic" || !message.metadata || typeof message.metadata !== "object") return
  const response = (message.metadata as Record<string, unknown>)[KEY] as BackgroundResponse | undefined
  if (!response || typeof response.id !== "string" || typeof response.text !== "string" ||
    typeof response.providerID !== "string" || typeof response.nativeID !== "string" || typeof response.binding !== "string" ||
    !response.usage?.inputTokens || !response.usage.outputTokens) return
  return response
}

export function backgroundParts(response: BackgroundResponse): LanguageModelV3StreamPart[] {
  const id = `background-${response.id}`
  const providerMetadata = { [response.providerID]: { backgroundResponseID: response.id } }
  return [{ type: "text-start", id, providerMetadata }, { type: "text-delta", id, delta: response.text }, { type: "text-end", id, providerMetadata }]
}

export function addUsage(left: LanguageModelV3Usage, right: LanguageModelV3Usage): LanguageModelV3Usage {
  const sum = (a: number | undefined, b: number | undefined) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  return {
    inputTokens: { total: sum(left.inputTokens.total, right.inputTokens.total), noCache: sum(left.inputTokens.noCache, right.inputTokens.noCache),
      cacheRead: sum(left.inputTokens.cacheRead, right.inputTokens.cacheRead), cacheWrite: sum(left.inputTokens.cacheWrite, right.inputTokens.cacheWrite) },
    outputTokens: { total: sum(left.outputTokens.total, right.outputTokens.total), text: sum(left.outputTokens.text, right.outputTokens.text),
      reasoning: sum(left.outputTokens.reasoning, right.outputTokens.reasoning) },
  }
}

export const emptyUsage = (): LanguageModelV3Usage => ({
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: undefined, reasoning: undefined },
})

export function createBackgroundPublisher(ctx: Plugin.Context) {
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  type Pending = { sessionID: string; response: BackgroundResponse; sent: boolean }
  type Journal = Pending | { sent: true }
  const admit = async (key: string, pending: Journal) => {
    if (stopped || pending.sent) return
    try {
      const session = await ctx.session.get({ sessionID: Session.ID.make(pending.sessionID) })
      if (stopped) return
      await ctx.session.synthetic({
        id: SessionMessage.ID.make(`msg_${pending.response.id}`),
        sessionID: Session.ID.make(pending.sessionID),
        text: "Full Claude Agent background response available.",
        metadata: JSON.parse(JSON.stringify({ [KEY]: pending.response })), delivery: "queue",
        resume: session.model?.providerID === pending.response.providerID,
      })
    } catch (error) {
      if (!(error && typeof error === "object" && "_tag" in error && error._tag === "Session.NotFoundError")) throw error
    }
    await ctx.storage.set(key, { sent: true })
  }
  return {
    async publish(sessionID: string, messages: SDKMessage[], owner: BackgroundOwner) {
      const errors: unknown[] = []
      const pending = new Map<string, Journal>()
      for (const message of messages) {
        if (message.type !== "result") continue
        try {
          if (!message.uuid) throw new Error("Claude background result has no UUID; cannot deduplicate its delivery.")
          const text = message.subtype === "success" && !message.is_error ? message.result
            : `Claude background activity failed: ${message.subtype === "success" ? message.result : message.errors.join("; ") || message.subtype}`
          if (!text.trim()) continue
          const id = digest([sessionID, owner.nativeID, message.uuid])
          const key = `${PREFIX}${sessionID}/${id}`
          const previous = await ctx.storage.get(key) as Journal | undefined
          if (previous) { pending.set(key, previous); continue }
          const finish = createStreamConverter().push(message).find((part) => part.type === "finish")
          if (!finish || finish.type !== "finish") continue
          const item: Pending = { sessionID, response: { ...owner, id, text, usage: finish.usage }, sent: false }
          await ctx.storage.set(key, JSON.parse(JSON.stringify(item)))
          pending.set(key, item)
        } catch (error) { errors.push(error) }
      }
      for (const [key, item] of pending) {
        try { await admit(key, item) }
        catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, `Could not deliver native background responses: ${errors.map(String).join("; ")}`)
    },
    async recover() {
      if (stopped) return
      if (retry) clearTimeout(retry)
      retry = undefined
      let after: string | undefined
      let failed = false
      try {
        do {
          const page = await ctx.storage.scan({ prefix: PREFIX, after, limit: 100 })
          for (const item of page.entries) {
            try { await admit(item.key, item.value as unknown as Journal) }
            catch (error) { failed = true; console.error("Full Claude Agent background recovery failed", error) }
          }
          after = page.next
        } while (after && !stopped)
      } catch (error) { failed = true; console.error("Full Claude Agent background recovery failed", error) }
      if (!failed) failures = 0
      else if (!stopped) {
        failures++
        retry = setTimeout(() => { void this.recover() }, Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30_000))
        retry.unref()
      }
    },
    stop() { stopped = true; if (retry) clearTimeout(retry) },
  }
}
