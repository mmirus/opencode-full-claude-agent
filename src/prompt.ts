import { createHash } from "node:crypto"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
type Content = SDKUserMessage["message"]["content"]

export function userFingerprints(prompt: LanguageModelV3Prompt): string[] {
  return prompt.filter((message) => message.role === "user").map(digest)
}

export function newContent(prompt: LanguageModelV3Prompt, previous: string[]): Content {
  const users = prompt.filter((message) => message.role === "user")
  const hashes = users.map(digest)
  if (previous.some((hash, index) => hashes[index] !== hash)) {
    throw new Error("Full Claude Agent cannot resume edited or compacted history. Start a new session.")
  }
  const remaining = users.slice(previous.length)
  if (!remaining.length) throw new Error("Full Claude Agent will not replay an already submitted prompt.")
  const blocks: Array<Exclude<Content, string>[number]> = []
  if (previous.length === 0) {
    const firstUser = prompt.findIndex((message) => message.role === "user")
    if (firstUser > 0 && prompt.slice(0, firstUser).some((message) => message.role !== "system")) {
      throw new Error("Full Claude Agent requires a new conversation; importing another runtime's history is not supported.")
    }
    if (prompt.some((message) => message.role === "assistant" || message.role === "tool")) {
      throw new Error("Start a new session to use Full Claude Agent; existing conversation import is not supported.")
    }
  }
  for (const message of remaining) {
    for (const part of message.content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text })
      else if (part.type === "file") {
        const mime = part.mediaType
        if (!["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
          throw new Error(`Full Claude Agent does not support attachment type ${mime}`)
        }
        const data = part.data instanceof Uint8Array ? Buffer.from(part.data).toString("base64") : part.data
        if (data instanceof URL) {
          if (mime === "application/pdf") blocks.push({ type: "document", source: { type: "url", url: data.href } })
          else blocks.push({ type: "image", source: { type: "url", url: data.href } })
        } else if (mime === "application/pdf") {
          blocks.push({ type: "document", source: { type: "base64", media_type: mime, data } })
        } else if (mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp") {
          blocks.push({ type: "image", source: { type: "base64", media_type: mime, data } })
        } else throw new Error(`Full Claude Agent does not support attachment type ${mime}`)
      }
    }
  }
  return blocks
}

export interface HistoryEntry { id: string; type: string; [key: string]: unknown }

export function historyBoundary(history: readonly HistoryEntry[]): string[] {
  return history
    .filter((message) => message.type !== "assistant" || message.finish !== undefined || message.error !== undefined ||
      (typeof message.time === "object" && message.time !== null && "completed" in message.time && message.time.completed !== undefined))
    .map(digest)
}

export function assertHistory(history: readonly HistoryEntry[], boundary: string[]) {
  const current = historyBoundary(history)
  if (boundary.some((hash, index) => current[index] !== hash)) {
    throw new Error("Full Claude Agent history changed before its saved boundary. Forks, rewind, and OpenCode compaction require a new session.")
  }
}
