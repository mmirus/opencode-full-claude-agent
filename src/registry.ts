import type { Plugin } from "@opencode/plugin"

export const HANDOVER_MS = 10_000
// Each import of this module creates its own registry, so a re-imported plugin cannot adopt the old one; the anchor lets it retire them.
const ANCHOR = Symbol.for("opencode-full-claude-agent/registries")
const FORWARDED = ["model", "permission", "provider", "session", "storage", "tool"] as const

export interface Owner { ctx: Plugin.Context }
interface Successor { supersede(key: string): Promise<void> }
interface Slot<O, T> {
  value: Promise<T>
  owners: O[]
  // Attached activations, including any still in setup; only an unattached slot may close.
  handles: number
  waiters: Set<ReturnType<typeof Promise.withResolvers<O>>>
  handover?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
}

/**
 * Retains plugin-owned resources across activations of the same module. `create` may use the attaching `ctx` during
 * setup; retained code must reach the host through `forwarded`, which calls the most recently attached owner and waits
 * for one while no activation is attached.
 */
export function createRegistry<O extends Owner, T>(options: {
  create(ctx: Plugin.Context, forwarded: Plugin.Context, current: () => O | undefined): Promise<T>
  busy(value: T): boolean
  dispose(value: T): Promise<void>
  handoverMs?: number
}) {
  const slots = new Map<string, Slot<O, T>>()
  const registries: Set<Successor> = ((globalThis as Record<symbol, unknown>)[ANCHOR] ??= new Set<Successor>()) as Set<Successor>

  const close = (key: string, slot: Slot<O, T>) => slot.closing ??= (async () => {
    clearTimeout(slot.handover)
    if (slots.get(key) === slot) slots.delete(key)
    for (const waiter of slot.waiters) waiter.reject(new Error("Full Claude Agent was unloaded"))
    slot.waiters.clear()
    await options.dispose(await slot.value)
  })()

  const self: Successor = {
    async supersede(key) {
      const slot = slots.get(key)
      if (slot && !slot.handles) await close(key, slot)
    },
  }
  registries.add(self)

  const forward = (slot: Slot<O, T>, location: Plugin.Context["location"]) => {
    const owner = () => {
      const current = slot.owners.at(-1)
      if (current) return Promise.resolve(current)
      if (slot.closing) return Promise.reject(new Error("Full Claude Agent was unloaded"))
      const waiter = Promise.withResolvers<O>()
      slot.waiters.add(waiter)
      return waiter.promise
    }
    const namespace = (name: typeof FORWARDED[number]) => new Proxy({}, {
      get: (_, method) => (...args: unknown[]) => owner().then(({ ctx }) => {
        const target = ctx[name] as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>
        return target[method]!(...args)
      }),
    })
    return { location, ...Object.fromEntries(FORWARDED.map((name) => [name, namespace(name)])) } as unknown as Plugin.Context
  }

  return {
    async attach(key: string, ctx: Plugin.Context) {
      let slot = slots.get(key)
      if (slot?.closing) {
        await slot.closing
        slot = slots.get(key)
      }
      if (!slot) {
        await Promise.all([...registries].filter((registry) => registry !== self).map((registry) => registry.supersede(key)))
        slot = slots.get(key)
      }
      if (!slot) {
        const created: Slot<O, T> = { value: undefined!, owners: [], handles: 0, waiters: new Set() }
        created.value = options.create(ctx, forward(created, ctx.location), () => created.owners.at(-1))
        slots.set(key, created)
        slot = created
        try { await created.value } catch (error) {
          if (slots.get(key) === created) slots.delete(key)
          throw error
        }
      }
      const attached = slot
      clearTimeout(attached.handover)
      attached.handover = undefined
      attached.handles++
      const value = await attached.value
      let owner: O | undefined
      let detached = false
      return {
        value,
        /** Makes this activation the target of forwarded calls; call once its registrations exist. */
        ready(next: O) {
          if (detached || attached.closing) return
          owner = next
          attached.owners.push(next)
          for (const waiter of attached.waiters) waiter.resolve(next)
          attached.waiters.clear()
        },
        async detach() {
          if (detached) return
          detached = true
          attached.handles--
          if (owner) attached.owners.splice(attached.owners.indexOf(owner), 1)
          if (attached.handles || attached.closing || slots.get(key) !== attached) return
          if (!options.busy(value)) return close(key, attached)
          clearTimeout(attached.handover)
          attached.handover = setTimeout(() => {
            if (!attached.handles) void close(key, attached).catch((error) => console.error("Full Claude Agent unload failed", error))
          }, options.handoverMs ?? HANDOVER_MS)
        },
      }
    },
  }
}
