/**
 * claude-code/format.ts -- the ONLY module that knows the (internal, undocumented)
 * on-disk formats of Claude Code under ~/.claude:
 *
 *   sessions/<pid>.json                                   live session registry
 *   projects/<encoded-cwd>/<sid>.jsonl                    main transcript
 *   projects/<encoded-cwd>/<sid>/subagents/agent-<id>.jsonl (+ .meta.json)
 *   projects/<encoded-cwd>/<sid>/subagents/workflows/<wf>/agent-<id>.jsonl
 *   projects/<encoded-cwd>/<sid>/custom-title.json
 *
 * Everything here is defensive: unknown shapes yield null / empty results and
 * are never fatal. If Claude Code changes its format, fix it in this file.
 */
import { maskSecrets, safeText } from "../../mask.js";
import { bool, clipLine, isObj, num, oneLine, splitCdPrefix, shortPath, str } from "../common.js";
import type { ActionKind, StreamEvent, ToolAction, Usage } from "../types.js";

// Shared helpers and neutral types, re-exported so callers of this module keep one import.
export { addUsage, clipLine, emptyUsage, shortPath, splitCdPrefix, totalTokens } from "../common.js";
export type { ActionKind, EventKind, StreamEvent, ToolAction, Usage } from "../types.js";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export type RawEntry = Record<string, unknown>;

// ---------------------------------------------------------------------------
// File-name conventions
// ---------------------------------------------------------------------------

/** `12345.json` -- deliberately excludes `12345.<hash>.key` files, which we never touch. */
export function isRegistryFileName(name: string): boolean {
  return /^\d+\.json$/.test(name);
}

export function isSessionId(s: string): boolean {
  return /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,79}$/.test(s);
}

export function isAgentId(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(s);
}

/** `agent-<id>.jsonl` -> id, else null. */
export function parseAgentTranscriptName(name: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
  return m?.[1] ?? null;
}

/** `agent-<id>.meta.json` -> id, else null. */
export function parseAgentMetaName(name: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(name);
  return m?.[1] ?? null;
}

/** Claude Code encodes a cwd as a directory name by replacing every non-alphanumeric char with '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// ---------------------------------------------------------------------------
// Live session registry (~/.claude/sessions/<pid>.json)
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  status?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
}

export function parseRegistryFile(text: string): RegistryEntry | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  const pid = num(j["pid"]);
  const sessionId = str(j["sessionId"]);
  if (pid === undefined || !sessionId) return null;
  const e: RegistryEntry = { pid, sessionId, cwd: str(j["cwd"]) ?? "" };
  const opt = <K extends keyof RegistryEntry>(k: K, v: RegistryEntry[K] | undefined) => {
    if (v !== undefined) e[k] = v;
  };
  opt("startedAt", num(j["startedAt"]));
  opt("version", str(j["version"]));
  opt("kind", str(j["kind"]));
  opt("entrypoint", str(j["entrypoint"]));
  opt("name", str(j["name"]));
  opt("status", str(j["status"]));
  opt("statusUpdatedAt", num(j["statusUpdatedAt"]));
  opt("updatedAt", num(j["updatedAt"]));
  return e;
}

// ---------------------------------------------------------------------------
// Subagent meta + session title files
// ---------------------------------------------------------------------------

export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  requestShape?: string;
  model?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export function parseAgentMeta(text: string): AgentMeta | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  const m: AgentMeta = {};
  const put = <K extends keyof AgentMeta>(k: K, v: AgentMeta[K] | undefined) => {
    if (v !== undefined) m[k] = v;
  };
  put("agentType", str(j["agentType"]));
  put("description", str(j["description"]));
  put("toolUseId", str(j["toolUseId"]));
  put("spawnDepth", num(j["spawnDepth"]));
  put("requestShape", str(j["requestShape"]));
  put("model", str(j["model"]));
  put("worktreePath", str(j["worktreePath"]));
  put("worktreeBranch", str(j["worktreeBranch"]));
  return m;
}

export function parseCustomTitleFile(text: string): string | undefined {
  try {
    const j: unknown = JSON.parse(text);
    return isObj(j) ? str(j["customTitle"]) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transcript lines
// ---------------------------------------------------------------------------

/** Parse one JSONL line. Returns null for blank / malformed / non-object lines (never throws). */
export function parseLine(line: string): RawEntry | null {
  const t = line.trim();
  if (t.length === 0 || t.charCodeAt(0) !== 123 /* { */) return null;
  try {
    const j: unknown = JSON.parse(t);
    return isObj(j) ? j : null;
  } catch {
    return null;
  }
}

