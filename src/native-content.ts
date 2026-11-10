import type { JSONValue } from "@ai-sdk/provider"

export function normalizeNativeContent(value: unknown): NonNullable<JSONValue> {
  if (value === undefined || value === null) return ""
  if (!Array.isArray(value)) return value as NonNullable<JSONValue>

  const text: string[] = []
  for (const block of value) {
    if (
      block === null || typeof block !== "object" || Array.isArray(block) ||
      Object.keys(block).length !== 2 ||
      !Object.hasOwn(block, "type") || !Object.hasOwn(block, "text") ||
      block.type !== "text" || typeof block.text !== "string"
    ) return value as NonNullable<JSONValue>
    text.push(block.text)
  }
  return text.join("\n")
}
