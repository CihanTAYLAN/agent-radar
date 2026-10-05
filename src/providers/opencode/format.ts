/**
 * opencode/format.ts -- everything we know about opencode's SQLite row shapes (also used by the Kilo
 * Code fork, which has the same session / message / part schema). Pure functions, no I/O.
 *
 * Part `data` JSON, by `type`: text | reasoning | step-start | step-finish | tool
 *   tool: { tool, callID, state: { status: pending|running|completed|error, input, output, error,
 *           title, metadata, time: { start, end } } }
 */
import { safeText } from "../../mask.js";
import { clipLine, isObj, num, shortPath, splitCdPrefix, str } from "../common.js";
import type { ActionKind, StreamEvent, ToolAction } from "../types.js";

export function parseJson(s: unknown): Record<string, unknown> | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** opencode ids look like `ses_<base62>`; validated before they touch a query (never a path). */
export function isNativeId(id: string): boolean {
  return /^ses_[A-Za-z0-9]{6,64}$/.test(id);
}

/** SQLite integers may arrive as bigint; everything else non-numeric is undefined. */
export function toMs(v: unknown): number | undefined {
  return num(typeof v === "bigint" ? Number(v) : v);
}

const KIND: Record<string, ActionKind> = {
  bash: "bash",
  shell: "bash",
  edit: "edit",
  patch: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  write: "write",
  read: "read",
  list: "read",
  grep: "search",
  glob: "search",
  codesearch: "search",
  webfetch: "web",
  websearch: "web",
  task: "agent",
  todowrite: "todo",
  todoread: "todo",
  skill: "skill",
  question: "message",
};

export function kindOf(tool: string): ActionKind {
  const k = KIND[tool.toLowerCase()];
  if (k) return k;
  // MCP tools are exposed as `<server>_<tool>`.
  return tool.includes("_") ? "mcp" : "other";
}

export interface CallInfo {
  tool: string;
  action: ToolAction;
  summary: string;
  detail?: Record<string, string>;
}

function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(input[k]);
    if (v) return v;
  }
  return undefined;
}

/** A tool part's call as a structured, masked action (+ selected input fields for rich rendering). */
export function describeTool(tool: string, inputRaw: unknown): CallInfo {
  const input = isObj(inputRaw) ? inputRaw : {};
  const kind = kindOf(tool);
  const detail: Record<string, string> = {};
  let target = "";
  const path = pick(input, "filePath", "file_path", "path");
  const dir = pick(input, "workdir", "cwd");
  switch (kind) {
    case "bash": {
      const cmd = pick(input, "command", "cmd") ?? "";
      const sp = splitCdPrefix(cmd);
      target = clipLine(sp.rest, 400);
      if (cmd) detail["command"] = safeText(cmd, 4000);
      const action: ToolAction = { tool, kind, target };
      const d = sp.dir ?? dir;
      if (d) action.dir = clipLine(d, 300);
      const desc = str(input["description"]);
      if (desc) detail["description"] = safeText(desc, 300);
      if (dir) detail["workdir"] = safeText(dir, 500);
      return { tool, action, summary: clipLine(cmd || desc || tool, 240), detail };
    }
    case "edit":
    case "write":
    case "read":
      target = path ? shortPath(clipLine(path, 300)) : "";
      if (path) detail["file_path"] = safeText(path, 500);
      if (kind === "edit") {
        const o = str(input["oldString"]) ?? str(input["old_string"]);
        const n = str(input["newString"]) ?? str(input["new_string"]);
        if (o) detail["old_string"] = safeText(o, 3000);
        if (n) detail["new_string"] = safeText(n, 3000);
        const patch = str(input["patchText"]) ?? str(input["patch"]);
        if (patch) detail["patch"] = safeText(patch, 6000);
      }
      if (kind === "write") {
        const c = str(input["content"]);
        if (c) detail["content"] = safeText(c, 3000);
      }
      break;
    case "search": {
      const pat = pick(input, "pattern", "query");
      target = clipLine(pat ?? path ?? "", 200);
      if (pat) detail["pattern"] = safeText(pat, 500);
      if (path) detail["path"] = safeText(path, 500);
      break;
    }
    case "web": {
      const u = pick(input, "url", "query");
      target = clipLine(u ?? "", 240);
      if (u) detail[input["url"] ? "url" : "query"] = safeText(u, 500);
      break;
    }
    case "agent": {
      const d = pick(input, "description", "prompt") ?? "";
      target = clipLine(d, 200);
      const sub = str(input["subagent_type"]);
      if (sub) detail["subagent_type"] = safeText(sub, 80);
      if (d) detail["description"] = safeText(d, 300);
      const p = str(input["prompt"]);
      if (p) detail["prompt"] = safeText(p, 2000);
      break;
    }
    case "skill":
      target = clipLine(pick(input, "name", "skill") ?? "", 120);
      break;
    default: {
      // Generic: first non-empty string field as the target.
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0) {
          target = clipLine(v, 160);
          break;
        }
      }
    }
  }
  const action: ToolAction = { tool, kind, target };
  return { tool, action, summary: target || tool, ...(Object.keys(detail).length ? { detail } : {}) };
}

