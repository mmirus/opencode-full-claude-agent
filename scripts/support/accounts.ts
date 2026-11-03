import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"
import { createHash } from "node:crypto"

export const accountProbeUsage = "Usage: bun run scripts/probe-accounts.ts [--show-identity] <config-dir> [<other-config-dir> ...]"

export function parseAccountProbeArgs(args: string[]) {
  const directories: string[] = []
  let showIdentity = false
  let positionalOnly = false
  for (const arg of args) {
    if (!positionalOnly && arg === "--") positionalOnly = true
    else if (!positionalOnly && arg === "--show-identity") showIdentity = true
    else if (!positionalOnly && arg.startsWith("-")) throw new Error(accountProbeUsage)
    else directories.push(arg)
  }
  if (!directories.length) throw new Error(accountProbeUsage)
  return { directories, showIdentity }
}

export function accountProbeOutput(configDir: string | undefined, version: string | undefined, account: AccountInfo, showIdentity: boolean) {
  const identityHash = account.email
    ? createHash("sha256").update(JSON.stringify([account.email, account.organization])).digest("hex").slice(0, 16)
    : undefined
  return {
    configDir, version, backend: account.apiProvider, subscription: account.subscriptionType,
    apiKeySource: account.apiKeySource, identityHash,
    ...(showIdentity ? { email: account.email, organization: account.organization } : {}),
  }
}
