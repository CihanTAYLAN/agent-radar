// Session timeline: one row per agent (running first, then by start), bars on a shared time axis, a live
// "now" line and one quiet activity series (parallel agents). Rows are keyed and patched in place.

import { h, svg, icon, fmtDur, fmtTime, fmtInt, stateLabel, nodeEnd, isActive, isFinished, ACTION, actionTarget } from "./util.js";

const LABEL_W = 232;
const ROW_H = 30;
const STEPS = [10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3];
const ZOOMS = [["all", "Tümü"], ["1h", "1 sa"], ["15m", "15 dk"]];
const ZOOM_MS = { "15m": 15 * 60e3, "1h": 60 * 60e3, all: Infinity };
const STATE_RANK = { running: 0, stalled: 1, idle: 2, failed: 3, stopped: 4, done: 5 };
/** Activity bucket sizes; the smallest one at least MIN_BUCKET_PX wide wins. */
const BUCKETS = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3, 43200e3, 86400e3];
const MIN_BUCKET_PX = 4;
const ACT_H = 24;

export function createTimeline(root, { onOpen }) {
  const opts = { zoom: "all", filter: "all", collapsed: null };
  let detail = null;
  let now = Date.now();
  let cursorKey = null;
  let openKey = null;
  let scale = null; // { t0, t1, px, trackW, live }
  let axisSig = "";
  let pinnedRight = true;
  let visible = []; // [{node, depth}]
  const rows = new Map();
  const byKey = new Map();

  // ---- static DOM ----------------------------------------------------------------------------------
  const filterSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Durum filtresi" });
  const zoomBtn = h("button", { class: "btn quiet", title: "Yakınlaştırma (1 · 2 · 3)", onclick: () => cycleZoom() });
  const toolbar = h("div", { class: "tl-toolbar" }, filterSeg, h("div", { class: "grow" }), zoomBtn);

  const axisTicks = h("div", { class: "tl-ticks" });
  const axis = h("div", { class: "tl-axis" }, h("div", { class: "tl-label" }), axisTicks);
  const actPath = svg("path", { class: "act-area" });
  const actSvg = svg("svg", { class: "tl-act-svg", preserveAspectRatio: "none", "aria-hidden": "true" }, actPath);
  const actLane = h("div", { class: "tl-act-lane" }, actSvg);
  const activity = h("div", { class: "tl-activity" }, h("div", { class: "tl-label" }), actLane);
  const head = h("div", { class: "tl-head" }, axis, activity);
  const grid = h("div", { class: "tl-grid", "aria-hidden": "true" });
  const nowLine = h("div", { class: "tl-now", "aria-hidden": "true" });
  const body = h("div", { class: "tl-body", role: "list" }, grid, nowLine);
  const canvas = h("div", { class: "tl-canvas" }, head, body);
  const scroller = h("div", { class: "tl-scroll", tabIndex: -1 }, canvas);
  const empty = h("div", { class: "tl-empty", hidden: true });
  const tip = h("div", { class: "tip", role: "tooltip", hidden: true });
  document.body.append(tip);
  root.append(toolbar, scroller, empty);

  const moreRow = h("button", { class: "tl-more", onclick: () => set({ collapsed: false }) });
  const lessRow = h("button", { class: "tl-more", onclick: () => set({ collapsed: true }) }, h("span", { text: "Tamamlananları daralt" }));
  const hint = h("div", { class: "tl-hint" });

  scroller.addEventListener("scroll", () => {
    pinnedRight = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 24;
    tip.hidden = true;
  });

  // ---- interactions ----------------------------------------------------------------------------------
  body.addEventListener("click", (e) => {
    const row = e.target.closest("[data-key]");
    if (!row) return;
    const key = row.getAttribute("data-key");
    setCursor(key);
    onOpen(key);
  });
  body.addEventListener("pointermove", (e) => {
    const bar = e.target.closest(".tl-bar");
    const n = bar ? byKey.get(bar.closest("[data-key]")?.getAttribute("data-key")) : null;
    if (!n) return (tip.hidden = true);
    if (tip.dataset.key !== n.key || tip.hidden) {
      tip.replaceChildren(...tipContent(n));
      tip.dataset.key = n.key;
    }
    placeTip(e.clientX, e.clientY);
  });
  body.addEventListener("pointerleave", () => (tip.hidden = true));
  actLane.addEventListener("pointermove", (e) => {
    if (!hist || !scale) return;
    const x = e.clientX - actLane.getBoundingClientRect().left;
    const i = Math.floor((x / scale.px + scale.t0 - hist.b0) / hist.bucket);
    if (i < 0 || i >= hist.nb) return (tip.hidden = true);
    const from = hist.b0 + i * hist.bucket;
    tip.dataset.key = `act${i}`;
    tip.replaceChildren(h("div", { class: "tip-t num", text: `${fmtTime(from)} – ${fmtTime(from + hist.bucket)}` }), h("div", { class: "num", text: `${fmtInt(hist.conc[i])} paralel ajan` }));
    placeTip(e.clientX, e.clientY);
  });
  actLane.addEventListener("pointerleave", () => (tip.hidden = true));

  function placeTip(x, y) {
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 12, x + 14))}px`;
    tip.style.top = `${Math.max(8, y + 18 + r.height > window.innerHeight ? y - r.height - 12 : y + 18)}px`;
  }
  function tipContent(n) {
    const end = nodeEnd(n, now);
    const act = n.state === "running" && n.lastAction ? ACTION[n.lastAction.kind] ?? ACTION.other : null;
    return [
      h("div", { class: "tip-t", text: n.key === "main" ? "Ana ajan" : n.label }),
      h("div", { class: "muted num", text: `${stateLabel(n.state)} · ${n.startedAt ? fmtDur(end - n.startedAt) : "–"}${n.startedAt ? ` · ${fmtTime(n.startedAt)}–${n.state === "running" ? "şimdi" : fmtTime(end)}` : ""}` }),
      act ? h("div", { class: "tip-act" }, h("span", { text: `${act.verb} ` }), h("span", { class: "mono muted", text: actionTarget(n.lastAction) })) : null,
      n.endReason ? h("div", { class: `tip-reason ${n.state}`, text: n.endReason }) : null,
    ].filter(Boolean);
  }

  // ---- options ---------------------------------------------------------------------------------------
  function set(p) {
    if (p.zoom && p.zoom !== opts.zoom) pinnedRight = true;
    Object.assign(opts, p);
    render(true);
  }
  function cycleZoom() {
    const i = ZOOMS.findIndex(([k]) => k === opts.zoom);
    set({ zoom: ZOOMS[(i + 1) % ZOOMS.length][0] });
  }
  const collapsedNow = () => (opts.collapsed !== null ? opts.collapsed : subs().some((n) => isActive(n.state)));
  const subs = () => [...iterNodes(detail.tree)].filter((n) => n.key !== "main");

  // ---- rows --------------------------------------------------------------------------------------------
  function orderedRows() {
    const out = [];
    const cmp = (a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity);
    const walk = (n, depth) => {
      out.push({ node: n, depth });
      [...n.children].sort(cmp).forEach((c) => walk(c, depth + 1));
    };
    walk(detail.tree, 0);
    return out;
  }

  function matches(n) {
    if (opts.filter === "running") return isActive(n.state) || (n.key === "main" && n.state === "running");
    if (opts.filter === "failed") return n.state === "failed";
    return true;
  }

  function computeVisible() {
    const all = orderedRows();
    const collapse = opts.filter === "all" && collapsedNow();
    const parentOf = new Map();
    for (const n of iterNodes(detail.tree)) for (const c of n.children) parentOf.set(c.key, n.key);
    let hidden = [];
    const shown = [];
    for (const { node } of all) {
      if (!matches(node)) continue;
      if (collapse && node.key !== "main" && isFinished(node.state) && !subtreeHas(node, (x) => !isFinished(x.state))) hidden.push(node);
      else shown.push(node);
    }
    // Collapsing is about fitting the view: reveal the most recently finished agents into the room left.
    if (hidden.length) {
      const room = roomForRows(shown.length);
      if (hidden.length <= room) {
        shown.push(...hidden);
        hidden = [];
      } else if (room > 1) {
        const pick = new Set([...hidden].sort((a, b) => nodeEnd(b, now) - nodeEnd(a, now)).slice(0, room - 1).map((n) => n.key));
        shown.push(...hidden.filter((n) => pick.has(n.key)));
        hidden = hidden.filter((n) => !pick.has(n.key));
      }
    }
    const keep = new Set(["main"]);
    for (const node of shown) for (let k = node.key; k; k = parentOf.get(k)) keep.add(k);
    return { rows: all.filter((r) => keep.has(r.node.key)), hidden, collapse };
  }

  function roomForRows(n) {
    const avail = root.clientHeight;
    if (!avail) return 0;
    const used = toolbar.offsetHeight + (head.offsetHeight || 52) + n * ROW_H + ROW_H + 16;
    return Math.max(0, Math.floor((avail - used) / ROW_H));
  }

  function syncRows(v) {
    const want = [];
    const seen = new Set();
    for (const { node, depth } of v.rows) {
      let r = rows.get(node.key);
      if (!r) rows.set(node.key, (r = makeRow(node)));
      fillRow(r, node, depth);
      seen.add(node.key);
      want.push(r.el);
    }
    for (const [k, r] of rows) if (!seen.has(k)) (r.el.remove(), rows.delete(k));
    const doneCount = subs().filter((n) => isFinished(n.state)).length;
    if (v.collapse && v.hidden.length > 0) {
      moreRow.replaceChildren(h("span", { class: "num", text: `${v.hidden.length} tamamlanan daha` }), icon("chevronDown"));
      want.push(moreRow);
    } else if (opts.filter === "all" && doneCount > 0 && !collapsedNow() && opts.collapsed === false) want.push(lessRow);
    if (detail.tree.children.length === 0) {
      hint.textContent = "Bu oturumda alt ajan yok; ana ajan işi tek başına yürüttü.";
      want.push(hint);
    } else if (v.rows.length <= 1 && v.hidden.length === 0) {
      hint.textContent = opts.filter === "running" ? "Şu an çalışan alt ajan yok." : "Hatalı ajan yok.";
      want.push(hint);
    }
    let ref = nowLine.nextSibling;
    for (const el of want) {
      if (el !== ref) body.insertBefore(el, ref);
      ref = el.nextSibling;
    }
    for (const el of [moreRow, lessRow, hint]) if (!want.includes(el) && el.isConnected) el.remove();
    markCursor();
  }

  function makeRow(n) {
    const name = h("span", { class: "tl-name" });
    const label = h("div", { class: "tl-label" }, name);
    const tickPath = svg("path", { class: "tl-ticks-path" });
    const ticks = svg("svg", { class: "tl-bar-ticks", preserveAspectRatio: "none", "aria-hidden": "true" }, tickPath);
    const bar = h("div", { class: "tl-bar" }, ticks);
    const dur = h("span", { class: "tl-dur num" });
    const el = h("div", { class: "tl-row", role: "listitem", "data-key": n.key, tabIndex: -1 }, label, h("div", { class: "tl-lane" }, bar, dur));
    return { el, name, label, bar, ticks, tickPath, dur, ticksSig: "" };
  }

  function fillRow(r, n, depth) {
    r.el.className = `tl-row st-${n.state}${n.key === "main" ? " is-main" : ""}`;
    r.label.style.paddingLeft = `${16 + Math.max(0, depth - 1) * 14 + (depth > 0 ? 8 : 0)}px`;
    const text = n.key === "main" ? "Ana ajan" : n.label;
    if (r.name.textContent !== text) r.name.textContent = text;
    r.name.title = n.key === "main" ? detail.name : n.label;
    r.bar.className = `tl-bar ${n.state}`;
    r.el.setAttribute("aria-label", `${text}, ${stateLabel(n.state)}`);
  }

  function placeRow(n) {
    const r = rows.get(n.key);
    if (!r) return;
    r.bar.hidden = n.startedAt === undefined;
    if (r.bar.hidden) return void (r.dur.textContent = "");
    const end = nodeEnd(n, now);
    const left = X(n.startedAt);
    const width = Math.max(3, X(end) - left);
    r.bar.style.transform = `translateX(${left.toFixed(1)}px)`;
    r.bar.style.width = `${width.toFixed(1)}px`;
    r.ticks.setAttribute("viewBox", `0 0 ${Math.max(1, (end - n.startedAt) / 1000).toFixed(1)} 10`);
    const sig = `${n.startedAt}|${n.ticks.length}|${n.ticks[n.ticks.length - 1] ?? ""}`;
    if (sig !== r.ticksSig) {
      r.ticksSig = sig;
      r.tickPath.setAttribute("d", n.ticks.map((t) => `M${t} 3V7`).join(""));
    }
    const txt = fmtDur(end - n.startedAt);
    if (r.dur.textContent !== txt) r.dur.textContent = txt;
    // Near the right edge the label goes inside a wide bar, or before a narrow one (never past the track).
    const near = left + width + 72 > scale.trackW;
    const inside = near && width > 80;
    r.dur.classList.toggle("inside", inside);
    r.dur.classList.toggle("before", near && !inside);
    r.dur.style.transform = `translateX(${(inside ? left + width - 8 : near ? left - 8 : left + width + 8).toFixed(1)}px)`;
  }

  // ---- scale / axis / activity ----------------------------------------------------------------------------
  function computeScale() {
    let t0 = Infinity;
    let t1 = 0;
    let live = Boolean(detail.live);
    for (const n of iterNodes(detail.tree)) {
      if (n.startedAt !== undefined) t0 = Math.min(t0, n.startedAt);
      if (n.state === "running" || n.state === "idle" || n.state === "stalled") live = true;
      t1 = Math.max(t1, nodeEnd(n, now));
    }
    if (!Number.isFinite(t0)) return null;
    if (live) t1 = Math.max(t1, now);
    const span = Math.max(60e3, t1 - t0);
    const viewW = Math.max(160, scroller.clientWidth - LABEL_W - 1);
    const win = ZOOM_MS[opts.zoom] ?? Infinity;
    if (win >= span) return { t0, t1, live, px: viewW / (span * (live ? 1.035 : 1.01)), trackW: viewW };
    const px = viewW / win;
    return { t0, t1, live, px, trackW: Math.ceil(span * px + viewW * 0.035) };
  }
  const X = (t) => (t - scale.t0) * scale.px;

  let hist = null;
  let dataVer = 0;
  function buildHist(structural) {
    if (structural) dataVer++;
    const bucket = BUCKETS.find((b) => b * scale.px >= MIN_BUCKET_PX) ?? BUCKETS[BUCKETS.length - 1];
    const b0 = Math.floor(scale.t0 / bucket) * bucket;
    const nb = Math.max(1, Math.ceil((Math.max(scale.t1, scale.live ? now : 0) - b0) / bucket));
    const sig = `${dataVer}|${bucket}|${b0}|${nb}`;
    if (hist?.sig === sig) return;
    const conc = new Array(nb).fill(0);
    for (const n of iterNodes(detail.tree)) {
      if (n.key === "main" || n.startedAt === undefined) continue;
      const i0 = Math.max(0, Math.floor((n.startedAt - b0) / bucket));
      const i1 = Math.min(nb - 1, Math.floor((Math.max(n.startedAt, nodeEnd(n, now) - 1) - b0) / bucket));
      for (let i = i0; i <= i1; i++) conc[i]++;
    }
    hist = { sig, bucket, b0, nb, conc };
    const max = Math.max(1, ...conc);
    actSvg.setAttribute("viewBox", `0 0 ${nb} ${ACT_H}`);
    let d = `M0 ${ACT_H}`;
    conc.forEach((c, i) => {
      const y = (ACT_H - (c / max) * (ACT_H - 3)).toFixed(1);
      d += `L${i} ${y}H${i + 1}`;
    });
    actPath.setAttribute("d", `${d}V${ACT_H}Z`);
  }
  function placeHist() {
    actSvg.style.transform = `translateX(${X(hist.b0).toFixed(1)}px)`;
    actSvg.style.width = `${(hist.nb * hist.bucket * scale.px).toFixed(1)}px`;
  }

  function drawAxis() {
    const step = STEPS.find((s) => s * scale.px >= 96) ?? STEPS[STEPS.length - 1];
    const first = Math.ceil(scale.t0 / step) * step;
    const count = Math.floor((scale.t0 + scale.trackW / scale.px - first) / step) + 1;
    const sig = `${scale.t0}|${scale.px.toPrecision(6)}|${step}|${count}`;
    if (sig === axisSig) return;
    axisSig = sig;
    const ticks = [];
    const lines = [];
    for (let t = first, i = 0; i < count && i < 2000; t += step, i++) {
      const x = `translateX(${X(t).toFixed(1)}px)`;
      const lab = h("span", { class: "tl-tick num", text: fmtTime(t, step < 60e3) });
      lab.style.transform = x;
      ticks.push(lab);
      const ln = h("div", { class: "tl-gridline" });
      ln.style.transform = x;
      lines.push(ln);
    }
    axisTicks.replaceChildren(...ticks);
    grid.replaceChildren(...lines);
  }

  function placeNow() {
    nowLine.hidden = !scale.live;
    if (scale.live) nowLine.style.transform = `translateX(${(LABEL_W + X(now)).toFixed(1)}px)`;
  }

  // ---- render ---------------------------------------------------------------------------------------------
  function updateChrome() {
    const all = subs();
    const running = all.filter((n) => isActive(n.state)).length;
    const failed = all.filter((n) => n.state === "failed").length;
    if (opts.filter === "failed" && failed === 0) opts.filter = "all";
    const defs = [["running", "Çalışan", running], ["all", "Tümü", all.length], ...(failed ? [["failed", "Hatalı", failed]] : [])];
    filterSeg.replaceChildren(...defs.map(([k, t, c]) =>
      h("button", { class: `seg-btn${opts.filter === k ? " on" : ""}${k === "failed" ? " bad" : ""}`, role: "radio", "aria-checked": String(opts.filter === k), onclick: () => set({ filter: k }) },
        h("span", { text: t }), h("span", { class: "seg-n num", text: String(c) }))));
    zoomBtn.replaceChildren(icon("clock"), h("span", { text: ZOOMS.find(([k]) => k === opts.zoom)?.[1] ?? "Tümü" }));
  }

  function render(structural) {
    if (!detail) return;
    if (!detail.hasTranscript || !detail.tree.startedAt) {
      showEmpty(detail.hasTranscript ? "Bu oturumda henüz etkinlik yok." : "Bu oturum için diskte henüz transkript yok.");
      return;
    }
    empty.hidden = true;
    scroller.hidden = false;
    toolbar.hidden = false;
    const prevScrollW = scroller.scrollWidth;
    scale = computeScale();
    if (!scale) return;
    canvas.style.width = `${LABEL_W + scale.trackW}px`;
    if (structural) {
      for (const n of iterNodes(detail.tree)) byKey.set(n.key, n);
      const v = computeVisible();
      visible = v.rows;
      syncRows(v);
      updateChrome();
    }
    for (const { node } of visible) placeRow(node);
    buildHist(structural);
    placeHist();
    drawAxis();
    placeNow();
    if (pinnedRight && scroller.scrollWidth > scroller.clientWidth && (structural || scroller.scrollWidth !== prevScrollW)) scroller.scrollLeft = scroller.scrollWidth;
  }

  function showEmpty(text) {
    scroller.hidden = true;
    toolbar.hidden = true;
    empty.hidden = false;
    empty.replaceChildren(h("div", { class: "muted", text }));
  }

  function markCursor() {
    for (const [k, r] of rows) {
      r.el.classList.toggle("cursor", k === cursorKey);
      r.el.classList.toggle("open", k === openKey);
    }
  }

  function setCursor(key, scroll = true) {
    cursorKey = key;
    markCursor();
    const r = rows.get(key);
    if (!r || !scroll) return;
    const top = r.el.offsetTop;
    const bottom = head.offsetHeight + top + r.el.offsetHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }

  new ResizeObserver(() => {
    if (!detail) return;
    root.classList.add("no-anim");
    render(false);
    requestAnimationFrame(() => root.classList.remove("no-anim"));
  }).observe(scroller);
  // The view's height decides how many finished agents fit; re-run the structural pass when it changes.
  let viewH = 0;
  let viewT = null;
  new ResizeObserver(() => {
    if (!detail || root.clientHeight === viewH) return;
    viewH = root.clientHeight;
    clearTimeout(viewT);
    viewT = setTimeout(() => render(true), 120);
  }).observe(root);

  return {
    update(d, t) {
      const sessionChanged = !detail || detail.id !== d.id;
      detail = d;
      now = t;
      byKey.clear();
      if (sessionChanged) {
        Object.assign(opts, { collapsed: null, filter: "all" });
        pinnedRight = true;
        axisSig = "";
        for (const r of rows.values()) r.el.remove();
        rows.clear();
        root.classList.add("no-anim");
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-anim")));
      }
      render(true);
    },
    tick(t) {
      now = t;
      if (detail && !scroller.hidden) render(false);
    },
    loading() {
      detail = null;
      scroller.hidden = true;
      toolbar.hidden = true;
      empty.hidden = false;
      empty.replaceChildren(h("div", { class: "sk-rows" }, ...Array.from({ length: 7 }, (_, i) => h("div", { class: "sk-row" }, h("i"), h("b", { class: `w${i % 4}` })))));
    },
    error(text) {
      detail = null;
      showEmpty(text);
    },
    setCursor,
    setOpen(key) {
      openKey = key;
      markCursor();
    },
    get cursor() {
      return cursorKey;
    },
    keys: () => visible.map((v) => v.node.key),
    setOptions: set,
  };
}

function* iterNodes(n) {
  yield n;
  for (const c of n.children) yield* iterNodes(c);
}

function subtreeHas(n, pred) {
  return n.children.some((c) => pred(c) || subtreeHas(c, pred));
}
