import { Model, Plugin, Provider } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { parseProfiles } from "./config.js"
import { FullClaudeModel, KIND_HEADER } from "./model.js"
import { Runtime } from "./runtime.js"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { requestContext } from "./request-context.js"
import { backgroundResponse, createBackgroundPublisher } from "./background.js"

const PACKAGE = "opencode-full-claude-agent/runtime"

export const makePlugin = (lease?: (sessionID: string) => () => void) => Plugin.define({
  id: "full-claude-agent",
  async setup(ctx) {
    const profiles = parseProfiles(ctx.options, ctx.location.directory)
    // OpenCode 2.2.5 caches model instances across hook disposal; each plugin lifetime needs a fresh key.
    const lifetime = randomUUID()
    const background = createBackgroundPublisher(ctx)
    const runtime = new Runtime(ctx.storage, undefined, background.publish)

    await ctx.provider.transform((editor) => {
      for (const profile of profiles) {
        const id = Provider.ID.make(profile.id)
        editor.add({
          info: { ...Provider.Info.empty(id), name: profile.name, activation: "enabled", package: `aisdk:${PACKAGE}`, settings: { fullClaudeRuntime: lifetime } },
          models: profile.models.map((name) => ({
            ...Model.Info.default(id, Model.ID.make(name)),
            name,
            limit: { context: 0, output: 0 },
            capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
            cost: [],
            variants: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
          })),
        })
      }
    })

    for (const profile of profiles) {
      const scope = { providerID: profile.id }
      await ctx.aisdk.hook("sdk", (event) => {
        if (event.package !== PACKAGE) return
        event.sdk = { languageModel: (modelID: string) => new FullClaudeModel(modelID, profile, ctx, runtime, lease) }
      }, scope)
      await ctx.session.hook("model.request", (event) => { event.headers[KIND_HEADER] = event.kind }, scope)
      await ctx.session.hook("context", async (event) => {
        const history = await ctx.session.context({ sessionID: event.sessionID })
        const control = new Set(history.filter((message) => backgroundResponse(message)?.providerID === profile.id).map((message) => message.id))
        event.messages = event.messages.filter((message) => !message.id || !control.has(message.id))
        event.tools = {}
        delete event.options.maxTokens
      }, scope)
      await ctx.session.hook("retry", (event) => { event.decision = { retry: false } }, scope)
      await ctx.session.hook("title", async (event) => {
        const messages = await ctx.session.context({ sessionID: event.sessionID })
        const text = messages.find((message) => message.type === "user")?.text ?? ""
        event.result = text.replace(/\s+/g, " ").trim().slice(0, 80) || "Full Claude Agent"
      }, scope)
      await ctx.session.hook("compaction", () => {
        throw new Error("Full Claude Agent uses native Claude compaction. OpenCode compaction is not supported; start a new session if the host history must be shortened.")
      }, scope)
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "full-claude",
        description: "Run a command provided by your Claude configuration, such as /full-claude /plugin:command",
        execute: async ({ sessionID, prompt, delivery }) => {
          const session = await ctx.session.get({ sessionID })
          const model = session.model
          if (!model || !profiles.some((profile) => profile.id === model.providerID)) {
            throw new Error("Select a Full Claude Agent model before invoking a native Claude command")
          }
          await ctx.session.prompt({ ...prompt, sessionID, delivery })
        },
      })
    })

    const abort = new AbortController()
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal, types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] })) {
        const sessionID = event.data.sessionID
        try {
          await runtime.checkpoint(sessionID, () => ctx.session.context({ sessionID }))
        } catch (error) { console.error("Full Claude Agent checkpoint failed", error) }
      }
    })().catch((error) => { if (!abort.signal.aborted) console.error("Full Claude Agent checkpoint failed", error) })
    void background.recover().catch((error) => console.error("Full Claude Agent background recovery failed", error))
    return async () => {
      background.stop()
      abort.abort()
      await runtime.dispose()
      await events
    }
  },
})

export default EffectPlugin.define({
  id: "full-claude-agent",
  effect: (ctx) => Effect.gen(function* () {
    const profiles = parseProfiles(ctx.options, ctx.location.directory)
    const bridge = yield* requestContext(ctx, profiles.map((profile) => profile.id))
    yield* fromPromise(makePlugin(bridge.lease)).effect(bridge.ctx)
  }),
})
