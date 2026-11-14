import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createRegistry, type Owner } from "../src/registry"

const context = (name: string) => ({
  location: { directory: "/project" },
  session: { get: async () => name },
}) as unknown as Plugin.Context

const fixture = (handoverMs = 50) => {
  const state = { busy: false, created: 0, disposed: 0 }
  const registry = createRegistry<Owner, { id: number; forwarded: Plugin.Context }>({
    async create(_ctx, forwarded) { return { id: ++state.created, forwarded } },
    busy: () => state.busy,
    async dispose() { state.disposed++ },
    handoverMs,
  })
  return { state, registry }
}

test("an idle registry disposes as soon as its last activation detaches", async () => {
  const { state, registry } = fixture()
  const first = await registry.attach("idle", context("first"))
  first.ready({ ctx: context("first") })
  await first.detach()
  expect(state.disposed).toBe(1)
  const second = await registry.attach("idle", context("second"))
  expect(second.value.id).toBe(2)
  await second.detach()
})

test("a busy registry is adopted by the next activation and forwards calls to it", async () => {
  const { state, registry } = fixture()
  const first = await registry.attach("busy", context("first"))
  first.ready({ ctx: context("first") })
  const forwarded = first.value.forwarded
  expect(await forwarded.session.get({} as never) as unknown).toBe("first")
  state.busy = true
  await first.detach()
  // A retained callback during the gap waits for the next owner rather than failing.
  const pending = forwarded.session.get({} as never) as Promise<unknown>
  const second = await registry.attach("busy", context("second"))
  expect(second.value.id).toBe(1)
  second.ready({ ctx: context("second") })
  expect(await pending).toBe("second")
  await Bun.sleep(80)
  expect(state.disposed).toBe(0)
  state.busy = false
  await second.detach()
  expect(state.disposed).toBe(1)
})

test("a busy registry with no successor disposes after the handover window and rejects waiting calls", async () => {
  const { state, registry } = fixture(20)
  const first = await registry.attach("orphan", context("first"))
  first.ready({ ctx: context("first") })
  state.busy = true
  await first.detach()
  const pending = first.value.forwarded.session.get({} as never) as Promise<unknown>
  await expect(pending).rejects.toThrow("Full Claude Agent was unloaded")
  expect(state.disposed).toBe(1)
})

test("an activation still in setup keeps the handover timer from disposing the registry", async () => {
  const { state, registry } = fixture(20)
  const first = await registry.attach("setup", context("first"))
  first.ready({ ctx: context("first") })
  state.busy = true
  await first.detach()
  const second = await registry.attach("setup", context("second"))
  await Bun.sleep(50)
  expect(state.disposed).toBe(0)
  state.busy = false
  await second.detach()
  expect(state.disposed).toBe(1)
})

test("a re-imported registry retires the previous module's unowned registry for the same key", async () => {
  const old = fixture(10_000)
  const first = await old.registry.attach("reimport", context("first"))
  first.ready({ ctx: context("first") })
  old.state.busy = true
  await first.detach()
  const next = fixture()
  const second = await next.registry.attach("reimport", context("second"))
  expect(old.state.disposed).toBe(1)
  await second.detach()
})
