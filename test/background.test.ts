import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Plugin } from "@opencode/plugin"
import { createBackgroundPublisher, type BackgroundResult } from "../src/background"

const owner = { providerID: "one", nativeID: "native-session", binding: "configuration" }
const completed = (uuid = "result-one", text = "Complete answer") => ({
  type: "result", subtype: "success", uuid, session_id: owner.nativeID,
  is_error: false, result: text, stop_reason: "end_turn",
  usage: { input_tokens: 11, output_tokens: 17, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
}) as SDKMessage

function harness() {
  const values = new Map<string, any>()
  const wakes: any[] = []
  const scans: Array<{ prefix: string; after?: string; limit?: number }> = []
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)) },
    async set(key: string, value: unknown) { values.set(key, structuredClone(value)) },
    async scan(options: { prefix: string; after?: string; limit?: number }) {
      scans.push(options)
      const keys = [...values.keys()].sort().filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after))
      const selected = keys.slice(0, options.limit)
      return { entries: selected.map((key) => ({ key, value: structuredClone(values.get(key)) })),
        next: keys.length > selected.length ? selected.at(-1) : undefined }
    },
  }
  const session = {
    async get(_input: { sessionID: string }): Promise<{ model?: { providerID: string; modelID: string } }> {
      return { model: { providerID: owner.providerID, modelID: "sonnet" } }
    },
    async synthetic(wake: any) { wakes.push(structuredClone(wake)) },
  }
  const context = { storage, session } as unknown as Plugin.Context
  return { values, wakes, scans, storage, session, publisher: createBackgroundPublisher(context), context }
}

