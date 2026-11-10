import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

export type BashObservation = { command: string; source: "PostToolUse" }

type Call = {
  parent: string | null
  bash: boolean
  completed: boolean
  ambiguous: boolean
  observation?: BashObservation
}

const extensions = new WeakMap<SDKMessage, Readonly<Record<string, BashObservation>>>()

export function bashObservation(message: SDKMessage, toolUseID: string): BashObservation | undefined {
  return extensions.get(message)?.[toolUseID]
}

export function createBashProvenance(nativeID: string): {
  hooks: NonNullable<Options["hooks"]>
  observe(message: SDKMessage): SDKMessage
  close(): void
} {
  // Completed IDs remain tombstones: evicting them could let a late callback
  // attach to a reused ID. Beyond this query-wide cap, new IDs stay unknown.
  const limit = 4096
  const calls = new Map<string, Call>()
  let closed = false

  const callback: HookCallback = async (input, toolUseID, { signal }) => {
    if (closed || signal.aborted || input.hook_event_name !== "PostToolUse" ||
      input.session_id !== nativeID || input.tool_name !== "Bash" ||
      !toolUseID || input.tool_use_id !== toolUseID) return {}
    const call = calls.get(toolUseID)
    if (!call || !call.bash || call.completed || call.ambiguous) return {}
    const command = input.tool_input && typeof input.tool_input === "object" &&
      "command" in input.tool_input ? input.tool_input.command : undefined
    if (typeof command !== "string" ||
      (call.observation && call.observation.command !== command)) {
      call.ambiguous = true
      call.observation = undefined
    } else {
      call.observation = Object.freeze({ command, source: "PostToolUse" })
    }
    return {}
  }

  return {
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [callback] }] },
    observe(message) {
      if (closed || message.session_id !== nativeID) return message
      if (message.type !== "assistant" && message.type !== "user") return message
      const content = message.message.content
      if (!Array.isArray(content)) return message
      const parent = message.parent_tool_use_id
      if (message.type === "assistant") {
        for (const block of content) {
          if (block.type !== "tool_use") continue
          const call = calls.get(block.id)
          if (call) {
            if (call.parent !== parent || call.bash !== (block.name === "Bash")) {
              call.ambiguous = true
              call.observation = undefined
            }
          } else if (calls.size < limit) {
            calls.set(block.id, { parent, bash: block.name === "Bash", completed: false, ambiguous: false })
          }
        }
        return message
      }

      const results = content.filter((block) => block.type === "tool_result")
      if (!results.length) return message
      const observations: Record<string, BashObservation> = Object.create(null)
      const seen = new Set<string>()
      for (const block of results) {
        const id = block.tool_use_id
        const call = calls.get(id)
        if (seen.has(id)) delete observations[id]
        else if (call && call.parent === parent && !call.completed && !call.ambiguous && call.bash && call.observation) {
          observations[id] = call.observation
        }
        seen.add(id)
        if (call) {
          call.completed = true
          call.observation = undefined
        } else if (calls.size < limit) {
          calls.set(id, { parent, bash: false, completed: true, ambiguous: true })
        }
      }
      // A result may be buffered past query cleanup. Keep evidence on that
      // frame, not in a lookup of the query's mutable call state.
      const snapshot = Object.freeze(observations)
      const annotated = { ...message, fullClaudeBash: snapshot }
      extensions.set(annotated, snapshot)
      return annotated
    },
    close() {
      closed = true
      calls.clear()
    },
  }
}
