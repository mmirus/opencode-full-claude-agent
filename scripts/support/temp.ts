import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function createTempDirectory(prefix: string): string {
  const parent = resolve(process.env.FULL_CLAUDE_TEMP_DIR ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}
