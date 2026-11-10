import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDirectory } from "./support/temp.js";

if (process.env.FULL_CLAUDE_LIVE !== "1") {
  console.log("Skipped: set FULL_CLAUDE_LIVE=1 to run paid shared-server Haiku smoke checks.");
  process.exit(0);
}

const secondConfigDir = process.env.SECOND_CLAUDE_CONFIG_DIR;
if (!secondConfigDir?.trim()) {
  throw new Error("Set SECOND_CLAUDE_CONFIG_DIR explicitly to the second Claude configuration directory before running the paid shared-server smoke test. FIRST_CLAUDE_CONFIG_DIR defaults to ~/.claude; no second configuration directory is assumed.");
}

const root = createTempDirectory("full-claude-shared-");
const cwd = join(root, "project");
const globalConfig = join(root, "opencode-config");
mkdirSync(cwd, { mode: 0o700 });
mkdirSync(globalConfig, { mode: 0o700 });
const plugin = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(plugin, "test/fixtures/claude-plugin");
const expand = (value: string) => resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
const firstConfig = expand(process.env.FIRST_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
const secondConfig = expand(secondConfigDir);
const database = join(root, "opencode.sqlite");
const marker = `FC_SHARED_${randomUUID().replaceAll("-", "")}`;
const secondMarker = `FC_SECOND_${randomUUID().replaceAll("-", "")}`;
const context = join(root, "context.txt");
const denied = join(root, "denied.txt");
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
writeFileSync(context, "Disposable native hook smoke-test input. Do not modify files.\n", { mode: 0o600 });
writeFileSync(join(root, "hooks.jsonl"), "", { mode: 0o600 });
save("project/opencode.json", {
  $schema: "https://opencode.ai/config.json",
  plugins: [{ package: plugin, options: { profiles: {
    first: {
      configDir: firstConfig, binaryPath: "claude", models: ["haiku"], plugins: [fixture],
      env: {
        FULL_CLAUDE_FIXTURE_DIR: root,
        FULL_CLAUDE_FIXTURE_MARKER: marker,
        FULL_CLAUDE_FIXTURE_RUNTIME: process.execPath,
      },
    },
    second: { configDir: secondConfig, binaryPath: "claude", models: ["haiku"] },
  } } }],
});

const password = randomBytes(32).toString("base64url");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCODE_CONFIG_DIR: globalConfig,
  OPENCODE_DB: database,
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_CONFIG_PROJECT_DISABLE: "0",
  OPENCODE_DISABLE_PROJECT_CONFIG: "0",
  OPENCODE_SIMULATE: "0",
  OPENCODE_PASSWORD: password,
};
delete env.OPENCODE_CONFIG;
delete env.OPENCODE_SERVER_PASSWORD;
const controller = new AbortController();
const children: Managed[] = [];
const deadline = setTimeout(() => controller.abort(new Error("Shared-server smoke exceeded its 180-second overall timeout")), 180_000);
const interrupt = () => controller.abort(new Error("Shared-server smoke interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
}
interface Managed {
  child: ChildProcess;
  done: Promise<Exit>;
  result?: Exit;
  label: string;
  stdout: string;
  stderr: string;
}

function killGroup(proc: Managed, signal: NodeJS.Signals) {
  if (!proc.child.pid) return;
  try { process.kill(-proc.child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function launch(label: string, args: string[]): Managed {
  controller.signal.throwIfAborted();
  const stdout = join(root, `${label}.stdout.log`);
  const stderr = join(root, `${label}.stderr.log`);
  const out = openSync(stdout, "w", 0o600);
  const err = openSync(stderr, "w", 0o600);
  const started = Date.now();
  let child: ChildProcess;
  try { child = spawn("opencode", args, { cwd, env, detached: true, stdio: ["ignore", out, err] }); }
  finally { closeSync(out); closeSync(err); }
  const proc: Managed = { child, label, stdout, stderr, done: Promise.resolve({ code: null, signal: null }) };
  proc.done = new Promise<Exit>((done) => {
    let spawnError: string | undefined;
    child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error.code ?? "spawn failed"; });
    child.once("close", (code, signal) => {
      proc.result = { code, signal, spawnError };
      save(`${label}.result.json`, { pid: child.pid, args, ...proc.result, elapsedMs: Date.now() - started, stdout, stderr });
      done(proc.result);
    });
  });
  children.push(proc);
  return proc;
}

function diagnose(output: string): string {
  if (/checkpoint|previous Claude turn|uncertain outcome/i.test(output)) return "Checkpoint validation failed.";
  if (/unauthorized|authentication|not logged in|invalid.*(?:key|token)|401/i.test(output)) return "Check the selected Claude config directory and inherited credentials.";
  if (/rate.?limit|429|credit|billing|quota/i.test(output)) return "Check provider rate limits, billing, and quota.";
  if (/unknown tool|tool.*not found|no tool.*named|cannot find.*(?:module|package)|plugin.*(?:failed|error)/i.test(output)) return "Check plugin loading and native tool routing.";
  return "Inspect the private stdout, stderr, and result files.";
}

async function command(label: string, args: string[]) {
  const proc = launch(label, args);
  const exit = await proc.done;
  controller.signal.throwIfAborted();
  const output = readFileSync(proc.stdout, "utf8");
  const errors = readFileSync(proc.stderr, "utf8");
  assert(!exit.spawnError && exit.code === 0 && !exit.signal,
    `${label}: ${exit.spawnError ?? `exit=${exit.code}, signal=${exit.signal ?? "none"}`}. ${diagnose(output + errors)}`);
  return output;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function ephemeralPort(): Promise<number> {
  return new Promise((done, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      assert(address && typeof address !== "string");
      socket.close((error) => error ? reject(error) : done(address.port));
    });
  });
}

async function ready(server: Managed, url: string) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    controller.signal.throwIfAborted();
    assert(!server.result, `Server exited before readiness. ${diagnose(readFileSync(server.stderr, "utf8"))}`);
    try {
      const response = await fetch(`${url}/api/info`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1_000)]),
      });
      if (response.ok) {
        const info: unknown = await response.json();
        save("server-info.json", info);
        assert(!server.result, "Server exited during readiness");
        return;
      }
      assert(response.status !== 401 && response.status !== 403, "Owned server rejected its generated password");
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    await delay(150, controller.signal);
  }
  throw new Error("Owned server did not become ready within 30 seconds; inspect server logs (including possible port conflicts)");
}

