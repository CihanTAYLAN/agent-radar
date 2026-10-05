import { describe, expect, it } from "vitest";
import { intraLine, lineDiff, parsePatch } from "../public/diff.js";

const kinds = (s: string, t: string, o?: { context?: number; maxCells?: number }) => lineDiff(s, t, o).rows.map((r) => (r.k === "gap" ? `gap${r.n}` : `${r.k}:${r.t}`));

describe("lineDiff", () => {
  it("keeps unchanged lines in the middle as context instead of delete+re-add", () => {
    const old = ["a", "b", "c", "d", "e"].join("\n");
    const neu = ["a", "B", "c", "d", "E"].join("\n");
    expect(kinds(old, neu, { context: 1 })).toEqual(["ctx:a", "del:b", "add:B", "ctx:c", "ctx:d", "del:e", "add:E"]);
    expect(lineDiff(old, neu)).toMatchObject({ add: 2, del: 2 });
  });

  it("folds long unchanged runs into gaps with context around changes", () => {
    const base = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const neu = [...base];
    neu[10] = "changed";
    expect(kinds(base.join("\n"), neu.join("\n"), { context: 2 })).toEqual(["gap8", "ctx:l8", "ctx:l9", "del:l10", "add:changed", "ctx:l11", "ctx:l12", "gap7"]);
  });

  it("handles pure insertions, deletions and empty sides", () => {
    expect(kinds("", "x\ny")).toEqual(["add:x", "add:y"]);
    expect(kinds("x\ny", "")).toEqual(["del:x", "del:y"]);
    expect(kinds("a\nc", "a\nb\nc")).toEqual(["ctx:a", "add:b", "ctx:c"]);
    expect(lineDiff("", "")).toEqual({ rows: [], add: 0, del: 0 });
  });

  it("falls back to delete-then-add when the middle is too large for LCS", () => {
    expect(kinds("a\nb", "b\na", { maxCells: 1 })).toEqual(["del:a", "del:b", "add:b", "add:a"]);
  });

  it("marks the changed part of 1:1 replaced lines", () => {
    const r = lineDiff("const x = 1;", "const x = 42;").rows;
    expect(r[0]).toEqual({ k: "del", t: "const x = 1;", segs: [{ t: "const x = " }, { t: "1", hl: true }, { t: ";" }] });
    expect(r[1]).toEqual({ k: "add", t: "const x = 42;", segs: [{ t: "const x = " }, { t: "42", hl: true }, { t: ";" }] });
  });
});

describe("intraLine", () => {
  it("skips unrelated lines", () => {
    expect(intraLine("completely different", "nothing alike here")).toBeNull();
  });
});

describe("parsePatch", () => {
  it("splits an apply_patch body into files with +/- rows and counts", () => {
    const p = parsePatch("*** Begin Patch\n*** Update File: /w/a.ts\n@@ fn()\n ctx\n-old\n+new\n*** Add File: /w/b.ts\n+x\n+y\n*** Delete File: /w/c.ts\n*** End Patch");
    expect(p.add).toBe(3);
    expect(p.del).toBe(1);
    expect(p.files.map((f) => [f.op, f.path, f.add, f.del])).toEqual([["update", "/w/a.ts", 1, 1], ["add", "/w/b.ts", 2, 0], ["delete", "/w/c.ts", 0, 0]]);
    expect(p.files[0]?.rows).toEqual([{ k: "hunk", t: "fn()" }, { k: "ctx", t: "ctx" }, { k: "del", t: "old" }, { k: "add", t: "new" }]);
  });
  it("never throws on junk", () => {
    expect(parsePatch("not a patch").files).toEqual([]);
    expect(parsePatch("").add).toBe(0);
  });
});
