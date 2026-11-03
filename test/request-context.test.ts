import { expect, test } from "bun:test"
import { Context, Effect, Option, Stream } from "effect"
import type { Context as EffectPluginContext } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { Plugin } from "@opencode/plugin"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { requestContext } from "../src/request-context"

class RequestLocation extends Context.Service<RequestLocation, string>()("test/RequestLocation") {}

function withRequestContext(run: (fixture: {
  ctx: Plugin.Context
  capture: (sessionID: string, directory: string) => Promise<Context.Context<never>>
  lease: (sessionID: string) => () => void
  observed: Array<string | undefined>
}) => Promise<void>, question?: Effect.Effect<{ output: { answers: string[][] } }>) {
  const captures: Array<(input: SessionHooks["context"]) => Effect.Effect<void>> = []
  const contexts = new Map<string, Context.Context<RequestLocation>>()
  const registration = { dispose: Effect.void }
  const observed: Array<string | undefined> = []
  const recordLocation = Effect.serviceOption(RequestLocation).pipe(Effect.map((location) => {
    observed.push(Option.getOrUndefined(location))
  }))
  const noopDomain: any = new Proxy(() => Effect.succeed(undefined), { get: () => noopDomain })
  const host = new Proxy({
    ...Object.fromEntries(["agent", "aisdk", "command", "credential", "experimental", "generate", "integration", "mcp", "model", "plugin", "provider", "reference", "rpc", "shell", "skill", "storage", "vcs", "websearch", "worktree"].map((name) => [name, noopDomain])),
    app: { version: "2.2.5" }, options: {}, location: { directory: "/setup" },
    session: new Proxy({ hook: (_name: string, callback: typeof captures[number]) => Effect.sync(() => { captures.push(callback); return registration }) }, { get: (target, key) => Reflect.get(target, key) ?? noopDomain }),
    event: { subscribe: () => Stream.never },
    tool: { list: () => Effect.succeed([{ id: "question", name: "question", input: {}, description: "test", execute: () => question ?? recordLocation.pipe(Effect.as({ output: { answers: [["Blue"]] } })) }]) },
    permission: { assert: () => recordLocation },
  }, { get: (target, key) => Reflect.get(target, key) ?? noopDomain }) as unknown as EffectPluginContext
  let promiseCtx!: Plugin.Context
  const adapter = fromPromise({ id: "test", setup: (ctx) => { promiseCtx = ctx } })
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const wrapped = yield* requestContext(host, ["full-claude-agent"])
    yield* adapter.effect(wrapped.ctx)
    yield* Effect.promise(() => run({
      ctx: promiseCtx,
      capture: async (sessionID, directory) => {
        const event = { sessionID: Session.ID.make(sessionID), model: { providerID: "full-claude-agent" } } as SessionHooks["context"]
        let context = contexts.get(directory)
        if (!context) {
          context = Context.make(RequestLocation, directory)
          contexts.set(directory, context)
        }
        return Effect.runPromiseWith(context)(Effect.gen(function* () {
          for (const capture of captures) yield* capture(event)
          return yield* Effect.context<never>()
        }))
      },
      lease: wrapped.lease,
      observed,
    }))
  })))
}

function executeQuestion(ctx: Plugin.Context, sessionID: string, signal = new AbortController().signal) {
  return ctx.tool.list().then((tools) => tools[0]!.execute({}, {
    sessionID: Session.ID.make(sessionID), agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_test"), id: Tool.CallID.make("tool_test"),
    signal, progress: async () => {},
  }))
}

function assertPermission(ctx: Plugin.Context, sessionID: string) {
  return ctx.permission.assert({ sessionID: Session.ID.make(sessionID), action: "read", resources: ["test"] })
}

test("native callbacks preserve the location from each session request through the Promise adapter", async () => {
  await withRequestContext(async ({ ctx, capture, observed }) => {
    await capture("ses_first", "/first")
    await capture("ses_second", "/second")
    for (const id of ["ses_first", "ses_second"]) {
      await executeQuestion(ctx, id)
      await assertPermission(ctx, id)
    }
    expect(observed).toEqual(["/first", "/first", "/second", "/second"])
  })
})

