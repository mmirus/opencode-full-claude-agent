import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createDelegationMcp, type ActiveDelegation } from "../src/delegation-mcp"

const input = { model: "example/reviewer", prompt: "Review the change", description: "Review change" }
const result = { sessionID: "ses_child", model: input.model, output: "Reviewed" }
const models = { models: [{ model: input.model, name: "Reviewer", providerID: "example", providerName: "Example", released: 1, status: "active", variants: [`${input.model}#high`] }], total: 1, truncated: false, next: null }
const searchMeta = { "claudecode/toolUseId": "toolu_search" }

async function fixture(run: (value: {
  client: Client
  setActive: (value: ActiveDelegation | undefined) => void
  parent: AbortController
  calls: Array<{ input: unknown; toolUseID: string; signal: AbortSignal }>
  searches: Array<{ input: unknown; toolUseID: string }>
}) => Promise<void>) {
  const parent = new AbortController()
  const calls: Array<{ input: unknown; toolUseID: string; signal: AbortSignal }> = []
  const searches: Array<{ input: unknown; toolUseID: string }> = []
  let active: ActiveDelegation | undefined = { signal: parent.signal, createHost: (signal) => ({
    listModels: async (input, toolUseID) => { searches.push({ input, toolUseID }); return models },
    delegate: async (input, toolUseID) => { calls.push({ input, toolUseID, signal }); return result },
  }) }
  const sdk = createDelegationMcp(() => active)
  const client = new Client({ name: "delegation-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await sdk.instance.connect(serverTransport)
  await client.connect(clientTransport)
  try { await run({ client, setActive: (value) => { active = value }, parent, calls, searches }) }
  finally { await client.close(); await sdk.instance.close() }
}

test("advertises only model discovery and foreground delegation and returns exact model refs", async () => {
  await fixture(async ({ client, searches }) => {
    const list = await client.listTools()
    expect(list.tools.map((item) => item.name)).toEqual(["list_models", "delegate"])
    const response = await client.callTool({ name: "list_models", arguments: { query: "reviewer", all: true, limit: 1, offset: 20 }, _meta: searchMeta })
    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toEqual(models)
    expect(searches).toEqual([{ input: { query: "reviewer", all: true, limit: 1, offset: 20 }, toolUseID: "toolu_search" }])
  })
})

test("passes the actual native tool ID through MCP metadata and returns the child reply", async () => {
  await fixture(async ({ client, calls }) => {
    const response = await client.callTool({ name: "delegate", arguments: { ...input, background: true }, _meta: { "claudecode/toolUseId": "toolu_native" } })
    expect(response.structuredContent).toEqual(result)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ input, toolUseID: "toolu_native" })
    expect(calls[0]!.input).not.toHaveProperty("background")
  })
})

test("refuses to invent a native tool ID", async () => {
  await fixture(async ({ client, calls }) => {
    const response = await client.callTool({ name: "delegate", arguments: input })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain("tool-use ID")
    expect(calls).toHaveLength(0)
  })
})

test("resolves the current turn for every call and refuses idle calls", async () => {
  await fixture(async ({ client, setActive }) => {
    const second = new AbortController()
    setActive({ signal: second.signal, createHost: () => ({ listModels: async () => ({ models: [], total: 0, truncated: false, next: null }), delegate: async () => result }) })
    expect((await client.callTool({ name: "list_models", arguments: {}, _meta: searchMeta })).structuredContent).toEqual({ models: [], total: 0, truncated: false, next: null })
    setActive(undefined)
    const idle = await client.callTool({ name: "delegate", arguments: input, _meta: { "claudecode/toolUseId": "toolu_idle" } })
    expect(idle.isError).toBe(true)
    expect(JSON.stringify(idle.content)).toContain("active foreground")
  })
})

test("empty host failures become nonempty native tool errors", async () => {
  await fixture(async ({ client, setActive, parent }) => {
    setActive({ signal: parent.signal, createHost: () => ({ listModels: async () => { throw new Error("") }, delegate: async () => result }) })
    const failed = await client.callTool({ name: "list_models", arguments: {}, _meta: searchMeta })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain("OpenCode delegation failed")
  })
})

test("parent cancellation reaches the host operation and never returns a completed child", async () => {
  await fixture(async ({ client, setActive, parent }) => {
    const started = Promise.withResolvers<AbortSignal>()
    setActive({ signal: parent.signal, createHost: (signal) => ({ listModels: async () => models,
      delegate: async () => {
        started.resolve(signal)
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
        return result
      },
    }) })
    const pending = client.callTool({ name: "delegate", arguments: input, _meta: { "claudecode/toolUseId": "toolu_parent_cancel" } })
    const signal = await started.promise
    parent.abort(new Error("Parent stopped"))
    const response = await pending
    expect(signal.aborted).toBe(true)
    expect(response.isError).toBe(true)
    expect(response.structuredContent).toBeUndefined()
  })
})

test("individual MCP request cancellation reaches the host operation", async () => {
  await fixture(async ({ client, setActive, parent }) => {
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    setActive({ signal: parent.signal, createHost: (signal) => ({ listModels: async () => models,
      delegate: async () => {
        started.resolve()
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { cancelled.resolve(); reject(signal.reason) }, { once: true }))
        return result
      },
    }) })
    const request = new AbortController()
    const pending = client.callTool({ name: "delegate", arguments: input, _meta: { "claudecode/toolUseId": "toolu_mcp_cancel" } }, undefined, { signal: request.signal })
    void pending.catch(() => {})
    await started.promise
    request.abort(new Error("Tool stopped"))
    await expect(pending).rejects.toThrow("Tool stopped")
    await cancelled.promise
    expect(parent.signal.aborted).toBe(false)
  })
})
