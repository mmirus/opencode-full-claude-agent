import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Profile {
  id: string;
  name: string;
  configDir: string;
  binaryPath?: string;
  plugins: string[];
  models?: string[];
  env?: Record<string, string | null>;
}

const profileKeys = ["configDir", "binaryPath", "plugins", "models", "env"];
const hostSessionVariables = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error(`${label} contains an unknown option`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty string without NUL characters`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  return Array.from(value, (entry) => text(entry, label));
}

export function parseProfiles(
  options: Record<string, unknown>,
  baseDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Profile[] {
  text(baseDirectory, "baseDirectory");
  const root = object(options, "options");
  const path = (value: unknown, label: string): string => {
    const input = text(value, label);
    const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
    return resolve(baseDirectory, expanded);
  };

  const parse = (value: unknown, key?: string): Profile => {
    const label = key === undefined ? "options" : `profiles.${key}`;
    const settings = object(value, label);
    keys(settings, key === undefined ? profileKeys : [...profileKeys, "name"], label);
    const configDir = path(
      Object.hasOwn(settings, "configDir") ? settings.configDir : env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      `${label}.configDir`,
    );
    let binaryPath = "claude";
    if (Object.hasOwn(settings, "binaryPath")) {
      const binary = text(settings.binaryPath, `${label}.binaryPath`);
      binaryPath = binary.includes("/") || binary === "~" || binary === "." || binary === ".."
        ? path(binary, `${label}.binaryPath`)
        : binary;
    }
    const plugins = Object.hasOwn(settings, "plugins") ? strings(settings.plugins, `${label}.plugins`) : [];
    const resolvedPlugins = plugins.map((plugin, index) => {
      const pluginLabel = `${label}.plugins[${index}]`;
      const directory = path(plugin, pluginLabel);
      try {
        if (!statSync(directory).isDirectory()) throw new Error();
        const manifest = object(JSON.parse(readFileSync(join(directory, ".claude-plugin", "plugin.json"), "utf8")), "manifest");
        text(manifest.name, "manifest.name");
      } catch {
        throw new Error(`${pluginLabel} must be a directory with a valid .claude-plugin/plugin.json containing a name`);
      }
      return directory;
    });
    const models = Object.hasOwn(settings, "models") ? strings(settings.models, `${label}.models`) : undefined;
    if (models?.length === 0) throw new Error(`${label}.models must not be empty`);
    let profileEnvironment: Record<string, string | null> | undefined;
    if (Object.hasOwn(settings, "env")) {
      const overrides = object(settings.env, `${label}.env`);
      for (const name of Reflect.ownKeys(overrides)) {
        if (typeof name !== "string" || name.trim().length === 0 || name.includes("=") || name.includes("\0")) {
          throw new Error(`${label}.env names must be nonempty strings without '=' or NUL characters`);
        }
        if (overrides[name] !== null && typeof overrides[name] !== "string") {
          throw new Error(`${label}.env values must be strings or null`);
        }
      }
      profileEnvironment = Object.fromEntries(Object.entries(overrides)) as Record<string, string | null>;
    }
    return {
      id: key === undefined ? "full-claude-agent" : `full-claude-agent-${key}`,
      name: Object.hasOwn(settings, "name") ? text(settings.name, `${label}.name`) : key === undefined ? "Full Claude Agent" : `Full Claude Agent (${key})`,
      configDir,
      binaryPath,
      plugins: resolvedPlugins,
      ...(models === undefined ? {} : { models }),
      ...(profileEnvironment === undefined ? {} : { env: profileEnvironment }),
    };
  };

  if (!Object.hasOwn(root, "profiles")) return [parse(root)];
  keys(root, ["profiles"], "options");
  const profiles = object(root.profiles, "profiles");
  const entries = Object.entries(profiles);
  if (entries.length === 0) throw new Error("profiles must not be empty");
  if (Reflect.ownKeys(profiles).some((key) => typeof key !== "string" || !/^[a-z][a-z0-9-]*$/.test(key))) {
    throw new Error("Profile IDs must match /^[a-z][a-z0-9-]*$/");
  }
  return entries.map(([key, value]) => parse(value, key));
}

/** API credentials remain inherited unless profile.env overrides or removes them; inherited credentials can select API billing. */
export function makeEnvironment(
  profile: Profile,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [name, value] of Object.entries(profile.env ?? {})) {
    if (value === null) delete environment[name];
    else Object.defineProperty(environment, name, { value, enumerable: true, writable: true, configurable: true });
  }
  environment.CLAUDE_CONFIG_DIR = profile.configDir;
  for (const key of hostSessionVariables) delete environment[key];
  return environment;
}
