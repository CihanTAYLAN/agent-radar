/**
 * codex/format.ts -- the ONLY module that knows the (internal, fast-moving) on-disk formats of the
 * OpenAI Codex CLI and the Codex desktop app under ~/.codex:
 *
 *   sessions/YYYY/MM/DD/rollout-<ISO ts>-<thread uuid>.jsonl   append-only thread rollouts
 *   archived_sessions/rollout-...jsonl                          archived rollouts (never live)
 *   state_<n>.sqlite  (tables `threads`, `thread_spawn_edges`)  thread index (read in index-db.ts)
 *
 * Rollout line: `{timestamp, ordinal, type, payload, [metadata]}`. Types used here: session_meta,
 * turn_context, token_usage_record, response_item (message / agent_message / reasoning /
 * function_call[_output] / custom_tool_call[_output]), event_msg (task_started / task_complete /
 * turn_aborted / token_count / thread_goal_updated) and compacted. Everything else is skipped.
 *
 * Never forwarded to the UI: reasoning `encrypted_content`, `base_instructions`, developer
 * messages, encrypted inter-agent payloads. Everything is defensive: unknown shapes yield
 * undefined / [] and never throw.
 */
import { safeText } from "../../mask.js";
import { clipLine, isObj, num, oneLine, shortPath, splitCdPrefix, str } from "../common.js";
import type { ActionKind, StreamEvent, ToolAction, Usage } from "../types.js";

export type RawLine = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Names and ids
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(s: string): boolean {
  return UUID.test(s);
}

/** `rollout-2026-09-29T18-16-51-<uuid>.jsonl` -> uuid, else null. */
export function rolloutThreadId(name: string): string | null {
  const m = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return m?.[1]?.toLowerCase() ?? null;
}

/** The index state database: `state_<n>.sqlite` (the highest n wins). Nothing else is ever opened. */
export function stateDbVersion(name: string): number | undefined {
  const m = /^state_(\d{1,4})\.sqlite$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/** Lines longer than this are only JSON-parsed when their header says they matter for aggregates. */
export const BIG_LINE = 256 * 1024;

export interface LineHead {
  ts?: string;
  type?: string;
  /** payload.type, when it is the first payload key. */
  ptype?: string;
}

/**
 * Reads timestamp / type / payload.type from the first bytes of a line without parsing it
 * (Codex writes `{"timestamp":…,"ordinal":…,"type":…,"payload":{"type":…`).
 */
export function peekHead(line: string): LineHead {
  const head = line.slice(0, 400);
  const out: LineHead = {};
  const ts = /"timestamp":"([^"]{10,40})"/.exec(head);
  if (ts?.[1]) out.ts = ts[1];
  const ty = /"type":"([a-z_]{1,48})","payload":\{(?:"type":"([a-z_]{1,48})")?/.exec(head);
  if (ty?.[1]) out.type = ty[1];
  if (ty?.[2]) out.ptype = ty[2];
  return out;
}

/** Types that never matter for aggregates (they can be huge); only their timestamp is used. */
const AGG_SKIP = new Set(["world_state", "compacted"]);
const AGG_SKIP_PAYLOAD = new Set(["item_completed", "function_call_output", "custom_tool_call_output", "reasoning", "message", "agent_message"]);

/** Should the aggregator JSON-parse this (possibly huge) line? Small lines are always parsed. */
export function worthParsing(line: string, head: LineHead = peekHead(line)): boolean {
  if (line.length <= BIG_LINE) return true;
  if (head.type && AGG_SKIP.has(head.type)) return false;
  if (head.ptype && AGG_SKIP_PAYLOAD.has(head.ptype)) return false;
  return true;
}

export function parseLine(line: string): RawLine | null {
  const t = line.trim();
  if (t.length === 0 || t.charCodeAt(0) !== 123 /* { */) return null;
  try {
    const j: unknown = JSON.parse(t);
    return isObj(j) ? j : null;
  } catch {
    return null;
  }
}

export function lineType(e: RawLine): string {
  return str(e["type"]) ?? "unknown";
}

export function payloadOf(e: RawLine): Record<string, unknown> {
  const p = e["payload"];
  return isObj(p) ? p : {};
}

// ---------------------------------------------------------------------------
// session_meta / thread source
// ---------------------------------------------------------------------------