describe("background publisher", () => {
  test.each(["blocked", "failed"])("journals later batch results even when the first admission is %s", async (mode) => {
    const h = harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    h.session.synthetic = async (wake) => {
      if (calls++ === 0) {
        entered.resolve()
        if (mode === "blocked") await release.promise
        throw new Error("first admission failed")
      }
      h.wakes.push(wake)
    }
    const published = h.publisher.publish("session", [completed("first", "First report"), completed("second", "Second report")], owner)
    void published.catch(() => {})
    await entered.promise
    if (mode === "blocked") {
      const texts = [...h.values.values()].map((pending) => pending.response?.text)
      release.resolve()
      await published.catch(() => {})
      expect(texts.sort()).toEqual(["First report", "Second report"])
    } else {
      await published.catch(() => {})
      expect(h.values.size).toBe(2)
      const texts = [...h.values.values()].map((pending) => pending.response?.text)
      texts.push(...h.wakes.map((wake) => wake.metadata.fullClaudeAgentBackground.text))
      expect(texts).toContain("Second report")
    }
    h.session.synthetic = async (wake) => { h.wakes.push(wake) }
    await createBackgroundPublisher(h.context).recover()
    expect(new Set(h.wakes.map((wake) => wake.metadata.fullClaudeAgentBackground.text))).toEqual(new Set(["First report", "Second report"]))
  })

  test("a recovery admission failure does not prevent other pending reports from being admitted", async () => {
    const h = harness()
    h.session.synthetic = async () => { throw new Error("offline") }
    for (const message of [completed("first", "First report"), completed("second", "Second report")]) {
      await expect(h.publisher.publish("session", [message], owner)).rejects.toThrow("offline")
    }
    const first = [...h.values.keys()].sort()[0]!
    const failedID = h.values.get(first).response.id
    h.session.synthetic = async (wake) => {
      if (wake.metadata.fullClaudeAgentBackground.id === failedID) throw new Error("temporary admission failure")
      h.wakes.push(wake)
    }
    const recovery = createBackgroundPublisher(h.context)
    await recovery.recover().catch(() => {})
    expect(h.wakes).toHaveLength(1)
    expect(h.values.get(first).sent).toBe(false)
    h.session.synthetic = async (wake) => { h.wakes.push(wake) }
    await recovery.recover()
    expect(new Set(h.wakes.map((wake) => wake.id)).size).toBe(2)
  })

  test.each(["get", "synthetic"] as const)("a deleted session during %s is terminal and stores only a compact sent marker", async (method) => {
    const h = harness()
    h.session.synthetic = async () => { throw new Error("offline") }
    await expect(h.publisher.publish("session", [completed()], owner)).rejects.toThrow("offline")
    let attempts = 0
    h.session[method] = async () => { attempts++; throw { _tag: "Session.NotFoundError" } }
    await createBackgroundPublisher(h.context).recover()
    expect(attempts).toBe(1)
    expect([...h.values.values()]).toEqual([{ sent: true }])
    await createBackgroundPublisher(h.context).recover()
    expect(attempts).toBe(1)
  })

  test("completed admissions retain only compact sent markers", async () => {
    const h = harness()
    await h.publisher.publish("session", [completed()], owner)
    expect([...h.values.values()]).toEqual([{ sent: true }])
    await h.publisher.publish("session", [completed()], owner)
    expect(h.wakes).toHaveLength(1)
  })

  test.each(["another-provider", undefined])("preserves the report without resuming when the selected provider is %s", async (providerID) => {
    const h = harness()
    h.session.get = async () => providerID ? { model: { providerID, modelID: "other-model" } } : {}
    await h.publisher.publish("session", [completed()], owner)
    expect(h.wakes).toHaveLength(1)
    expect(h.wakes[0]).toMatchObject({ delivery: "queue", resume: false,
      metadata: { fullClaudeAgentBackground: { ...owner, text: "Complete answer" } } })
  })

  test("ignores task notification summaries and publishes only completed SDK results", async () => {
    const h = harness()
    await h.publisher.publish("session", [{ type: "system", subtype: "task_notification", summary: "Short summary", output_file: "/tmp/output" } as SDKMessage], owner)
    expect(h.values.size).toBe(0)
    expect(h.wakes).toEqual([])
    await h.publisher.publish("session", [completed()], owner)
    expect(h.wakes[0]).toMatchObject({ delivery: "queue", resume: true,
      metadata: { fullClaudeAgentBackground: { ...owner, text: "Complete answer", usage: {
        inputTokens: { total: 19, noCache: 11, cacheRead: 3, cacheWrite: 5 }, outputTokens: { total: 17 },
      } } } })
    expect(h.wakes[0].text).not.toContain("Complete answer")
  })

  test("persists the complete answer before admission and recovers a failed admission", async () => {
    const h = harness()
    const text = "Full report\n".repeat(100_000)
    h.session.synthetic = async () => {
      expect([...h.values.values()]).toEqual([expect.objectContaining({ sent: false, response: expect.objectContaining({ text }) })])
      throw new Error("inbox unavailable")
    }
    await expect(h.publisher.publish("session", [completed("large", text)], owner)).rejects.toThrow("inbox unavailable")
    h.session.synthetic = async (wake) => { h.wakes.push(wake) }
    await createBackgroundPublisher(h.context).recover()
    expect(h.wakes).toHaveLength(1)
    expect(h.wakes[0].metadata.fullClaudeAgentBackground.text).toBe(text)
    expect([...h.values.values()][0].sent).toBe(true)
  })

  test("deduplicates result UUIDs, not identical answer text", async () => {
    const h = harness()
    await h.publisher.publish("session", [completed("one"), completed("one"), completed("two")], owner)
    expect(h.wakes).toHaveLength(2)
    expect(h.wakes[0].id).not.toBe(h.wakes[1].id)
    await createBackgroundPublisher(h.context).recover()
    expect(h.wakes).toHaveLength(2)
  })

  test("retries the same synthetic ID when storing the sent marker fails", async () => {
    const h = harness()
    const set = h.storage.set.bind(h.storage)
    h.storage.set = async (key, value: any) => {
      if (value.sent) throw new Error("sent marker unavailable")
      await set(key, value)
    }
    await expect(h.publisher.publish("session", [completed()], owner)).rejects.toThrow("sent marker unavailable")
    expect(h.wakes).toHaveLength(1)
    expect([...h.values.values()][0].sent).toBe(false)
    h.storage.set = set
    await createBackgroundPublisher(h.context).recover()
    expect(h.wakes).toHaveLength(2)
    expect(h.wakes[1]).toEqual(h.wakes[0])
    await h.publisher.recover()
    expect(h.wakes).toHaveLength(2)
  })

  test("surfaces native execution errors as deliverable reports", async () => {
    const h = harness()
    await h.publisher.publish("session", [{ ...completed(), subtype: "error_during_execution", is_error: true,
      errors: ["Tool crashed", "Retry exhausted"] } as SDKMessage], owner)
    expect(h.wakes[0].metadata.fullClaudeAgentBackground.text).toBe("Claude background activity failed: Tool crashed\nRetry exhausted")
  })

  test.each([429, 529])("journals HTTP %s failures with diagnostics and quota metadata through recovery", async (status) => {
    const h = harness()
    const rateLimit = { status: "rejected" as const, rateLimitType: "five_hour" as const, resetsAt: 2_000_000_000 }
    const message = { ...completed(), api_error_status: status, result: "",
      fullClaudeStatus: { diagnostics: { code: "rate_limit", detail: "Native quota detail" }, rateLimit },
    } as BackgroundResult
    h.session.synthetic = async () => { throw new Error("inbox unavailable") }
    await expect(h.publisher.publish("session", [message], owner)).rejects.toThrow("inbox unavailable")
    const pending = [...h.values.values()][0]
    expect(pending.response.text).toContain(status === 429 ? "Native quota detail" : "overloaded")
    expect(pending.response.text).toStartWith("Claude background activity failed:")
    expect(pending.response.error.statusCode).toBe(status)
    expect(typeof pending.response.error.message).toBe("string")
    expect(pending.response).toMatchObject({ ...owner, rateLimit })
    expect(pending.sent).toBe(false)
    h.session.synthetic = async (wake) => { h.wakes.push(structuredClone(wake)) }
    await createBackgroundPublisher(h.context).recover()
    expect(h.wakes).toHaveLength(1)
    expect(h.wakes[0].metadata.fullClaudeAgentBackground).toEqual(pending.response)
    expect([...h.values.values()]).toEqual([{ sent: true }])
  })

  test("successful background results retain quota metadata without retaining transient errors", async () => {
    const h = harness()
    const rateLimit = { status: "rejected" as const, rateLimitType: "seven_day" as const }
    await h.publisher.publish("session", [{ ...completed(), fullClaudeStatus: {
      diagnostics: { code: "rate_limit", detail: "Transient rejection" }, rateLimit,
    } } as BackgroundResult], owner)
    expect(h.wakes[0].metadata.fullClaudeAgentBackground).toMatchObject({ text: "Complete answer", rateLimit })
    expect(h.wakes[0].metadata.fullClaudeAgentBackground.error).toBeUndefined()
  })

  test("blank SDK errors use the captured root diagnostic in the recovered report", async () => {
    const h = harness()
    const message = { ...completed(), subtype: "error_during_execution", is_error: true, errors: ["", "  "],
      fullClaudeStatus: { diagnostics: { code: "unknown", detail: "Native terminal detail" } },
    } as BackgroundResult
    await h.publisher.publish("session", [message], owner)
    expect(h.wakes[0].metadata.fullClaudeAgentBackground).toMatchObject({
      text: "Claude background activity failed: Native terminal detail", error: { message: "Native terminal detail" },
    })
  })

  test("does not admit a wake when persisting the answer fails", async () => {
    const h = harness()
    h.storage.set = async () => { throw new Error("disk full") }
    await expect(h.publisher.publish("session", [completed()], owner)).rejects.toThrow("disk full")
    expect(h.wakes).toEqual([])
  })

  test("recovers every page without resending entries with sent markers", async () => {
    const h = harness()
    h.session.synthetic = async () => { throw new Error("offline") }
    for (let index = 0; index < 205; index++) {
      await expect(h.publisher.publish("session", [completed(`result-${index}`)], owner)).rejects.toThrow("offline")
    }
    h.session.synthetic = async (wake) => { h.wakes.push(wake) }
    await createBackgroundPublisher(h.context).recover()
    expect(h.scans).toHaveLength(3)
    expect(new Set(h.wakes.map((wake) => wake.id)).size).toBe(205)
    await createBackgroundPublisher(h.context).recover()
    expect(h.wakes).toHaveLength(205)
  })
})