interface Event {
  type: string;
  sessionID: string;
  part?: { text?: string; tool?: string; reason?: string; state?: { status?: string; error?: string; output?: string; input?: Record<string, unknown> } };
}
function events(label: string, output: string, expectedSession?: string) {
  const rows: Event[] = output.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`${label}: non-JSON stdout line ${index + 1}; inspect retained stdout`); }
  });
  assert(rows.length && rows.every((row) => row && typeof row.type === "string"), `${label}: missing or invalid CLI events`);
  assert(!rows.some((row) => row.type === "error"), `${label}: CLI emitted an error. ${diagnose(output)}`);
  const sessionID = rows[0]!.sessionID;
  assert(typeof sessionID === "string" && sessionID.startsWith("ses"), `${label}: missing host session ID`);
  assert(rows.every((row) => row.sessionID === sessionID), `${label}: inconsistent host session IDs`);
  if (expectedSession) assert.equal(sessionID, expectedSession, `${label}: host session changed`);
  assert(rows.some((row) => row.type === "step_finish" && row.part?.reason === "stop"), `${label}: no completed stop step`);
  const tools = rows.filter((row) => row.type === "tool_use");
  const text = rows.filter((row) => row.type === "text").map((row) => row.part?.text ?? "").join("").trim();
  return { sessionID, tools, text };
}