export type ThreadKind = "desktop" | "cli" | "exec" | "subagent" | "other";

export interface SourceInfo {
  kind: ThreadKind;
  /** Raw simple source (`vscode`, `cli`, `exec`, ...). */
  raw?: string;
  parentId?: string;
  depth?: number;
  nickname?: string;
  agentPath?: string;
  role?: string;
}

/** `threads.source` / `session_meta.source`: a string, or `{"subagent":{"thread_spawn":{...}}}` (object or JSON text). */
export function parseSource(v: unknown): SourceInfo {
  let s: unknown = v;
  if (typeof s === "string" && s.startsWith("{")) {
    try {
      s = JSON.parse(s);
    } catch {
      return { kind: "other" };
    }
  }
  if (typeof s === "string") {
    const raw = s;
    const kind: ThreadKind = raw === "vscode" ? "desktop" : raw === "cli" ? "cli" : raw === "exec" ? "exec" : "other";
    return { kind, raw };
  }
  if (!isObj(s)) return { kind: "other" };
  const sub = s["subagent"];
  if (isObj(sub)) {
    const ts = isObj(sub["thread_spawn"]) ? sub["thread_spawn"] : sub;
    const out: SourceInfo = { kind: "subagent" };
    const p = str(ts["parent_thread_id"]);
    if (p && isThreadId(p)) out.parentId = p.toLowerCase();
    const d = num(ts["depth"]);
    if (d !== undefined) out.depth = d;
    const nick = str(ts["agent_nickname"]);
    if (nick) out.nickname = nick;
    const ap = str(ts["agent_path"]);
    if (ap) out.agentPath = ap;
    const role = str(ts["agent_role"]);
    if (role) out.role = role;
    return out;
  }
  return { kind: "other" };
}

export interface SessionMeta {
  id?: string;
  parentId?: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  source: SourceInfo;
  threadSource?: string;
  nickname?: string;
  agentPath?: string;
  modelProvider?: string;
  startedAt?: number;
}

export function sessionMeta(p: Record<string, unknown>): SessionMeta {
  const source = parseSource(p["source"]);
  const m: SessionMeta = { source };
  const id = str(p["id"]);
  if (id && isThreadId(id)) m.id = id.toLowerCase();
  const parent = str(p["parent_thread_id"]) ?? source.parentId;
  if (parent && isThreadId(parent) && parent.toLowerCase() !== m.id) m.parentId = parent.toLowerCase();
  const put = <K extends keyof SessionMeta>(k: K, v: SessionMeta[K] | undefined) => {
    if (v !== undefined) m[k] = v;
  };
  put("cwd", str(p["cwd"]));
  put("originator", str(p["originator"]));
  put("cliVersion", str(p["cli_version"]));
  put("threadSource", str(p["thread_source"]));
  put("nickname", str(p["agent_nickname"]) ?? source.nickname);
  put("agentPath", str(p["agent_path"]) ?? source.agentPath);
  put("modelProvider", str(p["model_provider"]));
  const ts = str(p["timestamp"]);
  const ms = ts ? Date.parse(ts) : NaN;
  if (Number.isFinite(ms)) m.startedAt = ms;
  return m;
}

