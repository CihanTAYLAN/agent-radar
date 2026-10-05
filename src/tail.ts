/**
 * Incremental, strictly read-only JSONL reading by byte offset.
 * Only complete (newline-terminated) lines are ever returned; a partial last line
 * stays unread until its newline shows up, so an in-flight append is never mis-parsed.
 */
import { open, stat } from "node:fs/promises";

const NL = 0x0a;

export interface ReadResult {
  /** Complete lines (without the trailing newline / CR). */
  lines: string[];
  /** Byte offset just after the last complete line returned (or the previous offset). */
  offset: number;
  /** File size observed at read time. */
  size: number;
  /** True when the file shrank below the caller's offset and reading restarted at 0. */
  reset: boolean;
  /** True when more complete data may remain beyond this chunk. */
  more: boolean;
}

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 256 * 1024 * 1024;

function splitLines(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Read complete lines from `offset` (up to ~maxBytes). Never throws for a missing file: returns empty. */
export async function readNewLines(path: string, offset: number, maxBytes = DEFAULT_CHUNK): Promise<ReadResult> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { lines: [], offset, size: 0, reset: false, more: false };
  }
  let reset = false;
  let start = offset;
  if (size < start) {
    start = 0;
    reset = true;
  }
  if (size === start) return { lines: [], offset: start, size, reset, more: false };

  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return { lines: [], offset: start, size, reset, more: false };
  }
  try {
    let want = maxBytes;
    for (;;) {
      const len = Math.min(want, size - start);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      const chunk = buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(NL);
      if (lastNl >= 0) {
        const complete = chunk.subarray(0, lastNl);
        return {
          lines: splitLines(complete),
          offset: start + lastNl + 1,
          size,
          reset,
          more: start + lastNl + 1 < size,
        };
      }
      // No newline in the window: either a partial last line (wait) or a very long line (widen window).
      if (start + len >= size || want >= MAX_LINE) {
        return { lines: [], offset: start, size, reset, more: false };
      }
      want *= 2;
    }
  } finally {
    await fh.close();
  }
}

export interface TailResult {
  lines: string[];
  /** Cursor to continue from with readNewLines. */
  offset: number;
  /** Byte offset of the first returned line (page older data with `end = start`). */
  start: number;
  size: number;
  /** True if the returned window begins at the start of the file. */
  complete: boolean;
}

/**
 * Read roughly the last `maxBytes` of the file as complete lines. With `end`, read the window that
 * ends at byte `end` instead of the end of file (used to page backwards; `end` should be a line start).
 */
export async function readTailLines(path: string, maxBytes: number, end?: number): Promise<TailResult> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { lines: [], offset: 0, start: 0, size: 0, complete: true };
  }
  const stop = end === undefined ? size : Math.max(0, Math.min(end, size));
  if (stop === 0) return { lines: [], offset: 0, start: 0, size, complete: true };
  const start = Math.max(0, stop - maxBytes);
  const fh = await open(path, "r");
  try {
    const len = stop - start;
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    let chunk = buf.subarray(0, bytesRead);
    const lastNl = chunk.lastIndexOf(NL);
    if (lastNl < 0) return { lines: [], offset: start === 0 ? 0 : stop, start: stop, size, complete: start === 0 };
    const endOffset = start + lastNl + 1;
    chunk = chunk.subarray(0, lastNl);
    let complete = true;
    let first = start;
    if (start > 0) {
      // Drop the first (probably partial) line.
      const firstNl = chunk.indexOf(NL);
      complete = false;
      first = firstNl < 0 ? endOffset : start + firstNl + 1;
      chunk = firstNl < 0 ? chunk.subarray(chunk.length) : chunk.subarray(firstNl + 1);
    }
    return { lines: splitLines(chunk), offset: endOffset, start: first, size, complete };
  } finally {
    await fh.close();
  }
}
