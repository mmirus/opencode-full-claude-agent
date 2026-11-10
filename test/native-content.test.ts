import { describe, expect, test } from "bun:test"
import { normalizeNativeContent } from "../src/native-content"

describe("normalizeNativeContent", () => {
  test.each([undefined, null])("normalizes absent content %j to empty text", (value) => {
    expect(normalizeNativeContent(value)).toBe("")
  })

  test.each([
    "",
    "command output\n\n  indentation\r\n雪🙂",
    '{"content":[{"type":"text","text":"do not unwrap"}],"isError":true}',
    '[{"type":"text","text":"do not parse"}]',
    "Error: permission denied\nPlease run /login",
    "a".repeat(100_000),
  ])("preserves ordinary string content without parsing or rewriting: %j", (value) => {
    expect(normalizeNativeContent(value)).toBe(value)
  })

  test("joins simple text blocks in order with newlines, retaining repeated and empty text", () => {
    expect(normalizeNativeContent([
      { type: "text", text: "first" },
      { text: "first", type: "text" },
      { type: "text", text: "" },
      { type: "text", text: "last\n" },
    ])).toBe("first\nfirst\n\nlast\n")
  })

  test("preserves single-block error messages as plain strings", () => {
    const message = "Error: command exited with code 1\n  details"
    expect(normalizeNativeContent([{ type: "text", text: message }])).toBe(message)
  })

  test("normalizes empty arrays and empty text blocks to empty text", () => {
    expect(normalizeNativeContent([])).toBe("")
    expect(normalizeNativeContent([{ type: "text", text: "" }])).toBe("")
    expect(normalizeNativeContent([{ type: "text", text: "" }, { type: "text", text: "" }])).toBe("\n")
  })

  test.each([
    [[{ type: "image", source: { type: "base64", data: "abc", media_type: "image/png" } }]],
    [[{ type: "text", text: "keep" }, { type: "image", source: { data: "abc" } }]],
    [[{ type: "text", text: "cited", citations: [{ url: "https://example.com" }] }]],
    [[{ type: "text", text: "annotated", extra: null }]],
    [[{ type: "text", text: "keep" }, { type: "text", text: 42 }]],
    [[{ type: "text" }]],
    [[{ text: "missing type" }]],
    [[null]],
    [["plain", "strings"]],
    [[[{ type: "text", text: "nested" }]]],
    [{ type: "text", text: "not an array" }],
    [{ content: [{ type: "text", text: "not an envelope to unwrap" }], isError: true }],
    [{ content: "nested", isError: false }],
    [false],
    [0],
    [42],
  ])("preserves JSON fallback without losing metadata or malformed blocks: %j", (value) => {
    expect(normalizeNativeContent(value)).toBe(value)
  })

  test("does not discard sparse or undefined array entries", () => {
    const sparse = new Array(1)
    const missing = [{ type: "text", text: "keep" }, undefined]
    expect(normalizeNativeContent(sparse)).toBe(sparse)
    expect<unknown>(normalizeNativeContent(missing)).toBe(missing)
  })
})
