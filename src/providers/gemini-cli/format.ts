/**
 * gemini-cli/format.ts -- everything we know about Gemini CLI's on-disk chat format.
 *
 * DERIVED FROM SOURCE, NOT VERIFIED ON REAL DATA (none exists on this machine). Authority:
 * packages/core/src/services/chatRecordingService.ts and packages/core/src/config/storage.ts of
 * google-gemini/gemini-cli v0.20.0 (also read from the installed npm package's dist JS).
 *
 * Layout:  ~/.gemini/tmp/<sha256(projectRoot) hex>/chats/session-<YYYY-MM-DDTHH-MM>-<sessionId[0..8]>.json
 * Each file is ONE JSON document, rewritten whole on every change (read -> mutate -> writeFileSync):
 *   { sessionId, projectHash, startTime, lastUpdated, messages: MessageRecord[] }
 * MessageRecord: { id, timestamp, type: "user"|"gemini"|"info"|"error"|"warning", content: PartListUnion,
 *   // type "gemini" only:
 *   toolCalls?: [{ id, name, args, result?, status, timestamp, displayName?, description?, resultDisplay? }],
 *   thoughts?: [{ subject, description, timestamp }],
 *   tokens?: { input, output, cached, thoughts?, tool?, total } | null,
 *   model?: string }
 * ToolCall status: validating | scheduled | awaiting_approval | executing | success | error | cancelled.
 * There is no cwd field: the project root is only known through the directory-name hash.
 */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { maskSecrets, safeText } from "../../mask.js";
import { clipLine, isObj, num, shortPath, splitCdPrefix, str } from "../common.js";
import type { ActionKind, StreamEvent, ToolAction, Usage } from "../types.js";

export type MessageType = "user" | "gemini" | "info" | "error" | "warning";

export interface GTokens {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  total: number;
}

export interface GToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: string;
  ts?: number;
  resultDisplay?: string;
  result?: unknown;
}

export interface GThought {
  subject: string;
  description: string;
}

export interface GMessage {
  id: string;
  ts?: number;
  tsRaw?: string;
  type: MessageType;
  content: unknown;
  toolCalls: GToolCall[];
  thoughts: GThought[];
  tokens?: GTokens;
  model?: string;
}

export interface GConversation {
  sessionId?: string;
  projectHash?: string;
  startTime?: number;
  lastUpdated?: number;
  messages: GMessage[];
}

const TYPES = new Set(["user", "gemini", "info", "error", "warning"]);
/** Tool call statuses that mean "not finished yet". */
const PENDING = new Set(["validating", "scheduled", "awaiting_approval", "executing"]);

export function isPendingStatus(s: string): boolean {
  return PENDING.has(s);
}

function time(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function toTokens(v: unknown): GTokens | undefined {
  if (!isObj(v)) return undefined;
  const n = (k: string) => Math.max(0, num(v[k]) ?? 0);
  return { input: n("input"), output: n("output"), cached: n("cached"), thoughts: n("thoughts"), tool: n("tool"), total: n("total") };
}

/** Defensive parse of a whole session file; undefined when it is not a conversation record. */
export function parseConversation(text: string): GConversation | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(j) || !Array.isArray(j["messages"])) return undefined;
  const messages: GMessage[] = [];
  for (const m of j["messages"] as unknown[]) {
    if (!isObj(m)) continue;
    const type = str(m["type"]);
    if (!type || !TYPES.has(type)) continue;
    const toolCalls: GToolCall[] = [];
    if (Array.isArray(m["toolCalls"])) {
      for (const c of m["toolCalls"] as unknown[]) {
        if (!isObj(c)) continue;
        const tc: GToolCall = {
          id: str(c["id"]) ?? `call-${toolCalls.length}`,
          name: str(c["name"]) ?? "tool",
          args: isObj(c["args"]) ? c["args"] : {},
          status: str(c["status"]) ?? "success",
          result: c["result"],
        };
        const ts = time(c["timestamp"]);
        if (ts !== undefined) tc.ts = ts;
        const rd = c["resultDisplay"];
        if (typeof rd === "string" && rd) tc.resultDisplay = rd;
        toolCalls.push(tc);
      }
    }
    const thoughts: GThought[] = [];
    if (Array.isArray(m["thoughts"])) {
      for (const t of m["thoughts"] as unknown[]) {
        if (!isObj(t)) continue;
        thoughts.push({ subject: str(t["subject"]) ?? "", description: str(t["description"]) ?? "" });
      }
    }
    const msg: GMessage = { id: str(m["id"]) ?? `msg-${messages.length}`, type: type as MessageType, content: m["content"], toolCalls, thoughts };
    const ts = time(m["timestamp"]);
    if (ts !== undefined) msg.ts = ts;
    if (typeof m["timestamp"] === "string") msg.tsRaw = m["timestamp"];
    const tokens = toTokens(m["tokens"]);
    if (tokens) msg.tokens = tokens;
    const model = str(m["model"]);
    if (model) msg.model = model;
    messages.push(msg);
  }
  const conv: GConversation = { messages };
  const sid = str(j["sessionId"]);
  if (sid) conv.sessionId = sid;
  const ph = str(j["projectHash"]);
  if (ph) conv.projectHash = ph;
  const st = time(j["startTime"]);
  if (st !== undefined) conv.startTime = st;
  const lu = time(j["lastUpdated"]);
  if (lu !== undefined) conv.lastUpdated = lu;
  return conv;
}

