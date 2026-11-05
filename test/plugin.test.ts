import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { makePlugin } from "../src/index"
import type { SessionTitle, SessionContext } from "@opencode/plugin/promise/session"
import { emptyUsage } from "../src/background"

test("background delivery controls are removed by message identity without hiding real user text", async () => {
  let context!: (event: SessionContext) => Promise<void>
  const text = "Full Claude Agent background response available."
  const registration = { dispose: async () => {} }
  const ctx = {
    options: {}, location: { directory: process.cwd() },
    storage: { get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: { register: async () => ({ ...registration, events: { emit: async () => {} } }) },
    provider: { transform: async () => registration }, aisdk: { hook: async () => registration },
    session: {
      hook: async (name: string, handler: typeof context) => { if (name === "context") context = handler; return registration },
      context: async () => [
        { id: "msg_control", type: "synthetic", text, metadata: { fullClaudeAgentBackground: {
          id: "result", providerID: "full-claude-agent", nativeID: "native", binding: "binding", text: "Completed", usage: emptyUsage(),
        } } },
        { id: "msg_user", type: "user", text },
        { id: "msg_other", type: "synthetic", text },
      ],
    },
    command: { transform: async () => registration },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    } },
  } as unknown as Plugin.Context
  const dispose = await makePlugin().setup(ctx)
  try {
    const event = { sessionID: "ses_test", options: {}, tools: {},
      messages: ["msg_control", "msg_user", "msg_other"].map((id) => ({ id, role: "user", content: [{ type: "text", text }] })),
    } as unknown as SessionContext
    await context(event)
    expect(event.messages.map((message) => message.id)).toEqual(["msg_user", "msg_other"])
  } finally { await dispose?.() }
})

test.each([
  ["Here is the first message of the conversation:\n\n<message>\nCan we add a Pomodoro indicator to our waybar config?\n</message>\n\nReply with only the title.", "Can we add a Pomodoro indicator to our waybar config?", "Can we add a Pomodoro indicator to our waybar config?"],
  ["Here is the conversation so far:\n\n<conversation>\nOriginal request: original\nRecent conversation: unrelated\n</conversation>\n\nReply with only the title.", "  Add a\n Pomodoro indicator  ", "Add a Pomodoro indicator"],
  ["Wrapper text", "Explain the literal <message> tag", "Explain the literal <message> tag"],
  ["Wrapper text", "", "Full Claude Agent"],
])("title uses saved user text rather than title instructions: %s", async (wrapper, request, expected) => {
  let title!: (event: SessionTitle) => Promise<void>
  const registration = { dispose: async () => {} }
  const ctx = {
    options: {}, location: { directory: process.cwd() },
    storage: { get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: { register: async () => ({ ...registration, events: { emit: async () => {} } }) },
    provider: { transform: async () => registration },
    aisdk: { hook: async () => registration },
    session: {
      hook: async (name: string, handler: typeof title) => { if (name === "title") title = handler; return registration },
      context: async ({ sessionID }: { sessionID: string }) => {
        expect(sessionID).toBe("ses_title")
        return [{ id: "msg_user", type: "user", text: request }, { id: "msg_later", type: "user", text: "Unrelated follow-up" }]
      },
    },
    command: { transform: async () => registration },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    } },
  } as unknown as Plugin.Context
  const dispose = await makePlugin().setup(ctx)
  try {
    const event = { sessionID: "ses_title", messages: [{ role: "user", content: [{ type: "text", text: wrapper }] }] } as unknown as SessionTitle
    await title(event)
    expect(event.result).toBe(expected)
  } finally { await dispose?.() }
})

test("reloaded registrations cannot reuse a cached model from a disposed runtime", async () => {
  const plugin = makePlugin()
  const providers: Array<{ info: { id: string; settings: Record<string, unknown> } }> = []
  const registration = { dispose: async () => {} }
  const ctx = {
    options: {},
    location: { directory: process.cwd() },
    storage: { get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: { register: async () => ({ ...registration, events: { emit: async () => {} } }) },
    provider: { transform: async (callback: (editor: unknown) => void) => {
      callback({ add: (provider: typeof providers[number]) => providers.push(provider) })
      return registration
    } },
    aisdk: { hook: async () => registration },
    session: { hook: async () => registration },
    command: { transform: async () => registration },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    } },
  } as unknown as Plugin.Context
  const first = await plugin.setup(ctx)
  await first?.()
  const second = await plugin.setup(ctx)
  await second?.()
  expect(providers.map((provider) => provider.info.id)).toEqual(["full-claude-agent", "full-claude-agent"])
  expect(providers[0]!.info.settings.fullClaudeRuntime).toBeString()
  expect(providers[0]!.info.settings.fullClaudeRuntime).not.toBe(providers[1]!.info.settings.fullClaudeRuntime)
})