export interface EntryInfo {
  type: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  version?: string;
  entrypoint?: string;
  /** Present only for `user` / `assistant` entries. */
  role?: "user" | "assistant";
  messageId?: string;
  model?: string;
  stopReason?: string | null;
  usage?: Usage;
  isApiError?: boolean;
}

export function entryInfo(e: RawEntry): EntryInfo {
  const info: EntryInfo = { type: str(e["type"]) ?? "unknown" };
  const set = <K extends keyof EntryInfo>(k: K, v: EntryInfo[K] | undefined) => {
    if (v !== undefined) info[k] = v;
  };
  set("timestamp", str(e["timestamp"]));
  set("sessionId", str(e["sessionId"]));
  set("cwd", str(e["cwd"]));
  set("gitBranch", str(e["gitBranch"]));
  set("slug", str(e["slug"]));
  set("version", str(e["version"]));
  set("entrypoint", str(e["entrypoint"]));
  if (info.type === "assistant" || info.type === "user") {
    const msg = e["message"];
    if (isObj(msg)) {
      const role = msg["role"];
      if (role === "assistant" || role === "user") info.role = role;
      set("messageId", str(msg["id"]));
      const model = str(msg["model"]);
      if (model && model !== "<synthetic>") info.model = model;
      if ("stop_reason" in msg) {
        const sr = msg["stop_reason"];
        info.stopReason = typeof sr === "string" ? sr : null;
      }
      const u = msg["usage"];
      if (isObj(u)) {
        info.usage = {
          input: num(u["input_tokens"]) ?? 0,
          output: num(u["output_tokens"]) ?? 0,
          cacheRead: num(u["cache_read_input_tokens"]) ?? 0,
          cacheCreate: num(u["cache_creation_input_tokens"]) ?? 0,
        };
        // Optional 5m/1h split of the cache writes; only the 1h share is carried (5m = the rest).
        const cc = u["cache_creation"];
        const w1h = isObj(cc) ? num(cc["ephemeral_1h_input_tokens"]) : undefined;
        if (w1h && w1h > 0) info.usage.cacheCreate1h = Math.min(w1h, info.usage.cacheCreate);
      }
    }
    if (bool(e["isApiErrorMessage"])) info.isApiError = true;
  }
  return info;
}

