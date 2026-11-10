import { describe, expect, mock, spyOn, test } from "bun:test"
import { taskReads } from "../src/task-ui-rpc.js"

const unavailable = { type: "rpc.unavailable", message: "RPC is unavailable: full-claude-agent.tasks" }
const result = { tasks: [] }
const output = { text: "ready", available: true, truncated: false }
const input = { sessionID: "session-old" }

function fixture() {
  const abort = new AbortController()
  const options = { location: { directory: "/old" }, signal: abort.signal }
  const rpc = {
    list: mock(async (_input: unknown, _options: unknown) => result),
    output: mock(async (_input: unknown, _options: unknown) => output),
    stop: mock(async () => ({ requested: true })),
  }
  return { abort, options, rpc, reads: taskReads(rpc, options) }
}

describe("task RPC readiness", () => {
  test("retries unavailable list reads with the same session, location, and signal", async () => {
    const { rpc, reads, options } = fixture()
    rpc.list.mockRejectedValueOnce(unavailable)
    expect(await reads.list(input)).toEqual(result)
    expect(rpc.list.mock.calls).toEqual([[input, options], [input, options]])
  })

  test("retries output reads and removes completed delay listeners", async () => {
    const { rpc, reads, abort } = fixture()
    const add = spyOn(abort.signal, "addEventListener")
    const remove = spyOn(abort.signal, "removeEventListener")
    try {
      rpc.output.mockRejectedValueOnce(unavailable)
      expect(await reads.output({ ...input, id: "task-old" })).toEqual(output)
      expect(rpc.output).toHaveBeenCalledTimes(2)
      expect(remove.mock.calls[0]).toEqual(["abort", add.mock.calls[0][1]])
    } finally { add.mockRestore(); remove.mockRestore() }
  })

  test.each([
    { type: "rpc.method_not_found", message: "unknown method" },
    { type: "rpc.invalid_input", message: "invalid" },
    { type: "rpc.invalid_output", message: "invalid" },
    { type: "rpc.internal", message: "failed" },
    { _tag: "UnauthorizedError", message: "unauthorized" },
    new Error("rpc.unavailable"),
    "rpc.unavailable",
    { message: "RPC is unavailable" },
  ])("does not retry other failures: %j", async (error) => {
    const { rpc, reads } = fixture()
    rpc.list.mockRejectedValue(error)
    await expect(reads.list(input)).rejects.toBe(error)
    expect(rpc.list).toHaveBeenCalledTimes(1)
  })

  test("bounds unavailable reads to six attempts, without invoking Stop", async () => {
    const { rpc, reads } = fixture()
    rpc.list.mockRejectedValue(unavailable)
    await expect(reads.list(input)).rejects.toBe(unavailable)
    expect(rpc.list).toHaveBeenCalledTimes(6)
    expect(rpc.stop).not.toHaveBeenCalled()
    expect(Object.keys(reads)).toEqual(["list", "output"])
  })

  test("aborting a delay cancels retries and removes its listener", async () => {
    const { rpc, reads, abort } = fixture()
    const add = spyOn(abort.signal, "addEventListener")
    const remove = spyOn(abort.signal, "removeEventListener")
    const reason = new Error("session/location changed")
    try {
      rpc.list.mockRejectedValue(unavailable)
      const pending = reads.list(input)
      await Promise.resolve()
      abort.abort(reason)
      await expect(pending).rejects.toBe(reason)
      expect(rpc.list).toHaveBeenCalledTimes(1)
      expect(remove.mock.calls[0]).toEqual(["abort", add.mock.calls[0][1]])
    } finally { add.mockRestore(); remove.mockRestore() }
  })

  test("an already-aborted scope does not call RPC", async () => {
    const { rpc, reads, abort } = fixture()
    abort.abort()
    await expect(reads.list(input)).rejects.toBe(abort.signal.reason)
    expect(rpc.list).not.toHaveBeenCalled()
  })

  test("aborting an in-flight unavailable read does not schedule a retry", async () => {
    const { rpc, reads, abort } = fixture()
    rpc.list.mockImplementation(async () => { abort.abort(); throw unavailable })
    await expect(reads.list(input)).rejects.toBe(unavailable)
    expect(rpc.list).toHaveBeenCalledTimes(1)
  })
})
