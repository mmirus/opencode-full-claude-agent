import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Model } from "@opencode/schema/model"
import { FileDiff } from "@opencode/schema/file-diff"
import { Option, Schema } from "effect"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to verify native file-diff metadata on the running server.")
  process.exit(0)
}
const directory = createTempDirectory("full-claude-diffs-")
const edited = join(directory, "edit.txt")
const overwritten = join(directory, "overwrite.txt")
const created = join(directory, "created.txt")
const denied = join(directory, "denied.txt")
writeFileSync(edited, "context before\nBEFORE_EDIT\ncontext after\n")
writeFileSync(overwritten, "BEFORE_WRITE\n")
mkdirSync(join(directory, ".claude"))
const hook = join(directory, "deny.cjs")
writeFileSync(hook, `const fs=require("node:fs"); const path=require("node:path"); const input=JSON.parse(fs.readFileSync(0,"utf8")); if(path.basename(input.tool_input?.file_path??"")==="denied.txt") process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"The diff fixture denies this write. Do not retry."}}));`)
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
writeFileSync(join(directory, ".claude/settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(hook)}` }] }] } }))
const endpoint = await Service.discover()
assert(endpoint, "No running OpenCode server")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const signal = AbortSignal.timeout(120_000)
const decodeDiffs = Schema.decodeUnknownOption(Schema.Struct({ experimental: Schema.Struct({ fileDiffs: Schema.Array(FileDiff.Info) }) }))
const nativeDiffs = (native: unknown) => {
  const decoded = decodeDiffs(native)
  return Option.isSome(decoded) ? decoded.value.experimental.fileDiffs : []
}
let sessionID: string | undefined
console.log(`Diff smoke directory: ${directory}`)
try {
  const session = await client.session.create({ location: { directory }, title: "Full Claude native diff smoke",
    model: Model.Ref.parse(process.env.FULL_CLAUDE_PARENT_MODEL ?? "full-claude-agent/haiku"),
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }, { signal })
  sessionID = session.id
  await client.session.prompt({ sessionID, text: `This is a disposable native tool test. Perform these steps in order, without other tools or files:
1. Read ${edited} and ${overwritten} using native Read.
2. Use native Edit on ${edited}: replace BEFORE_EDIT with AFTER_EDIT.
3. Use native Write to create ${created} with content ${JSON.stringify("CREATED_LINE\n")}.
4. Use native Write to overwrite ${overwritten} with content ${JSON.stringify("AFTER_WRITE\n")}.
5. Attempt one native Write to ${denied} with content "must not exist". A hook will deny it. Do not retry or bypass the denial.
6. Attempt one native Edit on ${edited}, replacing MISSING_SENTINEL with UNEXPECTED. The string is absent; the edit must fail. Do not retry.
7. Reply DIFF_SMOKE_OK without printing diffs or file contents in the final answer.` }, { signal })
  await client.experimental.session.wait({ sessionID }, { signal })
  const history = await client.session.context({ sessionID }, { signal })
  writeFileSync(join(directory, "history.json"), JSON.stringify(history, null, 2), { mode: 0o600 })
  const assistant = history.findLast((message) => message.type === "assistant")
  assert(assistant?.type === "assistant" && !assistant.error && assistant.finish === "stop", "Native test did not complete")
  const tools = assistant.content.flatMap((part) => part.type === "tool" && (part.name === "Edit" || part.name === "Write") ? [part] : [])
  const completed = tools.filter((tool) => tool.state.status === "completed")
  const failed = tools.filter((tool) => tool.state.status === "error")
  assert.equal(completed.length, 3)
  assert.equal(failed.length, 2)
  for (const tool of completed) {
    assert(tool.executed, "Native tool was executed by OpenCode")
    assert.equal(nativeDiffs(tool.native).length, 1, `Missing authoritative diff on ${tool.name}`)
  }
  for (const tool of failed) assert.equal(nativeDiffs(tool.native).length, 0, "A failed operation was reported as an applied diff")
  const files = completed.flatMap((tool) => nativeDiffs(tool.native))
  const edit = files.find((file) => file.file === "edit.txt")
  const write = files.find((file) => file.file === "overwrite.txt")
  const create = files.find((file) => file.file === "created.txt")
  assert(edit && write && create, "Expected file diffs were not found")
  assert.equal(edit?.status, "modified")
  assert(edit.patch.includes("-BEFORE_EDIT") && edit.patch.includes("+AFTER_EDIT"))
  assert.equal(write?.status, "modified")
  assert(write.patch.includes("-BEFORE_WRITE") && write.patch.includes("+AFTER_WRITE"))
  assert.equal(create?.status, "added")
  assert(create.patch.includes("/dev/null") && create.patch.includes("+CREATED_LINE"))
  assert.equal(readFileSync(edited, "utf8"), "context before\nAFTER_EDIT\ncontext after\n")
  assert.equal(readFileSync(overwritten, "utf8"), "AFTER_WRITE\n")
  assert.equal(readFileSync(created, "utf8"), "CREATED_LINE\n")
  assert(!existsSync(denied))
  const text = assistant.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
  assert(text.includes("DIFF_SMOKE_OK"))
  assert(!text.includes("@@ ") && !text.includes("```diff"), "Display diffs leaked into assistant text")
  const summary = { status: "passed", directory, sessionID, files: files.map((file) => ({ file: file.file, status: file.status, additions: file.additions, deletions: file.deletions })), failedTools: failed.length }
  writeFileSync(join(directory, "success.json"), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
} finally {
  if (sessionID) await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(10_000) }).catch(() => {})
}
