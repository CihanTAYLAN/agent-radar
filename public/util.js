// Shared helpers: DOM builder (textContent only, never innerHTML), Turkish formatters, icons.

import { humanizeCommand, shortenPaths } from "./cmd.js";

export const $ = (id) => document.getElementById(id);

/** h("div", { class: "x", text: "y", onclick }, ...children) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "title" || k === "for") el.setAttribute(k, v === true ? "" : String(v));
      else el[k] = v;
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.append(k);
  return el;
}

// ---- icons (24px grid, stroke) ------------------------------------------------------------------

const ICONS = {
  terminal: ["M4 17l6-5-6-5", "M12 19h8"],
  pencil: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"],
  filePlus: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z", "M14 3v6h6", "M12 12v6", "M9 15h6"],
  file: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z", "M14 3v6h6", "M8 13h8", "M8 17h5"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z", "M21 21l-4.3-4.3"],
  agent: ["M12 8V4H8", "M4 12a8 8 0 0 1 8-4h0a8 8 0 0 1 8 4v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z", "M9 14h.01", "M15 14h.01"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M3 12h18", "M12 3a14 14 0 0 1 0 18", "M12 3a14 14 0 0 0 0 18"],
  checks: ["M3 7l2 2 4-4", "M3 17l2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8"],
  message: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"],
  sparkles: ["M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z", "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"],
  plug: ["M9 2v6", "M15 2v6", "M6 8h12v4a6 6 0 0 1-12 0Z", "M12 18v4"],
  wrench: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.8-.7-.7-2.8Z"],
  chevronRight: ["M9 6l6 6-6 6"],
  chevronDown: ["M6 9l6 6 6-6"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"],
  arrowDown: ["M12 5v14", "M19 12l-7 7-7-7"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  alert: ["M12 3l10 18H2Z", "M12 10v4", "M12 17h.01"],
  check: ["M20 6L9 17l-5-5"],
  layers: ["M12 3l9 5-9 5-9-5Z", "M3 13l9 5 9-5"],
  coins: ["M9 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z", "M18.1 10.4A6 6 0 1 1 10.4 18"],
  gantt: ["M3 5h10", "M7 10h12", "M5 15h8", "M10 20h10"],
  command: ["M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z"],
};

export function icon(name, cls = "") {
  const paths = ICONS[name] ?? ICONS.wrench;
  const el = svg("svg", { viewBox: "0 0 24 24", class: `ic ${cls}`.trim(), "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" });
  for (const d of paths) el.append(svg("path", { d }));
  return el;
}

// ---- actions (tool -> Turkish verb + icon) ----------------------------------------------------------

export const ACTION = {
  bash: { verb: "Komut çalıştırıyor", past: "Komut", icon: "terminal" },
  edit: { verb: "Düzenliyor", past: "Düzenleme", icon: "pencil" },
  write: { verb: "Yazıyor", past: "Dosya yazımı", icon: "filePlus" },
  read: { verb: "Okuyor", past: "Okuma", icon: "file" },
  search: { verb: "Arıyor", past: "Arama", icon: "search" },
  agent: { verb: "Alt ajan başlattı", past: "Alt ajan", icon: "agent" },
  web: { verb: "Web'e bakıyor", past: "Web", icon: "globe" },
  todo: { verb: "Görev listesini güncelliyor", past: "Görevler", icon: "checks" },
  message: { verb: "Mesaj gönderiyor", past: "Mesaj", icon: "message" },
  skill: { verb: "Skill kullanıyor", past: "Skill", icon: "sparkles" },
  mcp: { verb: "Entegrasyon çağırıyor", past: "MCP", icon: "plug" },
  other: { verb: "Araç kullanıyor", past: "Araç", icon: "wrench" },
};

const TOOL_KIND = {
  Bash: "bash", BashOutput: "bash", KillShell: "bash", PowerShell: "bash",
  Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Write: "write",
  Read: "read", NotebookRead: "read", LS: "read",
  Grep: "search", Glob: "search", ToolSearch: "search",
  Agent: "agent", Task: "agent", WebFetch: "web", WebSearch: "web",
  TodoWrite: "todo", TaskCreate: "todo", TaskUpdate: "todo", SendMessage: "message", Skill: "skill",
};
export const toolKind = (tool) => TOOL_KIND[tool] ?? (tool?.startsWith("mcp__") ? "mcp" : "other");

/** "mcp__atlassian__getJiraIssue" -> "atlassian · getJiraIssue" */
export function toolLabel(tool) {
  if (tool?.startsWith("mcp__")) {
    const [, server, name] = tool.split("__");
    return `${server} · ${name ?? ""}`;
  }
  return tool ?? "araç";
}

// ---- providers (agent tools) --------------------------------------------------------------------------
// Plain text labels only -- never a vendor logo. Unknown providers use the label from /api/providers.

