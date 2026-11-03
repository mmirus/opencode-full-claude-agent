import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnvironment, parseProfiles } from "../src/config";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claude-config-test-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("parseProfiles", () => {
  test("defaults to stable model aliases, the real home, and the installed CLI", () => {
    expect(parseProfiles({}, directory, {})).toEqual([{
      id: "full-claude-agent",
      name: "Full Claude Agent",
      configDir: join(homedir(), ".claude"),
      binaryPath: "claude",
      plugins: [],
      models: ["sonnet", "opus", "haiku"],
    }]);
  });

  test("resolves explicit and inherited paths without requiring config directories to exist", () => {
    expect(parseProfiles({}, directory, { CLAUDE_CONFIG_DIR: "inherited" })[0]!.configDir).toBe(join(directory, "inherited"));
    expect(parseProfiles({ configDir: "~/claude-test", binaryPath: "./bin/claude" }, directory, {})[0]).toMatchObject({
      configDir: join(homedir(), "claude-test"),
      binaryPath: join(directory, "bin/claude"),
    });
    expect(parseProfiles({ configDir: "explicit", binaryPath: "claude" }, directory, { CLAUDE_CONFIG_DIR: "ignored" })[0]).toMatchObject({
      configDir: join(directory, "explicit"),
      binaryPath: "claude",
    });
    expect(parseProfiles({ binaryPath: "~/bin/claude" }, directory, {})[0]!.binaryPath).toBe(join(homedir(), "bin/claude"));
  });

  test("supports independent named profiles and custom display names", () => {
    const input = { profiles: {
      personal: { configDir: "personal", models: ["sonnet"] },
      alternate: { configDir: "alternate", name: "Alternate" },
    } };
    const profiles = parseProfiles(input, directory, {});
    expect(profiles.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "full-claude-agent-personal", name: "Full Claude Agent (personal)" },
      { id: "full-claude-agent-alternate", name: "Alternate" },
    ]);
    profiles[0]!.models.push("opus");
    expect(input.profiles.personal.models).toEqual(["sonnet"]);
    expect(profiles[1]!.models).toEqual(["sonnet", "opus", "haiku"]);
  });

  test("validates plugin directories and returns absolute paths", () => {
    mkdirSync(join(directory, "plugin/.claude-plugin"), { recursive: true });
    writeFileSync(join(directory, "plugin/.claude-plugin/plugin.json"), JSON.stringify({ name: "fixture" }));
    expect(parseProfiles({ plugins: ["plugin"] }, directory, {})[0]!.plugins).toEqual([join(directory, "plugin")]);
    for (const contents of ["invalid JSON", "null", "[]", "{}", '{"name":""}']) {
      writeFileSync(join(directory, "plugin/.claude-plugin/plugin.json"), contents);
      expect(() => parseProfiles({ plugins: ["plugin"] }, directory, {})).toThrow("valid .claude-plugin/plugin.json");
    }
    expect(() => parseProfiles({ plugins: ["missing"] }, directory, {})).toThrow();
    writeFileSync(join(directory, "file"), "not a directory");
    expect(() => parseProfiles({ plugins: ["file"] }, directory, {})).toThrow();
    mkdirSync(join(directory, "empty-plugin"));
    expect(() => parseProfiles({ plugins: ["empty-plugin"] }, directory, {})).toThrow();
  });

  test.each([
    null, [], "bad", { typo: true }, { name: "unsupported" },
    { configDir: "" }, { configDir: " " }, { configDir: 1 }, { configDir: undefined },
    { binaryPath: "" }, { binaryPath: false }, { binaryPath: "bad\0path" },
    { plugins: "plugin" }, { plugins: [1] }, { plugins: [""] },
    { models: [] }, { models: "sonnet" }, { models: [""] }, { models: [null] },
    { env: null }, { env: [] }, { env: "bad" }, { env: undefined },
    { env: { "": "value" } }, { env: { " ": "value" } },
    { env: { "BAD=NAME": "value" } }, { env: { "BAD\0NAME": "value" } },
    { env: { KEY: 1 } }, { env: { KEY: false } }, { env: { KEY: undefined } },
    { env: { KEY: {} } }, { env: { [Symbol("invalid")]: "value" } },
    { profiles: {} }, { profiles: [] }, { profiles: null },
    { profiles: { Personal: {} } }, { profiles: { "bad_id": {} } },
    { profiles: { "1profile": {} } }, { profiles: { "": {} } },
    { profiles: { personal: null } }, { profiles: { personal: { name: " " } } },
    { profiles: { personal: { typo: true } } }, { profiles: { personal: {} }, models: ["sonnet"] },
  ].map((options) => ({ options })))("rejects malformed options %#", ({ options }) => {
    expect(() => parseProfiles(options as Record<string, unknown>, directory, {})).toThrow();
  });

  test("rejects empty inherited paths and does not disclose supplied values in errors", () => {
    expect(() => parseProfiles({}, directory, { CLAUDE_CONFIG_DIR: "" })).toThrow();
    expect(() => parseProfiles({ privateToken: "sensitive-fixture" }, directory, {})).toThrow("unknown option");
    try {
      parseProfiles({ privateToken: "sensitive-fixture" }, directory, {});
    } catch (error) {
      expect(String(error)).not.toContain("sensitive-fixture");
    }
  });
});

