import assert from "node:assert/strict"
import { homedir } from "node:os"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { parseProfiles } from "../src/config.js"
import { Runtime, type Storage } from "../src/runtime.js"
import type { HistoryEntry } from "../src/prompt.js"
import { createTempDirectory } from "./support/temp.js"

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to test native cancellation and continuation with model calls.")
  process.exit(0)
}
const directory = createTempDirectory("full-claude-cancel-")
const profile = parseProfiles({ configDir: process.env.FULL_CLAUDE_CONFIG_DIR ?? `${homedir()}/.claude` }, directory)[0]!
const saved = new Map<string, unknown>()
const storage: Storage = { get: async (key) => structuredClone(saved.get(key)), set: async (key, value) => { saved.set(key, structuredClone(value)) } }
const runtime = new Runtime(storage)
const abort = new AbortController()
const deadline = setTimeout(() => abort.abort(new Error("Native cancellation smoke timed out")), 90_000)
const text = "This is a cancellation test in a disposable directory. Run exactly `sleep 20` through native Bash in the foreground, then say done. Do not read or write files or run other tools."
const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text }] }]
const history: HistoryEntry[] = [{ id: "first", type: "user", text }]
let cancelledTool = false
try {
  await assert.rejects(runtime.run({
    sessionID: "cancel-smoke", directory, profile, model: "haiku", prompt, history, signal: abort.signal,
    interactions: () => ({ canUseTool: async (name, input) => !cancelledTool && name === "Bash" && input.command === "sleep 20"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Only the cancellation test's sleep command is permitted" } }),
    emit: (part) => {
      if (part.type === "tool-call" && part.toolName === "Bash") {
        cancelledTool = true
        abort.abort(new Error("Expected smoke-test cancellation"))
      }
    },
  }))
  assert(cancelledTool, "Claude did not reach the native Bash call before cancellation")
  history.push({ id: "cancelled", type: "assistant", model: { providerID: profile.id },
    finish: "error", error: { type: "aborted", message: "Expected smoke-test cancellation" }, content: [] })
  await runtime.checkpoint("cancel-smoke", async () => history)
  const record = saved.get("session/cancel-smoke") as { outcome: string; nativeID: string }
  assert.equal(record.outcome, "ready", "Cancellation did not drain to a checkpointable result")
  const nativeID = record.nativeID
  const followup = "The cancellation test is over. Do not use tools. Reply with a response containing CANCEL_RESUME_OK."
  let answer = ""
  await runtime.run({
    sessionID: "cancel-smoke", directory, profile, model: "haiku",
    prompt: [...prompt, { role: "user", content: [{ type: "text", text: followup }] }],
    history: [...history, { id: "second", type: "user", text: followup }],
    signal: AbortSignal.timeout(60_000),
    interactions: () => ({ canUseTool: async () => ({ behavior: "deny", message: "No tools are needed for this response" }) }),
    emit: (part) => { if (part.type === "text-delta") answer += part.delta },
  })
  assert.match(answer, /\bCANCEL_RESUME_OK\b/)
  assert.equal((saved.get("session/cancel-smoke") as { nativeID: string }).nativeID, nativeID)
  console.log(`PASS: native cancellation drained, and the same Claude session accepted the next turn. Disposable directory: ${directory}`)
} finally { clearTimeout(deadline); await runtime.dispose() }
