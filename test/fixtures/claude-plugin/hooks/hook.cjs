const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function handle(input, env = process.env) {
  const root = env.FULL_CLAUDE_FIXTURE_DIR;
  if (!root || !path.isAbsolute(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("FULL_CLAUDE_FIXTURE_DIR must name an existing absolute disposable directory");
  }
  const type = input.hook_event_name;
  const transcript = type === "SubagentStop" ? input.agent_transcript_path : input.transcript_path;
  const transcriptExists = typeof transcript === "string" && fs.existsSync(transcript);
  const marker = env.FULL_CLAUDE_FIXTURE_MARKER || "FIXTURE";
  const transcriptText = transcriptExists ? fs.readFileSync(transcript, "utf8") : "";
  const record = {
    hook_event_name: type,
    session_id: input.session_id,
    source: input.source,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    stop_hook_active: input.stop_hook_active,
    agent_id: input.agent_id,
    transcript_path: transcript,
    transcript_exists: transcriptExists,
    transcript_has_marker: transcriptText.includes(`${marker}_SUBAGENT`),
    last_assistant_message: input.last_assistant_message,
    final_has_marker: (input.last_assistant_message || "").includes(`${marker}_SUBAGENT`),
  };
  let output = {};
  if (type === "SessionStart") {
    output = { hookSpecificOutput: { hookEventName: type, additionalContext: `Include this exact token in your final answer: ${marker}_SESSION` } };
  }
  if (type === "PreToolUse" && path.basename(input.tool_input?.file_path || "") === "denied.txt") {
    record.denied = true;
    output = { hookSpecificOutput: { hookEventName: type, permissionDecision: "deny", permissionDecisionReason: `${marker}_DENIED: denied.txt is a fixture sentinel. Do not retry or use another tool.` } };
  }
  if (type === "PostToolUse" && path.resolve(input.tool_input?.file_path || "") === path.join(root, "context.txt")) {
    record.context_injected = true;
    output = { hookSpecificOutput: { hookEventName: type, additionalContext: `Include this exact token in your final answer: ${marker}_POST_CONTEXT` } };
  }
  if (type === "Stop") {
    const session = crypto.createHash("sha256").update(String(input.session_id)).digest("hex");
    const state = path.join(root, `stop-${session}`);
    try {
      fs.writeFileSync(state, "blocked", { flag: "wx" });
      record.blocked = true;
      output = { decision: "block", reason: `Continue once. Include ${marker}_STOP_CONTINUED in your final answer, preserve all earlier required tokens, and then stop. Do not call tools.` };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      record.blocked = false;
    }
  }
  fs.appendFileSync(path.join(root, "hooks.jsonl"), `${JSON.stringify(record)}\n`);
  return output;
}

module.exports = { handle };
if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(handle(JSON.parse(fs.readFileSync(0, "utf8")))));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
