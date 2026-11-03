import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Model } from "@opencode/schema/model"
import { DELEGATION_SERVER } from "../src/delegation-mcp.js"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 and FULL_CLAUDE_DELEGATE_MODEL=provider/model to test foreground delegation.")
  process.exit(0)
}
assert(process.env.FULL_CLAUDE_DELEGATE_MODEL, "Set FULL_CLAUDE_DELEGATE_MODEL to the exact requested child model")
const target = Model.Ref.parse(process.env.FULL_CLAUDE_DELEGATE_MODEL)
const query = process.env.FULL_CLAUDE_DELEGATE_QUERY ?? `${target.providerID}/${target.id}`
const parentModel = Model.Ref.parse(process.env.FULL_CLAUDE_PARENT_MODEL ?? "full-claude-agent/haiku")
const directory = createTempDirectory("full-claude-delegation-")
const marker = `DELEGATION_${randomUUID().replaceAll("-", "")}`
const endpoint = await Service.discover()
assert(endpoint, "No running OpenCode server")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const signal = AbortSignal.timeout(120_000)
let sessionID: string | undefined
console.log(`Delegation smoke artifacts: ${directory}`)
try {
  const session = await client.session.create({ location: { directory }, title: "Full Claude foreground delegation smoke", model: parentModel,
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: `claude.mcp__${DELEGATION_SERVER}__list_models`, resource: "*", effect: "allow" },
      { action: `claude.mcp__${DELEGATION_SERVER}__delegate`, resource: "*", effect: "allow" },
      { action: "subagent", resource: "general", effect: "allow" },
    ],
  }, { signal })
  sessionID = session.id
  await client.session.prompt({ sessionID, text: `Use mcp__${DELEGATION_SERVER}__list_models to find ${query}, then use mcp__${DELEGATION_SERVER}__delegate exactly once to run a foreground general subagent on the newest matching model unless I specified a version. ${target.variant ? `Use its ${target.variant} variant.` : "Use the base model without an effort variant."} Its entire task is: "Reply exactly ${marker}. Do not use tools." Do not use native Agent, Bash, or any other tools. When the child returns, report the actual model, child session ID, and reply.` }, { signal })
  await client.experimental.session.wait({ sessionID }, { signal })
  const parentHistory = await client.session.context({ sessionID }, { signal })
  const parent = parentHistory.findLast((message) => message.type === "assistant")
  writeFileSync(join(directory, "parent.json"), JSON.stringify(parentHistory, null, 2), { mode: 0o600 })
  assert(parent?.type === "assistant" && !parent.error && parent.finish === "stop", "Parent failed to complete")
  const tools = parent.content.filter((part) => part.type === "tool")
  assert(tools.some((tool) => tool.name === `mcp__${DELEGATION_SERVER}__list_models`), "Model discovery was not used")
  assert.equal(tools.filter((tool) => tool.name === `mcp__${DELEGATION_SERVER}__delegate`).length, 1, "Expected exactly one delegate invocation")
  assert(tools.every((tool) => tool.executed && tool.state.status === "completed"), "A native MCP tool was not provider-executed and completed")
  assert(parent.content.some((part) => part.type === "text" && part.text.includes(marker)), "Child reply did not reach the parent")
  const children = await client.session.list({ parentID: sessionID }, { signal })
  assert.equal(children.data.length, 1, "Expected exactly one OpenCode child session")
  const child = children.data[0]!
  assert.equal(child.model?.providerID, target.providerID)
  assert.equal(child.model?.id, target.id)
  if (target.variant) assert.equal(child.model?.variant, target.variant)
  const childHistory = await client.session.context({ sessionID: child.id }, { signal })
  writeFileSync(join(directory, "child.json"), JSON.stringify(childHistory, null, 2), { mode: 0o600 })
  const answer = childHistory.findLast((message) => message.type === "assistant")
  assert(answer?.type === "assistant" && !answer.error && answer.finish === "stop", "Child failed to complete")
  assert(answer.content.some((part) => part.type === "text" && part.text.includes(marker)), "Child did not produce the expected marker")
  assert(!answer.content.some((part) => part.type === "tool"), "Child used a tool")
  const summary = { status: "passed", sessionID, childSessionID: child.id, parentModel, childModel: child.model,
    checks: ["model discovery", "foreground child on exact requested model", "provider-executed MCP tools", "child result returned to native Claude"] }
  writeFileSync(join(directory, "success.json"), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
} finally {
  if (sessionID) await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(10_000) }).catch(() => {})
}
