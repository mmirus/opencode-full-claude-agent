import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { Plugin } from "@opencode/plugin"
import { Session } from "@opencode/schema/session"
import type { Profile } from "./config.js"
import { createInteractions } from "./interactions.js"
import { Runtime } from "./runtime.js"
import { createDelegation } from "./delegation.js"

export const KIND_HEADER = "x-full-claude-agent-kind"
export const SESSION_HEADER = "x-opencode-session-id"

export class FullClaudeModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly supportedUrls = {}
  readonly provider: string

  constructor(readonly modelId: string, private profile: Profile, private ctx: Plugin.Context, private runtime: Runtime,
    private lease?: (sessionID: string) => () => void) {
    this.provider = profile.id
  }

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Full Claude Agent requires streaming")
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const sessionID = options.headers?.[SESSION_HEADER]
    if (!sessionID || options.headers?.[KIND_HEADER] !== "primary") {
      throw new Error("Full Claude Agent currently supports primary session turns only")
    }
    const release = this.lease?.(sessionID) ?? (() => {})
    try {
      const abort = new AbortController()
      const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
      const session = await this.ctx.session.get({ sessionID: Session.ID.make(sessionID) })
      if (session.fork) throw new Error("Full Claude Agent cannot resume an OpenCode fork. Start a new session.")
      const history = await this.ctx.session.context({ sessionID: Session.ID.make(sessionID) })
      const value = options.providerOptions?.[this.profile.id]?.effort
      const efforts = ["low", "medium", "high", "xhigh", "max"] as const
      if (value !== undefined && !efforts.includes(value as typeof efforts[number])) throw new Error(`Invalid Claude effort: ${value}`)
      let cancelled = false
      let task: Promise<void> | undefined
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          controller.enqueue({ type: "stream-start", warnings: [] })
          task = this.runtime.run({
            sessionID,
            directory: session.location.directory,
            profile: this.profile,
            model: this.modelId,
            effort: value as Options["effort"],
            prompt: options.prompt,
            history,
            signal,
            interactions: (signal) => {
              const dispose = this.lease?.(sessionID)
              return { ...createInteractions(this.ctx, sessionID, signal), dispose }
            },
            delegation: (signal) => createDelegation(this.ctx, sessionID, signal),
            emit: (part) => { if (!cancelled) controller.enqueue(part) },
          }).then(() => {
            if (!cancelled) controller.close()
          }, (error) => {
            if (!cancelled) {
              controller.enqueue({ type: "error", error })
              controller.close()
            }
          }).finally(release)
        },
        cancel: async () => {
          cancelled = true
          abort.abort()
          await task
        },
      })
      return { stream }
    } catch (error) { release(); throw error }
  }
}