/** Thread titles are stored with HTML entities and blank lines (`/goal&#x20;\n\nSag…`); make them one line. */
export function cleanTitle(raw: string | undefined, max = 90): string | undefined {
  if (!raw) return undefined;
  const decoded = raw
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => safeCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const one = clipLine(decoded, max);
  return one.length > 0 ? one : undefined;
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * OpenAI-style usage -> neutral Usage. `input_tokens` INCLUDES cached (and cache-write) tokens, so
 * uncached input = input - cached - cacheWrite; `output_tokens` includes reasoning tokens.
 */
export function toUsage(v: unknown): Usage | undefined {
  if (!isObj(v)) return undefined;
  const inp = num(v["input_tokens"]);
  const out = num(v["output_tokens"]);
  if (inp === undefined && out === undefined) return undefined;
  const cached = num(v["cached_input_tokens"]) ?? 0;
  const cw = num(v["cache_write_input_tokens"]) ?? 0;
  return { input: Math.max(0, (inp ?? 0) - cached - cw), output: out ?? 0, cacheRead: cached, cacheCreate: cw };
}

// ---------------------------------------------------------------------------
// Tool calls -> human-readable actions
// ---------------------------------------------------------------------------

export interface CallInfo {
  callId?: string;
  /** Display tool name (`exec_command`, `apply_patch`, `collaboration.spawn_agent`, `mcp__x__y`...). */
  tool: string;
  action: ToolAction;
  /** One-line masked summary. */
  summary: string;
  /** Masked fields for the drawer (`command`, `workdir`, `patch`, `file_path`, `code`...). */
  detail?: Record<string, string>;
}

/** Reads a JS/JSON string literal starting at `i` (a quote char). Returns the decoded value. */
function readStringLiteral(src: string, i: number): { value: string; end: number } | undefined {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return undefined;
  let j = i + 1;
  let out = "";
  while (j < src.length) {
    const c = src[j] as string;
    if (c === "\\") {
      const n = src[j + 1];
      if (n === undefined) return undefined;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
        j += 6;
        continue;
      } else out += n;
      j += 2;
      continue;
    }
    if (c === q) return { value: out, end: j + 1 };
    if (q === "`" && c === "$" && src[j + 1] === "{") return undefined; // template with interpolation
    out += c;
    j++;
  }
  return undefined;
}

/** Value of `key: "<literal>"` (key optionally quoted) in JS/JSON source. */
function jsStringField(src: string, key: string, from = 0): string | undefined {
  const re = new RegExp(`["']?${key}["']?\\s*:\\s*(["'\`])`, "g");
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return undefined;
  return readStringLiteral(src, m.index + m[0].length - 1)?.value;
}

const PATCH_FILE = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;

/** Files touched by an apply_patch body (`*** Update File: path`). */
export function patchFiles(patch: string): Array<{ op: string; path: string }> {
  const out: Array<{ op: string; path: string }> = [];
  for (const m of patch.matchAll(PATCH_FILE)) out.push({ op: m[1] ?? "Update", path: (m[2] ?? "").trim() });
  return out;
}

/** The first string literal in `src` that contains an apply_patch body. */
function findPatch(src: string): string | undefined {
  const at = src.indexOf("*** Begin Patch");
  if (at < 0) return undefined;
  // Raw patch (custom tool `apply_patch`, or arguments.input already decoded).
  if (src.trimStart().startsWith("*** Begin Patch")) return src.trimStart();
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const lit = readStringLiteral(src, i);
      if (lit && lit.value.includes("*** Begin Patch")) return lit.value;
    }
  }
  return undefined;
}

function filesTarget(files: Array<{ path: string }>): string {
  if (files.length === 0) return "";
  // One file reads like a Claude Edit target; several are listed by file name.
  if (files.length === 1) return shortPath((files[0] as { path: string }).path);
  const shown = files.slice(0, 3).map((f) => f.path.split("/").pop() || f.path);
  return files.length > 3 ? `${shown.join(", ")} +${files.length - 3}` : shown.join(", ");
}

function patchCall(tool: string, patch: string, callId?: string): CallInfo {
  const files = patchFiles(patch);
  const target = clipLine(filesTarget(files) || "yama", 200);
  const detail: Record<string, string> = { patch: safeText(patch, 6000) };
  const first = files[0];
  if (first) detail["file_path"] = safeText(first.path, 500);
  if (files.length > 1) detail["files"] = String(files.length);
  const ci: CallInfo = { tool, action: { tool, kind: "edit", target }, summary: target, detail };
  if (callId) ci.callId = callId;
  return ci;
}

function bashCall(tool: string, cmd: string, workdir: string | undefined, callId?: string): CallInfo {
  const sp = splitCdPrefix(cmd);
  const action: ToolAction = { tool, kind: "bash", target: clipLine(sp.rest, 400) };
  const dir = sp.dir ?? workdir;
  if (dir) action.dir = clipLine(dir, 300);
  const detail: Record<string, string> = { command: safeText(cmd, 4000) };
  if (workdir) detail["workdir"] = safeText(workdir, 500);
  const ci: CallInfo = { tool, action, summary: clipLine(cmd, 240), detail };
  if (callId) ci.callId = callId;
  return ci;
}