// ---------------------------------------------------------------------------
// Content (PartListUnion: string | Part | Part[])
// ---------------------------------------------------------------------------

function partText(p: unknown): string {
  if (typeof p === "string") return p;
  if (!isObj(p)) return "";
  const t = p["text"];
  if (typeof t === "string") return t;
  const fr = p["functionResponse"];
  if (isObj(fr)) {
    const r = fr["response"];
    if (isObj(r)) return str(r["output"]) ?? str(r["error"]) ?? "";
    return "";
  }
  if (p["inlineData"] !== undefined || p["fileData"] !== undefined) return "[dosya]";
  return "";
}

/** Plain text of a message/tool content of any PartListUnion shape. */
export function contentText(c: unknown): string {
  if (Array.isArray(c)) return c.map(partText).filter((x) => x.length > 0).join("\n");
  return partText(c);
}

function resultText(tc: GToolCall): string {
  if (tc.resultDisplay) return tc.resultDisplay;
  return contentText(tc.result);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * `input` in Gemini's usage metadata includes cached tokens, so uncached input = input - cached
 * (+ tool-use prompt tokens); thought tokens are billed as output.
 */
export function toUsage(t: GTokens): Usage {
  return { input: Math.max(0, t.input - t.cached) + t.tool, output: t.output + t.thoughts, cacheRead: t.cached, cacheCreate: 0 };
}

// ---------------------------------------------------------------------------
// Project hash -> cwd
// ---------------------------------------------------------------------------

export function projectHashOf(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

const PATH_KEYS = ["file_path", "absolute_path", "dir_path", "path", "directory"];

/** Absolute paths mentioned in tool arguments (candidates for the project root's descendants). */
export function argPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of PATH_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.startsWith("/")) out.push(v);
  }
  return out;
}

/**
 * The hash is one-way, so hash every ancestor of the paths seen in tool arguments and keep the one that
 * matches: a verified project root (never a guess). undefined when no candidate matches.
 */
