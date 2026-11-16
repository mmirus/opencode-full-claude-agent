import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes, createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { createTempDirectory } from "./support/temp.js"

const flags = new Set(process.argv.slice(2))
const supported = new Set(["--changed-plugin", "--installers", "--control", "--baseline-order", "--provider-first", "--help"])
for (const flag of flags) assert(supported.has(flag), `Unknown option: ${flag}; use --help`)
if (flags.has("--help")) {
  console.log(`Usage: bun run scripts/reload-continuity-smoke.ts [options]
Default: provider-first ordering, same-byte rewrite, real permission and MCP bridges, zero Claude calls.
  --changed-plugin  Change observer source rather than rewriting identical bytes.
  --installers      Rerun audited Herdr and Worktrunk installers in private HOME/XDG directories.
  --control         Complete the turn without rewriting plugins.
  --baseline-order  Load Full Claude after the observer, so the reload reinitializes it and it must adopt its live runtime.
  --provider-first  Explicit alias for the default ordering.`)
  process.exit(0)
}
const installers = flags.has("--installers")
const control = flags.has("--control")
const changedPlugin = flags.has("--changed-plugin")
const providerFirst = !flags.has("--baseline-order")
assert(!(flags.has("--provider-first") && !providerFirst), "Choose only one ordering")
assert(!(installers && (control || changedPlugin)), "--installers cannot combine with --control or --changed-plugin")
assert(!(control && changedPlugin), "--control cannot combine with --changed-plugin")