function argvToCommand(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return undefined;
  const parts = v.filter((x): x is string => typeof x === "string");
  // ["bash", "-lc", "<script>"] / ["/bin/zsh", "-lc", "<script>"] -> the script.
  if (parts.length >= 3 && /(^|\/)(ba|z|da|fi)?sh$/.test(parts[0] ?? "") && /^-\w*c$/.test(parts[1] ?? "")) return parts.slice(2).join(" ");
  return parts.join(" ");
}

const NAMED_KINDS: Record<string, ActionKind> = {
  view_image: "read",
  read_file: "read",
  list_dir: "read",
  grep_files: "search",
  web_search: "web",
  web__run: "web",
  update_plan: "todo",
  create_goal: "todo",
  update_goal: "todo",
  get_goal: "todo",
  spawn_agent: "agent",
  send_message: "message",
  followup_task: "message",
  send_input: "message",
  send_message_to_thread: "message",
  request_user_input_async: "message",
};

function kindForName(name: string): ActionKind {
  if (name.startsWith("mcp__")) return "mcp";
  const base = name.split(/\.|__/).pop() ?? name;
  return NAMED_KINDS[name] ?? NAMED_KINDS[base] ?? "other";
}

function genericCall(tool: string, args: Record<string, unknown>, callId?: string): CallInfo {
  const kind = kindForName(tool);
  const base = tool.split(/\.|__/).pop() ?? tool;
  let target = "";
  if (kind === "agent") target = str(args["task_name"]) ?? str(args["agent_nickname"]) ?? str(args["name"]) ?? "";
  else if (kind === "message") target = str(args["target"]) ? `→ ${str(args["target"])}` : "";
  else if (base === "wait_agent" || base === "wait") target = "alt ajanları bekliyor";
  else if (base === "sleep") target = `${Math.round((num(args["duration_ms"]) ?? 0) / 1000)} sn bekliyor`;
  else if (base === "list_agents") target = "ajanları listeliyor";
  else if (kind === "read") target = shortPath(str(args["path"]) ?? str(args["file_path"]) ?? "");
  else if (kind === "web") target = str(args["query"]) ?? str(args["q"]) ?? str(args["url"]) ?? "";
  else if (kind === "mcp") {
    const [, server = "", name = ""] = tool.split("__");
    const arg = str(args["title"]) ?? str(args["query"]) ?? firstString(args, ["message", "code"]);
    target = `${server} · ${name}${arg ? `: ${arg}` : ""}`;
  } else target = str(args["title"]) ?? firstString(args, ["message"]) ?? "";
  const ci: CallInfo = { tool, action: { tool, kind, target: clipLine(target || tool, 160) }, summary: clipLine(target, 240) };
  const detail: Record<string, string> = {};
  const code = str(args["code"]);
  if (code) detail["code"] = safeText(code, 3000);
  if (Object.keys(detail).length > 0) ci.detail = detail;
  if (callId) ci.callId = callId;
  return ci;
}

/** First string value of a small object, skipping keys that hold encrypted/opaque payloads. */
function firstString(o: Record<string, unknown>, skip: string[]): string | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (skip.includes(k)) continue;
    if (typeof v === "string" && v.length > 0 && !v.startsWith("gAAAA")) return v;
  }
  return undefined;
}

/**
 * The desktop app runs most tools through a custom `exec` tool whose input is JavaScript calling
 * `tools.exec_command({cmd, workdir})`, `tools.apply_patch("*** Begin Patch…")`, `tools.web__run(…)` …
 * This picks the first meaningful inner call.
 */
