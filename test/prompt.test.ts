import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { assertHistory, historyBoundary, newContent, userFingerprints, type HistoryEntry } from "../src/prompt"

const user = (text: string): LanguageModelV3Prompt[number] => ({ role: "user", content: [{ type: "text", text }] })

describe("newContent", () => {
  test("submits only new users, excluding system instructions and historical assistant/tool messages", () => {
    const first: LanguageModelV3Prompt = [{ role: "system", content: "host instructions" }, user("first")]
    expect(newContent(first, [])).toEqual([{ type: "text", text: "first" }])
    const continued: LanguageModelV3Prompt = [...first,
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "Read", output: { type: "text", value: "file" } }] },
      user("second"), user("third")]
    expect(newContent(continued, userFingerprints(first))).toEqual([
      { type: "text", text: "second" }, { type: "text", text: "third" },
    ])
  })

  test("rejects replay, changed users, removed users, and imported conversations", () => {
    const previous = userFingerprints([user("first"), user("second")])
    expect(() => newContent([user("first"), user("second")], previous)).toThrow("already submitted")
    expect(() => newContent([user("edited"), user("second"), user("third")], previous)).toThrow("edited or compacted")
    expect(() => newContent([user("first")], previous)).toThrow("edited or compacted")
    const assistant: LanguageModelV3Prompt[number] = { role: "assistant", content: [{ type: "text", text: "old" }] }
    expect(() => newContent([assistant, user("new")], [])).toThrow("importing")
    expect(() => newContent([user("old"), assistant, user("new")], [])).toThrow("import")
  })

  test("converts binary and base64 image/PDF attachments without changing text order", () => {
    const prompt: LanguageModelV3Prompt = [{ role: "user", content: [
      { type: "text", text: "inspect" },
      ...["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].map((mediaType) => ({
        type: "file" as const, mediaType, data: new Uint8Array([0, 1, 255]),
      })),
      { type: "file", mediaType: "image/png", data: "YWJj" },
    ] }]
    expect(newContent(prompt, [])).toEqual([
      { type: "text", text: "inspect" },
      ...(["image/png", "image/jpeg", "image/gif", "image/webp"] as const).map((media_type) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type, data: "AAH/" },
      })),
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAH/" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
    ])
  })

  test("preserves image and PDF URLs", () => {
    expect(newContent([{ role: "user", content: [
      { type: "file", mediaType: "image/png", data: new URL("https://example.com/a.png") },
      { type: "file", mediaType: "application/pdf", data: new URL("https://example.com/a.pdf") },
    ] }], [])).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      { type: "document", source: { type: "url", url: "https://example.com/a.pdf" } },
    ])
  })

  test("rejects unsupported inline attachments", () => {
    expect(() => newContent([{ role: "user", content: [
      { type: "file", mediaType: "text/plain", data: "aGVsbG8=" },
    ] }], [])).toThrow("text/plain")
  })

  test("rejects unsupported URL attachments rather than labeling them as images", () => {
    expect(() => newContent([{ role: "user", content: [
      { type: "file", mediaType: "text/plain", data: new URL("https://example.com/file.txt") },
    ] }], [])).toThrow("text/plain")
  })
})

describe("history boundary", () => {
  const history: HistoryEntry[] = [
    { id: "u", type: "user", content: "question" },
    { id: "a", type: "assistant", finish: "stop", content: "answer" },
    { id: "t", type: "tool", result: { text: "original" } },
  ]

  test("allows appended history and ignores unfinished assistant messages", () => {
    const boundary = historyBoundary(history)
    expect(historyBoundary([...history, { id: "pending", type: "assistant", content: "streaming" }])).toEqual(boundary)
    expect(() => assertHistory([...history, { id: "next", type: "user", content: "next" }], boundary)).not.toThrow()
  })

  test.each([0, 1, 2])("detects changed persisted history entry %i", (index) => {
    const edited = structuredClone(history)
    edited[index] = { ...edited[index]!, content: "edited", result: "edited" }
    expect(() => assertHistory(edited, historyBoundary(history))).toThrow("saved boundary")
  })

  test("rejects deleted and reordered history", () => {
    expect(() => assertHistory(history.slice(1), historyBoundary(history))).toThrow("saved boundary")
    expect(() => assertHistory([...history].reverse(), historyBoundary(history))).toThrow("saved boundary")
  })

  test("protects interrupted assistant tool results even without a finish reason", () => {
    const interrupted = { id: "interrupted", type: "assistant", error: { type: "aborted" }, content: [{ type: "tool", result: "written" }] }
    const boundary = historyBoundary([...history, interrupted])
    expect(boundary).toHaveLength(history.length + 1)
    expect(() => assertHistory([...history, { ...interrupted, content: [] }], boundary)).toThrow("saved boundary")
  })
})