// The owned server loads the real provider; only native SDK transport and discovery are replaced.
const root = createTempDirectory("reload-continuity-")
const cwd = join(root, "project")
const privateHome = join(root, "home")
const privateXDG = join(privateHome, ".config")
const config = join(privateXDG, "opencode")
const wrapper = join(root, "provider")
const source = fileURLToPath(new URL("../src/", import.meta.url))
for (const dir of [cwd, config, wrapper, join(config, "plugins"), join(root, "claude")]) mkdirSync(dir, { recursive: true, mode: 0o700 })
const timeline = join(root, "timeline.jsonl")
const marker = join(root, "executions.txt")
const gate = join(root, "release")
const watched = join(config, "plugins", installers ? "z-continuity-observer.ts" : "continuity-observer.ts")
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const records = () => existsSync(timeline) ? readFileSync(timeline, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []
const log = (event: string, data: object = {}) => {
  const record = { at: Date.now(), event, ...data }
  console.log(JSON.stringify(record))
  writeFileSync(timeline, JSON.stringify(record) + "\n", { flag: "a", mode: 0o600 })
}
save("provider/package.json", { name: "reload-continuity-private-provider", type: "module", exports: { ".": "./index.ts" } })
writeFileSync(join(wrapper, "index.ts"), `
import { appendFileSync, existsSync } from "node:fs";
import { Runtime } from ${JSON.stringify(join(source, "runtime.ts"))};
import { makePlugin } from ${JSON.stringify(join(source, "index.ts"))};
import { parseProfiles } from ${JSON.stringify(join(source, "config.ts"))};
import { requestContext } from ${JSON.stringify(join(source, "request-context.ts"))};
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { InMemoryTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/inMemory.js"))};
const log = (event, data = {}) => appendFileSync(${JSON.stringify(timeline)}, JSON.stringify({at:Date.now(),event,...data}) + "\\n", {mode:0o600});
log("provider-module-loaded");
class FakeQuery {
  queue = []; waiting; closed = false; input; released = false;
  constructor(args, child) {
    this.args = args;
    this.child = child;
    log("sdk-created", {nativeID:args.options.sessionId ?? args.options.resume});
    this.timer = setInterval(() => {if(existsSync(${JSON.stringify(gate)})) void this.finish().catch(error=>{log("fake-finish-error",{message:String(error)});this.close();});}, 20);
    void (async () => {for await (const input of args.prompt) {
      this.input = input;
      log(child ? "child-sdk-submission" : "sdk-submission", {uuid:input.uuid});
      if(child) {void this.finish();continue;}
      const common = {session_id:args.options.sessionId ?? args.options.resume,parent_tool_use_id:null,user_message_uuid:input.uuid};
      const command = "printf 'executed\\n' >> executions.txt";
      this.push({...common,type:"assistant",message:{id:"native-call-"+input.uuid,role:"assistant",content:[{type:"tool_use",id:"bash-"+input.uuid,name:"Bash",input:{command}}]}});
      appendFileSync(${JSON.stringify(marker)}, "executed\\n", {mode:0o600});
      this.push({...common,type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"bash-"+input.uuid,content:"executed"}]}});
      log("native-result-held", {uuid:input.uuid});
    }})().catch(error => log("input-error",{message:String(error)})).finally(()=>this.close());
  }
  initializationResult() {return Promise.resolve({models:[]});}
  push(frame) {this.queue.push(frame);this.waiting?.();this.waiting=undefined;}
  async finish(interrupted = false) {
    if(!this.input || this.released || this.closed) return;
    this.released = true;
    if (!this.child && !interrupted) {
      const server = this.args.options.mcpServers?.full_claude_opencode;
      if(!server || server.type !== "sdk") throw new Error("Native delegation MCP server missing");
      const client = new Client({name:"reload-continuity",version:"1"});
      const [transport,serverTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      await client.connect(transport);
      log("native-mcp-delegate-start");
      try {
        const result = await client.callTool({name:"delegate",arguments:{model:"full-claude-agent-child/fake",prompt:"Return CHILD_COMPLETED without tools.",description:"Reload child"},_meta:{"claudecode/toolUseId":"reload-delegate"}},undefined,{timeout:4000});
        log("native-mcp-delegate-result",{result});
        if(result.isError || result.structuredContent?.status !== "running" || typeof result.structuredContent?.sessionID !== "string") throw new Error("Native MCP delegation failed: "+JSON.stringify(result));
      } finally {await client.close();await server.instance.close();}
    }
    if (!this.child && !interrupted) {
      log("native-permission-request");
      const signal = new AbortController().signal;
      let timer;
      try {
        const decision = await Promise.race([
          this.args.options.canUseTool("Bash",{command:"permission-check"},{toolUseID:"permission-check",signal}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Permission callback exceeded 3 seconds")),3000);})
        ]);
        log("native-permission-decision",{decision});
        if(decision.behavior !== "allow") throw new Error("Permission denied: "+JSON.stringify(decision));
      } finally {clearTimeout(timer);}
    }
    const common = {session_id:this.args.options.sessionId ?? this.args.options.resume,parent_tool_use_id:null,user_message_uuid:this.input.uuid};
    const text = this.child ? "CHILD_COMPLETED" : "CONTINUED_WITHOUT_REPLAY";
    this.push({...common,type:"assistant",message:{id:"native-answer",role:"assistant",content:[{type:"text",text}]}});
    this.push({...common,type:"result",subtype:"success",is_error:false,result:text,stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
    log(this.child ? "child-sdk-terminal-result" : "sdk-terminal-result");
  }
  async interrupt() {log("sdk-interrupt");await this.finish(true);}
  close() {log("sdk-close");this.closed=true;clearInterval(this.timer);this.waiting?.();}
  async *[Symbol.asyncIterator]() {
    while(!this.closed) {if(this.queue.length) yield this.queue.shift(); else await new Promise(resolve => this.waiting=resolve);}
  }
}
const run = Runtime.prototype.run;
Runtime.prototype.run = function(request) {
  this.factory = args => new FakeQuery(args,request.profile.id === "full-claude-agent-child");
  log("runtime-run",{sessionID:request.sessionID,providerID:request.profile.id});
  request.signal.addEventListener("abort",()=>log("host-request-abort",{reason:String(request.signal.reason)}),{once:true});
  return run.call(this,{...request,emit(part){log("stream-part",{part});request.emit(part);}});
};
const dispose = Runtime.prototype.dispose;
Runtime.prototype.dispose = async function() {
  log("runtime-dispose-start");
  await dispose.call(this);log("runtime-dispose-end");
};
export default Plugin.define({id:"full-claude-agent",effect:ctx => Effect.gen(function*(){
  const profiles = parseProfiles(ctx.options,ctx.location.directory);
  log("provider-setup",{profiles:profiles.map(profile=>({id:profile.id,models:profile.models,configDir:profile.configDir})),options:ctx.options});
  const bridge = yield* requestContext(ctx,profiles.map(profile=>profile.id));
  const traced = {...bridge.ctx,tool:{...bridge.ctx.tool,list:()=>Effect.gen(function*(){
    log("host-tool-list-start");
    const tools = yield* bridge.ctx.tool.list();
    log("host-tool-list-end");
    return tools.map(tool=>({...tool,execute:(...args)=>Effect.gen(function*(){
      log("host-tool-execute-start",{tool:tool.id});
      const result = yield* tool.execute(...args);
      log("host-tool-execute-end",{tool:tool.id});
      return result;
    })}));
  })},model:{...bridge.ctx.model,list:(...args)=>Effect.gen(function*(){
    log("host-model-list-start");
    const result = yield* bridge.ctx.model.list(...args);
    log("host-model-list-end");
    return result;
  })}};
  yield* fromPromise(makePlugin(bridge.lease,async()=>({models:[]}))).effect(traced);
})});
`, { mode: 0o600 })
const observerSource = `// Private watched-plugin continuity fixture.
import { Plugin } from "@opencode/plugin";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { appendFileSync } from "node:fs";
export default fromPromise(Plugin.define({id:"continuity-observer",async setup(ctx){
  appendFileSync(${JSON.stringify(timeline)},JSON.stringify({at:Date.now(),event:"observer-setup",options:ctx.options})+"\\n");
  await ctx.tool.hook("execute.before",event=>{
    appendFileSync(${JSON.stringify(timeline)},JSON.stringify({at:Date.now(),event:"host-tool-before",tool:event.tool})+"\\n");
    if(event.tool !== "subagent") throw new Error("Host tool execution forbidden");
  });
  return ()=>{appendFileSync(${JSON.stringify(timeline)},JSON.stringify({at:Date.now(),event:"observer-dispose"})+"\\n");};
}}));
`
writeFileSync(watched, observerSource, { mode: 0o600 })
const profile = { configDir: join(root, "claude"), binaryPath: "/nonexistent/forbidden-claude", models: ["fake"] }
const alias = join(config, "plugins", "00-full-claude-agent")
if (providerFirst) symlinkSync(wrapper, alias, "dir")
save("project/opencode.json", { plugins: [{ package: providerFirst ? alias : wrapper, options: { profiles: { continuity: profile, child: profile } } }] })
const password = randomBytes(32).toString("base64url")
const privateEnvironment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "dumb", HOME: privateHome,
  XDG_CONFIG_HOME: privateXDG, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(privateHome, ".gitconfig"), GIT_CEILING_DIRECTORIES: root }
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) mkdirSync(privateEnvironment[key]!, { recursive: true, mode: 0o700 })
const env: NodeJS.ProcessEnv = { ...privateEnvironment, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "opencode.sqlite"), OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_SIMULATE: "0", OPENCODE_PASSWORD: password }
const installedNames = ["plugins/herdr-agent-state.js", "herdr-tui-session.js", "tui.jsonc", "plugins/worktrunk.ts"]
const installedSnapshot = () => Object.fromEntries(installedNames.map(name => {
  const path = join(config, name)
  const info = statSync(path)
  return [name, { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mtimeMs: info.mtimeMs, inode: info.ino, size: info.size }]
}))
function installIntegrations(phase: string) {
  for (const [command, args] of [["herdr", ["integration", "install", "opencode"]], ["wt", ["config", "plugins", "opencode", "install", "--yes"]]] as const) {
    log("installer-start", { phase, command, args })
    const result = spawnSync(command, [...args], { cwd, env, encoding: "utf8", timeout: 10_000 })
    save(`installer-${phase}-${command}.json`, { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message })
    log("installer-end", { phase, command, status: result.status })
    assert.equal(result.status, 0, `${command} installer failed: ${result.stderr || result.error}`)
  }
}
let installedBefore: ReturnType<typeof installedSnapshot> | undefined
if (installers) {
  assert(!Object.keys(env).some(key => /^(HERDR|WORKTRUNK|TMUX|GIT_DIR|GIT_WORK_TREE)/.test(key)), "Inherited integration environment escaped isolation")
  assert.notEqual(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, env }).status, 0, "Installer project must not belong to a Git repository")
  installIntegrations("initial")
  installedBefore = installedSnapshot()
  // These hashes bind the safety audit to code whose sockets require Herdr pane variables and whose markers use the private project directory.
  const audited = { "plugins/herdr-agent-state.js": "f70a7d2193f4a9409838b078acee5a35f72f0925af08f63c142ec9cbf0ba5fcd", "herdr-tui-session.js": "50659d47db3cf4e7de3028e56f2666a656efaaddc24711b72f5b6baa9f99c5d3", "plugins/worktrunk.ts": "ce8be61d5d9e8925b87b85c3dd8f17c21abf7b0fe816d2493f8dc38775c9a56c" }
  for (const [name, hash] of Object.entries(audited)) assert.equal(installedBefore[name].sha256, hash, `Audit generated ${name} before loading a changed installer version`)
  save("installed-before.json", installedBefore)
  save("isolation.json", { env, cwd, config, audited })
}
const port = await new Promise<number>((done, reject) => {
  const socket = createServer(); socket.once("error", reject)
  socket.listen(0, "127.0.0.1", () => { const address = socket.address(); assert(address && typeof address !== "string"); socket.close(error => error ? reject(error) : done(address.port)) })
})
const url = `http://127.0.0.1:${port}`
const out = openSync(join(root, "server.stdout.log"), "w", 0o600)
const err = openSync(join(root, "server.stderr.log"), "w", 0o600)
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env, detached: true, stdio: ["ignore", out, err] })
closeSync(out); closeSync(err)
const abort = new AbortController()
const exited = new Promise<void>(done => server.once("close", () => done()))
server.once("error", error => abort.abort(error))
const kill = (signal: NodeJS.Signals) => { if (server.pid) try { process.kill(-server.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error } }
const timer = setTimeout(() => { abort.abort(new Error("Continuity smoke exceeded 60 seconds")); kill("SIGKILL") }, 60_000)
const interrupted = () => { abort.abort(new Error("Continuity smoke interrupted")); kill("SIGKILL") }
process.once("SIGINT", interrupted)
process.once("SIGTERM", interrupted)
const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } })
const client = OpenCode.make({ baseUrl: url, headers })
let eventPump: Promise<void> | undefined
let eventError: unknown
let sessionID: string | undefined
async function until(label: string, check: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms
  while (!await check()) { abort.signal.throwIfAborted(); assert(Date.now() < deadline, label); await Bun.sleep(50) }
}
console.log(`Private artifacts: ${root}`)
try {
  await until("Owned server readiness", async () => { try { return (await fetch(`${url}/api/info`, { headers, signal: AbortSignal.timeout(500) })).ok } catch { return false } }, 30_000)
  {
    const ready = Promise.withResolvers<void>()
    eventPump = (async () => {
      for await (const event of client.event.subscribe({ types: ["permission.asked"], signal: abort.signal })) {
        if (event.type === "server.connected") { ready.resolve(); continue }
        if (event.type !== "permission.asked" || event.data.sessionID !== sessionID) continue
        log("permission-asked", { location: event.location, data: event.data })
        assert(event.location, "Permission event has no Location")
        assert(records().some(record => record.event === "watched-rewrite") || control, "Permission preceded reload")
        await client.permission.reply({ sessionID: event.data.sessionID, requestID: event.data.id, decision: "once" }, { signal: abort.signal })
        log("permission-replied")
      }
    })().catch(error => { if (!abort.signal.aborted) { eventError = error; ready.reject(error); log("permission-listener-error", { message: String(error) }) } })
    await ready.promise
  }
  const session = await client.session.create({ location: { directory: cwd }, title: "No-op reload continuity", model: { providerID: "full-claude-agent-continuity", id: "fake" }, permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "permission-check", effect: "ask" }] }, { signal: abort.signal })
  sessionID = session.id
  save("run.json", { root, sessionID: session.id, pid: server.pid, url, providerFirst, changedPlugin, alias, installers, control })
  await client.session.prompt({ sessionID: session.id, text: "Execute the native marker once, then continue after the gate." }, { signal: abort.signal })
  await until("Fake SDK never received the user turn", () => records().some(record => record.event === "native-result-held"))
  const before = records().filter(record => record.event === "sdk-submission").length
  save("before-context.json", await client.session.context({ sessionID: session.id }, { signal: abort.signal }))
  const bytes = readFileSync(watched)
  const hash = createHash("sha256").update(bytes).digest("hex")
  log(control ? "control-no-rewrite" : "watched-rewrite", { hash, submissions: before })
  if (!control) {
    if (installers) {
      installIntegrations("held-turn")
      const installedAfter = installedSnapshot()
      save("installed-after.json", installedAfter)
      for (const name of installedNames) assert.equal(installedAfter[name].sha256, installedBefore![name].sha256, `Reinstallation changed ${name} content`)
      for (const name of ["plugins/herdr-agent-state.js", "herdr-tui-session.js"]) assert(installedAfter[name].mtimeMs !== installedBefore![name].mtimeMs || installedAfter[name].inode !== installedBefore![name].inode, `Installer did not rewrite ${name}`)
      log("installer-rewrites-verified", { files: installedAfter, rewrittenFiles: installedNames.filter(name => installedAfter[name].mtimeMs !== installedBefore![name].mtimeMs || installedAfter[name].inode !== installedBefore![name].inode), tuiConfigContentStable: true })
    } else writeFileSync(watched, changedPlugin ? Buffer.concat([bytes, Buffer.from("\n// Changed private observer fixture.\n")]) : bytes)
  }
  const afterHash = createHash("sha256").update(readFileSync(watched)).digest("hex")
  if (!changedPlugin) assert.equal(afterHash, hash)
  else assert.notEqual(afterHash, hash, "Changed-content case did not change the observer source")
  log("watched-rewrite-complete", { beforeHash: hash, afterHash, changedPlugin })
  if (!control) await until("Watched rewrite did not reload the trailing observer", () => records().filter(record => record.event === "observer-setup").length >= 2, 5_000)
  log("gate-release")
  writeFileSync(gate, "release", { mode: 0o600 })
  try { await client.experimental.session.wait({ sessionID: session.id }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(6_000)]) }) } catch (error) { log("host-wait-error", { message: String(error) }) }
  const history = await client.session.context({ sessionID: session.id }, { signal: abort.signal })
  save("context.json", history)
  const assistant = history.findLast(message => message.type === "assistant")
  const after = records().filter(record => record.event === "sdk-submission").length
  const executions = readFileSync(marker, "utf8").trim().split("\n").length
  log("outcome", { beforeSubmissions: before, afterSubmissions: after, markerExecutions: executions, observerGenerations: records().filter(record => record.event === "observer-setup").length, providerModules: records().filter(record => record.event === "provider-module-loaded").length, providerSetups: records().filter(record => record.event === "provider-setup").length, runtimeDisposals: records().filter(record => record.event === "runtime-dispose-start").length, childSubmissions: records().filter(record => record.event === "child-sdk-submission").length, hostAborts: records().filter(record => record.event === "host-request-abort").length, permissionsAsked: records().filter(record => record.event === "permission-asked").length, permissionsReplied: records().filter(record => record.event === "permission-replied").length, error: assistant?.type === "assistant" ? assistant.error : "No assistant", finish: assistant?.type === "assistant" ? assistant.finish : undefined })
  assert.equal(before, 1, "Initial turn was submitted more than once")
  assert.equal(after, before, "No-op rewrite replayed the SDK submission")
  assert.equal(executions, 1, "Native side effect ran more than once")
  if (!control) {
    if (installers) assert(records().filter(record => record.event === "observer-setup").length >= 2, "Installer rewrites did not reload the trailing observer")
    else assert.equal(records().filter(record => record.event === "observer-setup").length, 2, "Observer did not reload exactly once")
  } else assert.equal(records().filter(record => record.event === "observer-setup").length, 1, "Control unexpectedly reloaded the observer")
  assert(assistant?.type === "assistant" && !assistant.error && assistant.finish === "stop", "Active user turn failed during plugin reload")
  if (providerFirst || control) {
    assert.equal(records().filter(record => record.event === "runtime-dispose-start").length, 0, "Ordered Full Claude runtime was disposed during unrelated reload")
    assert.equal(records().filter(record => record.event === "provider-module-loaded").length, 1, "Ordered Full Claude module reloaded")
    const setups = records().filter(record => record.event === "provider-setup")
    assert.equal(setups.length, 1, "Ordered Full Claude setup ran more than once")
    assert.deepEqual(setups[0].profiles.map((entry: any) => entry.id), ["full-claude-agent-continuity", "full-claude-agent-child"])
    assert.deepEqual(setups[0].options.profiles.continuity, profile, "Exact-target explicit options were not retained")
  } else {
    assert(records().filter(record => record.event === "provider-setup").length >= 2, "Provider-last reload did not reinitialize Full Claude")
    assert.equal(records().filter(record => record.event === "runtime-dispose-start").length, 0, "Reinitialized Full Claude disposed its live runtime instead of adopting it")
    assert.equal(records().filter(record => record.event === "provider-module-loaded").length, 1, "Full Claude module was re-imported, so adoption was not exercised")
  }
  {
    const result = records().find(record => record.event === "native-mcp-delegate-result")?.result
    assert(result && !result.isError, "Native MCP delegation did not start a background child within 4 seconds")
    const deadline = Date.now() + 10_000
    while (!records().some(record => record.event === "child-sdk-submission") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(records().filter(record => record.event === "child-sdk-submission").length, 1, "Child did not receive exactly one SDK submission")
    const child = await client.session.get({ sessionID: result.structuredContent.sessionID }, { signal: abort.signal })
    save("child.json", child)
  }
  if (eventError) throw eventError
  assert.equal(records().filter(record => record.event === "permission-asked").length, 1, "Reloaded turn did not emit exactly one permission.asked event")
  assert.equal(records().filter(record => record.event === "permission-replied").length, 1, "Reloaded turn did not receive exactly one permission reply")
  assert.equal(records().filter(record => record.event === "sdk-interrupt").length, 0, "Native SDK query was interrupted during the turn")
  assert(JSON.stringify(assistant).includes("CONTINUED_WITHOUT_REPLAY"), "Active turn did not continue")
  console.log(control ? "PASS: control turn completed without replay" : `PASS: active Full Claude turn survived ${installers ? "actual Herdr and Worktrunk reinstallation" : changedPlugin ? "changed watched-plugin rewrite" : "identical watched-plugin rewrite"} without replay`)
} catch (error) {
  save("failure.json", { message: String(error) })
  console.error(error)
  process.exitCode = 1
} finally {
  process.removeListener("SIGINT", interrupted)
  process.removeListener("SIGTERM", interrupted)
  abort.abort(); clearTimeout(timer); kill("SIGTERM")
  const force = setTimeout(() => kill("SIGKILL"), 2_000)
  await exited; clearTimeout(force); kill("SIGKILL")
  await eventPump
}
