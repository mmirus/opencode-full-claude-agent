import { inspectNativeSession, NativeSessionError } from "./support/native-session.js"

const usage = "Usage: bun scripts/inspect-native-session.ts <ses_id> [--database PATH] [--config-dir PATH] [--tail N]"

export function parseNativeSessionArgs(args: string[]) {
  const hostSessionID = args[0]
  if (!hostSessionID || hostSessionID.startsWith("--")) throw new NativeSessionError("INVALID_ARGUMENT", usage)
  const options: { hostSessionID: string; database?: string; configDir?: string; tail?: number } = { hostSessionID }
  const seen = new Set<string>()
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]!
    const value = args[index + 1]
    if (!["--database", "--config-dir", "--tail"].includes(flag) || !value || value.startsWith("--") || seen.has(flag)) {
      throw new NativeSessionError("INVALID_ARGUMENT", usage)
    }
    seen.add(flag)
    if (flag === "--database") options.database = value
    if (flag === "--config-dir") options.configDir = value
    if (flag === "--tail") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) {
        throw new NativeSessionError("INVALID_TAIL", "--tail must be an integer from 1 to 200.")
      }
      options.tail = Number(value)
    }
  }
  return options
}

async function databasePath() {
  // `debug paths db` reads CLI paths without discovering or starting the host service.
  try {
    const child = Bun.spawn(["opencode", "debug", "paths", "db"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exitCode === 0 && stdout.trim() && !stdout.trim().includes("\n")) return stdout.trim()
  } catch {
    throw new NativeSessionError("DATABASE_PATH", "Cannot determine the OpenCode database path. Supply --database explicitly.")
  }
  throw new NativeSessionError("DATABASE_PATH", "Cannot determine the OpenCode database path. Supply --database explicitly.")
}

if (import.meta.main) {
  try {
    const options = parseNativeSessionArgs(Bun.argv.slice(2))
    const result = await inspectNativeSession({ ...options, database: options.database ?? await databasePath() })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof NativeSessionError ? error.code : "INSPECTION_FAILED",
      message: error instanceof NativeSessionError ? error.message : "Cannot inspect native session files." }))
    process.exitCode = 1
  }
}
