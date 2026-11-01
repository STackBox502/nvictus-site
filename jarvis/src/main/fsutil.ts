import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** Atomic write: write a temp file next to the target, then rename over it. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Reads JSON; a missing file returns undefined; a corrupt file is moved aside and returns undefined. */
export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return undefined;
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}