function describeExecScript(src: string, callId?: string): CallInfo {
  const patch = findPatch(src);
  if (patch) return patchCall("apply_patch", patch, callId);
  const inner = [...src.matchAll(/tools\.([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1] as string);
  const cmds: string[] = [];
  for (const m of src.matchAll(/tools\.(?:exec_command|shell|shell_command)\s*\(/g)) {
    const c = jsStringField(src, "cmd", m.index) ?? jsStringField(src, "command", m.index);
    if (c) cmds.push(c);
  }
  if (cmds.length > 0) {
    const ci = bashCall("exec_command", cmds[0] as string, jsStringField(src, "workdir"), callId);
    if (cmds.length > 1) {
      ci.action.target = clipLine(`${ci.action.target} (+${cmds.length - 1} komut)`, 400);
      if (ci.detail) ci.detail["command"] = safeText(cmds.join("\n"), 4000);
    }
    return ci;
  }
  const name = inner.find((n) => n !== "exec_command") ?? inner[0];
  if (name) {
    const ci = genericCall(name, {}, callId);
    if (name === "write_stdin") ci.action = { tool: name, kind: "bash", target: "çalışan komuta girdi gönderiyor" };
    ci.detail = { code: safeText(src, 3000) };
    return ci;
  }
  const ci: CallInfo = { tool: "exec", action: { tool: "exec", kind: "other", target: clipLine(src, 160) }, summary: clipLine(src, 240), detail: { code: safeText(src, 3000) } };
  if (callId) ci.callId = callId;
  return ci;
}

/** response_item function_call / custom_tool_call -> CallInfo; undefined for anything else. */
export function describeCall(p: Record<string, unknown>): CallInfo | undefined {
  const t = p["type"];
  const callId = str(p["call_id"]);
  const name = str(p["name"]) ?? "tool";
  const ns = str(p["namespace"]);
  if (t === "custom_tool_call") {
    const input = typeof p["input"] === "string" ? p["input"] : "";
    if (name === "apply_patch") return patchCall("apply_patch", findPatch(input) ?? input, callId);
    if (name === "exec") return describeExecScript(input, callId);
    return genericCall(name, { input }, callId);
  }
  if (t !== "function_call") return undefined;
  let args: Record<string, unknown> = {};
  const rawArgs = p["arguments"];
  if (typeof rawArgs === "string") {
    try {
      const j: unknown = JSON.parse(rawArgs);
      if (isObj(j)) args = j;
    } catch {
      args = { input: rawArgs };
    }
  } else if (isObj(rawArgs)) args = rawArgs;
  const tool = ns && !name.startsWith("mcp__") ? (ns.startsWith("mcp__") ? `${ns}__${name}` : `${ns}.${name}`) : name;
  if (name === "shell" || name === "exec_command" || name === "shell_command" || name === "local_shell" || name === "container.exec") {
    const cmd = argvToCommand(args["cmd"] ?? args["command"]);
    if (cmd) return bashCall(name, cmd, str(args["workdir"]) ?? str(args["cwd"]), callId);
  }
  if (name === "apply_patch") {
    const patch = str(args["input"]) ?? str(args["patch"]) ?? "";
    return patchCall("apply_patch", findPatch(patch) ?? patch, callId);
  }
  return genericCall(tool, args, callId);
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

export interface EventOptions {
  maxResult?: number;
  maxText?: number;
}

function blocksText(content: unknown, types: string[]): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    const bt = str(b["type"]) ?? "";
    if (types.includes(bt)) {
      const t = str(b["text"]);
      if (t) out.push(t);
    } else if (bt === "input_image" || bt === "image") out.push("[image]");
  }
  return out;
}

/** User-role plumbing the desktop app injects (`<environment_context>`, `<user_instructions>`...). */
function isPlumbing(t: string): boolean {
  const s = t.trimStart();
  return /^<[a-z_][\w-]*[\s>]/i.test(s) && !/^<image/i.test(s);
}

function outputText(v: unknown): { text: string; isError: boolean } {
  if (typeof v === "string") {
    // function_call_output may be a JSON envelope {"output": "...", "metadata": {"exit_code": 1}}.
    if (v.startsWith("{")) {
      try {
        const j: unknown = JSON.parse(v);
        if (isObj(j) && typeof j["output"] === "string") {
          const md = isObj(j["metadata"]) ? j["metadata"] : {};
          const code = num(md["exit_code"]);
          return { text: j["output"], isError: code !== undefined && code !== 0 };
        }
      } catch {
        /* plain text */
      }
    }
    return { text: v, isError: false };
  }
  if (isObj(v)) {
    const content = v["content"] ?? v["output"];
    const t = outputText(content);
    return { text: t.text, isError: t.isError || v["success"] === false };
  }
  const parts = blocksText(v, ["input_text", "output_text", "text"]);
  const text = parts.join("\n");
  return { text, isError: /^Script (failed|error|threw)/i.test(text) };
}

function fmtSecs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} sn` : `${Math.floor(s / 60)} dk ${String(s % 60).padStart(2, "0")} sn`;
}

/** One rollout line -> zero or more stream events. `lineId` must be stable within the file. */
export function toEvents(e: RawLine, lineId: string, opts: EventOptions = {}): StreamEvent[] {
  const maxResult = opts.maxResult ?? 2048;
  const maxText = opts.maxText ?? 4000;
  const type = lineType(e);
  const p = payloadOf(e);
  const pt = str(p["type"]);
  const ts = str(e["timestamp"]);
  const events: StreamEvent[] = [];
  const push = (idx: number, ev: Omit<StreamEvent, "id" | "ts">) => {
    const full: StreamEvent = { id: `${lineId}:${idx}`, ...ev };
    if (ts) full.ts = ts;
    events.push(full);
  };

  if (type === "response_item") {
    switch (pt) {
      case "message": {
        const role = p["role"];
        if (role === "assistant") {
          const t = blocksText(p["content"], ["output_text", "text"]).join("\n\n").trim();
          if (t) push(0, { kind: "assistant", text: safeText(t, maxText) });
        } else if (role === "user") {
          const parts = blocksText(p["content"], ["input_text", "text"]).filter((t) => !isPlumbing(t));
          const t = parts.join("\n\n").trim();
          if (t) push(0, { kind: "user", text: safeText(t, maxText) });
        }
        // developer / system messages are instructions, never shown.
        break;
      }
      case "agent_message": {
        // Inter-agent message (task hand-off / result); the readable part is the input_text block.
        const t = blocksText(p["content"], ["input_text", "output_text", "text"]).join("\n\n").trim();
        if (t) push(0, { kind: "user", text: safeText(t, maxText) });
        break;
      }
      case "reasoning": {
        // Only the plain summary; encrypted_content is never read.
        const sum = Array.isArray(p["summary"]) ? p["summary"] : [];
        const t = sum
          .map((b) => (isObj(b) ? (str(b["text"]) ?? "") : ""))
          .filter(Boolean)
          .join("\n\n")
          .trim();
        if (t) push(0, { kind: "thinking", text: safeText(t, maxText) });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const ci = describeCall(p);
        if (!ci) break;
        const ev: Omit<StreamEvent, "id" | "ts"> = { kind: "tool_use", tool: ci.tool, action: ci.action.kind, text: ci.summary || ci.action.target };
        if (ci.callId) ev.toolUseId = ci.callId;
        if (ci.detail) ev.detail = ci.detail;
        push(0, ev);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const o = outputText(p["output"]);
        const ev: Omit<StreamEvent, "id" | "ts"> = { kind: "tool_result", text: safeText(o.text, maxResult) };
        const cid = str(p["call_id"]);
        if (cid) ev.toolUseId = cid;
        if (o.isError) ev.isError = true;
        push(0, ev);
        break;
      }
      default:
    }
    return events;
  }

  if (type === "event_msg") {
    if (pt === "task_complete") {
      const d = num(p["duration_ms"]);
      push(0, { kind: "notification", text: `Tur tamamlandı${d !== undefined ? ` · ${fmtSecs(d)}` : ""}` });
    } else if (pt === "turn_aborted") {
      const r = str(p["reason"]);
      push(0, { kind: "notification", text: `Tur iptal edildi${r ? ` · ${clipLine(r, 120)}` : ""}` });
    } else if (pt === "thread_goal_updated") {
      const g = isObj(p["goal"]) ? (str(p["goal"]["objective"]) ?? str(p["goal"]["title"])) : str(p["goal"]);
      push(0, { kind: "notification", text: `Hedef güncellendi${g ? `: ${clipLine(g, 160)}` : ""}` });
    }
    return events;
  }

  if (type === "compacted") push(0, { kind: "notification", text: "Bağlam sıkıştırıldı" });
  return events;
}

/** Last user prompt text of a response_item message line (masked, one line), for session headers. */
export function userPrompt(p: Record<string, unknown>): string | undefined {
  if (p["type"] !== "message" || p["role"] !== "user") return undefined;
  const t = blocksText(p["content"], ["input_text", "text"]).filter((x) => !isPlumbing(x) && x !== "[image]").join(" ");
  const one = oneLine(t);
  return one ? safeText(one, 300) : undefined;
}
