import { afterEach, describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import * as Schema from "effect/Schema"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { NativeTaskStore } from "../src/tasks"

const owner = { sessionID: "session-one", providerID: "profile-one", nativeID: "native-one" }
type Connection = ReturnType<NativeTaskStore["connect"]>
const stores: NativeTaskStore[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function harness(values = new Map<string, unknown>()) {
  const changed: string[] = []
  let clock = 1_000
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)) },
    async set(key: string, value: unknown) { values.set(key, structuredClone(value)) },
    async scan(options: { prefix: string; after?: string; limit?: number }) {
      const keys = [...values.keys()].sort().filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after))
      const selected = keys.slice(0, options.limit)
      return {
        entries: selected.map((key) => ({ key, value: structuredClone(values.get(key)) })),
        next: keys.length > selected.length ? selected.at(-1) : undefined,
      }
    },
  }
  const store = new NativeTaskStore(storage, async (sessionID) => { changed.push(sessionID) }, () => ++clock)
  stores.push(store)
  return { store, values, changed }
}

function frame(subtype: string, fields: Record<string, unknown> = {}, identity = owner): SDKMessage {
  return { type: "system", subtype, uuid: crypto.randomUUID(), session_id: identity.nativeID, ...fields } as SDKMessage
}

function start(connection: Connection, taskID = "task-one", runID = "001", extra: Record<string, unknown> = {}, identity = owner) {
  connection.observe(frame("task_started", {
    task_id: taskID, run_id: runID, task_type: "local_bash", description: `Run ${taskID}`,
    is_backgrounded: true, ...extra,
  }, identity))
}

function finish(connection: Connection, taskID = "task-one", runID = "001", extra: Record<string, unknown> = {}, identity = owner) {
  connection.observe(frame("task_notification", {
    task_id: taskID, run_id: runID, status: "completed", output_file: "", summary: "Finished", ...extra,
  }, identity))
}

function snapshot(connection: Connection, ids: string[], extra: Record<string, unknown> = {}, identity = owner) {
  connection.observe(frame("background_tasks_changed", {
    tasks: ids.map((taskID) => ({ task_id: taskID, run_id: "001", task_type: "local_bash", description: `Run ${taskID}`, ...extra })),
  }, identity))
}

async function outputFixture() {
  const root = await mkdtemp(join(tmpdir(), "full-claude-native-task-test-"))
  directories.push(root)
  const tasks = join(root, owner.nativeID, "tasks")
  await mkdir(tasks, { recursive: true })
  return { root, tasks, path: join(tasks, "task-one.output") }
}

function bashResult(connection: Connection, path: string) {
  connection.observe({
    type: "assistant", uuid: crypto.randomUUID(), session_id: owner.nativeID, parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { command: "sleep 10", description: "Wait for build" } }] },
  } as unknown as SDKMessage)
  connection.observe({
    type: "user", uuid: crypto.randomUUID(), session_id: owner.nativeID, parent_tool_use_id: null,
    tool_use_result: { backgroundTaskId: "task-one" },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-call", content: `Command running in background with ID: task-one. Output is being written to: ${path}.` }] },
  } as unknown as SDKMessage)
}

