/**
 * bionic/format.ts -- everything we know about Bionic's on-disk format (Element Labs' LM Studio based
 * desktop app; data under `~/.lmstudio/apps/bionic/projects/<uuid>/`). Pure functions, no I/O except the
 * path allow-list, which is string math only.
 *
 * Per project:
 *   project.json                    {name, projectType}
 *   .internal/ng-sessions.sqlite    WAL SQLite: `sessions` + `chat_entries` (a singly linked list:
 *                                   `previous_id`, walked back from `sessions.committed_head_entry_id`).
 *
 * Entry types seen: message (user/assistant/tool; parts text | reasoning | image | toolCallRequest |
 * toolCallResult), turnSummary, subSessionReference, error, interrupted, elicitationRequest/Response and
 * bookkeeping (stateChange, fileReference, redirect, resourceHold, forkPoint, ...). Tokens are NOT
 * stored; only `context{before,self,total}` (a context-size estimate) exists.
 */
import { relative, resolve, sep } from "node:path";
import { safeText } from "../../mask.js";
import { clipLine, isObj, num, shortPath, splitCdPrefix, str } from "../common.js";
import { safeToRead } from "../guard.js";
import type { ActionKind, StreamEvent, ToolAction } from "../types.js";

// ---------------------------------------------------------------------------
// Path allow-list
// ---------------------------------------------------------------------------

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: string): boolean {
  return UUIDISH.test(id);
}

/** Project dir names are uuids; anything else under `projects/` is ignored. */
export function isProjectId(name: string): boolean {
  return UUIDISH.test(name);
}

const ALLOWED = /^[^/\\]+[/\\](project\.json|\.internal[/\\]ng-sessions\.sqlite)$/;

/**
 * The only two files we ever open: `<projectsDir>/<project>/project.json` and
 * `<projectsDir>/<project>/.internal/ng-sessions.sqlite`. Everything else under `~/.lmstudio`
 * (settings.json with HF tokens, mcp.json, other apps) and `~/Library/Application Support/Bionic` is
 * refused, on top of the generic deny-list in guard.ts.
 */
export function allowedBionicFile(p: string, projectsDir: string): boolean {
  if (!safeToRead(p, [projectsDir])) return false;
  const rel = relative(resolve(projectsDir), resolve(p));
  if (rel.startsWith("..") || rel === "") return false;
  const parts = rel.split(sep);
  if (!isProjectId(parts[0] ?? "")) return false;
  return ALLOWED.test(rel);
}

// ---------------------------------------------------------------------------
// Session row -> config
// ---------------------------------------------------------------------------

export interface SessionConfig {
  model?: string;
  cwd?: string;
  reasoning?: string;
  shellMode?: string;
  /** Latest context-size estimate (tokens); NOT usage. */
  ctxTotal?: number;
}

export function parseSessionConfig(json: unknown): SessionConfig {
  const out: SessionConfig = {};
  if (typeof json !== "string") return out;
  let j: unknown;
  try {
    j = JSON.parse(json);
  } catch {
    return out;
  }
  if (!isObj(j)) return out;
  const ms = j["modelSpecifier"];
  if (isObj(ms) && str(ms["model"])) out.model = str(ms["model"]) as string;
  const sp = j["sessionParams"];
  if (isObj(sp) && str(sp["working_directory"])) out.cwd = str(sp["working_directory"]) as string;
  const ic = j["inferenceConfig"];
  if (isObj(ic) && str(ic["reasoningLevel"])) out.reasoning = str(ic["reasoningLevel"]) as string;
  const sc = j["sessionConfig"];
  if (isObj(sc) && str(sc["shellMode"])) out.shellMode = str(sc["shellMode"]) as string;
  const ce = j["contextEstimation"];
  if (isObj(ce) && num(ce["total"]) !== undefined) out.ctxTotal = num(ce["total"]) as number;
  return out;
}

