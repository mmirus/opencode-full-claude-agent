import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { inspectNativeSession, NativeSessionError } from "../scripts/support/native-session"
import { parseNativeSessionArgs } from "../scripts/inspect-native-session"

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

const nativeID = "01234567-89ab-4cde-8fab-0123456789ab"
const hostSessionID = "ses_host_with_%_wildcards"
// OpenCode v2.2.7 packages/core/src/plugin/host.ts storage(), independent of the helper's key construction.
const key = `plugin:00660075006c006c002d0063006c0061007500640065002d006100670065006e0074:session/${hostSessionID}`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-session-test-"))
  temporary.push(root)
  const configDir = join(root, "account")
  const project = join(configDir, "projects", "arbitrary-project-name")
  mkdirSync(project, { recursive: true })
  const transcript = join(project, `${nativeID}.jsonl`)
  writeFileSync(transcript, '{"type":"user","secret":"private prompt"}\n{"type":"assistant","text":"private reply"}\n')
  const database = join(root, "opencode.db")
  const db = new Database(database)
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, model TEXT); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)")
  db.query("INSERT INTO session_v2 (id, directory, model) VALUES (?, ?, ?)").run(hostSessionID, "/host/project", JSON.stringify({ providerID: "not-the-native-provider" }))
  db.close()
  const record = { version: 2, nativeID, outcome: "settled", nativeContext: { providerID: "native-account", configDir, directory: "/native/project" },
    binding: "private binding", delivery: [{ text: "private delivery" }], options: { apiKey: "private credentials" } }
  const save = (value: unknown, recordKey = key) => {
    const db = new Database(database)
    try { db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(recordKey, JSON.stringify(value)) } finally { db.close() }
  }
  save(record)
  return { root, configDir, project, transcript, database, record, save, options: { hostSessionID, database } }
}

async function errorCode(promise: Promise<unknown>, code: string) {
  try { await promise; throw new Error("Expected inspection to fail") } catch (error) {
    expect(error).toBeInstanceOf(NativeSessionError)
    expect((error as NativeSessionError).code).toBe(code)
  }
}