describe("native task lifecycle", () => {
  test.each(["task_started", "background_tasks_changed"] as const)("list returns RPC-safe JSON when %s omits optional SDK metadata", (subtype) => {
    const { store } = harness()
    const connection = store.connect(owner)
    const message = subtype === "task_started" ? {
      type: "system", subtype: "task_started", uuid: crypto.randomUUID(), session_id: owner.nativeID,
      task_id: "task-one", description: "Run without optional metadata", is_backgrounded: true,
    } satisfies Extract<SDKMessage, { subtype: "task_started" }> : {
      type: "system", subtype: "background_tasks_changed", uuid: crypto.randomUUID(), session_id: owner.nativeID,
      tasks: [{ task_id: "task-one", task_type: "local_bash", description: "Run without optional metadata" }],
    } satisfies Extract<SDKMessage, { subtype: "background_tasks_changed" }>
    connection.observe(message)
    const tasks = store.list(owner.sessionID)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ taskID: "task-one", description: "Run without optional metadata", state: "running" })
    const decodeJson = Schema.decodeUnknownSync(Schema.Json)
    const response = { tasks }
    expect(() => decodeJson(response)).not.toThrow()
    expect(decodeJson(response)).toEqual(response)
    expect(Object.hasOwn(tasks[0]!, "parentTaskID")).toBe(false)
    expect(Object.hasOwn(tasks[0]!, "toolCallID")).toBe(false)
    expect(() => decodeJson({ tasks: [{ ...tasks[0], parentTaskID: undefined }] })).toThrow()
  })

  test("foreground tasks stay hidden until the SDK backgrounds them", async () => {
    const { store, changed } = harness()
    const connection = store.connect(owner)
    start(connection, "task-one", "001", { is_backgrounded: false })
    expect(store.list(owner.sessionID)).toEqual([])
    connection.observe(frame("task_updated", { task_id: "task-one", run_id: "001", patch: { is_backgrounded: true } }))
    expect(store.list(owner.sessionID)).toMatchObject([{ taskID: "task-one", state: "running", ambient: false }])
    await store.flush()
    expect(changed).toContain(owner.sessionID)
  })

  test("each snapshot replaces live membership, including an empty snapshot", () => {
    const { store } = harness()
    const connection = store.connect(owner)
    snapshot(connection, ["first", "second"])
    expect(store.list(owner.sessionID).filter((task) => task.state === "running").map((task) => task.taskID).sort()).toEqual(["first", "second"])
    snapshot(connection, ["second"])
    expect(store.list(owner.sessionID).filter((task) => task.state === "running").map((task) => task.taskID)).toEqual(["second"])
    expect(store.list(owner.sessionID).find((task) => task.taskID === "first")?.state).not.toBe("completed")
    snapshot(connection, [])
    expect(store.list(owner.sessionID).filter((task) => task.state === "running")).toEqual([])
  })

  test("ambient background tasks remain available in the task list", () => {
    const { store } = harness()
    const connection = store.connect(owner)
    snapshot(connection, ["watcher"], { ambient: true })
    expect(store.list(owner.sessionID)).toMatchObject([{ taskID: "watcher", ambient: true, state: "running" }])
    snapshot(connection, ["watcher"], { ambient: false })
    expect(store.list(owner.sessionID)[0]?.ambient).toBe(false)
  })

  test("progress updates detail and an SDK completion settles the same row", () => {
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    const id = store.list(owner.sessionID)[0]!.id
    connection.observe(frame("task_progress", {
      task_id: "task-one", run_id: "001", description: "Run task-one", summary: "Checking results",
      usage: { total_tokens: 12, tool_uses: 1, duration_ms: 100 },
    }))
    expect(store.list(owner.sessionID)[0]).toMatchObject({ id, state: "running", detail: "Checking results" })
    finish(connection)
    expect(store.list(owner.sessionID)).toMatchObject([{ id, state: "completed", canStop: false }])
    expect(store.list(owner.sessionID)[0]!.finishedAt).toBeNumber()
  })

  test("resumed runs get new row IDs and late frames cannot overwrite the newer run", async () => {
    const { store } = harness()
    const stopped: string[] = []
    const connection = store.connect(owner, async (id) => { stopped.push(id) })
    start(connection)
    const oldID = store.list(owner.sessionID)[0]!.id
    finish(connection)
    start(connection, "task-one", "002", { description: "Resumed task" })
    const current = store.list(owner.sessionID).find((task) => task.state === "running")!
    expect(current.id).not.toBe(oldID)
    finish(connection, "task-one", "001", { status: "failed" })
    connection.observe(frame("task_updated", { task_id: "task-one", run_id: "001", patch: { status: "killed", description: "Late patch" } }))
    expect(store.list(owner.sessionID).find((task) => task.id === current.id)).toMatchObject({ state: "running", description: "Resumed task" })
    expect(await store.stop(owner.sessionID, oldID)).toEqual({ requested: false })
    expect(stopped).toEqual([])
    expect(await store.stop(owner.sessionID, current.id)).toEqual({ requested: true })
    expect(stopped).toEqual(["task-one"])
  })

  test("a stale roster run cannot clear or rename the current running incarnation", async () => {
    const { store } = harness()
    const calls: string[] = []
    const connection = store.connect(owner, async (id) => { calls.push(id) })
    start(connection)
    finish(connection)
    start(connection, "task-one", "002", { description: "Current run" })
    snapshot(connection, ["task-one"], { run_id: "002", description: "Current run" })
    const current = store.list(owner.sessionID)[0]!
    snapshot(connection, ["task-one"], { run_id: "001", description: "Stale run" })
    expect(store.list(owner.sessionID)).toMatchObject([{ id: current.id, description: "Current run", state: "running", canStop: true }])
    expect(await store.stop(owner.sessionID, current.id)).toEqual({ requested: true })
    expect(calls).toEqual(["task-one"])
    snapshot(connection, [])
    expect(store.list(owner.sessionID)[0]!.state).toBe("unknown")
  })

  test("a new legacy start UUID reopens a terminal task with a new row ID, but replaying its start does not", () => {
    const { store } = harness()
    const connection = store.connect(owner)
    const first = frame("task_started", { task_id: "task-one", task_type: "local_bash", description: "First legacy run", is_backgrounded: true })
    connection.observe(first)
    const oldID = store.list(owner.sessionID)[0]!.id
    finish(connection, "task-one", "001", { run_id: undefined })
    connection.observe(first)
    expect(store.list(owner.sessionID)).toMatchObject([{ id: oldID, state: "completed" }])
    const resumed = frame("task_started", { task_id: "task-one", task_type: "local_bash", description: "Resumed legacy run", is_backgrounded: true })
    connection.observe(resumed)
    const current = store.list(owner.sessionID)[0]!
    expect(current.id).not.toBe(oldID)
    expect(current).toMatchObject({ state: "running", description: "Resumed legacy run" })
    connection.observe(resumed)
    expect(store.list(owner.sessionID)).toMatchObject([{ id: current.id, state: "running" }])
  })

  test("replaying a legacy start from an earlier incarnation cannot reopen a later completed run", () => {
    const { store } = harness()
    const connection = store.connect(owner)
    const first = frame("task_started", { task_id: "task-one", description: "First run", is_backgrounded: true })
    connection.observe(first)
    finish(connection, "task-one", "001", { run_id: undefined })
    connection.observe(frame("task_started", { task_id: "task-one", description: "Second run", is_backgrounded: true }))
    finish(connection, "task-one", "001", { run_id: undefined })
    const completed = store.list(owner.sessionID)[0]!
    connection.observe(first)
    expect(store.list(owner.sessionID)).toMatchObject([{ id: completed.id, state: "completed", description: "Second run" }])
  })

  test.each([undefined, "002"])("a live roster reopens a completed legacy task with a fresh incarnation when its run ID is %s", async (runID) => {
    const { store } = harness()
    const connection = store.connect(owner, async () => {})
    const originalStart = frame("task_started", { task_id: "task-one", description: "Original legacy run", is_backgrounded: true })
    connection.observe(originalStart)
    finish(connection, "task-one", "001", { run_id: undefined, summary: "Original completion summary" })
    const completed = store.list(owner.sessionID)[0]!
    expect(completed).toMatchObject({ state: "completed", detail: "Original completion summary" })
    expect(completed.finishedAt).toBeNumber()
    snapshot(connection, ["task-one"], { run_id: runID, description: "Resumed through roster" })
    const resumed = store.list(owner.sessionID)[0]!
    expect(resumed.id).not.toBe(completed.id)
    expect(resumed).toMatchObject({ state: "running", canStop: true, description: "Resumed through roster" })
    expect(resumed.detail).toBeUndefined()
    expect(resumed.finishedAt).toBeUndefined()
    expect(resumed.startedAt).toBeGreaterThan(completed.startedAt)
    expect(await store.stop(owner.sessionID, completed.id)).toEqual({ requested: false })
    snapshot(connection, ["task-one"], { run_id: runID, description: "Resumed through roster" })
    expect(store.list(owner.sessionID)[0]!.id).toBe(resumed.id)
    finish(connection, "task-one", "001", { run_id: runID, summary: "Resumed completion summary" })
    const final = store.list(owner.sessionID)
    connection.observe(originalStart)
    expect(store.list(owner.sessionID)).toEqual(final)
    expect(final[0]).toMatchObject({ id: resumed.id, state: "completed", detail: "Resumed completion summary" })
  })

  test("an authoritative empty roster prevents a late start edge from resurrecting running activity", async () => {
    const { store } = harness()
    const calls: string[] = []
    const connection = store.connect(owner, async (id) => { calls.push(id) })
    snapshot(connection, [])
    start(connection)
    expect(store.list(owner.sessionID).filter((task) => task.state === "running")).toEqual([])
    for (const task of store.list(owner.sessionID)) {
      expect(task.canStop).toBe(false)
      expect(await store.stop(owner.sessionID, task.id)).toEqual({ requested: false })
    }
    expect(calls).toEqual([])
    snapshot(connection, ["task-one"])
    expect(store.list(owner.sessionID)).toMatchObject([{ taskID: "task-one", state: "running", canStop: true }])
  })

  test.each([false, true])("foreground backgrounding respects roster authority when level mode is %s", (levelMode) => {
    const { store } = harness()
    const connection = store.connect(owner, async () => {})
    if (levelMode) snapshot(connection, [])
    start(connection, "task-one", "001", { is_backgrounded: false })
    expect(store.list(owner.sessionID)).toEqual([])
    connection.observe(frame("task_updated", { task_id: "task-one", run_id: "001", patch: { is_backgrounded: true } }))
    expect(store.list(owner.sessionID)).toMatchObject([{ taskID: "task-one", state: levelMode ? "unknown" : "running", canStop: !levelMode }])
    if (levelMode) {
      const id = store.list(owner.sessionID)[0]!.id
      snapshot(connection, ["task-one"])
      expect(store.list(owner.sessionID)).toMatchObject([{ id, state: "running", canStop: true }])
    }
  })

  test("replacing a native connection rejects old observe and close callbacks without an explicit old close", async () => {
    const { store } = harness()
    const old = store.connect(owner, async () => { throw new Error("wrong generation") })
    start(old)
    const calls: string[] = []
    const current = store.connect(owner, async (id) => { calls.push(id) })
    snapshot(current, ["task-one"])
    const before = store.list(owner.sessionID)
    finish(old)
    snapshot(old, [])
    start(old, "ghost")
    old.close()
    expect(store.list(owner.sessionID)).toEqual(before)
    expect(await store.stop(owner.sessionID, before[0]!.id)).toEqual({ requested: true })
    expect(calls).toEqual(["task-one"])
  })

  test("a late rejected stop callback cannot overwrite the replacement generation", async () => {
    const { store } = harness()
    const deferred = Promise.withResolvers<void>()
    const old = store.connect(owner, async () => deferred.promise)
    start(old)
    const pending = store.stop(owner.sessionID, store.list(owner.sessionID)[0]!.id)
    const current = store.connect(owner, async () => {})
    start(current, "task-one", "002", { description: "Replacement run" })
    const before = store.list(owner.sessionID)
    deferred.reject(new Error("old worker disconnected"))
    await expect(pending).rejects.toThrow("old worker disconnected")
    expect(store.list(owner.sessionID)).toEqual(before)
    expect(store.list(owner.sessionID)[0]).toMatchObject({ state: "running", canStop: true, description: "Replacement run" })
  })

  test.each(["completed", "failed", "stopped"] as const)("a rejected pending stop preserves the SDK's actual %s outcome and summary", async (status) => {
    const { store } = harness()
    const deferred = Promise.withResolvers<void>()
    const connection = store.connect(owner, async () => deferred.promise)
    start(connection)
    const id = store.list(owner.sessionID)[0]!.id
    const pending = store.stop(owner.sessionID, id)
    expect(store.list(owner.sessionID)[0]).toMatchObject({ state: "running", canStop: false })
    finish(connection, "task-one", "001", { status, summary: "Actual native outcome" })
    const settled = store.list(owner.sessionID)
    expect(settled[0]).toMatchObject({ id, state: status, detail: "Actual native outcome", canStop: false })
    expect(settled[0]!.finishedAt).toBeNumber()
    deferred.reject(new Error("stop control request failed after task settled"))
    await expect(pending).rejects.toThrow("stop control request failed after task settled")
    expect(store.list(owner.sessionID)).toEqual(settled)
    await store.flush()
    expect(store.list(owner.sessionID)).toEqual(settled)
  })

  test.each(["task_started", "task_updated", "task_notification", "background_tasks_changed"] as const)("a %s frame from another native session cannot mutate the owning connection", (subtype) => {
    const { store } = harness()
    const connection = store.connect(owner, async () => {})
    start(connection)
    const before = store.list(owner.sessionID)
    const foreign = { ...owner, nativeID: "foreign-native-session" }
    if (subtype === "task_started") start(connection, "foreign-task", "001", {}, foreign)
    else if (subtype === "task_updated") connection.observe(frame(subtype, { task_id: "task-one", run_id: "001", patch: { status: "failed", description: "Foreign update" } }, foreign))
    else if (subtype === "task_notification") finish(connection, "task-one", "001", { status: "failed", summary: "Foreign completion" }, foreign)
    else snapshot(connection, [], {}, foreign)
    expect(store.list(owner.sessionID)).toEqual(before)
  })

  test("stop requests use only the owning live SDK connection and await an actual stop event", async () => {
    const { store } = harness()
    const calls: string[] = []
    const connection = store.connect(owner, async (taskID) => { calls.push(taskID) })
    start(connection)
    const id = store.list(owner.sessionID)[0]!.id
    expect(await store.stop("another-session", id)).toEqual({ requested: false })
    expect(await store.stop(owner.sessionID, "missing")).toEqual({ requested: false })
    expect(calls).toEqual([])
    expect(await store.stop(owner.sessionID, id)).toEqual({ requested: true })
    expect(calls).toEqual(["task-one"])
    expect(store.list(owner.sessionID)[0]!.state).toBe("running")
    finish(connection, "task-one", "001", { status: "stopped" })
    expect(store.list(owner.sessionID)[0]).toMatchObject({ state: "stopped", canStop: false })
    expect(await store.stop(owner.sessionID, id)).toEqual({ requested: false })
  })

  test("a connection without SDK stop support does not advertise or fake cancellation", async () => {
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    const task = store.list(owner.sessionID)[0]!
    expect(task.canStop).toBe(false)
    expect(await store.stop(owner.sessionID, task.id)).toEqual({ requested: false })
    expect(store.list(owner.sessionID)[0]!.state).toBe("running")
  })

  test("closed generations ignore late messages and cannot stop through a replacement connection", async () => {
    const { store } = harness()
    const old = store.connect(owner, async () => {})
    start(old)
    const id = store.list(owner.sessionID)[0]!.id
    old.close()
    const calls: string[] = []
    const replacement = store.connect(owner, async (taskID) => { calls.push(taskID) })
    finish(old)
    start(old, "late-task")
    expect(store.list(owner.sessionID).find((task) => task.id === id)).toMatchObject({ state: "unknown", canStop: false })
    expect(store.list(owner.sessionID).some((task) => task.taskID === "late-task")).toBe(false)
    expect(await store.stop(owner.sessionID, id)).toEqual({ requested: false })
    expect(calls).toEqual([])
    snapshot(replacement, ["task-one"])
    expect(store.list(owner.sessionID).find((task) => task.taskID === "task-one")).toMatchObject({ state: "running", canStop: true })
  })

  test("identical native task IDs in different sessions and profiles have independent rows and stop routes", async () => {
    const { store } = harness()
    const other = { sessionID: "session-two", providerID: "profile-two", nativeID: "native-two" }
    const calls: string[] = []
    const first = store.connect(owner, async (id) => { calls.push(`one:${id}`) })
    const second = store.connect(other, async (id) => { calls.push(`two:${id}`) })
    start(first)
    start(second, "task-one", "001", {}, other)
    const one = store.list(owner.sessionID)[0]!
    const two = store.list(other.sessionID)[0]!
    expect(one.id).not.toBe(two.id)
    expect(one.providerID).toBe(owner.providerID)
    expect(two.providerID).toBe(other.providerID)
    expect(await store.stop(other.sessionID, one.id)).toEqual({ requested: false })
    expect(await store.stop(other.sessionID, two.id)).toEqual({ requested: true })
    expect(calls).toEqual(["two:task-one"])
    finish(first)
    expect(store.list(other.sessionID)[0]!.state).toBe("running")
  })

  test("switching profiles in one host session cannot route an old task stop to the new profile", async () => {
    const { store } = harness()
    const first = store.connect(owner, async () => {})
    start(first)
    const oldID = store.list(owner.sessionID)[0]!.id
    first.close()
    const other = { ...owner, providerID: "profile-two", nativeID: "native-two" }
    const calls: string[] = []
    const second = store.connect(other, async (id) => { calls.push(id) })
    start(second, "task-one", "001", {}, other)
    const current = store.list(owner.sessionID).find((task) => task.providerID === other.providerID)!
    expect(current.id).not.toBe(oldID)
    expect(await store.stop(owner.sessionID, oldID)).toEqual({ requested: false })
    expect(calls).toEqual([])
    expect(await store.stop(owner.sessionID, current.id)).toEqual({ requested: true })
    expect(calls).toEqual(["task-one"])
  })

  test("persisted running tasks restore as unknown, preserve IDs, and cannot use a stale stop callback", async () => {
    const first = harness()
    const connection = first.store.connect(owner, async () => { throw new Error("stale callback") })
    start(connection)
    start(connection, "finished")
    finish(connection, "finished")
    const id = first.store.list(owner.sessionID).find((task) => task.taskID === "task-one")!.id
    await first.store.flush()
    const restored = harness(first.values)
    await restored.store.restore()
    expect(restored.store.list(owner.sessionID).find((task) => task.id === id)).toMatchObject({ state: "unknown", canStop: false })
    expect(restored.store.list(owner.sessionID).find((task) => task.taskID === "finished")).toMatchObject({ state: "completed" })
    expect(await restored.store.stop(owner.sessionID, id)).toEqual({ requested: false })
    restored.store.connect(owner)
    expect(restored.store.list(owner.sessionID).find((task) => task.id === id)!.state).toBe("unknown")
  })

  test("completion history is capped at 200 without evicting active tasks", async () => {
    const { store, values } = harness()
    const connection = store.connect(owner)
    start(connection, "keep-running")
    for (let index = 0; index < 300; index++) {
      start(connection, `history-${index}`)
      finish(connection, `history-${index}`)
    }
    expect(store.list(owner.sessionID).filter((task) => task.state === "completed")).toHaveLength(200)
    expect(store.list(owner.sessionID).find((task) => task.taskID === "keep-running")!.state).toBe("running")
    expect(store.list(owner.sessionID).some((task) => task.taskID === "history-0")).toBe(false)
    expect(store.list(owner.sessionID).some((task) => task.taskID === "history-299")).toBe(true)
    await store.flush()
    const restored = harness(values)
    await restored.store.restore()
    expect(restored.store.list(owner.sessionID)).toHaveLength(201)
  })
})

