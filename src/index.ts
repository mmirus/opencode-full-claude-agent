import { Model, Plugin, Provider } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { parseProfiles } from "./config.js"
import { FullClaudeModel, KIND_HEADER } from "./model.js"
import { Runtime } from "./runtime.js"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { requestContext } from "./request-context.js"
import { backgroundMetadata, createBackgroundPublisher } from "./background.js"
import { NativeTaskStore } from "./tasks.js"
import { NativeTasks } from "./task-rpc.js"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { ModelCatalog, probeClaudeModels, type ModelProbe } from "./models.js"
import { createRegistry, type Owner } from "./registry.js"

const PACKAGE = "opencode-full-claude-agent/runtime"

interface ActivationOwner extends Owner {
  catalog: ModelCatalog
  changed(sessionID: string): Promise<void>
}

// Module-level so a reactivation that does not re-import this module adopts live native sessions instead of interrupting them.
const retained = createRegistry<ActivationOwner, { runtime: Runtime; tasks: NativeTaskStore; background: ReturnType<typeof createBackgroundPublisher>; ctx: Plugin.Context }>({
  async create(ctx, forwarded, current) {
    const tasks = new NativeTaskStore(ctx.storage, async (sessionID) => { await current()?.changed(sessionID) })
    await tasks.restore()
    const background = createBackgroundPublisher(forwarded)
    const runtime = new Runtime(forwarded.storage, undefined, background.publish, tasks,
      async (profile, models, account, binding) => { await current()?.catalog.update(profile, models, account, binding) },
      async (profile) => {
        const owner = current()
        if (!owner) throw new Error("Full Claude Agent was unloaded")
        return owner.catalog.capture(profile)
      })
    return { runtime, tasks, background, ctx: forwarded }
  },
  busy: ({ runtime, tasks }) => runtime.busy() || tasks.running(),
  async dispose({ runtime, tasks, background }) {
    background.stop()
    await runtime.dispose()
    await tasks.dispose()
  },
})

export const makePlugin = (lease?: (sessionID: string) => () => void, probe: ModelProbe = probeClaudeModels) => Plugin.define({
  id: "full-claude-agent",
  async setup(ctx) {
    const profiles = parseProfiles(ctx.options, ctx.location.directory)
    // OpenCode 2.2.5 caches model instances across hook disposal; each plugin lifetime needs a fresh key.
    const lifetime = randomUUID()
    const catalog = new ModelCatalog(ctx.storage, profiles, ctx.location.directory, () => ctx.provider.reload(), probe)
    await catalog.load()
    const handle = await retained.attach(JSON.stringify([ctx.location.directory, ctx.location.workspaceID ?? null]), ctx)
    const { runtime, tasks, background } = handle.value
    let taskRPC: RpcRegistration<typeof NativeTasks> | undefined
    const abort = new AbortController()
    let events: Promise<void> | undefined
    try {
      taskRPC = await ctx.rpc.register(NativeTasks, {
        list: async ({ sessionID }) => ({ tasks: tasks.list(sessionID) }),
        output: ({ sessionID, id }) => tasks.output(sessionID, id),
        stop: ({ sessionID, id }) => tasks.stop(sessionID, id),
      })
      await ctx.provider.transform((editor) => {
        for (const profile of profiles) {
          const id = Provider.ID.make(profile.id)
          editor.add({
            info: { ...Provider.Info.empty(id), name: profile.name, activation: "enabled", package: `aisdk:${PACKAGE}`, settings: { fullClaudeRuntime: lifetime, cache: { warming: false } } },
            models: catalog.get(profile.id).map((model) => ({
              ...Model.Info.default(id, Model.ID.make(model.id)),
              name: model.name,
              limit: { context: 0, output: 0 },
              capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
              cost: [],
              variants: model.efforts.map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
            })),
          })
        }
      })

      for (const profile of profiles) {
        const scope = { providerID: profile.id }
        await ctx.aisdk.hook("sdk", (event) => {
          if (event.package !== PACKAGE) return
          event.sdk = { languageModel: (modelID: string) => new FullClaudeModel(modelID, profile, handle.value.ctx, runtime, lease) }
        }, scope)
        await ctx.session.hook("model.request", (event) => { event.headers[KIND_HEADER] = event.kind }, scope)
        await ctx.session.hook("context", (event) => {
          event.messages = event.messages.filter((message) => backgroundMetadata(message.metadata)?.providerID !== profile.id)
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

      events = (async () => {
        for await (const event of ctx.event.subscribe({ signal: abort.signal, types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] })) {
          const sessionID = event.data.sessionID
          try {
            await runtime.checkpoint(sessionID, () => ctx.session.context({ sessionID }))
          } catch (error) { console.error("Full Claude Agent checkpoint failed", error) }
        }
      })().catch((error) => { if (!abort.signal.aborted) console.error("Full Claude Agent checkpoint failed", error) })
      const rpc = taskRPC
      handle.ready({ ctx, catalog, changed: async (sessionID) => { await rpc.events.emit("changed", { sessionID }) } })
      void background.recover().catch((error) => console.error("Full Claude Agent background recovery failed", error))
      void catalog.refresh()
    } catch (error) {
      abort.abort()
      await handle.detach()
      await catalog.dispose()
      await taskRPC?.dispose()
      throw error
    }
    return async () => {
      abort.abort()
      await handle.detach()
      await catalog.dispose()
      await taskRPC?.dispose()
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
