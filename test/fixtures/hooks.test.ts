import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { handle } = createRequire(import.meta.url)("./claude-plugin/hooks/hook.cjs");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true })));

test("native hook outputs deny writes, inject context, and block Stop once per session", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-fixture-test-"));
  roots.push(root);
  const env = { FULL_CLAUDE_FIXTURE_DIR: root, FULL_CLAUDE_FIXTURE_MARKER: "TOKEN" };
  const base = { session_id: "session-a" };
  expect(handle({ ...base, hook_event_name: "SessionStart" }, env).hookSpecificOutput.additionalContext).toContain("TOKEN_SESSION");
  expect(handle({ ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "denied.txt") } }, env).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(handle({ ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "allowed.txt") } }, env)).toEqual({});
  expect(handle({ ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(root, "context.txt") } }, env).hookSpecificOutput.additionalContext).toContain("TOKEN_POST_CONTEXT");
  expect(handle({ ...base, hook_event_name: "Stop", stop_hook_active: false }, env).decision).toBe("block");
  expect(handle({ ...base, hook_event_name: "Stop", stop_hook_active: true }, env)).toEqual({});
  expect(handle({ session_id: "session-b", hook_event_name: "Stop" }, env).decision).toBe("block");
});

test("SubagentStop records transcript availability and both final-text channels", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-fixture-test-"));
  roots.push(root);
  const transcript = join(root, "agent.jsonl");
  writeFileSync(transcript, JSON.stringify({ message: { content: [{ type: "text", text: "TOKEN_SUBAGENT" }] } }));
  const env = { FULL_CLAUDE_FIXTURE_DIR: root, FULL_CLAUDE_FIXTURE_MARKER: "TOKEN" };
  handle({ hook_event_name: "SubagentStop", session_id: "a", agent_transcript_path: transcript, last_assistant_message: "TOKEN_SUBAGENT" }, env);
  handle({ hook_event_name: "SubagentStop", session_id: "a", agent_transcript_path: join(root, "missing") }, env);
  const records = readFileSync(join(root, "hooks.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records[0]).toMatchObject({ transcript_exists: true, transcript_has_marker: true, final_has_marker: true });
  expect(records[1]).toMatchObject({ transcript_exists: false, transcript_has_marker: false, final_has_marker: false });
});

test("fixture refuses a missing state-directory environment variable", () => {
  expect(() => handle({ hook_event_name: "Stop" }, {})).toThrow("FULL_CLAUDE_FIXTURE_DIR");
});

test("command entry point consumes stdin JSON and emits hook JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-fixture-test-"));
  roots.push(root);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./claude-plugin/hooks/hook.cjs", import.meta.url))], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "subprocess", tool_name: "Write", tool_input: { file_path: join(root, "denied.txt") } }),
    env: { ...process.env, FULL_CLAUDE_FIXTURE_DIR: root },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(JSON.parse(readFileSync(join(root, "hooks.jsonl"), "utf8")).session_id).toBe("subprocess");
});
