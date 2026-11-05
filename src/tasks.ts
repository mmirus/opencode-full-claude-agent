import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { NativeTask } from "./task-rpc.js"
import { digest } from "./prompt.js"

const PREFIX = "native-tasks/"
const OUTPUT_BYTES = 64 * 1024
const TERMINAL = new Set<NativeTask["state"]>(["completed", "failed", "stopped"])
interface Owner { sessionID: string; providerID: string; nativeID: string }
interface Stored {
  view: NativeTask
  nativeID: string
  generation: string
  runID?: string
  background: boolean
  outputFile?: string
  stopping?: boolean
  startEventID?: string
  startEvents?: string[]
}
interface Connection {
  owner: Owner
  generation: string
  stopTask?: (taskID: string) => Promise<void>
  live?: Map<string, string | undefined>
  calls: Map<string, { name: string; description: string }>
}
interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: any): Promise<void>
  scan(input: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

const plain = (text: string) => stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

export class NativeTaskStore {
  private records = new Map<string, Map<string, Stored>>()
  private connections = new Map<string, Connection>()
  private dirty = new Set<string>()
  private flushing?: Promise<void>
  private disposed = false

  constructor(private storage: Storage, private changed: (sessionID: string) => Promise<void>, private now = Date.now) {}

  async restore() {
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: PREFIX, after, limit: 100 })
      for (const { key, value } of page.entries) {
        const saved = value as { version?: number; tasks?: Stored[] }
        if (saved?.version !== 1 || !Array.isArray(saved.tasks)) continue
        const sessionID = key.slice(PREFIX.length)
        const records = new Map<string, Stored>()
        for (const task of saved.tasks) {
          const parsed = NativeTask.safeParse(task.view)
          if (!parsed.success || parsed.data.sessionID !== sessionID || typeof task.nativeID !== "string") continue
          const record = { ...task, view: parsed.data, stopping: false }
          record.view.canStop = false
          if (record.view.state === "running") {
            record.view.state = "unknown"
            record.view.detail = "Claude connection restarted; task outcome is not confirmed."
          }
          records.set(record.view.taskID, record)
        }
        this.records.set(sessionID, records)
      }
      after = page.next
    } while (after)
  }

  connect(owner: Owner, stopTask?: (taskID: string) => Promise<void>) {
    this.close(owner.sessionID)
    const connection: Connection = { owner, generation: randomUUID(), stopTask, calls: new Map() }
    if (!this.disposed) this.connections.set(owner.sessionID, connection)
    return {
      observe: (message: SDKMessage) => {
        if (!this.disposed && this.connections.get(owner.sessionID) === connection) this.observe(connection, message)
      },
      close: () => { if (this.connections.get(owner.sessionID) === connection) this.close(owner.sessionID) },
    }
  }

  list(sessionID: string): NativeTask[] {
    const connection = this.connections.get(sessionID)
    const tasks = [...(this.records.get(sessionID)?.values() ?? [])].filter((record) => record.background).map((record) => ({
      ...record.view,
      canStop: record.view.state === "running" && !record.stopping && !!connection?.stopTask && connection.generation === record.generation,
      hasOutput: !!record.outputFile,
    })).sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.updatedAt - a.updatedAt)
    // RPC responses must be JSON values; optional SDK fields can be present with undefined.
    return JSON.parse(JSON.stringify(tasks))
  }

  async stop(sessionID: string, id: string) {
    const record = this.find(sessionID, id)
    const connection = this.connections.get(sessionID)
    if (!record || !connection?.stopTask || record.generation !== connection.generation || record.view.state !== "running" || record.stopping) {
      return { requested: false }
    }
    record.stopping = true
    record.view.detail = "Stop requested; waiting for Claude."
    this.save(sessionID)
    try { await connection.stopTask(record.view.taskID) }
    catch (error) {
      if (this.find(sessionID, id) === record && this.connections.get(sessionID) === connection && record.stopping && record.view.state === "running") {
        record.stopping = false
        record.view.detail = `Stop request failed: ${error instanceof Error ? error.message : String(error)}`
        this.save(sessionID)
      }
      throw error
    }
    return { requested: true }
  }

  async output(sessionID: string, id: string) {
    const record = this.find(sessionID, id)
    if (!record) return { text: "", truncated: false, available: false, reason: "This native task is no longer available." }
    if (!record.outputFile) return this.noOutput("Claude has not provided an output file for this task.")
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      const path = record.outputFile
      if (!this.outputPath(record, path) || await realpath(dirname(path)) !== dirname(path)) {
        return this.noOutput("The native output path is not a supported task file.")
      }
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await file.stat()
      if (!stat.isFile()) return this.noOutput("The native output is not a regular file.")
      const length = Math.min(stat.size, OUTPUT_BYTES)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, stat.size - length))
      return { text: plain(buffer.subarray(0, bytesRead).toString("utf8")), truncated: stat.size > OUTPUT_BYTES, available: true,
        ...(bytesRead ? {} : { reason: "No captured output yet. Output redirected by the command is stored separately." }) }
    } catch {
      return this.noOutput("The native output file is unavailable.")
    } finally { await file?.close() }
  }

  async flush() { while (this.flushing) await this.flushing }

  async dispose() {
    this.disposed = true
    for (const sessionID of [...this.connections.keys()]) this.close(sessionID)
    await this.flush()
  }

  private find(sessionID: string, id: string) {
    return [...(this.records.get(sessionID)?.values() ?? [])].find((record) => record.view.id === id && record.background)
  }

  private noOutput(reason: string) {
    return { text: "", truncated: false, available: false, reason }
  }

  private outputPath(record: Stored, path: string) {
    return isAbsolute(path) && !/[\0\r\n]/.test(path) && resolve(path) === path && basename(path) === `${record.view.taskID}.output` &&
      basename(dirname(path)) === "tasks" && basename(dirname(dirname(path))) === record.nativeID
  }

  private record(connection: Connection, taskID: string, runID?: string, restart?: string): Stored | undefined {
    const { owner, generation } = connection
    let records = this.records.get(owner.sessionID)
    if (!records) this.records.set(owner.sessionID, records = new Map())
    let record = records.get(taskID)
    if (record?.runID && runID && runID < record.runID && record.nativeID === owner.nativeID) return
    if (!record || restart || record.nativeID !== owner.nativeID || record.view.providerID !== owner.providerID || (runID && runID !== record.runID) ||
      (record.generation !== generation && !runID)) {
      record = { nativeID: owner.nativeID, generation, runID, background: true,
        startEvents: record?.nativeID === owner.nativeID ? record.startEvents : undefined,
        view: { id: digest([owner.sessionID, owner.providerID, owner.nativeID, taskID, runID ?? restart ?? generation]), sessionID: owner.sessionID,
          providerID: owner.providerID, taskID, kind: "task", description: "Native Claude task", state: "running",
          startedAt: this.now(), updatedAt: this.now(), ambient: false, canStop: false, hasOutput: false } }
      records.set(taskID, record)
    }
    record.generation = generation
    return record
  }

  private reconcileLive(connection: Connection) {
    if (!connection.live) return
    for (const record of this.records.get(connection.owner.sessionID)?.values() ?? []) {
      if (record.generation !== connection.generation || TERMINAL.has(record.view.state)) continue
      const liveRun = connection.live.get(record.view.taskID)
      if (connection.live.has(record.view.taskID) && (!liveRun || !record.runID || liveRun === record.runID)) {
        record.background = true
        record.view.state = "running"
      } else if (record.view.state === "running") {
        record.view.state = "unknown"
        record.view.detail = "Task is no longer listed by Claude; final outcome is not confirmed."
        record.stopping = false
      }
    }
  }

  private observe(connection: Connection, message: SDKMessage) {
    const sessionID = connection.owner.sessionID
    if ("session_id" in message && message.session_id && message.session_id !== connection.owner.nativeID) return
    if (message.type === "assistant") {
      for (const content of message.message?.content ?? []) {
        if (content.type !== "tool_use" || !["Bash", "Monitor"].includes(content.name)) continue
        const input = typeof content.input === "object" && content.input !== null ? content.input as Record<string, unknown> : {}
        connection.calls.set(content.id, { name: content.name,
          description: typeof input.description === "string" ? input.description : content.name })
      }
      return
    }
    if (message.type === "user") {
      const result = message.tool_use_result as { backgroundTaskId?: unknown } | undefined
      if (!Array.isArray(message.message.content)) return
      if (!result || typeof result.backgroundTaskId !== "string") {
        for (const content of message.message.content) if (content.type === "tool_result") connection.calls.delete(content.tool_use_id)
        return
      }
      const record = this.record(connection, result.backgroundTaskId)
      if (!record) return
      for (const content of message.message.content) {
        if (content.type !== "tool_result") continue
        const call = connection.calls.get(content.tool_use_id)
        connection.calls.delete(content.tool_use_id)
        record.view.toolCallID = content.tool_use_id
        if (call) { record.view.description = call.description; record.view.kind = call.name === "Bash" ? "local_bash" : call.name }
        const text = typeof content.content === "string" ? content.content : ""
        const output = /Output is being written to: (.+?\.output)(?:\.|\s|$)/.exec(text)?.[1]
        if (output && this.outputPath(record, output)) record.outputFile = output
      }
      record.background = true
      this.reconcileLive(connection)
      this.save(sessionID)
      return
    }
    if (message.type !== "system") return
    if (message.subtype === "background_tasks_changed") {
      const live = new Map<string, string | undefined>()
      for (const task of message.tasks) {
        const previous = this.records.get(sessionID)?.get(task.task_id)
        const restart = !task.run_id && !previous?.runID && previous && TERMINAL.has(previous.view.state) ? randomUUID() : undefined
        const record = this.record(connection, task.task_id, task.run_id, restart)
        if (!record) {
          const current = this.records.get(sessionID)?.get(task.task_id)
          if (current?.generation === connection.generation && current.view.state === "running") live.set(task.task_id, current.runID)
          continue
        }
        live.set(task.task_id, task.run_id)
        record.background = true
        Object.assign(record.view, { description: task.description, kind: task.task_type, parentTaskID: task.parent_task_id,
          ambient: task.ambient === true, updatedAt: this.now() })
      }
      connection.live = live
      this.reconcileLive(connection)
      this.save(sessionID)
      return
    }
    if (!["task_started", "task_updated", "task_progress", "task_notification"].includes(message.subtype)) return
    if (!("task_id" in message)) return
    const previous = this.records.get(sessionID)?.get(message.task_id)
    if (message.subtype === "task_started" && previous?.nativeID === connection.owner.nativeID &&
      previous.view.providerID === connection.owner.providerID && previous.startEvents?.includes(message.uuid)) return
    const restart = message.subtype === "task_started" && !message.run_id && !previous?.runID && previous?.startEventID &&
      previous.startEventID !== message.uuid && TERMINAL.has(previous.view.state) &&
      (!connection.live || connection.live.has(message.task_id)) ? message.uuid : undefined
    const record = this.record(connection, message.task_id, message.run_id, restart)
    if (!record) return
    record.view.updatedAt = this.now()
    if (message.subtype === "task_started") {
      record.startEventID = message.uuid
      record.startEvents = [...new Set([...(previous?.nativeID === record.nativeID ? previous.startEvents ?? [] : []), message.uuid])]
      record.background = message.is_backgrounded !== false
      Object.assign(record.view, { description: message.description, kind: message.task_type ?? "task",
        toolCallID: message.tool_use_id, parentTaskID: message.parent_task_id, ambient: message.ambient === true || message.skip_transcript === true })
    } else if (message.subtype === "task_updated") {
      const patch = message.patch
      if (patch.description !== undefined) record.view.description = patch.description
      if (patch.is_backgrounded !== undefined) record.background = patch.is_backgrounded
      if (patch.error) record.view.detail = patch.error
      if (patch.status && !TERMINAL.has(record.view.state)) {
        record.view.state = patch.status === "killed" ? "stopped" : patch.status === "pending" ? "running" : patch.status === "paused" ? "unknown" : patch.status
        if (patch.status === "paused") record.view.detail = "Paused by Claude."
      }
      if (patch.end_time !== undefined) record.view.finishedAt = patch.end_time
    } else if (message.subtype === "task_progress") {
      record.view.description = message.description
      if (!TERMINAL.has(record.view.state) && message.summary) record.view.detail = message.summary
    } else if (message.subtype === "task_notification") {
      record.view.state = message.status
      record.view.finishedAt = this.now()
      record.view.detail = message.summary
      record.stopping = false
      if (message.tool_use_id) record.view.toolCallID = message.tool_use_id
      if (message.ambient !== undefined) record.view.ambient = message.ambient
      if (this.outputPath(record, message.output_file)) record.outputFile = message.output_file
    }
    if (TERMINAL.has(record.view.state)) { record.view.finishedAt ??= this.now(); record.stopping = false }
    this.reconcileLive(connection)
    this.save(sessionID)
  }

  private close(sessionID: string) {
    const connection = this.connections.get(sessionID)
    if (!connection) return
    this.connections.delete(sessionID)
    for (const record of this.records.get(sessionID)?.values() ?? []) {
      if (record.generation !== connection.generation || record.view.state !== "running") continue
      record.view.state = "unknown"
      record.view.detail = "Claude connection closed; task outcome is not confirmed."
      record.stopping = false
    }
    this.save(sessionID)
  }

  private save(sessionID: string) {
    const records = this.records.get(sessionID)
    const inactive = [...(records?.values() ?? [])].filter((record) => record.view.state !== "running").sort((a, b) => b.view.updatedAt - a.view.updatedAt)
    for (const record of inactive.slice(200)) records?.delete(record.view.taskID)
    this.dirty.add(sessionID)
    this.startFlush()
  }

  private startFlush() {
    if (this.flushing) return
    this.flushing = Promise.resolve().then(async () => {
      while (this.dirty.size) {
        const ids = [...this.dirty]
        this.dirty.clear()
        for (const sessionID of ids) {
          const tasks = [...(this.records.get(sessionID)?.values() ?? [])]
          try { await this.storage.set(`${PREFIX}${sessionID}`, JSON.parse(JSON.stringify({ version: 1, tasks }))) }
          catch (error) { console.error("Full Claude Agent task persistence failed", error) }
          try { await this.changed(sessionID) }
          catch (error) { console.error("Full Claude Agent task event failed", error) }
        }
      }
    }).finally(() => { this.flushing = undefined; if (this.dirty.size) this.startFlush() })
  }
}
