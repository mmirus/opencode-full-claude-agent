import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDirectory } from "./support/temp.js";

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to run two paid Haiku turns through installed OpenCode 2.2.5.");
  process.exit(0);
}

const root = createTempDirectory("full-claude-host-");
const cwd = join(root, "project");
const globalConfig = join(root, "opencode-config");
mkdirSync(cwd);
mkdirSync(globalConfig);
const plugin = fileURLToPath(new URL("../", import.meta.url));
const configured = process.env.FULL_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const configDir = resolve(configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured);
const database = join(root, "opencode.sqlite");
const marker = `FC_HOST_${randomUUID().replaceAll("-", "")}`;

writeFileSync(join(cwd, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugins: [{ package: plugin, options: { configDir, binaryPath: "claude", models: ["haiku"] } }],
}, null, 2));

const env: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCODE_CONFIG_DIR: globalConfig,
  OPENCODE_DB: database,
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_CONFIG_PROJECT_DISABLE: "0",
  OPENCODE_DISABLE_PROJECT_CONFIG: "0",
  OPENCODE_SIMULATE: "0",
};
delete env.OPENCODE_CONFIG;

console.log(`Host smoke artifacts (may contain private diagnostics): ${root}`);

function diagnose(output: string): string {
  if (/checkpoint|previous Claude turn|history.*(changed|match)|uncertain outcome/i.test(output)) {
    return "Claude session checkpoint or history validation failed; inspect the retained logs.";
  }
  if (/unauthorized|authentication|not logged in|invalid.*(?:key|token)|login required|401/i.test(output)) {
    return "Authentication failed; check the selected FULL_CLAUDE_CONFIG_DIR and inherited credential variables.";
  }
  if (/plugin.*(?:failed|error)|cannot find (?:module|package)|module_not_found|export.*not found/i.test(output)) {
    return "Plugin loading failed; inspect package exports and the retained logs.";
  }
  if (/rate.?limit|429|credit|billing|quota/i.test(output)) {
    return "The provider reported a rate limit, billing, or quota failure; inspect the retained logs.";
  }
  if (/enoent|not found|executable/i.test(output)) {
    return "An executable or file was unavailable; check installed opencode, claude, and the retained logs.";
  }
  return "Inspect the retained stdout, stderr, and result files for host/provider diagnostics.";
}

async function command(label: string, args: string[]): Promise<string> {
  const stdoutPath = join(root, `${label}.stdout.jsonl`);
  const stderrPath = join(root, `${label}.stderr.log`);
  const stdout = openSync(stdoutPath, "w", 0o600);
  const stderr = openSync(stderrPath, "w", 0o600);
  const started = Date.now();
  let child;
  try {
    child = spawn("opencode", args, { cwd, env, detached: true, stdio: ["ignore", stdout, stderr] });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
  }, 120_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>((done) => {
    let spawnError: string | undefined;
    child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error.code ?? "spawn failed"; });
    child.once("close", (code, signal) => done({ code, signal, spawnError }));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  // A timed-out standalone host can exit before its native Claude child exits.
  if (timedOut) kill("SIGKILL");
  writeFileSync(join(root, `${label}.result.json`), JSON.stringify({
    args, ...result, timedOut, elapsedMs: Date.now() - started, stdoutPath, stderrPath,
  }, null, 2));
  const output = readFileSync(stdoutPath, "utf8");
  const errors = readFileSync(stderrPath, "utf8");
  if (timedOut) throw new Error(`${label}: exceeded 120 seconds; terminated the host process group. ${diagnose(output + errors)}`);
  if (result.spawnError || result.code !== 0 || result.signal) {
    throw new Error(`${label}: ${result.spawnError ?? `exit=${result.code}, signal=${result.signal ?? "none"}`}. ${diagnose(output + errors)}`);
  }
  if (/Full Claude Agent checkpoint failed/.test(errors)) {
    throw new Error(`${label}: the plugin reported a checkpoint failure; inspect ${stderrPath}.`);
  }
  return output;
}

interface Event {
  type: string;
  sessionID: string;
  part?: { text?: string; reason?: string };
}

function validate(label: string, output: string, sessionID?: string): string {
  const events: Event[] = output.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    let value;
    try { value = JSON.parse(line); }
    catch { throw new Error(`${label}: stdout line ${index + 1} is not JSON; inspect the retained stdout.`); }
    assert(value && typeof value === "object" && typeof value.type === "string", `${label}: invalid CLI event`);
    return value;
  });
  assert(!events.some((event) => event.type === "error"), `${label}: CLI emitted an error event. ${diagnose(output)}`);
  assert(events.length > 0, `${label}: CLI emitted no events`);
  const id = events[0]!.sessionID;
  assert(typeof id === "string" && id.startsWith("ses"), `${label}: CLI did not report a session ID`);
  assert(events.every((event) => event.sessionID === id), `${label}: CLI emitted inconsistent session IDs`);
  if (sessionID) assert.equal(id, sessionID, `${label}: restart created a different host session`);
  assert(!events.some((event) => event.type === "tool_use"), `${label}: model called a tool despite the no-tools prompt`);
  assert(events.some((event) => event.type === "step_finish" && event.part?.reason === "stop"), `${label}: CLI did not emit a completed stop step`);
  const text = events.filter((event) => event.type === "text").map((event) => event.part?.text ?? "").join("").trim();
  assert.equal(text, marker, `${label}: response did not equal the remembered marker`);
  return id;
}

try {
  const version = (await command("version", ["--version"])).trim();
   assert.match(version, /^(?:opencode v)?2\.2\.5$/, "This smoke test targets installed OpenCode 2.2.5");
  const flags = ["--standalone", "run", "--model", "full-claude-agent/haiku", "--format", "json"];
  const first = await command("initial", [...flags, `Do not use tools. Remember marker ${marker}. Reply exactly ${marker}, with no other text.`]);
  const sessionID = validate("initial", first);
  const second = await command("resume", [...flags, "--session", sessionID, "Do not use tools. Return the exact marker from our prior turn, with no other text."]);
  validate("resume", second, sessionID);
  const artifact = join(root, "success.json");
  writeFileSync(artifact, JSON.stringify({ status: "passed", version, model: "full-claude-agent/haiku", sessionID, database, cwd, plugin, configDir, checks: ["package exports loaded by installed host", "initial exact response without tools", "standalone restart resumes same session and recalls marker"] }, null, 2));
  console.log(`PASS: installed OpenCode loaded the plugin and resumed the checkpointed session after a standalone restart. Success artifact: ${artifact}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown host smoke failure";
  writeFileSync(join(root, "failure.json"), JSON.stringify({ status: "failed", message }, null, 2));
  console.error(`FAIL: ${message}\nArtifacts: ${root}`);
  process.exitCode = 1;
}