/** Session-level metadata carried on non-message lines. */
export function sessionMetaFromEntry(e: RawEntry): { customTitle?: string; agentName?: string; lastPrompt?: string } {
  switch (e["type"]) {
    case "custom-title": {
      const v = str(e["customTitle"]);
      return v ? { customTitle: v } : {};
    }
    case "agent-name": {
      const v = str(e["agentName"]);
      return v ? { agentName: v } : {};
    }
    case "last-prompt": {
      const v = str(e["lastPrompt"]);
      return v ? { lastPrompt: safeText(v, 300) } : {};
    }
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;

function contentBlocks(e: RawEntry): Block[] {
  const msg = e["message"];
  if (!isObj(msg)) return [];
  const c = msg["content"];
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (Array.isArray(c)) return c.filter(isObj);
  return [];
}

// ---------------------------------------------------------------------------
// Subagent spawns (Agent / Task tool_use) and task notifications
// ---------------------------------------------------------------------------

export interface SpawnInfo {
  toolUseId: string;
  description?: string;
  subagentType?: string;
  model?: string;
  background?: boolean;
  isolation?: string;
}

const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

export function extractSpawns(e: RawEntry): SpawnInfo[] {
  if (e["type"] !== "assistant") return [];
  const out: SpawnInfo[] = [];
  for (const b of contentBlocks(e)) {
    if (b["type"] !== "tool_use") continue;
    const name = str(b["name"]);
    const id = str(b["id"]);
    if (!name || !id || !AGENT_TOOL_NAMES.has(name)) continue;
    const input = isObj(b["input"]) ? b["input"] : {};
    const s: SpawnInfo = { toolUseId: id };
    const d = str(input["description"]);
    if (d) s.description = safeText(d, 300);
    const st = str(input["subagent_type"]);
    if (st) s.subagentType = st;
    const m = str(input["model"]);
    if (m) s.model = m;
    const bg = bool(input["run_in_background"]);
    if (bg !== undefined) s.background = bg;
    const iso = str(input["isolation"]);
    if (iso) s.isolation = iso;
    out.push(s);
  }
  return out;
}

/**
 * Count of tool_use blocks in an assistant entry, a one-line description of the last one ("Bash: npm test")
 * and the structured action of the last one (for "what is this agent doing right now").
 */
export function describeToolUses(e: RawEntry): { count: number; last?: string; action?: ToolAction } {
  if (e["type"] !== "assistant") return { count: 0 };
  let count = 0;
  let last: string | undefined;
  let action: ToolAction | undefined;
  for (const b of contentBlocks(e)) {
    if (b["type"] !== "tool_use") continue;
    count++;
    const name = str(b["name"]) ?? "tool";
    const summary = summarizeToolInput(name, b["input"], 120);
    last = summary ? `${name}: ${summary}` : name;
    action = describeAction(name, b["input"]);
  }
  const out: { count: number; last?: string; action?: ToolAction } = { count };
  if (last !== undefined) out.last = last;
  if (action) out.action = action;
  return out;
}

// ---------------------------------------------------------------------------
// Human-readable actions ("Komut çalıştırıyor: npm test") -- structured, the UI localises `kind`.
// ---------------------------------------------------------------------------

const ACTION_KINDS: Record<string, ActionKind> = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  PowerShell: "bash",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Read: "read",
  NotebookRead: "read",
  Grep: "search",
  Glob: "search",
  ToolSearch: "search",
  LS: "read",
  Agent: "agent",
  Task: "agent",
  WebFetch: "web",
  WebSearch: "web",
  TodoWrite: "todo",
  TaskCreate: "todo",
  TaskUpdate: "todo",
  SendMessage: "message",
  Skill: "skill",
};

export function describeAction(tool: string, input: unknown, max = 160): ToolAction {
  const kind: ActionKind = ACTION_KINDS[tool] ?? (tool.startsWith("mcp__") ? "mcp" : "other");
  const inp = isObj(input) ? input : {};
  let target: string;
  let dir: string | undefined;
  switch (kind) {
    case "edit":
    case "write":
    case "read": {
      const p = str(inp["file_path"]) ?? str(inp["notebook_path"]) ?? str(inp["path"]);
      target = p ? shortPath(p) : summarizeToolInput(tool, input, max);
      break;
    }
    case "search": {
      const pat = str(inp["pattern"]) ?? str(inp["query"]) ?? "";
      const where = str(inp["path"]) ?? str(inp["glob"]);
      target = where ? `${pat} · ${shortPath(where, 2)}` : pat;
      break;
    }
    case "mcp": {
      // mcp__server__tool -> "server · tool: first-arg"
      const [, server = "", name = ""] = tool.split("__");
      const arg = summarizeToolInput(tool, input, max);
      target = `${server} · ${name}${arg ? `: ${arg}` : ""}`;
      break;
    }
    case "bash": {
      // "cd /some/long/worktree && npm test" reads as "npm test"; the dir travels separately.
      const cmd = str(inp["command"]);
      if (cmd) {
        const sp = splitCdPrefix(cmd);
        target = sp.rest;
        if (sp.dir) dir = clipLine(sp.dir, 300);
      } else target = summarizeToolInput(tool, input, max + 512);
      break;
    }
    default:
      target = summarizeToolInput(tool, input, max + 512);
  }
  // Commands get more room: the UI shortens their paths client-side, which frees most of it again.
  const out: ToolAction = { tool, kind, target: clipLine(target, kind === "bash" ? Math.max(max, 400) : max) };
  if (dir) out.dir = dir;
  return out;
}

/** Timestamp (ms) of an assistant entry that carries at least one tool_use, else undefined. */
export function toolUseTime(e: RawEntry): number | undefined {
  if (e["type"] !== "assistant") return undefined;
  if (!contentBlocks(e).some((b) => b["type"] === "tool_use")) return undefined;
  const ts = str(e["timestamp"]);
  const ms = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** Tool-result of an Agent call carries `toolUseResult.agentId` -> links tool_use id to the agent transcript. */
export function extractAgentLinks(e: RawEntry): Array<{ toolUseId: string; agentId: string }> {
  if (e["type"] !== "user") return [];
  const tur = e["toolUseResult"];
  if (!isObj(tur)) return [];
  const agentId = str(tur["agentId"]);
  if (!agentId) return [];
  const results = contentBlocks(e).filter((b) => b["type"] === "tool_result");
  if (results.length !== 1) return [];
  const toolUseId = str(results[0]?.["tool_use_id"]);
  return toolUseId ? [{ toolUseId, agentId }] : [];
}

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
}

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  const v = m?.[1]?.trim();
  return v ? v : undefined;
}