interface HookRow {
  hook_event_name: string;
  session_id: string;
  source?: string;
  denied?: boolean;
  blocked?: boolean;
  context_injected?: boolean;
  transcript_exists?: boolean;
  transcript_has_marker?: boolean;
  final_has_marker?: boolean;
}
function hooks(): HookRow[] {
  assert(existsSync(join(root, "hooks.jsonl")), "Native fixture did not write hooks.jsonl");
  return readFileSync(join(root, "hooks.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

async function cleanup() {
  for (const proc of children) killGroup(proc, "SIGTERM");
  const exited = Promise.all(children.map((proc) => proc.done));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<void>((done) => { timer = setTimeout(done, 2_000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    // Native Claude processes share the owned server's process group.
    for (const proc of children) killGroup(proc, "SIGKILL");
  }
  await exited;
}

const abortChildren = () => {
  for (const proc of children) killGroup(proc, "SIGKILL");
};
controller.signal.addEventListener("abort", abortChildren, { once: true });
console.log(`Shared-server artifacts (private diagnostics): ${root}`);
console.log(`Profile config directories: first=${firstConfig}; second=${secondConfig}. Account identities are not verified.`);

try {
  const version = (await command("version", ["--version"])).trim();
  assert.match(version, /^(?:opencode v)?2\.2\.7$/, "This smoke test targets installed OpenCode 2.2.7");
  const port = await ephemeralPort();
  const url = `http://127.0.0.1:${port}`;
  const server = launch("server", ["serve", "--hostname", "127.0.0.1", "--port", String(port)]);
  await ready(server, url);
  const flags = (profile: string) => ["--server", url, "run", "-m", `full-claude-agent-${profile}/haiku`, "--format", "json", "--auto"];
  const firstPrompt = `This is a disposable native hook smoke test, not repository work. Perform only these steps in order:
1. Read ${context} exactly once with Read.
2. Attempt exactly one Write to ${denied} with content "must not exist". The hook must deny this Write. Never retry or bypass the denial with another tool.
3. Invoke Agent exactly once with subagent_type "general-purpose", synchronously in the foreground (run_in_background=false). Tell the subagent: "Do not use tools. Return exactly ${marker}_SUBAGENT and stop. Preserve that token if a Stop hook asks you to continue."
4. Return a short final answer containing the subagent token and every token requested by SessionStart, PostToolUse, and Stop hook context. If a Stop hook asks you to continue, continue once without tools, preserve all required tokens, and stop. Never run commands, inspect repositories, or modify other files.`;
  const results = await Promise.allSettled([
    command("first", [...flags("first"), firstPrompt]),
    command("second", [...flags("second"), `Do not use tools. Reply exactly ${secondMarker}, with no other text.`]),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  const first = events("first", (results[0] as PromiseFulfilledResult<string>).value);
  const second = events("second", (results[1] as PromiseFulfilledResult<string>).value);
  assert.notEqual(first.sessionID, second.sessionID, "Concurrent profiles reused a host session");
  assert.equal(second.tools.length, 0, "Second profile called tools");
  assert.equal(second.text, secondMarker, "Second profile did not return its exact marker");
  assert(!second.text.includes(marker), "First profile marker leaked into the second response");
  assert(!first.text.includes(secondMarker), "Second profile marker leaked into the first response");
  for (const name of ["Read", "Write", "Agent"]) {
    assert.equal(first.tools.filter((event) => event.part?.tool === name).length, 1, `First profile must emit exactly one native ${name} tool event`);
  }
  assert(first.tools.every((event) => ["Read", "Write", "Agent"].includes(event.part?.tool ?? "")), "First profile called an unexpected tool");
  for (const event of first.tools) {
    assert(!/unknown tool|tool.*not found|no tool.*named/i.test(`${event.part?.state?.error ?? ""}\n${event.part?.state?.output ?? ""}`), "Host tried to execute a native tool as an unknown local tool");
    if (event.part?.tool !== "Write") assert.equal(event.part?.state?.status, "completed", "Native Read or Agent failed");
    const input = event.part?.state?.input;
    if (event.part?.tool === "Read") assert.equal(input?.file_path, context, "Native Read used another path");
    if (event.part?.tool === "Write") assert.equal(input?.file_path, denied, "Native Write used another path");
    if (event.part?.tool === "Agent") {
      assert.equal(input?.subagent_type, "general-purpose", "Native Agent used another subagent type");
      assert(!input?.run_in_background, "Native Agent ran in the background");
    }
  }
  assert(!existsSync(denied), "Denied Write created denied.txt");
  for (const suffix of ["SESSION", "POST_CONTEXT", "STOP_CONTINUED", "SUBAGENT"]) {
    assert(first.text.includes(`${marker}_${suffix}`), `First final response omitted ${suffix}`);
  }
  const initialHooks = hooks();
  const nativeID = initialHooks.find((row) => row.hook_event_name === "SessionStart")?.session_id;
  assert(nativeID, "Native SessionStart hook missing");
  const nativeRows = initialHooks.filter((row) => row.session_id === nativeID);
  assert(nativeRows.some((row) => row.denied), "Native PreToolUse did not deny Write");
  assert(nativeRows.some((row) => row.context_injected), "Native PostToolUse did not inject context");
  assert.equal(nativeRows.filter((row) => row.hook_event_name === "Stop" && row.blocked).length, 1, "Native Stop must block exactly once");
  assert(nativeRows.some((row) => row.hook_event_name === "Stop" && row.blocked === false), "Native Stop did not run after continuation");
  assert(nativeRows.some((row) => row.hook_event_name === "SubagentStop" && row.transcript_exists && row.transcript_has_marker && row.final_has_marker), "SubagentStop did not verify its transcript and final marker");
  const resumed = events("resume", await command("resume", [
    ...flags("first"), "--session", first.sessionID,
    "Do not use tools. Return only the exact POST_CONTEXT token from our prior turn, with no other text.",
  ]), first.sessionID);
  assert.equal(resumed.tools.length, 0, "Resume called tools");
  assert.equal(resumed.text, `${marker}_POST_CONTEXT`, "Resume did not remember the native hook context");
  const resumedHooks = hooks();
  assert.equal(resumedHooks.filter((row) => row.session_id === nativeID && row.hook_event_name === "Stop" && row.blocked).length, 1, "Resume reblocked the native Stop hook");
  assert(resumedHooks.slice(initialHooks.length).some((row) => row.session_id === nativeID && row.hook_event_name === "Stop" && row.blocked === false), "Resume did not run Stop on the original native session");
  assert(!existsSync(denied), "Resume created denied.txt");
  assert(!server.result, "Owned server exited during client runs");
  assert(!/Full Claude Agent checkpoint failed/.test(readFileSync(server.stderr, "utf8")), "Server reported a checkpoint failure");
  save("success.json", {
    status: "passed", version, url, serverPID: server.child.pid, database, cwd, plugin,
    profiles: { first: { configDir: firstConfig, sessionID: first.sessionID }, second: { configDir: secondConfig, sessionID: second.sessionID } },
    accountIdentitiesVerified: false,
    checks: ["concurrent profiles on owned server", "native Read, denied Write, and synchronous Agent", "native hook context and SubagentStop transcript", "Stop continuation once", "same-session resume recalls hook context without tools"],
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown shared-server smoke failure";
  save("failure.json", { status: "failed", message });
  console.error(`FAIL: ${message}\nArtifacts: ${root}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  clearTimeout(deadline);
  controller.signal.removeEventListener("abort", abortChildren);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

if (!process.exitCode) console.log(`PASS: concurrent shared-server profiles, native hooks/tools, and same-session resume. Success artifact: ${join(root, "success.json")}`);