export function parseProjectName(json: string): string | undefined {
  try {
    const j: unknown = JSON.parse(json);
    return isObj(j) ? str(j["name"]) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Chain analysis
// ---------------------------------------------------------------------------

export interface SubRef {
  sessionId: string;
  title?: string;
  done: boolean;
}

export interface Analysis {
  /** user + assistant messages. */
  messages: number;
  toolCalls: number;
  turns: number;
  lastTool?: string;
  lastAction?: ToolAction;
  /** uniqueToolCallId of the newest tool call, and whether it still has no result. */
  lastCallId?: string;
  lastCallPending: boolean;
  firstTs?: number;
  lastTs?: number;
  firstUser?: string;
  lastPrompt?: string;
  /** Tool-call times (ms). */
  ticks: number[];
  /** Per-minute message counts (minute index -> count), last hour only. */
  minutes: Map<number, number>;
  /** The newest significant entry means the agent still owes a step (see openTurn()). */
  openTurn: boolean;
  terminal?: "error" | "interrupted";
  errorCode?: string;
  /** Latest `context.total` of a message (context-size estimate). */
  ctxTotal?: number;
  subs: SubRef[];
}

export type Entry = Record<string, unknown>;

function parts(e: Entry): unknown[] {
  const m = e["message"];
  return isObj(m) && Array.isArray(m["parts"]) ? (m["parts"] as unknown[]) : [];
}
function role(e: Entry): string {
  const m = e["message"];
  return isObj(m) ? (str(m["role"]) ?? "") : "";
}
function partText(p: unknown): string {
  return isObj(p) && (p["type"] === "text" || p["type"] === "reasoning") ? (str(p["text"]) ?? "") : "";
}

/** User-visible text of a user message (hidden/plumbing messages give ""). */
export function userText(e: Entry): string {
  if (e["hidden"] === true) return "";
  return parts(e).map(partText).filter(Boolean).join("\n");
}

/** Entry types that carry no agent state: skipped when deciding whether a turn is open. */
const SIGNIFICANT = new Set(["message", "turnSummary", "error", "interrupted", "elicitationRequest", "elicitationResponse"]);

/** `entries` are oldest first. */
export function analyzeChain(entries: Entry[], nowMs: number): Analysis {
  const a: Analysis = { messages: 0, toolCalls: 0, turns: 0, lastCallPending: false, ticks: [], minutes: new Map(), openTurn: false, subs: [] };
  const requested = new Set<string>();
  const answered = new Set<string>();
  const minNow = Math.floor(nowMs / 60000);
  let lastSig: Entry | undefined;
  for (const e of entries) {
    const type = str(e["type"]);
    if (type && SIGNIFICANT.has(type)) lastSig = e;
    if (type === "turnSummary") a.turns++;
    else if (type === "subSessionReference") {
      const sid = str(e["sessionId"]);
      if (sid) {
        const done = str(e["doneTitle"]);
        const ref: SubRef = { sessionId: sid, done: done !== undefined };
        const title = done ?? str(e["workingTitle"]);
        if (title) ref.title = title;
        a.subs.push(ref);
      }
    } else if (type === "message") {
      const r = role(e);
      const ts = num(e["createdTimestamp"]);
      if (ts !== undefined) {
        a.firstTs = a.firstTs === undefined ? ts : Math.min(a.firstTs, ts);
        a.lastTs = a.lastTs === undefined ? ts : Math.max(a.lastTs, ts);
        if (r !== "tool") {
          const m = Math.floor(ts / 60000);
          if (minNow - m < 60) a.minutes.set(m, (a.minutes.get(m) ?? 0) + 1);
        }
      }
      const ctx = e["context"];
      if (isObj(ctx) && num(ctx["total"]) !== undefined) a.ctxTotal = num(ctx["total"]);
      if (r === "user" || r === "assistant") a.messages++;
      if (r === "user") {
        const t = userText(e);
        if (t) {
          a.firstUser ??= t;
          a.lastPrompt = t;
        }
      }
      for (const p of parts(e)) {
        if (!isObj(p)) continue;
        if (p["type"] === "toolCallRequest") {
          a.toolCalls++;
          const call = describeCall(p);
          a.lastTool = call.tool;
          a.lastAction = call.action;
          const id = str(p["uniqueToolCallId"]);
          if (id) {
            requested.add(id);
            a.lastCallId = id;
          }
          if (ts !== undefined) a.ticks.push(ts);
        } else if (p["type"] === "toolCallResult") {
          const id = str(p["uniqueToolCallId"]);
          if (id) answered.add(id);
        }
      }
    }
  }
  a.lastCallPending = a.lastCallId !== undefined && !answered.has(a.lastCallId);
  if (lastSig) {
    const t = str(lastSig["type"]);
    if (t === "message") {
      const r = role(lastSig);
      a.openTurn = r === "user" || r === "tool" || (r === "assistant" && parts(lastSig).some((p) => isObj(p) && p["type"] === "toolCallRequest"));
    } else if (t === "elicitationResponse") a.openTurn = true;
    else if (t === "error") {
      a.terminal = "error";
      const c = str(lastSig["errorCode"]);
      if (c) a.errorCode = c;
    } else if (t === "interrupted") a.terminal = "interrupted";
  }
  return a;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface CallInfo {
  tool: string;
  action: ToolAction;
  summary: string;
  detail?: Record<string, string>;
}

function firstStr(v: unknown): string | undefined {
  if (typeof v === "string" && v) return v;
  if (Array.isArray(v)) return v.find((x): x is string => typeof x === "string" && x.length > 0);
  return undefined;
}

/** A `toolCallRequest` part -> what the UI shows. Tool ids look like `ngModule:lmstudio:<module>:<fn>`. */
export function describeCall(p: Record<string, unknown>): CallInfo {
  const tool = str(p["name"]) ?? "tool";
  const args = isObj(p["parameters"]) ? p["parameters"] : {};
  const path = str(args["path"]);
  const mk = (kind: ActionKind, target: string, detail?: Record<string, string>): CallInfo => {
    const ci: CallInfo = { tool, action: { tool, kind, target: clipLine(target || tool, 300) }, summary: clipLine(target, 240) };
    if (detail && Object.keys(detail).length > 0) ci.detail = detail;
    return ci;
  };
  switch (tool) {
    case "shell_command": {
      const cmd = str(args["command"]) ?? "";
      const sp = splitCdPrefix(cmd);
      const workdir = str(args["workdir"]);
      const ci = mk("bash", sp.rest, { command: safeText(cmd, 4000) });
      const dir = sp.dir ?? workdir;
      if (dir) ci.action.dir = clipLine(dir, 300);
      if (workdir && ci.detail) ci.detail["workdir"] = safeText(workdir, 500);
      return ci;
    }
    case "read_file_lines":
      return mk("read", shortPath(path ?? ""), path ? { file_path: safeText(path, 500) } : undefined);
    case "list_dir":
      return mk("read", shortPath(path ?? ""), path ? { file_path: safeText(path, 500) } : undefined);
    case "open_file_in_side_editor":
      return mk("read", shortPath(path ?? ""), path ? { file_path: safeText(path, 500) } : undefined);
    case "search_file_line": {
      const term = str(args["search_term"]) ?? "";
      const d: Record<string, string> = {};
      if (term) d["pattern"] = safeText(term, 300);
      if (path) d["path"] = safeText(path, 500);
      return mk("search", term, d);
    }
    case "find_files": {
      const glob = str(args["glob"]) ?? "";
      const d: Record<string, string> = {};
      if (glob) d["pattern"] = safeText(glob, 300);
      if (path) d["path"] = safeText(path, 500);
      return mk("search", glob, d);
    }
    case "edit_file_tool":
      return mk("edit", shortPath(path ?? ""), path ? { file_path: safeText(path, 500) } : undefined);
    case "replace_file":
      return mk("write", shortPath(path ?? ""), path ? { file_path: safeText(path, 500) } : undefined);
    case "create_folder":
      return mk("write", shortPath(path ?? ""), path ? { file_path: safeText(path, 500) } : undefined);
    case "move":
      return mk("edit", `${shortPath(str(args["old_path"]) ?? "")} → ${shortPath(str(args["new_path"]) ?? "")}`);
    case "web_search":
      return mk("web", firstStr(args["objective"]) ?? firstStr(args["searchQueries"]) ?? "");
    case "web_extract":
      return mk("web", firstStr(args["urls"]) ?? firstStr(args["objective"]) ?? "");
    case "open_url_in_app_browser":
      return mk("web", str(args["url"]) ?? "");
    case "agentic_find":
      return mk("agent", firstStr(args["queries"]) ?? "");
    case "run_python": {
      const code = str(args["code"]);
      return mk("other", "Python çalıştırıyor", code ? { code: safeText(code, 3000) } : undefined);
    }
    case "bionic_tool":
      return mk("mcp", str(args["name"]) ?? "");
    default: {
      const first = Object.values(args).find((v) => typeof v === "string" && v.length > 0);
      return mk("other", typeof first === "string" ? first : "");
    }
  }
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

const MAX_TEXT = 6000;
const MAX_RESULT = 4000;

function fmtSecs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} dk ${s % 60} sn` : `${s} sn`;
}

function resultText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v.map((x) => (isObj(x) ? (str(x["text"]) ?? `[${str(x["type"]) ?? "?"}]`) : "")).filter(Boolean).join("\n");
}

/** One chain entry -> 0..n events. `id` is the entry id (parts get a `:<i>` suffix). */
export function toEvents(e: Entry): StreamEvent[] {
  const out: StreamEvent[] = [];
  const id = str(e["id"]) ?? "?";
  const ts = num(e["createdTimestamp"]);
  const push = (i: number, ev: Omit<StreamEvent, "id" | "ts">): void => {
    const full: StreamEvent = { id: `${id}:${i}`, ...ev };
    if (ts !== undefined) full.ts = new Date(ts).toISOString();
    out.push(full);
  };
  const type = str(e["type"]);
  if (type === "message") {
    const r = role(e);
    if (r === "user" && e["hidden"] === true) return out;
    parts(e).forEach((p, i) => {
      if (!isObj(p)) return;
      const pt = p["type"];
      if (pt === "text") {
        const t = str(p["text"]);
        if (t && (r === "user" || r === "assistant")) push(i, { kind: r, text: safeText(t, MAX_TEXT) });
      } else if (pt === "reasoning") {
        const t = str(p["text"]);
        if (t) push(i, { kind: "thinking", text: safeText(t, MAX_TEXT) });
      } else if (pt === "image") {
        push(i, { kind: "user", text: "[görsel]" });
      } else if (pt === "toolCallRequest") {
        const ci = describeCall(p);
        const ev: Omit<StreamEvent, "id" | "ts"> = { kind: "tool_use", tool: ci.tool, action: ci.action.kind, text: ci.summary || ci.action.target };
        const cid = str(p["uniqueToolCallId"]);
        if (cid) ev.toolUseId = cid;
        if (ci.detail) ev.detail = ci.detail;
        push(i, ev);
      } else if (pt === "toolCallResult") {
        const ev: Omit<StreamEvent, "id" | "ts"> = { kind: "tool_result", text: safeText(resultText(p["result"]), MAX_RESULT) };
        const cid = str(p["uniqueToolCallId"]);
        if (cid) ev.toolUseId = cid;
        push(i, ev);
      }
    });
    return out;
  }
  if (type === "turnSummary") {
    const d = num(e["durationMs"]);
    const files = Array.isArray(e["files"]) ? e["files"].length : 0;
    push(0, { kind: "notification", text: `Tur tamamlandı${d !== undefined ? ` · ${fmtSecs(d)}` : ""}${files > 0 ? ` · ${files} dosya` : ""}` });
  } else if (type === "subSessionReference") {
    const t = str(e["doneTitle"]) ?? str(e["workingTitle"]);
    push(0, { kind: "notification", text: `Alt oturum${t ? `: ${clipLine(t, 160)}` : ""}` });
  } else if (type === "error") {
    const m = str(e["message"]);
    push(0, { kind: "notification", text: `Hata${m ? `: ${clipLine(m, 200)}` : ""}`, isError: true });
  } else if (type === "interrupted") push(0, { kind: "notification", text: "Tur kesildi" });
  else if (type === "elicitationRequest") push(0, { kind: "notification", text: "Kullanıcıdan onay/yanıt bekleniyor" });
  return out;
}
