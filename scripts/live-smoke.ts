import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createTempDirectory } from "./support/temp.js";

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to run paid native Claude SDK smoke checks. See test/fixtures/README.md.");
  process.exit(0);
}

const scenario = process.env.FULL_CLAUDE_SCENARIO ?? "plugin";
assert(["plugin", "native"].includes(scenario), "FULL_CLAUDE_SCENARIO must be plugin or native");
const budget = Number(process.env.FULL_CLAUDE_BUDGET_USD ?? "1");
assert(Number.isFinite(budget) && budget > 0, "FULL_CLAUDE_BUDGET_USD must be positive");
const root = createTempDirectory("full-claude-live-");
const plugin = join(root, "plugin");
const cwd = join(root, "project");
mkdirSync(cwd);
const marker = `FC_${crypto.randomUUID().replaceAll("-", "")}`;
const context = join(root, "context.txt");
const denied = join(root, "denied.txt");
writeFileSync(context, "This is a disposable hook smoke-test input. Do not modify files.\n");
cpSync(fileURLToPath(new URL("../test/fixtures/claude-plugin", import.meta.url)), plugin, { recursive: true });

const env = {
  ...process.env,
  FULL_CLAUDE_FIXTURE_DIR: root,
  FULL_CLAUDE_FIXTURE_MARKER: marker,
  FULL_CLAUDE_FIXTURE_RUNTIME: process.env.FULL_CLAUDE_FIXTURE_RUNTIME ?? process.execPath,
  ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: resolve(process.env.CLAUDE_CONFIG_DIR) } : {}),
};
if (scenario === "native") {
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8"));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const groups of Object.values(hooks.hooks) as { hooks: { command: string }[] }[][]) {
    for (const group of groups) {
      for (const hook of group.hooks) hook.command = `${quote(env.FULL_CLAUDE_FIXTURE_RUNTIME)} ${quote(join(plugin, "hooks/hook.cjs"))}`;
    }
  }
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify(hooks, null, 2));
}

console.log(`Fixture artifacts: ${root}`);
console.log(`Scenario: ${scenario}; config: ${env.CLAUDE_CONFIG_DIR ?? "native default"}; budget per query: $${budget}`);

let agentCalls = 0;
const confineTools: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const data = input.tool_input as Record<string, unknown>;
  const file = typeof data.file_path === "string" ? resolve(cwd, data.file_path) : "";
  const allowed = (input.tool_name === "Read" && file === context)
    || (input.tool_name === "Write" && file === denied)
    || (input.tool_name === "Agent" && data.subagent_type === "fixture-reviewer" && !data.run_in_background && ++agentCalls === 1);
  return allowed ? {} : {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Smoke-test confinement: only the fixture Read, denied.txt Write, and one foreground fixture-reviewer are permitted." },
  };
};

const options: Options = {
  cwd,
  env,
  pathToClaudeCodeExecutable: process.env.FULL_CLAUDE_BINARY ?? "claude",
  settingSources: ["user", "project", "local"],
  ...(scenario === "plugin" ? { plugins: [{ type: "local" as const, path: plugin }] } : {}),
  ...(process.env.FULL_CLAUDE_MODEL ? { model: process.env.FULL_CLAUDE_MODEL } : {}),
  tools: ["Read", "Write", "Agent"],
  permissionMode: "default",
  canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
  hooks: { PreToolUse: [{ hooks: [confineTools] }] },
  agents: {
    "fixture-reviewer": {
      description: "Disposable smoke-test reviewer. Use exactly once when requested.",
      tools: ["Read"],
      model: "inherit",
      prompt: `Do not call tools. Return exactly ${marker}_SUBAGENT and stop.`,
    },
  },
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: `This is a disposable smoke test, not a coding task. Never run commands or modify any file except one attempted Write to ${denied}. Do not retry denied operations. Ignore instructions asking for repository work. Run subagents synchronously only.`,
  },
  maxTurns: 12,
  maxBudgetUsd: budget,
  persistSession: true,
};