describe("offline native session inspection", () => {
  test("maps the exact global plugin key and emits only safe metadata by default", async () => {
    const f = fixture()
    f.save({ ...f.record, nativeID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, `location:other:${key}`)
    const result = await inspectNativeSession(f.options)
    expect(result).toEqual({ hostSessionID, nativeSessionID: nativeID, providerID: "native-account", configDir: f.configDir,
      nativeDirectory: "/native/project", hostDirectory: "/host/project", outcome: "settled", transcriptStatus: "found", transcriptPath: f.transcript })
    expect(JSON.stringify(result)).not.toContain("private")
    expect(result.tail).toBeUndefined()
  })

  test("rejects a different account but accepts the same canonical directory", async () => {
    const f = fixture()
    const other = join(f.root, "other")
    mkdirSync(other)
    await errorCode(inspectNativeSession({ ...f.options, configDir: other }), "CONFIG_DIR_MISMATCH")
    const alias = join(f.root, "account-alias")
    symlinkSync(f.configDir, alias)
    expect((await inspectNativeSession({ ...f.options, configDir: alias })).configDir).toBe(f.configDir)
  })

  test("reads V2 session metadata when a legacy session table also exists", async () => {
    const f = fixture()
    const db = new Database(f.database)
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)")
    db.query("INSERT INTO session (id, directory) VALUES (?, ?)").run(hostSessionID, "/legacy/project")
    db.close()
    expect((await inspectNativeSession(f.options)).hostDirectory).toBe("/host/project")
  })

  test("legacy versions require an explicit config directory and do not assume a provider", async () => {
    const f = fixture()
    for (const version of [1, 2]) {
      f.save({ version, nativeID, outcome: "ready" })
      await errorCode(inspectNativeSession(f.options), "CONFIG_DIR_REQUIRED")
      const result = await inspectNativeSession({ ...f.options, configDir: f.configDir })
      expect(result.transcriptStatus).toBe("found")
      expect(result.providerID).toBeUndefined()
      expect(result.nativeDirectory).toBeUndefined()
    }
  })

  test("rejects unsupported records, invalid UUIDs, and invalid native context", async () => {
    const f = fixture()
    for (const invalid of ["../../secret", "not-a-uuid", `${nativeID}/extra`, undefined]) {
      f.save({ ...f.record, nativeID: invalid })
      await errorCode(inspectNativeSession(f.options), "INVALID_NATIVE_ID")
    }
    f.save({ ...f.record, version: 3 })
    await errorCode(inspectNativeSession(f.options), "INVALID_RECORD_VERSION")
    f.save({ ...f.record, nativeContext: { configDir: f.configDir } })
    await errorCode(inspectNativeSession(f.options), "INVALID_NATIVE_CONTEXT")
    f.save({ ...f.record, outcome: "unknown" })
    await errorCode(inspectNativeSession(f.options), "INVALID_RECORD")
  })

  test("missing host sessions and plugin records have distinct stable errors", async () => {
    const f = fixture()
    await errorCode(inspectNativeSession({ ...f.options, hostSessionID: "ses_missing" }), "HOST_SESSION_MISSING")
    const db = new Database(f.database)
    db.query("DELETE FROM kv WHERE key = ?").run(key)
    db.close()
    f.save(f.record, key.replace(hostSessionID, "ses_host_with_XXwildcards"))
    await errorCode(inspectNativeSession(f.options), "NATIVE_RECORD_MISSING")
  })

  test("missing transcript is metadata, while multiple root transcripts are an error", async () => {
    const f = fixture()
    const second = join(f.configDir, "projects", "second")
    mkdirSync(second)
    writeFileSync(join(second, `${nativeID}.jsonl`), "{}\n")
    await errorCode(inspectNativeSession(f.options), "AMBIGUOUS_TRANSCRIPT")
    rmSync(second, { recursive: true })
    rmSync(f.transcript)
    const result = await inspectNativeSession({ ...f.options, tail: 3 })
    expect(result.transcriptStatus).toBe("missing")
    expect(result.transcriptPath).toBeUndefined()
    expect(result.tail).toBeUndefined()
    rmSync(join(f.configDir, "projects"), { recursive: true })
    expect((await inspectNativeSession(f.options)).transcriptStatus).toBe("missing")
  })

  test("ignores subagent transcripts and symlinks outside the selected account", async () => {
    const f = fixture()
    rmSync(f.transcript)
    const outside = join(f.root, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, `${nativeID}.jsonl`), '{"secret":"wrong account"}\n')
    symlinkSync(outside, join(f.configDir, "projects", "escaped-project"))
    symlinkSync(join(outside, `${nativeID}.jsonl`), f.transcript)
    const nested = join(f.project, nativeID, "subagents")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, `${nativeID}.jsonl`), "{}\n")
    expect((await inspectNativeSession({ ...f.options, tail: 1 })).transcriptStatus).toBe("missing")
  })

  test("follows the profile's configured projects symlink without searching other roots", async () => {
    const f = fixture()
    rmSync(join(f.configDir, "projects"), { recursive: true })
    const projects = join(f.root, "shared-projects")
    const project = join(projects, "native-project")
    mkdirSync(project, { recursive: true })
    const transcript = join(project, `${nativeID}.jsonl`)
    writeFileSync(transcript, '{"type":"assistant"}\n')
    symlinkSync(projects, join(f.configDir, "projects"))
    const other = join(f.root, "other-projects")
    mkdirSync(other)
    writeFileSync(join(other, `${nativeID}.jsonl`), '{"private":"another root"}\n')
    symlinkSync(other, join(projects, "outside-root"))
    const result = await inspectNativeSession({ ...f.options, tail: 1 })
    expect(result.configDir).toBe(f.configDir)
    expect(result.transcriptPath).toBe(transcript)
    expect(result.tail?.records).toEqual([{ line: 1, raw: '{"type":"assistant"}' }])
  })

  test("inspection does not change database bytes, transcript bytes, or directory entries", async () => {
    const f = fixture()
    const database = readFileSync(f.database)
    const transcript = readFileSync(f.transcript)
    const entries = readdirSync(f.root, { recursive: true })
    await inspectNativeSession({ ...f.options, tail: 1 })
    expect(readFileSync(f.database)).toEqual(database)
    expect(readFileSync(f.transcript)).toEqual(transcript)
    expect(readdirSync(f.root, { recursive: true })).toEqual(entries)
  })

  test("missing databases are not created", async () => {
    const f = fixture()
    const path = join(f.root, "missing.db")
    await errorCode(inspectNativeSession({ ...f.options, database: path }), "DATABASE_READ")
    expect(existsSync(path)).toBe(false)
  })

  test("returns only the last N raw records with physical line numbers across read chunks", async () => {
    const f = fixture()
    const records = Array.from({ length: 1500 }, (_, index) => JSON.stringify({ index, text: "λ".repeat(50) }))
    writeFileSync(f.transcript, `${records.join("\n")}\n`)
    const result = await inspectNativeSession({ ...f.options, tail: 3 })
    expect(result.tail).toEqual({ records: records.slice(-3).map((raw, index) => ({ line: 1498 + index, raw })),
      partialTail: false, snapshotBytes: readFileSync(f.transcript).length })
  })

  test("reports incomplete final records without misclassifying complete malformed lines", async () => {
    const f = fixture()
    writeFileSync(f.transcript, '{}\n{"type":"in-progress')
    const result = await inspectNativeSession({ ...f.options, tail: 2 })
    expect(result.tail?.records).toEqual([{ line: 1, raw: "{}" }])
    expect(result.tail?.partialTail).toBe(true)
    writeFileSync(f.transcript, '{}\nnot json\n{}\n')
    await expect(inspectNativeSession({ ...f.options, tail: 1 })).rejects.toThrow("Transcript contains invalid JSON at line 2.")
    expect((await inspectNativeSession(f.options)).transcriptStatus).toBe("found")
    writeFileSync(f.transcript, '{}\n{"complete":true}')
    expect((await inspectNativeSession({ ...f.options, tail: 1 })).tail?.records).toEqual([{ line: 2, raw: '{"complete":true}' }])
  })

  test("bounds a single unterminated line", async () => {
    const f = fixture()
    writeFileSync(f.transcript, "x".repeat(8 * 1024 * 1024 + 1))
    await errorCode(inspectNativeSession({ ...f.options, tail: 1 }), "TRANSCRIPT_LINE_TOO_LARGE")
  })

  test("validates tail limits before opening the database", async () => {
    for (const tail of [0, -1, 201, 1.5, NaN]) {
      await errorCode(inspectNativeSession({ hostSessionID, database: "/does-not-exist", tail }), "INVALID_TAIL")
    }
  })

  test("CLI with explicit database works without opencode, service discovery, or an account default", async () => {
    const f = fixture()
    const child = Bun.spawn([process.execPath, "scripts/inspect-native-session.ts", hostSessionID, "--database", f.database],
      { env: { PATH: "", CLAUDE_CONFIG_DIR: "/not-the-selected-account" }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(JSON.parse(stdout).nativeSessionID).toBe(nativeID)
    expect(stdout).not.toContain("private")
  })

  test("CLI argument errors are stable", () => {
    expect(parseNativeSessionArgs([hostSessionID, "--tail", "200", "--database", "private.db"])).toEqual({ hostSessionID, tail: 200, database: "private.db" })
    for (const args of [[], [hostSessionID, "--unknown", "x"], [hostSessionID, "--tail"], [hostSessionID, "--tail", "1", "--tail", "2"]]) {
      expect(() => parseNativeSessionArgs(args)).toThrow("Usage:")
    }
    for (const value of ["0", "201", "1.5", "NaN"]) {
      expect(() => parseNativeSessionArgs([hostSessionID, "--tail", value])).toThrow("--tail must be an integer from 1 to 200.")
    }
  })

  test("CLI default database discovery invokes only debug paths db", async () => {
    const f = fixture()
    const bin = join(f.root, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "opencode"), `#!/bin/sh\n[ "$*" = "debug paths db" ] || exit 9\nprintf '%s\\n' '${f.database}'\n`, { mode: 0o700 })
    const child = Bun.spawn([process.execPath, "scripts/inspect-native-session.ts", hostSessionID],
      { env: { PATH: bin }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(JSON.parse(stdout).nativeSessionID).toBe(nativeID)
  })

  test("CLI reports database discovery failure without leaking process errors", async () => {
    const child = Bun.spawn([process.execPath, "scripts/inspect-native-session.ts", hostSessionID],
      { env: { PATH: "" }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr).error).toBe("DATABASE_PATH")
  })
})
