import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to test native permission rejection on the running OpenCode server.")
  process.exit(0)
}
const root = createTempDirectory("full-claude-permission-")
const target = join(root, "approval-test.txt")
mkdirSync(join(root, ".claude"))
writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify({ permissions: { ask: ["Write"] } }))
writeFileSync(join(root, "opencode.json"), JSON.stringify({ permissions: [{ action: "edit", resource: target, effect: "ask" }] }))
const endpoint = await Service.discover()
assert(endpoint, "No running OpenCode server")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const abort = new AbortController()
const ready = Promise.withResolvers<void>()
const completed = Promise.withResolvers<void>()
void completed.promise.catch(() => {})
const timer = setTimeout(() => {
  const error = new Error("Permission smoke timed out")
  abort.abort(error)
  ready.reject(error)
  completed.reject(error)
}, 60_000)
console.log(`Permission smoke artifacts: ${root}`)
let sessionID: string | undefined
let asked = false
const pump = (async () => {
  for await (const event of client.event.subscribe({ types: ["permission.asked", "session.execution.succeeded", "session.execution.failed"], signal: abort.signal })) {
    if (event.type === "server.connected") { ready.resolve(); continue }
    if (event.data.sessionID !== sessionID) continue
    if (event.type === "permission.asked") {
      asked = true
      assert(event.location, "Permission event has no location")
      await client.permission.reply({ sessionID: event.data.sessionID, requestID: event.data.id, decision: "reject" }, { signal: abort.signal })
    } else completed.resolve()
  }
})().catch((error) => { ready.reject(error); completed.reject(error) })
try {
  await ready.promise
  const session = await client.session.create({ location: { directory: root }, title: "Native permission rejection smoke", model: { providerID: "full-claude-agent", id: "haiku" } }, { signal: abort.signal })
  sessionID = session.id
  await client.session.prompt({ sessionID, text: `Use native Write to create ${target} containing PERMISSION_TEST. Do not use another tool to create it. If permission is denied, stop without retrying.` }, { signal: abort.signal })
  await completed.promise
  const history = await client.session.context({ sessionID }, { signal: abort.signal })
  const assistant = history.findLast((message) => message.type === "assistant")
  assert(assistant?.type === "assistant")
  const tools = assistant.content.filter((part) => part.type === "tool")
  const summary = { sessionID, root, permissionAsked: asked, fileExists: existsSync(target), finish: assistant.finish, error: assistant.error,
    tools: tools.map((tool) => ({ name: tool.name, status: tool.state.status, error: tool.state.status === "error" ? tool.state.error : undefined })) }
  writeFileSync(join(root, "result.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  assert(asked, "Native write failed without asking OpenCode for permission")
  assert(!existsSync(target), "Rejected write created the file")
  assert(!assistant.error && assistant.finish === "stop", "Rejecting a write failed the model turn")
  assert(tools.every((tool) => tool.state.status !== "running" && tool.state.status !== "streaming"), "Rejected tool is still running")
  console.log("PASS: permission rejection prevents the write and completes the native turn")
} finally {
  abort.abort()
  clearTimeout(timer)
  await pump
  if (sessionID) await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(5_000) }).catch(() => {})
}
