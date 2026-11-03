import { query } from "@anthropic-ai/claude-agent-sdk"
import { makeEnvironment, parseProfiles } from "../src/config.js"
import { accountProbeOutput, parseAccountProbeArgs } from "./support/accounts.js"
import { createTempDirectory } from "./support/temp.js"

const { directories, showIdentity } = parseAccountProbeArgs(process.argv.slice(2))
const cwd = createTempDirectory("full-claude-probe-")
const identities = await Promise.all(directories.map(async (directory) => {
  const profile = parseProfiles({ configDir: directory }, cwd)[0]!
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), 30_000)
  const native = query({ prompt: new ReadableStream(), options: {
    cwd, env: makeEnvironment(profile), pathToClaudeCodeExecutable: profile.binaryPath,
    settingSources: ["user", "project", "local"], persistSession: false, abortController,
  } })
  try {
    const initialized = await native.initializationResult()
    const account = await native.accountInfo()
    const output = accountProbeOutput(profile.configDir, initialized.claude_code_version, account, showIdentity)
    console.log(JSON.stringify(output))
    return output.identityHash
  } finally { clearTimeout(timer); native.close() }
}))
console.log(JSON.stringify({ accountIdentitiesAvailable: identities.every(Boolean), distinctAccounts: identities.every(Boolean) ? new Set(identities).size === identities.length : undefined }))