const PROVIDER_META = {
  "claude-code": { label: "Claude Code", short: "Claude" },
  codex: { label: "Codex", short: "Codex" },
  antigravity: { label: "Antigravity", short: "Antigravity" },
  opencode: { label: "opencode", short: "opencode" },
  kilo: { label: "Kilo Code", short: "Kilo" },
  bionic: { label: "Bionic", short: "Bionic" },
  "gemini-cli": { label: "Gemini CLI", short: "Gemini" },
};

/** Latest /api/providers statuses; app.js keeps this current. */
export const providerState = { list: [] };

const ALL_CAPS = { transcript: true, tokens: true, tools: true, subagents: true, cost: true };

export function providerInfo(id) {
  const st = providerState.list.find((p) => p.id === id);
  const meta = PROVIDER_META[id];
  return {
    id,
    label: meta?.label ?? st?.label ?? id ?? "?",
    short: meta?.short ?? st?.label ?? id ?? "?",
    caps: st?.capabilities ?? ALL_CAPS,
  };
}

// ---- commands / paths ----------------------------------------------------------------------------------

/** Where paths get shortened against; app.js fills this in (home from /api/health, cwd per session). */
export const pathCtx = { home: "", cwd: "" };

/** One-line, humanized target of a ToolAction (bash: `cd` prefix removed, paths shortened). */
export function actionTarget(a) {
  if (!a) return "";
  if (a.kind === "bash") return humanizeCommand(a.target ?? "", pathCtx, a.dir ?? null).head || a.tool;
  return shortenPaths(a.target || a.tool || "", pathCtx);
}

export { humanizeCommand, shortenPaths };

// ---- state labels ------------------------------------------------------------------------------------

export const STATE = {
  running: { label: "Çalışıyor", cls: "running" },
  idle: { label: "Boşta", cls: "idle" },
  done: { label: "Tamamlandı", cls: "done" },
  failed: { label: "Hatalı", cls: "failed" },
  stopped: { label: "Durduruldu", cls: "stopped" },
  stalled: { label: "Takıldı", cls: "stalled" },
};
export const stateLabel = (s) => STATE[s]?.label ?? s;

// ---- formatting (tr-TR) ------------------------------------------------------------------------------

const nf = new Intl.NumberFormat("tr-TR");
const nf1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const usd = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const fmtInt = (n) => (Number.isFinite(n) ? nf.format(n) : "–");

export function fmtTok(n) {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1e9) return `${nf2.format(n / 1e9)}B`;
  if (n >= 1e6) return `${nf2.format(n / 1e6)}M`;
  if (n >= 1e4) return `${nf1.format(n / 1e3)}k`;
  if (n >= 1e3) return `${nf1.format(n / 1e3)}k`;
  return nf.format(n);
}

export function fmtUsd(n) {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1000) return usd0.format(n);
  if (n > 0 && n < 0.01) return "<$0,01";
  return usd.format(n);
}

/** Cost of a session / agent: "—" when no price is known, "≥ $x" when only part of the usage is priced. */
export function fmtCost(x) {
  if (!x) return "–";
  if (x.costPartial) return x.costUsd > 0 ? `≥ ${fmtUsd(x.costUsd)}` : "—";
  return fmtUsd(x.costUsd);
}

/** Compact duration: 45sn · 12dk 05sn · 3sa 12dk · 2g 4sa */
export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}dk ${String(s % 60).padStart(2, "0")}sn`;
  const hr = Math.floor(m / 60);
  if (hr < 48) return `${hr}sa ${String(m % 60).padStart(2, "0")}dk`;
  return `${Math.floor(hr / 24)}g ${hr % 24}sa`;
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "–";
  const d = now - ms;
  if (d < 45_000) return "az önce";
  if (d < 3600_000) return `${Math.round(d / 60_000)}dk önce`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)}sa önce`;
  return `${Math.round(d / 86400_000)}g önce`;
}

export function fmtTime(ms, withSec = false) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString("tr-TR", withSec ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
}

export function fmtIsoTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? fmtTime(t, true) : "";
}

export function shortModel(m) {
  if (!m) return "";
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1");
}

export const lastSeg = (p) => (p ? p.split("/").filter(Boolean).pop() ?? p : "");

export function trLower(s) {
  return String(s ?? "").toLocaleLowerCase("tr-TR");
}

// ---- tree helpers -------------------------------------------------------------------------------------

export function flatten(n, out = [], depth = 0, parent = null) {
  out.push({ node: n, depth, parent });
  for (const c of n.children) flatten(c, out, depth + 1, n);
  return out;
}

export function findNode(n, key) {
  if (!n) return null;
  if (n.key === key) return n;
  for (const c of n.children) {
    const r = findNode(c, key);
    if (r) return r;
  }
  return null;
}

/** End of an agent's bar: now while running/stalled, else endedAt/lastActivityAt. */
export function nodeEnd(n, now) {
  if (n.state === "running" || n.state === "idle") return now;
  return n.endedAt ?? n.lastActivityAt ?? n.startedAt ?? now;
}

export const isActive = (s) => s === "running" || s === "stalled";
export const isFinished = (s) => s === "done" || s === "stopped";

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export async function api(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status}`), { status: r.status });
  return r.json();
}
