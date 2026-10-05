import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNewLines, readTailLines } from "../src/tail.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "radar-tail-"));
  file = join(dir, "t.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readNewLines", () => {
  it("returns only complete lines and leaves a partial last line for later", async () => {
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":');
    const r1 = await readNewLines(file, 0);
    expect(r1.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r1.offset).toBe('{"a":1}\n{"b":2}\n'.length);

    await appendFile(file, "3}\n");
    const r2 = await readNewLines(file, r1.offset);
    expect(r2.lines).toEqual(['{"c":3}']);
    expect(r2.more).toBe(false);
  });

  it("reads only what was appended (byte-offset tailing)", async () => {
    await writeFile(file, "one\ntwo\n");
    const r1 = await readNewLines(file, 0);
    await appendFile(file, "three\n");
    const r2 = await readNewLines(file, r1.offset);
    expect(r2.lines).toEqual(["three"]);
    const r3 = await readNewLines(file, r2.offset);
    expect(r3.lines).toEqual([]);
  });

  it("handles multi-byte characters and CRLF", async () => {
    await writeFile(file, "çağrı \u{1F680}\r\nsecond\n");
    const r = await readNewLines(file, 0);
    expect(r.lines).toEqual(["çağrı \u{1F680}", "second"]);
  });

  it("restarts from 0 when the file shrank", async () => {
    await writeFile(file, "aaaaaaaa\n");
    const r1 = await readNewLines(file, 0);
    await writeFile(file, "b\n");
    const r2 = await readNewLines(file, r1.offset);
    expect(r2.reset).toBe(true);
    expect(r2.lines).toEqual(["b"]);
  });

  it("paginates with maxBytes and reports more", async () => {
    await writeFile(file, "aaaa\nbbbb\ncccc\n");
    const r1 = await readNewLines(file, 0, 10);
    expect(r1.lines).toEqual(["aaaa", "bbbb"]);
    expect(r1.more).toBe(true);
    const r2 = await readNewLines(file, r1.offset, 10);
    expect(r2.lines).toEqual(["cccc"]);
    expect(r2.more).toBe(false);
  });

  it("widens the window for a single line larger than maxBytes", async () => {
    const big = "x".repeat(100);
    await writeFile(file, `${big}\nnext\n`);
    const r = await readNewLines(file, 0, 16);
    expect(r.lines[0]).toBe(big);
  });

  it("returns empty for a missing file instead of throwing", async () => {
    const r = await readNewLines(join(dir, "nope.jsonl"), 0);
    expect(r.lines).toEqual([]);
  });
});

describe("readTailLines", () => {
  it("drops the partial first line when starting mid-file and reports incompleteness", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
    await writeFile(file, lines.join("\n") + "\n");
    const t = await readTailLines(file, 40);
    expect(t.complete).toBe(false);
    expect(t.lines.length).toBeGreaterThan(0);
    expect(t.lines.at(-1)).toBe("line-049");
    for (const l of t.lines) expect(l).toMatch(/^line-\d{3}$/);
  });

  it("returns everything when the window covers the file, and ignores an unterminated tail", async () => {
    await writeFile(file, "a\nb\npartial");
    const t = await readTailLines(file, 1000);
    expect(t.complete).toBe(true);
    expect(t.lines).toEqual(["a", "b"]);
    expect(t.offset).toBe(4);
  });
});
