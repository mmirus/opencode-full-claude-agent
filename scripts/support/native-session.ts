import { Database } from "bun:sqlite"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export class NativeSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "NativeSessionError"
  }
}

export interface NativeSessionOptions {
  hostSessionID: string
  database: string
  configDir?: string
  tail?: number
}

export interface NativeSessionInspection {
  hostSessionID: string
  nativeSessionID: string
  providerID?: string
  configDir: string
  nativeDirectory?: string
  hostDirectory: string
  outcome: "ready" | "pending" | "settled" | "uncertain"
  transcriptStatus: "found" | "missing"
  transcriptPath?: string
  tail?: {
    records: Array<{ line: number; raw: string }>
    partialTail: boolean
    snapshotBytes: number
  }
}

// Matches OpenCode 2.2.7's plugin storage namespace in packages/core/src/plugin/host.ts.
const namespace = `plugin:${"full-claude-agent".split("").map((value) => value.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const maxLineBytes = 8 * 1024 * 1024

function fail(code: string, message: string): never {
  throw new NativeSessionError(code, message)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function missing(error: unknown) {
  return object(error) && error.code === "ENOENT"
}

function within(root: string, path: string) {
  const remainder = relative(root, path)
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder)
}

async function canonicalConfig(path: string) {
  try {
    const canonical = await realpath(resolve(path))
    if (!(await lstat(canonical)).isDirectory()) fail("CONFIG_DIRECTORY", "Claude config directory is not a directory.")
    return canonical
  } catch (error) {
    if (error instanceof NativeSessionError) throw error
    fail("CONFIG_DIRECTORY", "Cannot resolve Claude config directory.")
  }
}

function readMapping(options: NativeSessionOptions): {
  nativeSessionID: string
  outcome: NativeSessionInspection["outcome"]
  hostDirectory: string
  context?: { providerID: string; configDir: string; directory: string }
} {
  let db: Database | undefined
  try {
    db = new Database(options.database, { readonly: true, create: false, strict: true })
    const host = db.query<{ directory: string }, [string]>("SELECT directory FROM session_v2 WHERE id = ?").get(options.hostSessionID)
    if (!host) fail("HOST_SESSION_MISSING", "OpenCode session was not found in the selected database.")
    const row = db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(`${namespace}session/${options.hostSessionID}`)
    if (!row) fail("NATIVE_RECORD_MISSING", "Full Claude Agent has no native session record for this OpenCode session.")
    let record: unknown
    try { record = JSON.parse(row.value) } catch { fail("INVALID_RECORD", "Native session record is not valid JSON.") }
    if (!object(record) || (record.version !== 1 && record.version !== 2)) {
      fail("INVALID_RECORD_VERSION", "Native session record must have version 1 or 2.")
    }
    if (typeof record.nativeID !== "string" || !uuid.test(record.nativeID)) {
      fail("INVALID_NATIVE_ID", "Native session record does not contain a valid UUID nativeID.")
    }
    const outcome = record.outcome
    if (outcome !== "ready" && outcome !== "pending" && outcome !== "settled" && outcome !== "uncertain") {
      fail("INVALID_RECORD", "Native session record has an invalid outcome.")
    }
    const context = record.nativeContext
    if (context !== undefined && (!object(context) || typeof context.providerID !== "string" || !context.providerID ||
      typeof context.configDir !== "string" || !context.configDir || typeof context.directory !== "string" || !context.directory)) {
      fail("INVALID_NATIVE_CONTEXT", "Native session record has an invalid nativeContext.")
    }
    return {
      nativeSessionID: record.nativeID,
      outcome,
      hostDirectory: host.directory,
      context: context as { providerID: string; configDir: string; directory: string } | undefined,
    }
  } catch (error) {
    if (error instanceof NativeSessionError) throw error
    return fail("DATABASE_READ", "Cannot read the OpenCode database. Supply --database with a compatible local database path.")
  } finally {
    db?.close()
  }
}

async function locateTranscript(configDir: string, nativeID: string) {
  let projects: string
  let entries: string[]
  try {
    projects = await realpath(join(configDir, "projects"))
    entries = await readdir(projects)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  const matches = new Set<string>()
  for (const entry of entries) {
    try {
      const project = await realpath(join(projects, entry))
      if (!within(projects, project) || !(await lstat(project)).isDirectory()) continue
      const path = await realpath(join(project, `${nativeID}.jsonl`))
      if (within(projects, path) && (await lstat(path)).isFile()) matches.add(path)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  if (matches.size > 1) fail("AMBIGUOUS_TRANSCRIPT", "Multiple root transcripts match nativeID in the selected config directory.")
  return matches.values().next().value as string | undefined
}

async function readTail(path: string, count: number): Promise<NonNullable<NativeSessionInspection["tail"]>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const snapshotBytes = (await file.stat()).size
    const records: Array<{ line: number; raw: string }> = []
    let pending = Buffer.alloc(0)
    let line = 0
    let position = 0
    let partialTail = false
    const accept = (bytes: Buffer, complete: boolean) => {
      line++
      if (bytes.length > maxLineBytes) fail("TRANSCRIPT_LINE_TOO_LARGE", `Transcript line ${line} exceeds the 8 MiB inspection limit.`)
      const raw = bytes.toString("utf8")
      try { JSON.parse(raw) } catch {
        if (!complete) { partialTail = true; return }
        fail("MALFORMED_TRANSCRIPT", `Transcript contains invalid JSON at line ${line}.`)
      }
      records.push({ line, raw })
      if (records.length > count) records.shift()
    }
    const chunk = Buffer.alloc(64 * 1024)
    while (position < snapshotBytes) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, snapshotBytes - position), position)
      if (!bytesRead) fail("TRANSCRIPT_CHANGED", "Transcript was truncated while reading the snapshot.")
      position += bytesRead
      const bytes = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
      let start = 0
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 10) continue
        accept(bytes.subarray(start, index), true)
        start = index + 1
      }
      pending = Buffer.from(bytes.subarray(start))
      if (pending.length > maxLineBytes) fail("TRANSCRIPT_LINE_TOO_LARGE", `Transcript line ${line + 1} exceeds the 8 MiB inspection limit.`)
    }
    if (pending.length) accept(pending, false)
    return { records, partialTail, snapshotBytes }
  } finally {
    await file.close()
  }
}

export async function inspectNativeSession(options: NativeSessionOptions): Promise<NativeSessionInspection> {
  if (!options.hostSessionID) fail("INVALID_ARGUMENT", "An OpenCode session ID is required.")
  if (options.tail !== undefined && (!Number.isInteger(options.tail) || options.tail < 1 || options.tail > 200)) {
    fail("INVALID_TAIL", "--tail must be an integer from 1 to 200.")
  }
  const mapping = readMapping(options)
  if (!mapping.context && !options.configDir) {
    fail("CONFIG_DIR_REQUIRED", "Native session record has no account context. Supply --config-dir explicitly; no default account is selected.")
  }
  const configDir = await canonicalConfig(mapping.context?.configDir ?? options.configDir!)
  if (mapping.context && options.configDir && await canonicalConfig(options.configDir) !== configDir) {
    fail("CONFIG_DIR_MISMATCH", "--config-dir does not match the native session record's account directory.")
  }
  let transcriptPath: string | undefined
  try {
    transcriptPath = await locateTranscript(configDir, mapping.nativeSessionID)
  } catch (error) {
    if (error instanceof NativeSessionError) throw error
    fail("TRANSCRIPT_LOOKUP", "Cannot search transcripts in the selected config directory.")
  }
  let tail: NativeSessionInspection["tail"]
  if (transcriptPath && options.tail !== undefined) {
    try {
      tail = await readTail(transcriptPath, options.tail)
    } catch (error) {
      if (error instanceof NativeSessionError) throw error
      fail("TRANSCRIPT_READ", "Cannot read the native transcript snapshot.")
    }
  }
  return {
    hostSessionID: options.hostSessionID,
    nativeSessionID: mapping.nativeSessionID,
    ...(mapping.context ? { providerID: mapping.context.providerID, nativeDirectory: mapping.context.directory } : {}),
    configDir,
    hostDirectory: mapping.hostDirectory,
    outcome: mapping.outcome,
    transcriptStatus: transcriptPath ? "found" : "missing",
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(tail ? { tail } : {}),
  }
}