function plainText(e: RawEntry): string {
  if (e["type"] === "queue-operation") return str(e["content"]) ?? "";
  return contentBlocks(e)
    .filter((b) => b["type"] === "text")
    .map((b) => str(b["text"]) ?? "")
    .join("\n");
}

export type TaskOutcome = "done" | "failed" | "stopped";

/**
 * Maps a task-notification `<status>` to how the task ended. Claude Code writes `completed`,
 * `failed` (API error, watchdog, crash) and `killed` (stopped by the user / TaskStop); the other
 * spellings are accepted defensively. Unknown statuses (e.g. progress updates) return undefined.
 */
export function notificationOutcome(status: string | undefined): TaskOutcome | undefined {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (/^(killed|stopped|cancel|abort|interrupt)/.test(s)) return "stopped";
  if (/^(failed|failure|error)/.test(s)) return "failed";
  if (/^(completed|complete|done|success)/.test(s)) return "done";
  return undefined;
}

export function extractTaskNotifications(e: RawEntry): TaskNotification[] {
  const t = e["type"];
  if (t !== "user" && !(t === "queue-operation" && e["operation"] === "enqueue")) return [];
  const text = plainText(e);
  if (!text.includes("<task-notification>")) return [];
  const out: TaskNotification[] = [];
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[1] ?? "";
    const taskId = tag(body, "task-id");
    if (!taskId) continue;
    const n: TaskNotification = { taskId };
    const u = tag(body, "tool-use-id");
    if (u) n.toolUseId = u;
    const s = tag(body, "status");
    if (s) n.status = s;
    const sum = tag(body, "summary");
    if (sum) n.summary = safeText(sum, 200);
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live stream events
// ---------------------------------------------------------------------------

export interface EventOptions {
  /** Max chars for tool results (default 2048). */
  maxResult?: number;
  /** Max chars for assistant/user text (default 4000). */
  maxText?: number;
  /** Max chars for a one-line tool input summary (default 240). */
  maxSummary?: number;
}

const SUMMARY_KEYS: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Agent: "description",
  Task: "description",
  SendMessage: "message",
  ToolSearch: "query",
  Skill: "skill",
};

export function summarizeToolInput(tool: string, input: unknown, max = 240): string {
  if (!isObj(input)) return typeof input === "string" ? safeText(oneLine(input), max) : "";
  const key = SUMMARY_KEYS[tool];
  let s: string | undefined = key ? anyToString(input[key]) : undefined;
  if (!s) {
    // Fall back: first short-ish string value, else compact JSON.
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.length > 0) {
        s = v;
        break;
      }
    }
  }
  if (!s) {
    try {
      s = JSON.stringify(input);
    } catch {
      s = "";
    }
  }
  return safeText(oneLine(s), max).replace(/\n/g, " ");
}

function anyToString(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!isObj(c)) return "";
        if (c["type"] === "text") return str(c["text"]) ?? "";
        if (c["type"] === "image") return "[image]";
        return `[${str(c["type"]) ?? "block"}]`;
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return "";
}

/** Which input fields are worth showing per tool, and how many chars each may carry. */
const DETAIL_FIELDS: Record<string, Array<[string, number]>> = {
  Bash: [["command", 4000], ["description", 300], ["run_in_background", 10]],
  Edit: [["file_path", 500], ["old_string", 3000], ["new_string", 3000], ["replace_all", 10]],
  Write: [["file_path", 500], ["content", 3000]],
  Read: [["file_path", 500], ["offset", 20], ["limit", 20]],
  NotebookEdit: [["notebook_path", 500], ["new_source", 3000]],
  Grep: [["pattern", 500], ["path", 500], ["glob", 200], ["type", 50], ["output_mode", 50]],
  Glob: [["pattern", 500], ["path", 500]],
  Agent: [["description", 300], ["subagent_type", 100], ["model", 100], ["prompt", 3000], ["run_in_background", 10], ["isolation", 50]],
  Task: [["description", 300], ["subagent_type", 100], ["model", 100], ["prompt", 3000], ["run_in_background", 10]],
  WebFetch: [["url", 1000], ["prompt", 1000]],
  WebSearch: [["query", 500]],
  Skill: [["skill", 200], ["args", 1000]],
  SendMessage: [["to", 200], ["message", 2000]],
};