export interface PartRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  role?: string;
  data: Record<string, unknown>;
}

/** A part whose content will not change any more (streaming text / running tools are held back). */
export function isSettled(data: Record<string, unknown>, updatedAt: number, now: number): boolean {
  const stale = now - updatedAt > 10 * 60_000;
  const type = str(data["type"]);
  if (type === "tool") {
    const st = isObj(data["state"]) ? str(data["state"]["status"]) : undefined;
    return st === "completed" || st === "error" || stale;
  }
  if (type === "text" || type === "reasoning") {
    const time = isObj(data["time"]) ? data["time"] : undefined;
    return num(time?.["end"]) !== undefined || stale;
  }
  return true;
}

const MAX_TEXT = 4000;
const MAX_RESULT = 2000;

/** Events of one part (a finished tool call yields tool_use + tool_result). */
export function partToEvents(p: PartRow): StreamEvent[] {
  const type = str(p.data["type"]);
  const ts = new Date(p.createdAt).toISOString();
  if (type === "text") {
    if (p.data["synthetic"] === true || p.data["ignored"] === true) return [];
    const text = str(p.data["text"]);
    if (!text) return [];
    return [{ id: `p:${p.id}`, ts, kind: p.role === "user" ? "user" : "assistant", text: safeText(text, MAX_TEXT) }];
  }
  if (type === "reasoning") {
    const text = str(p.data["text"]);
    if (!text) return [];
    return [{ id: `p:${p.id}`, ts, kind: "thinking", text: safeText(text, MAX_TEXT) }];
  }
  if (type === "tool") {
    const tool = str(p.data["tool"]) ?? "tool";
    const state = isObj(p.data["state"]) ? p.data["state"] : {};
    const ci = describeTool(tool, state["input"]);
    const callId = str(p.data["callID"]) ?? p.id;
    const use: StreamEvent = { id: `p:${p.id}`, ts, kind: "tool_use", tool, action: ci.action.kind, toolUseId: callId, text: ci.summary };
    if (ci.detail) use.detail = ci.detail;
    const out: StreamEvent[] = [use];
    const status = str(state["status"]);
    if (status === "completed" || status === "error") {
      const failed = status === "error";
      const raw = failed ? (str(state["error"]) ?? str(state["output"]) ?? "hata") : (str(state["output"]) ?? str(state["title"]) ?? "");
      out.push({ id: `r:${p.id}`, ts, kind: "tool_result", toolUseId: callId, text: safeText(raw, MAX_RESULT), ...(failed ? { isError: true } : {}) });
    }
    return out;
  }
  return [];
}