describe("native task output", () => {
  test("legacy Bash results use the prior tool description and register the SDK output path", async () => {
    const fixture = await outputFixture()
    await writeFile(fixture.path, "build output\n")
    const { store } = harness()
    const connection = store.connect(owner)
    bashResult(connection, fixture.path)
    const task = store.list(owner.sessionID)[0]!
    expect(task).toMatchObject({ taskID: "task-one", description: "Wait for build", toolCallID: "bash-call", state: "running" })
    expect(await store.output(owner.sessionID, task.id)).toMatchObject({ available: true, text: "build output\n", truncated: false })
  })

  test("completion output is a bounded tail with terminal escape sequences removed", async () => {
    const fixture = await outputFixture()
    await writeFile(fixture.path, `SECRET_PREFIX${"x".repeat(80 * 1024)}\u001b[31mTAIL\u001b[0m\u001b]0;title\u0007\n`)
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    finish(connection, "task-one", "001", { output_file: fixture.path })
    const result = await store.output(owner.sessionID, store.list(owner.sessionID)[0]!.id)
    expect(result.available).toBe(true)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(64 * 1024)
    expect(result.text).not.toContain("SECRET_PREFIX")
    expect(result.text).not.toContain("\u001b")
    expect(result.text).toEndWith("TAIL\n")
  })

  test("output is scoped to the owning session and an RPC path cannot register a file", async () => {
    const fixture = await outputFixture()
    await writeFile(fixture.path, "private output")
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    finish(connection, "task-one", "001", { output_file: fixture.path })
    const id = store.list(owner.sessionID)[0]!.id
    for (const [sessionID, requestedID] of [["other-session", id], [owner.sessionID, fixture.path]]) {
      const result = await store.output(sessionID!, requestedID!)
      expect(result.available).toBe(false)
      expect(result.text).toBe("")
    }
  })

  test.each(["relative", "dot-segments", "nul"] as const)("typed SDK completion metadata rejects a %s output path without exposing private metadata", async (mode) => {
    const fixture = await outputFixture()
    await writeFile(fixture.path, "PRIVATE_FILE_CONTENT")
    const outputFile = mode === "relative" ? `${owner.nativeID}/tasks/task-one.output`
      : mode === "dot-segments" ? `${fixture.tasks}/../tasks/task-one.output`
      : `${fixture.path}\0private`
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    const notification = {
      type: "system", subtype: "task_notification", uuid: crypto.randomUUID(), session_id: owner.nativeID,
      task_id: "task-one", run_id: "001", status: "completed", summary: "Finished", output_file: outputFile,
    } satisfies Extract<SDKMessage, { subtype: "task_notification" }>
    connection.observe(notification)
    const task = store.list(owner.sessionID)[0]!
    const output = await store.output(owner.sessionID, task.id)
    expect(output).toMatchObject({ available: false, text: "", truncated: false })
    expect(output.reason).toBeTruthy()
    const publicResult = JSON.stringify({ task, output })
    expect(publicResult).not.toContain(fixture.root)
    expect(publicResult).not.toContain("PRIVATE_FILE_CONTENT")
    expect(publicResult).not.toContain("output_file")
  })

  test("typed SDK output metadata permits the registered file without returning its private path", async () => {
    const fixture = await outputFixture()
    await writeFile(fixture.path, "Captured output")
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    const notification = {
      type: "system", subtype: "task_notification", uuid: crypto.randomUUID(), session_id: owner.nativeID,
      task_id: "task-one", run_id: "001", status: "completed", summary: "Finished", output_file: fixture.path,
    } satisfies Extract<SDKMessage, { subtype: "task_notification" }>
    connection.observe(notification)
    const task = store.list(owner.sessionID)[0]!
    expect(task.hasOutput).toBe(true)
    const output = await store.output(owner.sessionID, task.id)
    expect(output).toMatchObject({ available: true, text: "Captured output", truncated: false })
    const publicResult = JSON.stringify({ task, output })
    expect(publicResult).not.toContain(fixture.root)
    expect(publicResult).not.toContain("output_file")
    expect(publicResult).not.toContain("outputFile")
  })

  test.each(["wrong-owner", "wrong-basename", "outside-tasks", "file-symlink", "directory-symlink"] as const)("rejects SDK output paths with %s", async (mode) => {
    const fixture = await outputFixture()
    const secret = join(fixture.root, "private.log")
    await writeFile(secret, "DO_NOT_EXPOSE")
    let path = fixture.path
    if (mode === "wrong-owner") path = join(fixture.root, "native-other", "tasks", "task-one.output")
    if (mode === "wrong-basename") path = join(fixture.tasks, "another-task.output")
    if (mode === "outside-tasks") path = join(fixture.root, owner.nativeID, "logs", "task-one.output")
    if (mode === "file-symlink") await symlink(secret, path)
    else if (mode === "directory-symlink") {
      const real = join(fixture.root, "real-tasks")
      await mkdir(real)
      await writeFile(join(real, "task-one.output"), "DO_NOT_EXPOSE")
      const parent = join(fixture.root, "linked", owner.nativeID)
      await mkdir(parent, { recursive: true })
      await symlink(real, join(parent, "tasks"))
      path = join(parent, "tasks", "task-one.output")
    } else {
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, "DO_NOT_EXPOSE")
    }
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    finish(connection, "task-one", "001", { output_file: path })
    const result = await store.output(owner.sessionID, store.list(owner.sessionID)[0]!.id)
    expect(result.available).toBe(false)
    expect(result.text).toBe("")
    expect(result.reason).toBeTruthy()
  })

  test("a zero-byte SDK output file explains that redirected command output was not captured", async () => {
    const fixture = await outputFixture()
    await writeFile(fixture.path, "")
    const { store } = harness()
    const connection = store.connect(owner)
    bashResult(connection, fixture.path)
    const result = await store.output(owner.sessionID, store.list(owner.sessionID)[0]!.id)
    expect(result.text).toBe("")
    expect(result.truncated).toBe(false)
    expect(result.reason).toMatch(/empty|captur|redirect|no output/i)
  })

  test("unregistered or missing output returns an explanation rather than exposing a path or throwing", async () => {
    const fixture = await outputFixture()
    const { store } = harness()
    const connection = store.connect(owner)
    start(connection)
    const id = store.list(owner.sessionID)[0]!.id
    const unregistered = await store.output(owner.sessionID, id)
    expect(unregistered).toMatchObject({ available: false, text: "" })
    expect(unregistered.reason).toBeTruthy()
    finish(connection, "task-one", "001", { output_file: fixture.path })
    const missing = await store.output(owner.sessionID, id)
    expect(missing).toMatchObject({ available: false, text: "" })
    expect(missing.reason).toBeTruthy()
  })
})
