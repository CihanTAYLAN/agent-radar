// Line diff for Edit tool cards. Pure functions (no DOM) so the test suite can import them.
// LCS on the changed middle (common prefix/suffix lines trimmed first), unchanged runs folded to a few
// context lines, and 1:1 replaced line pairs get their differing middle marked for highlighting.

/**
 * @typedef {{ t: string, hl?: boolean }} Seg
 * @typedef {{ k: "ctx" | "del" | "add", t: string, segs?: Seg[] } | { k: "gap", n: number }} DiffRow
 */

/**
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} maxCells
 * @returns {Array<["eq" | "del" | "add", string]>}
 */
function lcsOps(a, b, maxCells) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((t) => ["add", t]);
  if (m === 0) return a.map((t) => ["del", t]);
  if (n * m > maxCells) return [...a.map((t) => /** @type {["del", string]} */ (["del", t])), ...b.map((t) => /** @type {["add", string]} */ (["add", t]))];
  // dp[i][j] = LCS length of a[i..] and b[j..], flattened.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? (dp[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
    }
  }
  /** @type {Array<["eq" | "del" | "add", string]>} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(["eq", a[i] ?? ""]);
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) ops.push(["del", a[i++] ?? ""]);
    else ops.push(["add", b[j++] ?? ""]);
  }
  while (i < n) ops.push(["del", a[i++] ?? ""]);
  while (j < m) ops.push(["add", b[j++] ?? ""]);
  return ops;
}

/**
 * Mark the differing middle of a replaced line (common prefix/suffix stay plain).
 * @param {string} x
 * @param {string} y
 * @returns {[Seg[], Seg[]] | null}
 */
export function intraLine(x, y) {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  // Only worth it when the lines are clearly related.
  if (p + s < 3 || p + s < Math.min(x.length, y.length) * 0.3) return null;
  const seg = (/** @type {string} */ t) => {
    /** @type {Seg[]} */
    const out = [];
    if (p) out.push({ t: t.slice(0, p) });
    const mid = t.slice(p, t.length - s);
    if (mid) out.push({ t: mid, hl: true });
    if (s) out.push({ t: t.slice(t.length - s) });
    return out;
  };
  return [seg(x), seg(y)];
}

/**
 * @param {string} oldS
 * @param {string} newS
 * @param {{ context?: number, maxCells?: number }} [opts]
 * @returns {{ rows: DiffRow[], add: number, del: number }}
 */
export function lineDiff(oldS, newS, opts = {}) {
  const context = opts.context ?? 2;
  const maxCells = opts.maxCells ?? 250_000;
  const a = oldS === "" ? [] : oldS.split("\n");
  const b = newS === "" ? [] : newS.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  /** @type {Array<["eq" | "del" | "add", string]>} */
  const ops = [
    ...a.slice(0, pre).map((t) => /** @type {["eq", string]} */ (["eq", t])),
    ...lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), maxCells),
    ...a.slice(a.length - suf).map((t) => /** @type {["eq", string]} */ (["eq", t])),
  ];

  let add = 0;
  let del = 0;
  /** @type {DiffRow[]} */
  const rows = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (!op) break;
    if (op[0] === "eq") {
      let e = k;
      while (e < ops.length && ops[e]?.[0] === "eq") e++;
      const run = ops.slice(k, e).map((o) => o[1]);
      const atStart = k === 0;
      const atEnd = e === ops.length;
      const head = atStart ? 0 : context;
      const tail = atEnd ? 0 : context;
      if (run.length > head + tail + 1) {
        for (const t of run.slice(0, head)) rows.push({ k: "ctx", t });
        rows.push({ k: "gap", n: run.length - head - tail });
        for (const t of run.slice(run.length - tail)) rows.push({ k: "ctx", t });
      } else for (const t of run) rows.push({ k: "ctx", t });
      k = e;
      continue;
    }
    // A change block: dels then adds (LCS emits them grouped per gap).
    const dels = [];
    const adds = [];
    while (k < ops.length && ops[k]?.[0] !== "eq") {
      const o = ops[k++];
      if (o?.[0] === "del") dels.push(o[1]);
      else if (o) adds.push(o[1]);
    }
    del += dels.length;
    add += adds.length;
    const paired = dels.length === adds.length ? dels.map((d, i) => intraLine(d, adds[i] ?? "")) : [];
    dels.forEach((t, i) => {
      const segs = paired[i]?.[0];
      rows.push(segs ? { k: "del", t, segs } : { k: "del", t });
    });
    adds.forEach((t, i) => {
      const segs = paired[i]?.[1];
      rows.push(segs ? { k: "add", t, segs } : { k: "add", t });
    });
  }
  return { rows, add, del };
}

/**
 * @typedef {{ k: "ctx" | "del" | "add" | "hunk", t: string }} PatchRow
 * @typedef {{ op: "update" | "add" | "delete", path: string, moveTo?: string, rows: PatchRow[], add: number, del: number }} PatchFile
 */

/**
 * Parse an apply_patch body (Codex): `*** Begin Patch`, then per file `*** Update File: p` /
 * `*** Add File: p` / `*** Delete File: p` (optionally `*** Move to: q`), `@@` hunk headers and
 * `+` / `-` / ` ` lines. Unknown lines are kept as context; never throws.
 * @param {string} text
 * @returns {{ files: PatchFile[], add: number, del: number }}
 */
export function parsePatch(text) {
  /** @type {PatchFile[]} */
  const files = [];
  /** @type {PatchFile | null} */
  let cur = null;
  let add = 0;
  let del = 0;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (m) {
      /** @type {PatchFile["op"]} */
      const op = m[1] === "Add" ? "add" : m[1] === "Delete" ? "delete" : "update";
      cur = { op, path: (m[2] ?? "").trim(), rows: [], add: 0, del: 0 };
      files.push(cur);
      continue;
    }
    if (/^\*\*\* (Begin|End) Patch/.test(line) || line === "*** End of File") continue;
    if (!cur) continue;
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv) {
      cur.moveTo = (mv[1] ?? "").trim();
      continue;
    }
    if (line.startsWith("@@")) cur.rows.push({ k: "hunk", t: line.slice(2).trim() });
    else if (line.startsWith("+")) {
      cur.rows.push({ k: "add", t: line.slice(1) });
      cur.add++;
      add++;
    } else if (line.startsWith("-")) {
      cur.rows.push({ k: "del", t: line.slice(1) });
      cur.del++;
      del++;
    } else cur.rows.push({ k: "ctx", t: line.startsWith(" ") ? line.slice(1) : line });
  }
  for (const f of files) {
    while (f.rows.length > 0 && f.rows[f.rows.length - 1]?.k === "ctx" && f.rows[f.rows.length - 1]?.t === "") f.rows.pop();
  }
  return { files, add, del };
}
