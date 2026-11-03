import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { accountProbeOutput, parseAccountProbeArgs } from "../scripts/support/accounts.js"

describe("account probe arguments", () => {
  test("keeps identity private by default", () => {
    expect(parseAccountProbeArgs(["/synthetic/first", "/synthetic/second"])).toEqual({
      directories: ["/synthetic/first", "/synthetic/second"], showIdentity: false,
    })
  })

  test("accepts the explicit flag before or after directories", () => {
    for (const args of [["--show-identity", "/synthetic/first"], ["/synthetic/first", "--show-identity"]]) {
      expect(parseAccountProbeArgs(args)).toEqual({ directories: ["/synthetic/first"], showIdentity: true })
    }
  })

  test("requires directories and rejects unknown options without echoing arguments", () => {
    for (const args of [[], ["--show-identity"], ["--"], ["--show-identity=false", "/synthetic/first"], ["--token=synthetic-secret"]]) {
      expect(() => parseAccountProbeArgs(args)).toThrow("Usage: bun run scripts/probe-accounts.ts [--show-identity]")
      try { parseAccountProbeArgs(args) } catch (error) {
        expect(String(error)).not.toContain("synthetic-secret")
      }
    }
  })

  test("treats arguments after -- as directories, not opt-in flags", () => {
    expect(parseAccountProbeArgs(["--", "--show-identity"])).toEqual({ directories: ["--show-identity"], showIdentity: false })
  })
})

describe("account probe output", () => {
  const account = {
    email: "synthetic@example.invalid", organization: "Synthetic Organization",
    apiProvider: "firstParty" as const, subscriptionType: "team", apiKeySource: "user",
    tokenSource: "synthetic-token-source", accessToken: "synthetic-access-token",
    refreshToken: "synthetic-refresh-token", apiKey: "synthetic-api-key", credentials: "synthetic-credentials",
  }

  test("preserves metadata and the existing hash without emitting identity by default", () => {
    const output = accountProbeOutput("/synthetic/first", "synthetic-version", account, false)
    expect(output).toEqual({
      configDir: "/synthetic/first", version: "synthetic-version", backend: "firstParty",
      subscription: "team", apiKeySource: "user",
      identityHash: createHash("sha256").update(JSON.stringify([account.email, account.organization])).digest("hex").slice(0, 16),
    })
    expect(JSON.stringify(output)).not.toContain(account.email)
    expect(JSON.stringify(output)).not.toContain(account.organization)
  })

  test("adds only SDK email and organization when opted in, retaining metadata", () => {
    expect(accountProbeOutput("/synthetic/first", "synthetic-version", account, true)).toEqual({
      ...accountProbeOutput("/synthetic/first", "synthetic-version", account, false),
      email: account.email, organization: account.organization,
    })
  })

  test("never forwards token or credential fields in either mode", () => {
    for (const showIdentity of [false, true]) {
      const serialized = JSON.stringify(accountProbeOutput("/synthetic/first", "synthetic-version", account, showIdentity))
      for (const secret of [account.tokenSource, account.accessToken, account.refreshToken, account.apiKey, account.credentials]) {
        expect(serialized).not.toContain(secret)
      }
    }
  })

  test("does not invent missing identity fields or hashes", () => {
    const output = JSON.parse(JSON.stringify(accountProbeOutput(undefined, "synthetic-version", { apiProvider: "bedrock" }, true)))
    expect(output).toEqual({ version: "synthetic-version", backend: "bedrock" })
  })

  test("organization participates in the hash", () => {
    expect(accountProbeOutput(undefined, "v", account, false).identityHash).not.toBe(
      accountProbeOutput(undefined, "v", { ...account, organization: "Other Synthetic Organization" }, false).identityHash,
    )
  })
})
