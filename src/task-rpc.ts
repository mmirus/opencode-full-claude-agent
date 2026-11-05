import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const NativeTask = z.object({
  id: z.string(),
  sessionID: z.string(),
  providerID: z.string(),
  taskID: z.string(),
  description: z.string(),
  kind: z.string(),
  state: z.enum(["running", "completed", "failed", "stopped", "unknown"]),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().optional(),
  parentTaskID: z.string().optional(),
  toolCallID: z.string().optional(),
  ambient: z.boolean(),
  canStop: z.boolean(),
  hasOutput: z.boolean(),
  detail: z.string().optional(),
})
export type NativeTask = z.infer<typeof NativeTask>

export const NativeTasks = Rpc.define({
  id: "full-claude-agent.tasks",
  methods: {
    list: {
      input: z.object({ sessionID: z.string() }),
      output: z.object({ tasks: z.array(NativeTask) }),
    },
    output: {
      input: z.object({ sessionID: z.string(), id: z.string() }),
      output: z.object({ text: z.string(), truncated: z.boolean(), available: z.boolean(), reason: z.string().optional() }),
    },
    stop: {
      input: z.object({ sessionID: z.string(), id: z.string() }),
      output: z.object({ requested: z.boolean() }),
    },
  },
  events: {
    changed: { schema: z.object({ sessionID: z.string() }) },
  },
})
