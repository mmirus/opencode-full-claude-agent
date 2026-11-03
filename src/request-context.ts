import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Context, Effect } from "effect"

export function requestContext(ctx: PluginContext, providerIDs: readonly string[]) {
  return Effect.gen(function* () {
    const requests = new Map<string, { context: Context.Context<never>; leased?: boolean }>()
    const leases = new Map<string, number>()
    yield* Effect.addFinalizer(() => Effect.sync(() => { requests.clear(); leases.clear() }))
    for (const providerID of providerIDs) {
      yield* ctx.session.hook("context", (event) => Effect.gen(function* () {
        // External plugin setup lacks the Location service that routes live form events to clients.
        requests.set(event.sessionID, { context: yield* Effect.context<never>() })
      }), { providerID })
    }
    const run = <A, E>(sessionID: string, operation: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        const context = requests.get(sessionID)
        if (!context) return Effect.die(new Error("No active Full Claude Agent request context"))
        return operation().pipe(Effect.provide(context.context))
      })
    return {
      ctx: {
        ...ctx,
        tool: {
          ...ctx.tool,
          list: () => ctx.tool.list().pipe(Effect.map((tools) => tools.map((tool) => ({
            ...tool,
            execute: (input, context) => run(context.sessionID, () => tool.execute(input, context)),
          })))),
        },
        permission: {
          ...ctx.permission,
          assert: (input) => run(input.sessionID, () => ctx.permission.assert(input)),
        },
      } satisfies PluginContext,
      lease: (sessionID: string) => {
        const context = requests.get(sessionID)
        if (!context) throw new Error("No active Full Claude Agent request context")
        context.leased = true
        leases.set(sessionID, (leases.get(sessionID) ?? 0) + 1)
        let released = false
        return () => {
          if (released) return
          released = true
          const remaining = (leases.get(sessionID) ?? 1) - 1
          if (remaining) leases.set(sessionID, remaining)
          else {
            leases.delete(sessionID)
            const current = requests.get(sessionID)
            if (current === context || current?.leased) requests.delete(sessionID)
          }
        }
      },
    }
  })
}
