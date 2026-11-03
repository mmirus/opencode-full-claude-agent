import assert from "node:assert/strict"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Model } from "@opencode/schema/model"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DELEGATION_SERVER } from "../src/delegation-mcp.js"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 and FULL_CLAUDE_DELEGATE_MODEL=provider/model to test delegated-child cancellation.")
  process.exit(0)
}
assert(process.env.FULL_CLAUDE_DELEGATE_MODEL, "Set FULL_CLAUDE_DELEGATE_MODEL to the exact requested child model")
const target = Model.Ref.parse(process.env.FULL_CLAUDE_DELEGATE_MODEL)
const parentModel = Model.Ref.parse(process.env.FULL_CLAUDE_PARENT_MODEL ?? "full-claude-agent/haiku")
const directory = createTempDirectory("full-claude-delegation-cancel-")
const endpoint = await Service.discover()
assert(endpoint, "No running OpenCode server")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const abort = new AbortController()
const ready = Promise.withResolvers<void>()
const started = Promise.withResolvers<void>()
const interrupted = Promise.withResolvers<void>()
void started.promise.catch(() => {})
void interrupted.promise.catch(() => {})
const timer = setTimeout(() => {
  const error = new Error("Delegation cancellation smoke timed out")
  abort.abort(error)
  ready.reject(error); started.reject(error); interrupted.reject(error)
}, 60_000)
let parentID: string | undefined
let childID: string | undefined
const pump = (async () => {
  for await (const event of client.event.subscribe({ types: ["session.created", "session.execution.started", "session.execution.interrupted"], signal: abort.signal })) {
    if (event.type === "server.connected") { ready.resolve(); continue }
    if (event.type === "session.created" && event.data.parentID === parentID) childID = event.data.sessionID
    if (event.type === "session.execution.started" && event.data.sessionID === childID) started.resolve()
    if (event.type === "session.execution.interrupted" && event.data.sessionID === childID) interrupted.resolve()
  }
})().catch((error) => { ready.reject(error); started.reject(error); interrupted.reject(error) })
console.log(`Cancellation smoke artifacts: ${directory}`)
try {
  await ready.promise
  const session = await client.session.create({ location: { directory }, title: "Full Claude delegation cancellation smoke", model: parentModel,
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: `claude.mcp__${DELEGATION_SERVER}__list_models`, resource: "*", effect: "allow" },
      { action: `claude.mcp__${DELEGATION_SERVER}__delegate`, resource: "*", effect: "allow" },
      { action: "subagent", resource: "general", effect: "allow" },
    ],
  }, { signal: abort.signal })
  parentID = session.id
  await client.session.prompt({ sessionID: parentID, text: `Use mcp__${DELEGATION_SERVER}__list_models to find ${process.env.FULL_CLAUDE_DELEGATE_MODEL}, then use mcp__${DELEGATION_SERVER}__delegate once to run a foreground general subagent on that exact model. Its task is: "Do not use tools. Explain in detail why session cancellation must stop delegated child operations." Do not use any other tools.` }, { signal: abort.signal })
  await started.promise
  const before = Date.now()
  await client.session.interrupt({ sessionID: parentID, resume: false }, { signal: abort.signal })
  await interrupted.promise
  assert(childID, "No delegated child was created")
  const cleanupSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])
  await Promise.all([
    client.experimental.session.wait({ sessionID: parentID }, { signal: cleanupSignal }),
    client.experimental.session.wait({ sessionID: childID }, { signal: cleanupSignal }),
  ])
  const child = await client.session.get({ sessionID: childID }, { signal: abort.signal })
  assert.equal(child.model?.providerID, target.providerID)
  assert.equal(child.model?.id, target.id)
  const active = await client.session.active({ signal: abort.signal })
  assert(!active[parentID] && !active[childID], "Parent or child remained active after cancellation")
  const summary = { status: "passed", parentID, childID, childModel: child.model, cancellationMs: Date.now() - before }
  writeFileSync(join(directory, "success.json"), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
} finally {
  abort.abort()
  clearTimeout(timer)
  await pump
  for (const sessionID of [parentID, childID]) if (sessionID) {
    await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(10_000) }).catch(() => {})
  }
}
