import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FileDiff } from "@opencode/schema/file-diff";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import type { StructuredPatchHunk } from "diff";

const MAX_PATCH_BYTES = 256 * 1024;
const NO_NEWLINE = "\\ No newline at end of file";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hunks(value: unknown): StructuredPatchHunk[] | undefined {
  if (!Array.isArray(value)) return;
  const result: StructuredPatchHunk[] = [];
  let bytes = 0;
  for (const hunk of value) {
    bytes += 80;
    if (bytes > MAX_PATCH_BYTES) return;
    if (!object(hunk)) return;
    const { oldStart, oldLines, newStart, newLines, lines } = hunk;
    if (![oldStart, oldLines, newStart, newLines].every((n) =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
    ) || !Array.isArray(lines)) return;
    if ((oldStart === 0 && oldLines !== 0) || (newStart === 0 && newLines !== 0)) return;
    let oldCount = 0;
    let newCount = 0;
    let previous = "";
    for (const line of lines) {
      if (typeof line !== "string" || line.includes("\0") || line.includes("\n")) return;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > MAX_PATCH_BYTES) return;
      if (line === NO_NEWLINE) {
        if (!previous || previous === "\\") return;
      } else {
        if (line[0] !== " " && line[0] !== "+" && line[0] !== "-") return;
        if (line[0] !== "+") oldCount++;
        if (line[0] !== "-") newCount++;
      }
      previous = line[0];
    }
    if (oldCount !== oldLines || newCount !== newLines) return;
    result.push({ oldStart, oldLines, newStart, newLines, lines } as StructuredPatchHunk);
  }
  return result;
}

function changed(hunk: StructuredPatchHunk): boolean {
  const old: string[] = [];
  const next: string[] = [];
  let previous = "";
  for (const line of hunk.lines) {
    if (line === NO_NEWLINE) {
      if (previous !== "+") old[old.length - 1] = old[old.length - 1].slice(0, -1);
      if (previous !== "-") next[next.length - 1] = next[next.length - 1].slice(0, -1);
    } else {
      if (line[0] !== "+") old.push(line.slice(1) + "\n");
      if (line[0] !== "-") next.push(line.slice(1) + "\n");
    }
    previous = line[0];
  }
  return old.join("") !== next.join("");
}

export function nativeFileDiff(toolName: string, result: unknown, directory: string): FileDiff.Info | undefined {
  if (toolName !== "Edit" && toolName !== "Write") return;
  if (!object(result) || result.staged === true) return;
  if (typeof result.filePath !== "string" || !result.filePath.trim() || /[\0\r\n]/.test(result.filePath)) return;
  if (typeof directory !== "string" || !directory || directory.includes("\0")) return;
  for (const value of [result.originalFile, result.content]) {
    if (typeof value === "string" && value.includes("\0")) return;
  }
  if (toolName === "Write" && (result.type !== "create" && result.type !== "update")) return;
  if (toolName === "Write" && typeof result.content !== "string") return;
  let actualHunks = hunks(result.structuredPatch);
  if (!actualHunks) return;

  const absolute = resolve(directory, result.filePath);
  const local = relative(directory, absolute);
  const file = local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ? absolute : local;
  if (!file) return;
  const added = toolName === "Write" && result.type === "create";
  if (added && actualHunks.length === 0) {
    const content = result.content as string;
    if (Buffer.byteLength(content) > MAX_PATCH_BYTES) return;
    actualHunks = structuredPatch("/dev/null", file, "", content).hunks;
  }
  if (!actualHunks.some(changed)) return;
  const patch = formatPatch({
    oldFileName: added ? "/dev/null" : file,
    newFileName: file,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: actualHunks,
  }, FILE_HEADERS_ONLY);
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) return;
  let additions = 0;
  let deletions = 0;
  for (const hunk of actualHunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      if (line.startsWith("-")) deletions++;
    }
  }
  return { file, patch, additions, deletions, status: added ? "added" : "modified" };
}