/**
 * Structured, masked view of a tool_use input for the detail UI. Every value is a string passed
 * through safeText; unknown tools get nothing (the one-line summary is enough).
 */
export function toolDetail(tool: string, input: unknown): Record<string, string> | undefined {
  if (!isObj(input)) return undefined;
  const out: Record<string, string> = {};
  if (tool === "MultiEdit") {
    const fp = str(input["file_path"]);
    if (fp) out["file_path"] = safeText(fp, 500);
    const edits = Array.isArray(input["edits"]) ? input["edits"].filter(isObj) : [];
    out["edits"] = String(edits.length);
    const first = edits[0];
    if (first) {
      const o = str(first["old_string"]);
      const n = str(first["new_string"]);
      if (o) out["old_string"] = safeText(o, 3000);
      if (n) out["new_string"] = safeText(n, 3000);
    }
    return out;
  }
  const fields = DETAIL_FIELDS[tool];
  if (!fields) return undefined;
  for (const [k, max] of fields) {
    const v = anyToString(input[k]);
    if (v !== undefined) out[k] = safeText(v, max);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function toEvents(e: RawEntry, opts: EventOptions = {}): StreamEvent[] {
  const maxResult = opts.maxResult ?? 2048;
  const maxText = opts.maxText ?? 4000;
  const maxSummary = opts.maxSummary ?? 240;
  const type = e["type"];
  if (type !== "assistant" && type !== "user") return [];
  const uuid = str(e["uuid"]) ?? "";
  const ts = str(e["timestamp"]);
  const events: StreamEvent[] = [];
  const push = (idx: number, ev: Omit<StreamEvent, "id" | "ts">) => {
    const full: StreamEvent = { id: `${uuid}:${idx}`, ...ev };
    if (ts) full.ts = ts;
    events.push(full);
  };

  // Task notifications are user-role plumbing; show them as a compact notification.
  const notes = extractTaskNotifications(e);
  if (type === "user" && notes.length > 0) {
    notes.forEach((n, i) => {
      push(i, { kind: "notification", text: `task ${n.taskId} ${n.status ?? "update"}${n.summary ? ` - ${n.summary}` : ""}` });
    });
    return events;
  }

  contentBlocks(e).forEach((b, i) => {
    const bt = b["type"];
    if (type === "assistant") {
      if (bt === "text") {
        const t = str(b["text"])?.trim();
        if (t) push(i, { kind: "assistant", text: safeText(t, maxText) });
      } else if (bt === "thinking") {
        const t = str(b["thinking"])?.trim();
        if (t) push(i, { kind: "thinking", text: safeText(t, maxText) });
      } else if (bt === "tool_use") {
        const tool = str(b["name"]) ?? "tool";
        const ev: Omit<StreamEvent, "id" | "ts"> = {
          kind: "tool_use",
          tool,
          text: summarizeToolInput(tool, b["input"], maxSummary),
        };
        const tid = str(b["id"]);
        if (tid) ev.toolUseId = tid;
        const det = toolDetail(tool, b["input"]);
        if (det) ev.detail = det;
        push(i, ev);
      }
    } else {
      if (bt === "text") {
        const t = str(b["text"])?.trim();
        if (t && !t.startsWith("<system-reminder>") && e["isMeta"] !== true) push(i, { kind: "user", text: safeText(t, maxText) });
      } else if (bt === "tool_result") {
        const ev: Omit<StreamEvent, "id" | "ts"> = { kind: "tool_result", text: safeText(resultText(b["content"]), maxResult) };
        const tid = str(b["tool_use_id"]);
        if (tid) ev.toolUseId = tid;
        if (bool(b["is_error"])) ev.isError = true;
        push(i, ev);
      } else if (bt === "image") {
        push(i, { kind: "user", text: "[image]" });
      }
    }
  });
  return events;
}