describe("makeEnvironment", () => {
  test("applies independent account overrides without mutating inputs", () => {
    const base = Object.freeze({ ANTHROPIC_API_KEY: "parent-key", ANTHROPIC_AUTH_TOKEN: "parent-token", HOME: "/home/example" });
    const overrides = Object.freeze({ ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: "profile-token", EMPTY: "", CLAUDE_CONFIG_DIR: "ignored", CLAUDECODE: "ignored" });
    const profiles = parseProfiles({ profiles: {
      personal: { configDir: "personal", env: overrides },
      alternate: { configDir: "alternate", env: { ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_API_KEY: "alternate-key" } },
    } }, directory, {});
    const personal = makeEnvironment(profiles[0]!, base);
    const alternate = makeEnvironment(profiles[1]!, base);
    expect(Object.hasOwn(personal, "ANTHROPIC_API_KEY")).toBe(false);
    expect(personal.ANTHROPIC_AUTH_TOKEN).toBe("profile-token");
    expect(personal.EMPTY).toBe("");
    expect(personal.HOME).toBe(base.HOME);
    expect(personal.CLAUDE_CONFIG_DIR).toBe(join(directory, "personal"));
    expect(Object.hasOwn(personal, "CLAUDECODE")).toBe(false);
    expect(alternate.ANTHROPIC_API_KEY).toBe("alternate-key");
    expect(Object.hasOwn(alternate, "ANTHROPIC_AUTH_TOKEN")).toBe(false);
    expect(base).toEqual({ ANTHROPIC_API_KEY: "parent-key", ANTHROPIC_AUTH_TOKEN: "parent-token", HOME: "/home/example" });
    expect(profiles[0]!.env).toEqual(overrides);
    expect(profiles[0]!.env).not.toBe(overrides);
    profiles[0]!.env!.ANTHROPIC_AUTH_TOKEN = "changed";
    expect(overrides.ANTHROPIC_AUTH_TOKEN).toBe("profile-token");
    expect(personal.ANTHROPIC_AUTH_TOKEN).toBe("profile-token");
  });

  test("accepts single-profile env overrides and protects the mandatory config path from removal", () => {
    const profile = parseProfiles({ configDir: "personal", env: { CLAUDE_CONFIG_DIR: null, ANTHROPIC_API_KEY: null } }, directory, {})[0]!;
    expect(makeEnvironment(profile, { CLAUDE_CONFIG_DIR: "/parent", ANTHROPIC_API_KEY: "parent-key" })).toEqual({ CLAUDE_CONFIG_DIR: profile.configDir });
  });

  test("removes T3 host-session variables but preserves HOME and authentication choices", () => {
    const sessionKeys = [
      "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_DESKTOP_APP_VERSION",
      "CLAUDE_EFFORT", "CLAUDE_PID", "CLAUDE_AGENT_SDK_VERSION",
    ];
    const base: Readonly<NodeJS.ProcessEnv> = Object.freeze({
      ...Object.fromEntries(sessionKeys.map((key) => [key, "parent-session"])),
      HOME: "/original/home", PATH: "/bin", CLAUDE_CONFIG_DIR: "/parent/config",
      ANTHROPIC_API_KEY: "test-key", ANTHROPIC_AUTH_TOKEN: "test-token",
      ANTHROPIC_BASE_URL: "https://example.invalid", CLAUDE_CODE_USE_BEDROCK: "1",
    });
    const profile = parseProfiles({ configDir: "personal" }, directory, {})[0]!;
    const environment = makeEnvironment(profile, base);
    for (const key of sessionKeys) expect(Object.hasOwn(environment, key)).toBe(false);
    expect(environment).toEqual({
      HOME: base.HOME, PATH: base.PATH, CLAUDE_CONFIG_DIR: profile.configDir,
      ANTHROPIC_API_KEY: base.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: base.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: base.ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(base.CLAUDE_CONFIG_DIR).toBe("/parent/config");
    expect(base.CLAUDECODE).toBe("parent-session");
  });

  test("concurrent profiles cannot change each other's environment or process.env", async () => {
    const before = { ...process.env };
    const profiles = parseProfiles({ profiles: { personal: { configDir: "personal" }, alternate: { configDir: "alternate" } } }, directory);
    const environments = await Promise.all(profiles.map(async (profile) => makeEnvironment(profile)));
    expect(environments.map((environment) => environment.CLAUDE_CONFIG_DIR)).toEqual(profiles.map((profile) => profile.configDir));
    environments[0]!.CLAUDE_CONFIG_DIR = "changed";
    expect(environments[1]!.CLAUDE_CONFIG_DIR).toBe(profiles[1]!.configDir);
    expect(process.env).toEqual(before);
  });
});
