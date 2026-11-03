import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { makePlugin } from "../src/index"

test("reloaded registrations cannot reuse a cached model from a disposed runtime", async () => {
  const plugin = makePlugin()
  const providers: Array<{ info: { id: string; settings: Record<string, unknown> } }> = []
  const registration = { dispose: async () => {} }
  const ctx = {
    options: {},
    location: { directory: process.cwd() },
    storage: { get: async () => undefined, set: async () => {} },
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
