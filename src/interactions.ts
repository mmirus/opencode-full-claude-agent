import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { Plugin } from "@opencode/plugin"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function questions(input: Record<string, unknown>) {
  if (!Array.isArray(input.questions) || input.questions.length === 0) throw new Error("AskUserQuestion requires questions")
  return input.questions.map((question: unknown) => {
    if (!record(question) || typeof question.header !== "string" || typeof question.question !== "string" || !Array.isArray(question.options)) {
      throw new Error("Invalid AskUserQuestion question")
    }
    return {
      header: question.header,
      question: question.question,
      options: question.options.map((option: unknown) => {
        if (!record(option) || typeof option.label !== "string" || typeof option.description !== "string") {
          throw new Error("Invalid AskUserQuestion option")
        }
        return { label: option.label, description: option.description }
      }),
      multiple: question.multiSelect === true,
    }
  })
}

function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return operation()
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

export function createInteractions(ctx: Plugin.Context, sessionID: string, signal: AbortSignal): {
  canUseTool: NonNullable<Options["canUseTool"]>
} {
  const session = Session.ID.make(sessionID)
  return {
    async canUseTool(toolName, input, callbackOptions) {
      const combined = AbortSignal.any([signal, callbackOptions.signal])
      try {
        return await abortable(combined, async () => {
          if (toolName === "AskUserQuestion") {
            const mapped = questions(input)
            const tools = await ctx.tool.list()
            combined.throwIfAborted()
            const question = tools.find((tool) => tool.id === "question")
            if (!question) throw new Error("OpenCode question tool is unavailable")
            const messages = await ctx.session.context({ sessionID: session })
            combined.throwIfAborted()
            const assistant = messages.findLast((message) => message.type === "assistant")
            if (!assistant) throw new Error("AskUserQuestion requires an existing OpenCode assistant message")
            const info = await ctx.session.get({ sessionID: session })
            combined.throwIfAborted()
            const result = await question.execute({ questions: mapped }, {
              sessionID: session,
              agent: Agent.ID.make(info.agent ?? "build"),
              messageID: SessionMessage.ID.make(assistant.id),
              id: Tool.CallID.make(callbackOptions.toolUseID),
              signal: combined,
              progress: async () => {},
            })
            combined.throwIfAborted()
            const output: unknown = result.output
            if (!record(output) || !Array.isArray(output.answers) || output.answers.length !== mapped.length) {
              throw new Error("OpenCode question tool returned invalid answers")
            }
            const returnedAnswers = output.answers
            const answers = Object.fromEntries(mapped.map((question, index) => {
              const answer: unknown = returnedAnswers[index]
              if (!Array.isArray(answer) || !answer.every((value: unknown) => typeof value === "string")) {
                throw new Error("OpenCode question tool returned invalid answers")
              }
              return [question.question, answer.join(", ")]
            }))
            return { behavior: "allow" as const, updatedInput: { ...input, answers } }
          }

          const edit = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)
          const action = toolName === "Bash" ? "shell" : edit ? "edit" : toolName === "Read" ? "read" : `claude.${toolName}`
          const resource = toolName === "Bash" ? input.command : edit || toolName === "Read" ? input.file_path ?? input.notebook_path : toolName
          if (typeof resource !== "string" || resource.length === 0) throw new Error(`${toolName} requires a permission resource`)
          // assert has no signal: an aborted callback can leave a pending OpenCode permission prompt.
          await ctx.permission.assert({ sessionID: session, action, resources: [resource], metadata: { toolName, input } })
          combined.throwIfAborted()
          return { behavior: "allow" as const, updatedInput: input }
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : typeof error === "string" ? error : ""
        return {
          behavior: "deny",
          message: combined.aborted ? "Tool request aborted" : reason.trim() || "Tool request denied by OpenCode.",
        }
      }
    },
  }
}
