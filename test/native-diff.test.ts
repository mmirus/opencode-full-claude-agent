import { describe, expect, test } from "bun:test";
import { applyPatch, FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import { nativeFileDiff } from "../src/native-diff";

const directory = "/synthetic/project";
const filePath = `${directory}/source.txt`;

function edit(before = "before\n", after = "after\n", extra: Record<string, unknown> = {}) {
  return {
    filePath,
    oldString: "proposed old text",
    newString: "proposed new text",
    originalFile: before,
    structuredPatch: structuredPatch(filePath, filePath, before, after).hunks,
    userModified: true,
    replaceAll: false,
    ...extra,
  };
}

function write(before: string, content: string, type: "create" | "update", extra: Record<string, unknown> = {}) {
  return { ...edit(before, content), type, content, originalFile: type === "create" ? null : before, ...extra };
}

describe("nativeFileDiff", () => {
  test("uses the authoritative Edit patch, not proposed strings or gitDiff", () => {
    const result = nativeFileDiff("Edit", edit("before\n", "accepted\n", {
      gitDiff: { additions: 999, deletions: 999, patch: "unrelated", status: "added" },
    }), directory)!;
    expect(result).toMatchObject({ file: "source.txt", additions: 1, deletions: 1, status: "modified" });
    expect(applyPatch("before\n", result.patch)).toBe("accepted\n");
    expect(result.patch).not.toContain("proposed");
    expect(result.patch).not.toContain("unrelated");
    expect(result.patch).toBe(formatPatch({
      oldFileName: "source.txt", newFileName: "source.txt", oldHeader: undefined, newHeader: undefined,
      hunks: edit("before\n", "accepted\n").structuredPatch,
    }, FILE_HEADERS_ONLY));
  });

  test("preserves multiple hunks and replaceAll counts", () => {
    const before = "old\n" + "context\n".repeat(15) + "old\n";
    const after = before.replaceAll("old", "new\nextra");
    const payload = edit(before, after, { replaceAll: true });
    expect(payload.structuredPatch.length).toBe(2);
    const result = nativeFileDiff("Edit", payload, directory)!;
    expect(result).toMatchObject({ additions: 4, deletions: 2, status: "modified" });
    expect(applyPatch(before, result.patch)).toBe(after);
  });

  test.each([
    ["old", "new"],
    ["old\n", "old"],
    ["old", "old\n"],
    ["one\r\ntwo\r\n", "one\r\nthree\r\n"],
    ["α\n", "雪🙂\n"],
    ["", "added\n"],
    ["removed\n", ""],
  ])("preserves line endings and text for %j -> %j", (before, after) => {
    const result = nativeFileDiff("Edit", edit(before, after), directory)!;
    expect(result.status).toBe("modified");
    expect(applyPatch(before, result.patch)).toBe(after);
    expect(Number.isSafeInteger(result.additions)).toBe(true);
    expect(Number.isSafeInteger(result.deletions)).toBe(true);
    expect(result.additions).toBeGreaterThanOrEqual(0);
    expect(result.deletions).toBeGreaterThanOrEqual(0);
  });

  test.each(["hello\n", "hello", "雪\r\n🙂\r\n"])("synthesizes create from actual content %j", (content) => {
    const result = nativeFileDiff("Write", write("", content, "create", { structuredPatch: [] }), directory)!;
    expect(result).toMatchObject({ file: "source.txt", status: "added", deletions: 0 });
    expect(result.patch).toContain("--- /dev/null\n");
    expect(applyPatch("", result.patch)).toBe(content);
  });

  test("formats a create with authoritative hunks using /dev/null", () => {
    const result = nativeFileDiff("Write", write("", "created\n", "create"), directory)!;
    expect(result).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(result.patch).toContain("--- /dev/null\n");
    expect(applyPatch("", result.patch)).toBe("created\n");
  });

  test("formats Write updates, including updates with unavailable originalFile", () => {
    const payload = write("before\n", "after\n", "update", { originalFile: null });
    const result = nativeFileDiff("Write", payload, directory)!;
    expect(result).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(result.patch).not.toContain("/dev/null");
    expect(applyPatch("before\n", result.patch)).toBe("after\n");
  });

  test.each([[], undefined, null].map((value) => [value] as const))("never treats an update without hunks as a create: %j", (structuredPatch) => {
    expect(nativeFileDiff("Write", write("before", "after", "update", { structuredPatch, originalFile: null }), directory)).toBeUndefined();
  });

  test.each([
    [filePath, "source.txt"],
    ["nested/path with spaces 雪.txt", "nested/path with spaces 雪.txt"],
    [`${directory}/nested/../source.txt`, "source.txt"],
    ["../outside.txt", "/synthetic/outside.txt"],
    ["/synthetic/project-other/file.txt", "/synthetic/project-other/file.txt"],
    ["/elsewhere/file.txt", "/elsewhere/file.txt"],
  ])("resolves %j to %j", (path, expected) => {
    const result = nativeFileDiff("Edit", edit("a\n", "b\n", { filePath: path }), directory)!;
    expect(result.file).toBe(expected);
    expect(result.patch).toContain(`+++ ${expected}\n`);
    expect(applyPatch("a\n", result.patch)).toBe("b\n");
  });

  test.each(["Read", "Bash", "MultiEdit", "edit", "mcp__custom__Edit"])("ignores unsupported tool %s", (tool) => {
    expect(nativeFileDiff(tool, edit(), directory)).toBeUndefined();
  });

  test.each([null, undefined, false, "text result", [], {}, { filePath }].map((value) => [value] as const))("ignores malformed payload %j", (payload) => {
    expect(nativeFileDiff("Edit", payload, directory)).toBeUndefined();
  });

  test.each([true, false])("skips staged Edit and Write results, regardless of userModified=%j", (userModified) => {
    expect(nativeFileDiff("Edit", edit("a", "b", { staged: true, userModified }), directory)).toBeUndefined();
    expect(nativeFileDiff("Write", write("", "created", "create", { staged: true, userModified }), directory)).toBeUndefined();
  });

  test("does not skip an applied result with staged:false", () => {
    expect(nativeFileDiff("Edit", edit("a", "b", { staged: false }), directory)).toBeDefined();
  });

  test("skips empty and no-change patches without reconstructing Edit content", () => {
    for (const structuredPatch of [[], undefined, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" same"] }]]) {
      expect(nativeFileDiff("Edit", edit("before", "after", { structuredPatch }), directory)).toBeUndefined();
    }
    expect(nativeFileDiff("Edit", edit("same", "same"), directory)).toBeUndefined();
    expect(nativeFileDiff("Edit", edit("same\n", "same\n", {
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-same", "+same"] }],
    }), directory)).toBeUndefined();
    expect(nativeFileDiff("Write", write("", "", "create", { structuredPatch: [] }), directory)).toBeUndefined();
  });

  test.each([
    null, {}, [null], [{}],
    [{ oldStart: -1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    [{ oldStart: 1, oldLines: 1.5, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    [{ oldStart: NaN, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    [{ oldStart: 0, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 1, lines: ["-a", "+b"] }],
    [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [1] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["a", "b"] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a\n", "+b"] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["\\ No newline at end of file", "-a", "+b"] }],
  ].map((value) => [value] as const))("rejects malformed structuredPatch %j", (structuredPatch) => {
    expect(nativeFileDiff("Edit", edit("a", "b", { structuredPatch }), directory)).toBeUndefined();
  });

  test.each(["", "\0bad", "file\nname", "file\rname", null, 42])("rejects invalid filePath %j", (filePath) => {
    expect(nativeFileDiff("Edit", edit("a", "b", { filePath }), directory)).toBeUndefined();
  });

  test("skips NUL in source content, written content, and hunks", () => {
    expect(nativeFileDiff("Edit", edit("a\0", "b"), directory)).toBeUndefined();
    expect(nativeFileDiff("Edit", edit("a", "b\0"), directory)).toBeUndefined();
    expect(nativeFileDiff("Write", write("", "b\0", "create", { structuredPatch: [] }), directory)).toBeUndefined();
  });

  test("caps both supplied and synthesized patches at 256 KiB in UTF-8 bytes", () => {
    for (const content of ["x".repeat(256 * 1024), "雪".repeat(100 * 1024)]) {
      expect(nativeFileDiff("Write", write("", content, "create", { structuredPatch: [] }), directory)).toBeUndefined();
      expect(nativeFileDiff("Edit", edit("a", content), directory)).toBeUndefined();
    }
    const result = nativeFileDiff("Write", write("", "x".repeat(240 * 1024), "create", { structuredPatch: [] }), directory)!;
    expect(result.status).toBe("added");
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(256 * 1024);
  });

  test("requires a valid Write type and actual content", () => {
    expect(nativeFileDiff("Write", write("a", "b", "update", { type: "other" }), directory)).toBeUndefined();
    expect(nativeFileDiff("Write", write("a", "b", "update", { content: undefined }), directory)).toBeUndefined();
    expect(nativeFileDiff("Write", write("", "b", "create", { structuredPatch: undefined }), directory)).toBeUndefined();
  });
});
