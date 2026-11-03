import type { Plugin } from "@opencode/plugin"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"

export interface DelegationModel {
  model: string
  name: string
  providerID: string
  providerName: string
  released: number
  status: string
  variants: string[]
}

export interface DelegationModels {
  models: DelegationModel[]
  total: number
  truncated: boolean
  next: number | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failure(error: unknown): Error {
  if (error instanceof Error && error.message.trim()) return error
  const message = typeof error === "string" ? error : record(error) ? error.message : undefined
  return new Error(typeof message === "string" && message.trim() ? message : "OpenCode delegation failed")
}

function modelSearchResult(output: unknown): DelegationModels {
  const invalid = () => new Error("OpenCode returned an invalid model search result")
  if (!record(output) || !Array.isArray(output.providers) || typeof output.total !== "number" || !Number.isSafeInteger(output.total) || output.total < 0 ||
    !(output.next === null || (typeof output.next === "number" && Number.isSafeInteger(output.next) && output.next >= 0))) throw invalid()
  const models: DelegationModel[] = []
  for (const provider of output.providers) {
    if (!record(provider) || typeof provider.id !== "string" || !provider.id.trim() || typeof provider.name !== "string" || !Array.isArray(provider.models)) throw invalid()
    for (const model of provider.models) {
      if (!record(model) || typeof model.id !== "string" || typeof model.name !== "string" || typeof model.released !== "number" || !Number.isFinite(model.released) ||
        typeof model.status !== "string" || !model.status.trim() || !Array.isArray(model.variants)) throw invalid()
      try {
        const ref = Model.Ref.parse(model.id)
        if (ref.providerID !== provider.id || ref.variant !== undefined || model.id !== `${ref.providerID}/${ref.id}`) throw invalid()
      } catch {
        throw invalid()
      }
      const variants: string[] = []
      for (const variant of model.variants) {
        if (typeof variant !== "string" || !variant.trim()) throw invalid()
        const full = `${model.id}#${variant}`
        try {
          if (Model.Ref.parse(full).variant !== variant) throw invalid()
        } catch {
          throw invalid()
        }
        variants.push(full)
      }
      models.push({ model: model.id, name: model.name, providerID: provider.id, providerName: provider.name, released: model.released, status: model.status, variants })
    }
  }
  if (models.length > output.total || (output.next !== null && output.next >= output.total)) throw invalid()
  return { models, total: output.total, truncated: output.next !== null, next: output.next }
}

async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  try {
    signal.throwIfAborted()
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return operation()
      }).then((result) => {
        signal.throwIfAborted()
        resolve(result)
      }).catch(reject).finally(() => signal.removeEventListener("abort", abort))
    })
  } catch (error) {
    throw failure(error)
  }
}

export function createDelegation(ctx: Plugin.Context, sessionID: string, signal: AbortSignal) {
  const session = Session.ID.make(sessionID)
  return {
    async listModels(input: { query?: string; provider?: string; all?: boolean; limit?: number; offset?: number }, toolUseID: string): Promise<DelegationModels> {
      return abortable(signal, async () => {
        if (!toolUseID.trim()) throw new Error("Model search requires a native tool-use ID")
        const tools = await ctx.tool.list()
        signal.throwIfAborted()
        const search = tools.find((tool) => tool.id === "opencode_models")
        if (!search) throw new Error("OpenCode model search tool is unavailable")
        const messages = await ctx.session.context({ sessionID: session })
        signal.throwIfAborted()
        const assistant = messages.findLast((message) => message.type === "assistant")
        if (!assistant) throw new Error("Model search requires an existing OpenCode assistant message")
        const info = await ctx.session.get({ sessionID: session })
        signal.throwIfAborted()
        const result = await search.execute({ ...input, type: "chat" }, {
          sessionID: session, agent: Agent.ID.make(info.agent ?? "build"),
          messageID: SessionMessage.ID.make(assistant.id), id: Tool.CallID.make(toolUseID),
          signal, progress: async () => {},
        })
        signal.throwIfAborted()
        return modelSearchResult(result?.output)
      })
    },

    async delegate(input: { model: string; prompt: string; description: string; agent?: string }, toolUseID: string): Promise<{ sessionID: string; model: string; output: string }> {
      const { subagent, assistant, info } = await abortable(signal, async () => {
        if (!toolUseID.trim()) throw new Error("Delegation requires a native tool-use ID")
        let ref: Model.Ref
        try {
          ref = Model.Ref.parse(input.model)
        } catch {
          throw new Error(`Invalid model "${input.model}"; use providerID/modelID or providerID/modelID#variant`)
        }
        const { data } = await ctx.model.list()
        signal.throwIfAborted()
        const model = data.find((candidate) => candidate.providerID === ref.providerID && candidate.id === ref.id && (candidate.type === undefined || candidate.type === "chat"))
        if (!model) throw new Error(`Chat model "${input.model}" is not available`)
        if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant)) {
          throw new Error(`Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}"`)
        }
        const tools = await ctx.tool.list()
        signal.throwIfAborted()
        const subagent = tools.find((tool) => tool.id === "subagent")
        if (!subagent) throw new Error("OpenCode subagent tool is unavailable")
        const messages = await ctx.session.context({ sessionID: session })
        signal.throwIfAborted()
        const assistant = messages.findLast((message) => message.type === "assistant")
        if (!assistant) throw new Error("Delegation requires an existing OpenCode assistant message")
        const info = await ctx.session.get({ sessionID: session })
        signal.throwIfAborted()
        return { subagent, assistant, info }
      })
      let childID: string | undefined
      let backgrounded = false
      try {
        signal.throwIfAborted()
        try {
          const result = await subagent.execute({
            agent: input.agent ?? "general", description: input.description, prompt: input.prompt,
            model: input.model, background: false,
          }, {
            sessionID: session, agent: Agent.ID.make(info.agent ?? "build"),
            messageID: SessionMessage.ID.make(assistant.id), id: Tool.CallID.make(toolUseID),
            signal, progress: async (update) => {
              if (typeof update.sessionID === "string" && update.sessionID.trim()) childID = update.sessionID
            },
          })
          const output: unknown = result?.output
          if (record(output) && typeof output.sessionID === "string" && output.sessionID.trim()) childID = output.sessionID
          signal.throwIfAborted()
          if (record(output) && output.status === "running") {
            backgrounded = true
            throw new Error(`OpenCode subagent is running in the background (sessionID: ${childID ?? "unknown"}); only completed foreground delegation is supported. Retry without backgrounding the child.`)
          }
          if (!record(output) || output.status !== "completed" || typeof output.sessionID !== "string" || !output.sessionID.trim() || typeof output.output !== "string" || !output.output.trim()) {
            throw new Error("OpenCode subagent returned an invalid completed result")
          }
          return { sessionID: output.sessionID, model: input.model, output: output.output }
        } finally {
          // Cancellation during prompt admission precedes the core executor's jobs.block interruption handler.
          if ((signal.aborted || backgrounded) && childID) {
            try {
              await ctx.session.interrupt({ sessionID: Session.ID.make(childID), resume: false })
            } catch (error) {
              throw new Error(`Failed to interrupt delegated child (sessionID: ${childID}); interrupt this session before retrying: ${failure(error).message}`)
            }
          }
        }
      } catch (error) {
        throw failure(error)
      }
    },
  }
}