test("native callbacks reject a session without captured request context", async () => {
  await withRequestContext(async ({ ctx, capture, lease, observed }) => {
    await capture("ses_other", "/other")
    await expect(executeQuestion(ctx, "ses_missing")).rejects.toThrow("No active Full Claude Agent request context")
    await expect(assertPermission(ctx, "ses_missing")).rejects.toThrow("No active Full Claude Agent request context")
    expect(() => lease("ses_missing")).toThrow("No active Full Claude Agent request context")
    expect(observed).toEqual([])
  })
})

test("aborting a Promise question interrupts the raw Effect with its request location", async () => {
  const started = Promise.withResolvers<void>()
  const interrupted: Array<string | undefined> = []
  const question = Effect.sync(() => started.resolve()).pipe(
    Effect.andThen(Effect.never),
    Effect.onInterrupt(() => Effect.serviceOption(RequestLocation).pipe(Effect.map((location) => {
      interrupted.push(Option.getOrUndefined(location))
    }))),
  )
  await withRequestContext(async ({ ctx, capture }) => {
    await capture("ses_question", "/question")
    const controller = new AbortController()
    const execution = executeQuestion(ctx, "ses_question", controller.signal)
    await started.promise
    controller.abort()
    await expect(execution).rejects.toThrow()
    expect(interrupted).toEqual(["/question"])
  }, question)
})

test("releasing a request lease removes its captured context", async () => {
  await withRequestContext(async ({ ctx, capture, lease, observed }) => {
    await capture("ses_request", "/request")
    const release = lease("ses_request")
    await executeQuestion(ctx, "ses_request")
    await assertPermission(ctx, "ses_request")
    release()
    release()
    await expect(executeQuestion(ctx, "ses_request")).rejects.toThrow("No active Full Claude Agent request context")
    await expect(assertPermission(ctx, "ses_request")).rejects.toThrow("No active Full Claude Agent request context")
    expect(observed).toEqual(["/request", "/request"])
  })
})

test("a native-process lease retains session context between foreground requests", async () => {
  await withRequestContext(async ({ ctx, capture, lease, observed }) => {
    await capture("ses_native", "/native")
    const releaseTurn = lease("ses_native")
    const releaseNative = lease("ses_native")
    releaseTurn()
    await assertPermission(ctx, "ses_native")
    await capture("ses_native", "/native")
    const releaseNext = lease("ses_native")
    releaseNext()
    await assertPermission(ctx, "ses_native")
    expect(observed).toEqual(["/native", "/native"])
    releaseNative()
    await expect(assertPermission(ctx, "ses_native")).rejects.toThrow("No active Full Claude Agent request context")
  })
})

test("releasing a lease does not discard a newly captured request before its model acquires a lease", async () => {
  await withRequestContext(async ({ ctx, capture, lease }) => {
    await capture("ses_request", "/request")
    const release = lease("ses_request")
    await capture("ses_request", "/request")
    release()
    const releaseNext = lease("ses_request")
    await assertPermission(ctx, "ses_request")
    releaseNext()
    await expect(assertPermission(ctx, "ses_request")).rejects.toThrow("No active Full Claude Agent request context")
  })
})

test.each(["/newer", "/older"])("releasing an older lease preserves a newer capture with location %s", async (directory) => {
  await withRequestContext(async ({ ctx, capture, lease, observed }) => {
    const olderContext = await capture("ses_request", "/older")
    const releaseOlder = lease("ses_request")
    const newerContext = await capture("ses_request", directory)
    if (directory === "/older") expect(newerContext).toBe(olderContext)
    const releaseNewer = lease("ses_request")
    releaseOlder()
    await executeQuestion(ctx, "ses_request")
    await assertPermission(ctx, "ses_request")
    expect(observed).toEqual([directory, directory])
    releaseNewer()
    await expect(executeQuestion(ctx, "ses_request")).rejects.toThrow("No active Full Claude Agent request context")
    await expect(assertPermission(ctx, "ses_request")).rejects.toThrow("No active Full Claude Agent request context")
  })
})