export function resolveProjectRoot(hash: string, paths: Iterable<string>): string | undefined {
  let n = 0;
  const seen = new Set<string>();
  for (const p of paths) {
    if (++n > 300) break;
    let cur = p;
    for (let i = 0; i < 64 && !seen.has(cur); i++) {
      seen.add(cur);
      if (projectHashOf(cur) === hash) return cur;
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool calls -> human actions
// ---------------------------------------------------------------------------

export interface CallInfo {
  action: ToolAction;
  summary: string;
  detail?: Record<string, string>;
}

function arg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function kindOf(name: string): ActionKind {
  switch (name) {
    case "run_shell_command":
      return "bash";
    case "replace":
      return "edit";
    case "write_file":
      return "write";
    case "read_file":
    case "read_many_files":
      return "read";
    case "glob":
    case "search_file_content":
    case "list_directory":
      return "search";
    case "google_web_search":
    case "web_fetch":
      return "web";
    case "write_todos":
      return "todo";
    default:
      return name.startsWith("mcp_") || name.includes("__") ? "mcp" : "other";
  }
}

export function describeCall(name: string, args: Record<string, unknown>): CallInfo {
  const kind = kindOf(name);
  let target = "";
  let dir: string | undefined;
  const detail: Record<string, string> = {};
  const put = (k: string, v: string | undefined, max = 400) => {
    if (v) detail[k] = safeText(v, max);
  };
  switch (name) {
    case "run_shell_command": {
      const raw = arg(args, "command") ?? "";
      const sp = splitCdPrefix(raw);
      target = clipLine(sp.rest, 160);
      const d = sp.dir ?? arg(args, "dir_path", "directory");
      if (d) dir = clipLine(d, 200);
      put("command", raw, 1200);
      put("description", arg(args, "description"), 300);
      break;
    }
    case "replace":
    case "write_file":
    case "read_file": {
      const p = arg(args, "file_path", "absolute_path", "path");
      target = p ? clipLine(shortPath(p), 160) : "";
      put("file_path", p, 300);
      break;
    }
    case "read_many_files": {
      const inc = args["include"] ?? args["paths"];
      target = clipLine(Array.isArray(inc) ? inc.filter((x) => typeof x === "string").join(", ") : typeof inc === "string" ? inc : "", 160);
      break;
    }
    case "glob":
    case "search_file_content": {
      target = clipLine(arg(args, "pattern") ?? "", 160);
      put("pattern", arg(args, "pattern"), 300);
      put("path", arg(args, "dir_path", "path"), 300);
      break;
    }
    case "list_directory": {
      const p = arg(args, "dir_path", "path");
      target = p ? clipLine(shortPath(p), 160) : "";
      break;
    }
    case "google_web_search":
      target = clipLine(arg(args, "query") ?? "", 160);
      break;
    case "web_fetch":
      target = clipLine(arg(args, "prompt", "url") ?? "", 160);
      break;
    default:
      target = clipLine(arg(args, "description", "query", "prompt", "command", "file_path", "path") ?? "", 160);
  }
  const action: ToolAction = { tool: maskSecrets(name), kind, target };
  if (dir) action.dir = dir;
  const info: CallInfo = { action, summary: target };
  if (Object.keys(detail).length > 0) info.detail = detail;
  return info;
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

const MAX_TEXT = 6000;
const MAX_RESULT = 2000;

/** Flatten a conversation into the neutral event list. The index in the array is the paging cursor. */
export function toEvents(conv: GConversation): StreamEvent[] {
  const out: StreamEvent[] = [];
  conv.messages.forEach((m, i) => {
    const base = `m${i}`;
    const push = (id: string, ev: Omit<StreamEvent, "id" | "ts">, ts: string | undefined) => {
      const e: StreamEvent = { id, ...ev };
      if (ts) e.ts = ts;
      out.push(e);
    };
    if (m.type === "user") {
      push(base, { kind: "user", text: safeText(contentText(m.content), MAX_TEXT) }, m.tsRaw);
      return;
    }
    if (m.type === "info" || m.type === "warning" || m.type === "error") {
      const ev: Omit<StreamEvent, "id" | "ts"> = { kind: "notification", text: safeText(contentText(m.content), 1000) };
      if (m.type === "error") ev.isError = true;
      push(base, ev, m.tsRaw);
      return;
    }
    m.thoughts.forEach((t, j) => {
      const text = [t.subject, t.description].filter((x) => x).join(": ");
      if (text) push(`${base}t${j}`, { kind: "thinking", text: safeText(text, 2000) }, m.tsRaw);
    });
    const txt = contentText(m.content);
    if (txt.trim()) push(base, { kind: "assistant", text: safeText(txt, MAX_TEXT) }, m.tsRaw);
    m.toolCalls.forEach((tc, k) => {
      const ci = describeCall(tc.name, tc.args);
      const ev: Omit<StreamEvent, "id" | "ts"> = { kind: "tool_use", tool: tc.name, action: ci.action.kind, text: ci.summary || ci.action.target, toolUseId: tc.id };
      if (ci.detail) ev.detail = ci.detail;
      push(`${base}c${k}`, ev, tc.ts !== undefined ? new Date(tc.ts).toISOString() : m.tsRaw);
      if (!isPendingStatus(tc.status)) {
        const bad = tc.status === "error" || tc.status === "cancelled";
        const body = resultText(tc) || (tc.status === "cancelled" ? "İptal edildi" : "");
        const r: Omit<StreamEvent, "id" | "ts"> = { kind: "tool_result", toolUseId: tc.id, text: safeText(body, MAX_RESULT) };
        if (bad) r.isError = true;
        push(`${base}r${k}`, r, m.tsRaw);
      }
    });
  });
  return out;
}