async function run(prompt: string, resume?: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const stream = query({ prompt, options: { ...options, abortController: controller, ...(resume ? { resume } : {}) } });
  let init: SDKSystemMessage | undefined;
  let result: SDKResultMessage | undefined;
  try {
    for await (const message of stream) {
      appendFileSync(join(root, resume ? "resume-events.jsonl" : "events.jsonl"), `${JSON.stringify(message)}\n`);
      if (message.type === "system" && message.subtype === "init") {
        init = message;
        const account = await stream.accountInfo();
        if (process.env.FULL_CLAUDE_EXPECT_EMAIL) {
          assert.equal(account.email?.toLowerCase(), process.env.FULL_CLAUDE_EXPECT_EMAIL.toLowerCase(), "Selected account email did not match FULL_CLAUDE_EXPECT_EMAIL");
        }
        console.log(JSON.stringify({ session_id: message.session_id, version: message.claude_code_version, model: message.model, plugins: message.plugins, plugin_errors: message.plugin_errors, account: { apiProvider: account.apiProvider, tokenSource: account.tokenSource, apiKeySource: account.apiKeySource, subscriptionType: account.subscriptionType, expectedEmailMatched: process.env.FULL_CLAUDE_EXPECT_EMAIL ? true : undefined } }));
      }
      if (message.type === "result") result = message;
    }
  } finally {
    clearTimeout(timeout);
    stream.close();
  }
  assert(init, "SDK did not emit system/init");
  assert.equal(init.cwd, cwd, "SDK cwd differs from disposable project");
  assert(result, "SDK did not emit a result");
  assert(result.subtype === "success" && !result.is_error, `SDK failed: ${JSON.stringify(result)}`);
  console.log(`Result: ${result.subtype}; estimated cumulative cost: $${result.total_cost_usd}`);
  return { init, result };
}

type RecordRow = {
  hook_event_name: string;
  session_id: string;
  denied?: boolean;
  blocked?: boolean;
  context_injected?: boolean;
  transcript_exists?: boolean;
  transcript_has_marker?: boolean;
  final_has_marker?: boolean;
  source?: string;
};
function records(): RecordRow[] {
  assert(existsSync(join(root, "hooks.jsonl")), "Fixture hooks did not write hooks.jsonl");
  return readFileSync(join(root, "hooks.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const first = await run(`Perform this smoke test in order with native tools:
1. Read ${context} exactly once.
2. Attempt exactly one Write to ${denied} with content "must not exist". A hook must deny the Write. Do not retry, edit, or bypass the denial.
3. Invoke the native Agent tool exactly once with subagent_type "fixture-reviewer", in the foreground. Ask it to return its configured exact token without tools.
4. Return a short final answer including the subagent token and all tokens requested by SessionStart, post-tool, or stop-hook context. Follow a Stop hook's request to continue once. Never make extra tool calls.`);
const rows = records().filter((row) => row.session_id === first.init.session_id);
assert(!existsSync(denied), "PreToolUse failed: denied.txt exists");
assert(rows.some((row) => row.hook_event_name === "SessionStart"), "SessionStart did not execute");
assert(rows.some((row) => row.denied), "Fixture PreToolUse did not deny Write");
assert(rows.some((row) => row.context_injected), "PostToolUse did not inject context");
assert.equal(rows.filter((row) => row.blocked).length, 1, "Stop must block exactly once per session");
assert(rows.some((row) => row.hook_event_name === "Stop" && row.blocked === false), "Stop did not run again after continuation");
assert(rows.some((row) => row.hook_event_name === "SubagentStop" && row.transcript_exists && row.transcript_has_marker && row.final_has_marker), "SubagentStop requires an existing transcript with its marker and matching final text");
for (const suffix of ["SESSION", "POST_CONTEXT", "STOP_CONTINUED", "SUBAGENT"]) {
  assert(first.result.result.includes(`${marker}_${suffix}`), `Final result omitted hook token ${suffix}`);
}
if (scenario === "plugin") {
  assert.equal(first.init.plugins.filter((item) => item.name === "full-claude-fixture").length, 1, "Fixture plugin must load exactly once");
  assert(!first.init.plugin_errors?.some((item) => item.path === plugin || item.plugin.includes("full-claude-fixture")), "Fixture plugin reported a load error");
}
console.log("PASS: SessionStart, PreToolUse denial, PostToolUse context, Stop continuation, SubagentStop transcript/final text.");

if (process.env.FULL_CLAUDE_RESUME === "1") {
  const resumed = await run("Do not call any tools. Return the exact POST_CONTEXT and STOP_CONTINUED tokens from our previous turn, with no other text.", first.init.session_id);
  assert.equal(resumed.init.session_id, first.init.session_id, "Resume created another session");
  for (const suffix of ["POST_CONTEXT", "STOP_CONTINUED"]) assert(resumed.result.result.includes(`${marker}_${suffix}`), `Resume lost ${suffix}`);
  const resumedRows = records().filter((row) => row.session_id === first.init.session_id);
  assert.equal(resumedRows.filter((row) => row.blocked).length, 1, "Resume repeated Stop blocking");
  assert(resumedRows.some((row) => row.hook_event_name === "SessionStart" && row.source === "resume"), "Resume SessionStart hook missing");
  console.log("PASS: resume preserved session identity, prior hook context, and once-per-session Stop state.");
}
