import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, SDKControlInitializeResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseProfiles, type Profile } from "../src/config";
import { ModelCatalog, normalizeModels, probeClaudeModels, selectModels, type ModelProbe } from "../src/models";
import type { NativeQuery, QueryFactory, Storage } from "../src/runtime";

const model = (value: string, displayName = value, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  value, displayName, description: "Fixture model", ...extra,
});
const discovered = [
  model("default", "Default"),
  model("claude-sonnet-5", "Sonnet 5", { supportsEffort: true, supportedEffortLevels: ["low", "high"] }),
  model("claude-fable-5", "Fable 5", { supportsEffort: true, supportedEffortLevels: ["medium", "xhigh", "max"] }),
];

let directory: string;
const catalogs: ModelCatalog[] = [];
let expectedFailures: WeakSet<Error>;
let errorSpy: ReturnType<typeof spyOn<typeof console, "error">>;
function expectedFailure(message: string) {
  const error = new Error(message);
  expectedFailures.add(error);
  return error;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claude-models-test-"));
  expectedFailures = new WeakSet();
  const report = console.error.bind(console);
  errorSpy = spyOn(console, "error").mockImplementation((...args) => {
    if (args[0]?.startsWith?.("Full Claude Agent model discovery failed for ") && expectedFailures.has(args[1])) return;
    report(...args);
  });
});
afterEach(async () => {
  try {
    await Promise.all(catalogs.splice(0).map((catalog) => catalog.dispose()));
    rmSync(directory, { recursive: true, force: true });
  } finally { errorSpy.mockRestore(); }
});

function profile(options: Record<string, unknown> = {}): Profile {
  return parseProfiles({ configDir: join(directory, "config"), ...options }, directory, {})[0]!;
}

function storage() {
  const records = new Map<string, unknown>();
  const writes: unknown[] = [];
  const result: Storage = {
    async get(key) { return structuredClone(records.get(key)); },
    async set(key, value) { writes.push(structuredClone(value)); records.set(key, structuredClone(value)); },
  };
  return { ...result, records, writes };
}

function catalog(store: Storage, profiles: Profile[], probe: ModelProbe, cwd = directory) {
  const reloads: number[] = [];
  const instance = new ModelCatalog(store, profiles, cwd, async () => { reloads.push(1); }, probe);
  catalogs.push(instance);
  return { instance, reloads };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Catalog did not reach the expected state");
}

describe("model selection", () => {
  test("preserves discovered IDs, display names, and reported effort levels, including Fable", () => {
    const rows = normalizeModels(discovered);
    expect(rows.find(({ id }) => id === "claude-fable-5")).toEqual({
      id: "claude-fable-5", name: "Fable 5", efforts: ["medium", "xhigh", "max"],
    });
    expect(selectModels(profile(), rows)).toEqual([
      { id: "claude-sonnet-5", name: "Sonnet 5", efforts: ["low", "high"] },
      { id: "claude-fable-5", name: "Fable 5", efforts: ["medium", "xhigh", "max"] },
    ]);
  });

  test("does not infer effort support from model family or supportsEffort alone", () => {
    expect(normalizeModels([
      model("opus", "Opus"), model("claude-sonnet-5", "Sonnet 5", { supportsEffort: true }),
      model("fable", "Fable", { supportsEffort: false }),
    ]).map(({ efforts }) => efforts)).toEqual([[], [], []]);
  });

  test("explicit models preserve exact IDs and order and exclude unrequested discovery", () => {
    const rows = normalizeModels(discovered);
    expect(selectModels(profile({ models: ["private-model", "claude-fable-5"] }), rows)).toEqual([
      { id: "private-model", name: "private-model", efforts: [] },
      { id: "claude-fable-5", name: "Fable 5", efforts: ["medium", "xhigh", "max"] },
    ]);
  });

  test("matches explicit versioned IDs to unambiguous resolvedModel metadata without rewriting IDs", () => {
    const rows = normalizeModels([
      model("sonnet", "Sonnet 5", { resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["high"] }),
    ]);
    expect(selectModels(profile({ models: ["claude-sonnet-5"] }), rows).map(({ id, name, efforts }) => ({ id, name, efforts }))).toEqual([
      { id: "claude-sonnet-5", name: "Sonnet 5", efforts: ["high"] },
    ]);
  });

  test("exact value matches take precedence over resolvedModel aliases", () => {
    const rows = normalizeModels([
      model("sonnet", "Alias", { resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["low"] }),
      model("claude-sonnet-5", "Exact", { supportedEffortLevels: ["high"] }),
    ]);
    expect(selectModels(profile({ models: ["claude-sonnet-5"] }), rows)).toEqual([
      { id: "claude-sonnet-5", name: "Exact", efforts: ["high"] },
    ]);
  });

  test("ambiguous resolvedModel matches do not supply effort metadata", () => {
    const rows = normalizeModels([
      model("sonnet", "Alias", { resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["high"] }),
      model("sonnet-preview", "Preview", { resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["max"] }),
    ]);
    expect(selectModels(profile({ models: ["claude-sonnet-5"] }), rows)).toEqual([
      { id: "claude-sonnet-5", name: "claude-sonnet-5", efforts: [] },
    ]);
  });

  test("empty discovery uses aliases without fabricated effort capabilities", () => {
    const fallback = ["sonnet", "opus", "haiku"].map((id) => ({ id, name: id, efforts: [] }));
    expect(selectModels(profile(), [])).toEqual(fallback);
    expect(selectModels(profile(), normalizeModels([model("default")]))).toEqual(fallback);
    expect(selectModels(profile({ models: ["claude-fable-5"] }), [])).toEqual([
      { id: "claude-fable-5", name: "claude-fable-5", efforts: [] },
    ]);
  });
});

describe("ModelCatalog", () => {
  test("refreshes independent profiles and applies each profile's explicit override", async () => {
    const profiles = parseProfiles({ profiles: {
      personal: { configDir: "personal" },
      work: { configDir: "work", models: ["work-model"] },
    } }, directory, {});
    const seen: string[] = [];
    const { instance } = catalog(storage(), profiles, async (selected, cwd) => {
      expect(cwd).toBe(directory);
      seen.push(selected.id);
      return { models: selected.id === profiles[0]!.id ? discovered : [model("work-model", "Work model")] };
    });
    await instance.load();
    await instance.refresh();
    expect(new Set(seen)).toEqual(new Set(profiles.map(({ id }) => id)));
    expect(instance.get(profiles[0]!.id).map(({ id }) => id)).toEqual(["claude-sonnet-5", "claude-fable-5"]);
    expect(instance.get(profiles[1]!.id)).toEqual([{ id: "work-model", name: "Work model", efforts: [] }]);
  });

  test("loads matching cache before a background probe finishes and retains cache after probe failure", async () => {
    const selected = profile();
    const store = storage();
    const first = catalog(store, [selected], async () => ({ models: discovered })).instance;
    await first.load();
    await first.refresh();
    await first.dispose();
    const pending = Promise.withResolvers<{ models: ModelInfo[] }>();
    let started = false;
    const second = catalog(store, [selected], async () => { started = true; return pending.promise; }).instance;
    await second.load();
    expect(second.get(selected.id).map(({ id }) => id)).toEqual(["claude-sonnet-5", "claude-fable-5"]);
    expect(started).toBe(false);
    const refreshing = second.refresh();
    await until(() => started);
    pending.reject(expectedFailure("Offline"));
    await refreshing;
    expect(second.get(selected.id).map(({ id }) => id)).toEqual(["claude-sonnet-5", "claude-fable-5"]);
  });

  test("failed discovery without a matching cache retains fallback aliases", async () => {
    const selected = profile();
    const { instance } = catalog(storage(), [selected], async () => { throw expectedFailure("Not authenticated"); });
    await instance.load();
    await instance.refresh();
    expect(instance.get(selected.id).map(({ id, efforts }) => ({ id, efforts }))).toEqual(
      ["sonnet", "opus", "haiku"].map((id) => ({ id, efforts: [] })),
    );
  });

  test.each(["environment", "configDir", "binary", "directory", "auth", "settings"])("invalidates cached discovery after a binding %s change", async (change) => {
    const original = profile({ env: { ANTHROPIC_AUTH_TOKEN: "token-before" } });
    mkdirSync(original.configDir, { recursive: true });
    writeFileSync(join(original.configDir, ".credentials.json"), '{"token":"auth-before"}');
    writeFileSync(join(original.configDir, "settings.json"), '{"env":{"TEST":"before"}}');
    const store = storage();
    const first = catalog(store, [original], async () => ({ models: discovered })).instance;
    await first.load();
    await first.refresh();
    await first.dispose();
    const changed = { ...original };
    let cwd = directory;
    if (change === "environment") changed.env = { ANTHROPIC_AUTH_TOKEN: "token-after" };
    if (change === "configDir") changed.configDir = join(directory, "other-config");
    if (change === "binary") changed.binaryPath = "/fixture/other-claude";
    if (change === "directory") { cwd = join(directory, "other-project"); mkdirSync(cwd); }
    if (change === "auth") writeFileSync(join(original.configDir, ".credentials.json"), '{"token":"auth-after"}');
    if (change === "settings") writeFileSync(join(original.configDir, "settings.json"), '{"env":{"TEST":"after"}}');
    const second = catalog(store, [changed], async () => { throw expectedFailure("Offline"); }, cwd).instance;
    await second.load();
    await second.refresh();
    expect(second.get(changed.id).map(({ id }) => id)).toEqual(["sonnet", "opus", "haiku"]);
    const serialized = JSON.stringify([...store.records]);
    for (const secret of ["token-before", "token-after", "auth-before", "auth-after"]) expect(serialized).not.toContain(secret);
  });

  test("canonical directory aliases reuse matching cache", async () => {
    const selected = profile();
    mkdirSync(selected.configDir);
    const store = storage();
    const first = catalog(store, [selected], async () => ({ models: discovered })).instance;
    await first.load();
    await first.refresh();
    await first.dispose();
    const alias = join(directory, "project-link");
    const configAlias = join(directory, "config-link");
    symlinkSync(directory, alias);
    symlinkSync(selected.configDir, configAlias);
    const second = catalog(store, [{ ...selected, configDir: configAlias }], async () => { throw expectedFailure("Offline"); }, alias).instance;
    await second.load();
    expect(second.get(selected.id).map(({ id }) => id)).toEqual(["claude-sonnet-5", "claude-fable-5"]);
  });

  test("invalidates cached discovery when inherited effective environment changes", async () => {
    const key = "FULL_CLAUDE_MODEL_TEST_ENV";
    const previous = process.env[key];
    try {
      process.env[key] = "inherited-secret-before";
      const selected = profile();
      const store = storage();
      const first = catalog(store, [selected], async () => ({ models: discovered })).instance;
      await first.load();
      await first.refresh();
      await first.dispose();
      process.env[key] = "inherited-secret-after";
      const second = catalog(store, [selected], async () => { throw expectedFailure("Offline"); }).instance;
      await second.load();
      await second.refresh();
      expect(second.get(selected.id).map(({ id }) => id)).toEqual(["sonnet", "opus", "haiku"]);
      const serialized = JSON.stringify([...store.records]);
      expect(serialized).not.toContain("inherited-secret-before");
      expect(serialized).not.toContain("inherited-secret-after");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("live initialization supersedes an older in-flight startup probe", async () => {
    const selected = profile();
    const pending = Promise.withResolvers<{ models: ModelInfo[] }>();
    let started = false;
    const store = storage();
    const { instance } = catalog(store, [selected], async () => { started = true; return pending.promise; });
    await instance.load();
    const refreshing = instance.refresh();
    await until(() => started);
    try {
      await instance.update(selected, [model("live-fable", "Live Fable", { supportedEffortLevels: ["max"] })]);
      const writes = store.writes.length;
      pending.resolve({ models: discovered });
      await refreshing;
      expect(instance.get(selected.id)).toEqual([{ id: "live-fable", name: "Live Fable", efforts: ["max"] }]);
      expect(store.writes.length).toBe(writes);
    } finally {
      pending.resolve({ models: discovered });
      await refreshing;
    }
  });

  test("live initialization after an auth change caches the new account without overwriting the old account", async () => {
    const selected = profile();
    mkdirSync(selected.configDir);
    const credentials = join(selected.configDir, ".credentials.json");
    const authA = '{"token":"account-a-secret"}';
    writeFileSync(credentials, authA);
    const store = storage();
    const modelsA = [model("account-a-model", "Account A")];
    const modelsB = [model("account-b-fable", "Account B Fable", { supportedEffortLevels: ["max"] })];
    const { instance } = catalog(store, [selected], async () => ({ models: modelsA }));
    await instance.load();
    await instance.refresh();
    const bindingA = await instance.capture(selected);
    writeFileSync(credentials, '{"token":"account-b-secret"}');
    const bindingB = await instance.capture(selected);
    expect(bindingB).not.toBe(bindingA);
    await instance.update(selected, modelsB, undefined, bindingB);
    expect(instance.get(selected.id)).toEqual(normalizeModels(modelsB));
    await instance.dispose();
    const offline: ModelProbe = async () => { throw expectedFailure("Offline"); };
    const restoredB = catalog(store, [selected], offline).instance;
    await restoredB.load();
    await restoredB.refresh();
    expect(restoredB.get(selected.id)).toEqual(normalizeModels(modelsB));
    await restoredB.dispose();
    writeFileSync(credentials, authA);
    const restoredA = catalog(store, [selected], offline).instance;
    await restoredA.load();
    await restoredA.refresh();
    expect(restoredA.get(selected.id)).toEqual(normalizeModels(modelsA));
    const serialized = JSON.stringify([...store.records]);
    expect(serialized).not.toContain("account-a-secret");
    expect(serialized).not.toContain("account-b-secret");
  });

  test("rejects a slow initialization result when the query-start auth binding no longer matches", async () => {
    const selected = profile();
    mkdirSync(selected.configDir);
    const credentials = join(selected.configDir, ".credentials.json");
    const authA = '{"token":"account-a-secret"}';
    writeFileSync(credentials, authA);
    const store = storage();
    const original = [model("original-account-a", "Original Account A")];
    const { instance } = catalog(store, [selected], async () => ({ models: original }));
    await instance.load();
    await instance.refresh();
    const queryStartBinding = await instance.capture(selected);
    const writes = store.writes.length;
    writeFileSync(credentials, '{"token":"account-b-secret"}');
    await instance.update(selected, [model("stale-account-a", "Stale Account A")], undefined, queryStartBinding);
    expect(store.writes).toHaveLength(writes);
    await instance.dispose();
    const offline: ModelProbe = async () => { throw expectedFailure("Offline"); };
    const restoredB = catalog(store, [selected], offline).instance;
    await restoredB.load();
    await restoredB.refresh();
    expect(restoredB.get(selected.id).map(({ id }) => id)).toEqual(["sonnet", "opus", "haiku"]);
    await restoredB.dispose();
    writeFileSync(credentials, authA);
    const restoredA = catalog(store, [selected], offline).instance;
    await restoredA.load();
    await restoredA.refresh();
    expect(restoredA.get(selected.id)).toEqual(normalizeModels(original));
  });

  test("a rejected stale initialization does not cancel discovery for the current account", async () => {
    const selected = profile();
    mkdirSync(selected.configDir);
    const credentials = join(selected.configDir, ".credentials.json");
    writeFileSync(credentials, '{"token":"account-a-secret"}');
    const store = storage();
    const pending = Promise.withResolvers<{ models: ModelInfo[] }>();
    const started = Promise.withResolvers<void>();
    const modelsB = [model("account-b-fable", "Account B Fable", { supportedEffortLevels: ["max"] })];
    const { instance } = catalog(store, [selected], async () => {
      started.resolve();
      return pending.promise;
    });
    await instance.load();
    const queryStartBindingA = await instance.capture(selected);
    writeFileSync(credentials, '{"token":"account-b-secret"}');
    const refreshing = instance.refresh();
    await started.promise;
    try {
      await instance.update(selected, [model("stale-account-a", "Stale Account A")], undefined, queryStartBindingA);
      expect(store.writes).toHaveLength(0);
    } finally {
      pending.resolve({ models: modelsB });
      await refreshing;
    }
    expect(instance.get(selected.id)).toEqual(normalizeModels(modelsB));
    expect(store.writes).toHaveLength(1);
    await instance.dispose();
    const restored = catalog(store, [selected], async () => { throw new Error("Must not probe during cache load"); }).instance;
    await restored.load();
    expect(restored.get(selected.id)).toEqual(normalizeModels(modelsB));
  });

  test("retries discovery after an in-flight auth change and persists only the second account's result", async () => {
    const selected = profile();
    mkdirSync(selected.configDir);
    const credentials = join(selected.configDir, ".credentials.json");
    const authA = '{"token":"account-a-secret"}';
    writeFileSync(credentials, authA);
    const store = storage();
    const pending = Promise.withResolvers<{ models: ModelInfo[] }>();
    const started = Promise.withResolvers<void>();
    const modelsB = [model("account-b-fable", "Account B Fable", { supportedEffortLevels: ["max"] })];
    let probes = 0;
    const { instance } = catalog(store, [selected], async () => {
      if (++probes === 1) { started.resolve(); return pending.promise; }
      return { models: modelsB };
    });
    await instance.load();
    const refreshing = instance.refresh();
    await started.promise;
    try {
      writeFileSync(credentials, '{"token":"account-b-secret"}');
    } finally { pending.resolve({ models: [model("stale-account-a", "Stale Account A")] }); }
    await refreshing;
    expect(probes).toBe(2);
    expect(store.writes).toHaveLength(1);
    expect(instance.get(selected.id)).toEqual(normalizeModels(modelsB));
    await instance.dispose();
    const offline: ModelProbe = async () => { throw expectedFailure("Offline"); };
    const restoredB = catalog(store, [selected], offline).instance;
    await restoredB.load();
    expect(restoredB.get(selected.id)).toEqual(normalizeModels(modelsB));
    await restoredB.dispose();
    writeFileSync(credentials, authA);
    const restoredA = catalog(store, [selected], offline).instance;
    await restoredA.load();
    await restoredA.refresh();
    expect(restoredA.get(selected.id).map(({ id }) => id)).toEqual(["sonnet", "opus", "haiku"]);
  });

  test("disposal aborts startup discovery and prevents late cache writes or reloads", async () => {
    const selected = profile();
    const pending = Promise.withResolvers<{ models: ModelInfo[] }>();
    let signal: AbortSignal | undefined;
    const store = storage();
    const { instance, reloads } = catalog(store, [selected], async (_profile, _cwd, abort) => {
      signal = abort;
      return pending.promise;
    });
    await instance.load();
    const refreshing = instance.refresh();
    await until(() => signal !== undefined);
    const disposing = instance.dispose();
    await until(() => signal!.aborted);
    const writes = store.writes.length;
    const reloadCount = reloads.length;
    pending.resolve({ models: discovered });
    await refreshing;
    await disposing;
    await instance.update(selected, discovered);
    expect(store.writes.length).toBe(writes);
    expect(reloads.length).toBe(reloadCount);
  });

  test("live initialization queues behind an in-flight startup cache write and wins both cache and catalog", async () => {
    const selected = profile();
    const backing = storage();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const store: Storage = {
      get: backing.get,
      async set(key, value) {
        if (++calls === 1) { entered.resolve(); await release.promise; }
        await backing.set(key, value);
      },
    };
    const { instance, reloads } = catalog(store, [selected], async () => ({ models: discovered }));
    await instance.load();
    const refreshing = instance.refresh();
    await entered.promise;
    const liveModels = [model("live-fable", "Live Fable", { supportedEffortLevels: ["max"] })];
    const captured = Promise.withResolvers<void>();
    const capture = instance.capture.bind(instance);
    const captureSpy = spyOn(instance, "capture").mockImplementation(async (profile) => {
      const binding = await capture(profile);
      captured.resolve();
      return binding;
    });
    const updating = instance.update(selected, liveModels);
    try {
      await captured.promise;
      await Promise.resolve();
      expect(calls).toBe(1);
    } finally { captureSpy.mockRestore(); release.resolve(); }
    await Promise.all([refreshing, updating]);
    const expected = [{ id: "live-fable", name: "Live Fable", efforts: ["max"] }];
    expect(instance.get(selected.id)).toEqual(expected);
    expect(calls).toBe(2);
    expect(reloads).toHaveLength(1);
    await instance.dispose();
    const restored = catalog(backing, [selected], async () => { throw new Error("Must not probe during cache load"); }).instance;
    await restored.load();
    expect(restored.get(selected.id)).toEqual(expected);
  });

  test("disposal during a cache write prevents publication and reload after the write completes", async () => {
    const selected = profile();
    const backing = storage();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const store: Storage = {
      get: backing.get,
      async set(key, value) {
        entered.resolve();
        await release.promise;
        await backing.set(key, value);
      },
    };
    const { instance, reloads } = catalog(store, [selected], async () => ({ models: discovered }));
    await instance.load();
    const refreshing = instance.refresh();
    await entered.promise;
    const disposing = instance.dispose();
    release.resolve();
    await Promise.all([refreshing, disposing]);
    expect(reloads).toHaveLength(0);
    expect(instance.get(selected.id).map(({ id }) => id)).toEqual(["sonnet", "opus", "haiku"]);
    expect(backing.writes).toHaveLength(1);
    await instance.update(selected, discovered);
    expect(backing.writes).toHaveLength(1);
    expect(reloads).toHaveLength(0);
  });
});

function controlQuery(initialization: Promise<SDKControlInitializeResponse>) {
  const closed = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let closeCount = 0;
  let drained = false;
  const native: NativeQuery = {
    initializationResult: () => { started.resolve(); return initialization; },
    async interrupt() {},
    close() { closeCount++; closed.resolve(); },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
      try { await closed.promise; } finally { drained = true; }
    },
  };
  return { native, started: started.promise, get closeCount() { return closeCount; }, get drained() { return drained; } };
}

describe("probeClaudeModels", () => {
  test("initializes without submitting a prompt, disables side effects, and closes and drains the query", async () => {
    const selected = profile({ binaryPath: "./fixture-claude", env: { ANTHROPIC_AUTH_TOKEN: "profile-token" } });
    const initialized = { models: discovered, account: {}, claude_code_version: "fixture-version" } as SDKControlInitializeResponse;
    const fake = controlQuery(Promise.resolve(initialized));
    let inputs = 0;
    let consuming: Promise<void> | undefined;
    const factory: QueryFactory = ({ prompt, options }) => {
      expect(options).toMatchObject({
        cwd: directory, pathToClaudeCodeExecutable: selected.binaryPath,
        env: { CLAUDE_CONFIG_DIR: selected.configDir, ANTHROPIC_AUTH_TOKEN: "profile-token" },
        settingSources: [], strictMcpConfig: true, skills: [], tools: [], mcpServers: {},
        settings: { disableAllHooks: true }, persistSession: false,
      });
      expect(options.model).toBeUndefined();
      consuming = (async () => { for await (const _message of prompt) inputs++; })();
      return fake.native;
    };
    const result = await probeClaudeModels(selected, directory, new AbortController().signal, factory);
    await consuming;
    expect(result.models).toEqual(discovered);
    expect(result.version).toBe("fixture-version");
    expect(inputs).toBe(0);
    expect(fake.closeCount).toBeGreaterThan(0);
    expect(fake.drained).toBe(true);
  });

  test.each(["timeout", "abort", "failure"])("cleans up a query after initialization %s without submitting inputs", async (mode) => {
    const pending = Promise.withResolvers<SDKControlInitializeResponse>();
    const fake = controlQuery(pending.promise);
    const controller = new AbortController();
    let inputs = 0;
    let consuming: Promise<void> | undefined;
    const factory: QueryFactory = ({ prompt }) => {
      consuming = (async () => { for await (const _message of prompt) inputs++; })();
      return fake.native;
    };
    const probing = probeClaudeModels(profile(), directory, controller.signal, factory, mode === "timeout" ? 10 : 1_000);
    const rejected = expect(probing).rejects.toThrow();
    await fake.started;
    if (mode === "abort") controller.abort(new Error("Cancelled fixture"));
    if (mode === "failure") pending.reject(new Error("Initialization failed"));
    await rejected;
    await consuming;
    expect(inputs).toBe(0);
    expect(fake.closeCount).toBeGreaterThan(0);
    expect(fake.drained).toBe(true);
  });

  test("an already-aborted signal does not start a native query", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));
    let calls = 0;
    const factory: QueryFactory = () => { calls++; throw new Error("Must not launch"); };
    await expect(probeClaudeModels(profile(), directory, controller.signal, factory)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
