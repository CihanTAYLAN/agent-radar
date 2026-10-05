/**
 * topics.ts -- "Konular": a deterministic, semantic summary of what work is going on. Pure functions
 * over the in-memory session/agent projections (titles, subagent descriptions, branches, cwd) and the
 * tool actions the providers already parse. No model, no network, no disk: it collects nothing new.
 *
 * Grouping: project + ticket key, else project + PR, else project + normalised title (token Jaccard
 * >= 0.6). Main agents of big orchestration sessions do not swallow their subagents: the subagents'
 * own descriptions decide their topics and the main agent follows its session's dominant topic (or
 * lands in "Orkestrasyon").
 */
import { createHash } from "node:crypto";
import type { ActionKind, AgentState, ToolAction } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

/** Prefixes that look like ticket keys but are standards, algorithms, versions, ... */
const TICKET_STOP = new Set([
  "UTF", "SHA", "ISO", "HTTP", "HTTPS", "TLS", "SSL", "RFC", "CVE", "AES", "RSA", "MD", "IPV", "GPT", "ECMA", "TCP", "UDP", "HS", "RS", "ES", "PBKDF",
  "COVID", "SQL", "PDF", "USB", "WIN", "ASCII", "BASE", "OAUTH", "H", "X", "IEEE", "ANSI", "RGB", "HSL", "CRC", "BLAKE", "SHAKE", "HMAC", "ARM", "AMD",
  "GHSA", "PEP", "NODE", "PYTHON", "LLAMA", "CLAUDE", "OPUS", "SONNET", "HAIKU", "QWEN", "GEMINI", "CODEX", "UNICODE", "UTC", "GMT", "IPV", "OS", "IOS", "MACOS",
  "ED", "ECDSA", "EC", "SM", "DES", "RC", "CBC", "GCM", "CTR", "ECB", "POSIX", "LTS", "ES", "TS", "JS", "CSS", "HTML",
]);

const TICKET_RE = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]+)-(\d{1,6})(?![A-Za-z0-9]|-\d)/g;

/** Ticket keys in `text`; only prefixes outside the stoplist. Order of appearance, de-duplicated. */
export function extractTickets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TICKET_RE)) {
    const prefix = m[1] as string;
    if (TICKET_STOP.has(prefix) || prefix.length > 10) continue;
    const key = `${prefix}-${m[2]}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Same as extractTickets, but case-insensitive for prefixes already known to be real (e.g. "proj-2823" in a prompt). */
export function extractTicketsLoose(text: string, knownPrefixes: ReadonlySet<string>): string[] {
  const out = extractTickets(text);
  for (const m of text.matchAll(/(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]+)-(\d{1,6})(?![A-Za-z0-9]|-\d)/g)) {
    const prefix = (m[1] as string).toUpperCase();
    if (!knownPrefixes.has(prefix)) continue;
    const key = `${prefix}-${m[2]}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** PR numbers named in a title/description: "PR 4069", "PR #4069", "#4069" (not HTML entities like "&#x20;"). */
export function extractPrsFromText(text: string): number[] {
  const out: number[] = [];
  const add = (s: string | undefined): void => {
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  };
  for (const m of text.matchAll(/\bPRs?\s*#?(\d{1,6})\b/gi)) add(m[1]);
  for (const m of text.matchAll(/(?<![\w&])#(\d{1,6})\b/g)) add(m[1]);
  return out;
}

/** PR number of a shell command: `gh pr checks 4121`, `gh pr view https://github.com/o/r/pull/12`. */
export function extractPrFromCommand(cmd: string): number | undefined {
  const url = /\/pull\/(\d{1,6})\b/.exec(cmd);
  if (url && /\bgh\b/.test(cmd)) return Number(url[1]);
  const m = /\bgh\s+pr\s+(.*)/s.exec(cmd);
  if (!m) return undefined;
  const toks = (m[1] as string).split(/[\s;|&]+/);
  const valueFlags = new Set(["--limit", "-L", "--json", "--jq", "-q", "--repo", "-R", "--body", "-b", "--title", "-t", "--base", "-B", "--head", "-H", "--search", "-S", "--state", "-s", "--author", "-A", "--label", "-l", "--assignee", "-a", "--template", "-p", "--milestone", "-m"]);
  let skip = false;
  for (const t of toks.slice(1)) {
    if (skip) {
      skip = false;
      continue;
    }
    if (t.startsWith("-")) {
      if (valueFlags.has(t) && !t.includes("=")) skip = true;
      continue;
    }
    const n = /^#?(\d{1,6})$/.exec(t);
    if (n) return Number(n[1]);
    const u = /\/pull\/(\d{1,6})/.exec(t);
    if (u) return Number(u[1]);
  }
  return undefined;
}

/** Directory of an edited file, relative to the repo, collapsed to a meaningful module path (<= 5 segments). */
export function moduleOf(filePath: string, cwd = "", home = ""): string | undefined {
  let p = filePath.trim().replace(/\\/g, "/");
  if (!p || p.includes("\n")) return undefined;
  p = p.replace(/^.*?\/\.claude\/worktrees\/[^/]+\//, "/__wt__/").replace(/^\.claude\/worktrees\/[^/]+\//, "");
  if (p.startsWith("/__wt__/")) p = p.slice("/__wt__/".length);
  else {
    const c = cwd.replace(/\/+$/, "").replace(/\/\.claude\/worktrees\/[^/]+$/, "");
    if (c && p.startsWith(`${c}/`)) p = p.slice(c.length + 1);
    else if (home && p.startsWith(`${home}/`)) p = `~/${p.slice(home.length + 1)}`;
    else if (p.startsWith("/")) p = p.slice(1);
  }
  const segs = p.split("/").filter((s) => s && s !== "." && s !== "..");
  segs.pop(); // the file name
  const drop = new Set(["__tests__", "tests", "test", "spec", "__mocks__", "fixtures", "dist", "build"]);
  while (segs.length && drop.has(segs[segs.length - 1] as string)) segs.pop();
  if (segs.length === 0) return undefined;
  return segs.slice(0, 5).join("/");
}

/** "apps/api/src/modules/email" -> "api/email" (structural directories dropped, last two kept). */
export function shortModule(mod: string): string {
  const skip = new Set(["apps", "packages", "libs", "lib", "src", "modules", "app", "source"]);
  const segs = mod.split("/").filter((s) => !skip.has(s));
  return (segs.length ? segs : mod.split("/")).slice(-2).join("/");
}

/** Project = last folder of the cwd (worktree suffixes stripped); the home folder is "~". */
export function projectOf(cwd: string, home = ""): string {
  const c = cwd.replace(/\/+$/, "").replace(/\/\.claude\/worktrees\/[^/]+$/, "");
  if (!c || c === home) return "~";
  return c.split("/").pop() || "~";
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "fix", "add", "update", "check", "run", "make", "use", "new", "all", "not", "are", "bir", "ile", "için", "ve", "bu", "şu", "her",
  "den", "dan", "gibi", "daha", "olan", "yap", "yapma", "kontrol", "et", "ama", "veya", "sonra", "önce",
]);
const GENERIC_WORDS = ["selam", "merhaba", "naber", "canım", "master", "masteng", "greeting", "casual", "turkish", "hello", "goal", "test", "deneme", "yeni", "sohbet", "chat", "session", "oturum", "selamlaşma"];
const GENERIC = new Set(GENERIC_WORDS.map((w) => w.slice(0, 5)));
/** Verbs/nouns of dev work that say nothing about the subject ("fix", "audit", "page"...). */
const DEV_WORDS = [
  "remove", "verify", "check", "audit", "scan", "build", "refresh", "update", "write", "gather", "measure", "declare", "bump", "prune", "only", "page", "pages", "analysis", "review", "plan",
  "investigation", "cleanup", "clean", "sweep", "alert", "done", "read", "prod", "production", "with", "after", "before", "other", "finish", "compress", "apply", "state", "issue", "issues", "work",
  "kontrol", "incele", "inceleme", "düzelt", "ekle", "sil", "tara", "ölç", "hazırla", "bitir", "sonra", "önce", "test", "tests", "script", "config", "code", "case", "cases", "part", "parts", "slice",
  "step", "steps", "task", "tasks", "final", "full", "real", "data", "make", "sure", "ready", "readiness",
];
const DEV = new Set(DEV_WORDS.map((w) => w.slice(0, 5)));

/** Title tokens for similarity: lowercased, numbers/punctuation stripped, 5-char prefixes (crude Turkish/English stemming). */
export function titleTokens(title: string): string[] {
  const words = title.toLocaleLowerCase("tr").replace(/[^\p{L}\s]+/gu, " ").split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (!/[aeıioöuüy]/.test(w)) continue; // "cff", "xkcd": not a word
    const t = w.slice(0, 5);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const x of new Set(a)) if (sb.has(x)) inter++;
  return inter / (new Set(a).size + sb.size - inter);
}

/** True when a title says something (>= 2 informative tokens, not a greeting / hash / markup). */
export function informativeTitle(title: string): boolean {
  const t = title.trim();
  if (!t || /^[0-9a-f]{6,}$/i.test(t) || /^[<#]/.test(t)) return false;
  const toks = titleTokens(t).filter((x) => !GENERIC.has(x));
  return toks.length >= 2;
}

/** A title without its ticket key / PR prefix and leading punctuation. */
export function cleanTitle(title: string, keys: readonly string[] = []): string {
  let t = title.replace(/^\/goal\b\s*/i, "").replace(/\s+/g, " ").trim();
  for (const k of keys) t = t.split(k).join(" ");
  t = t.replace(/^[\s:–—\-·|,.()[\]]+/, "").replace(/[\s:–—\-·|,.([]+$/, "").replace(/\s+/g, " ");
  return t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

const VERB: Record<ActionKind, string> = {
  bash: "Komut çalıştırıyor",
  edit: "Düzenliyor",
  write: "Yazıyor",
  read: "Okuyor",
  search: "Arıyor",
  agent: "Alt ajan başlattı",
  web: "Web'e bakıyor",
  todo: "Görev listesini güncelliyor",
  message: "Mesaj gönderiyor",
  skill: "Skill kullanıyor",
  mcp: "Entegrasyon çağırıyor",
  other: "Araç kullanıyor",
};

/** The interesting part of a shell one-liner: strips `cd x &&`, `timeout N`, loop scaffolding and trailing flags. */
export function bashCore(cmd: string): string {
  const c = cmd.replace(/^cd\s+\S+\s*&&\s*/, "").replace(/\s\d?>&?\d*/g, " >");
  const m = /\b(gh|git|npm|pnpm|yarn|npx|docker|aws|gcloud|psql|curl|terraform|kubectl|vitest|tsc|make)\s+[^;|&>\n]*/.exec(c);
  if (!m) return c;
  return m[0].replace(/\s+\d*>.*$/, "").replace(/\s+--?[A-Za-z][\w-]*(?:[= ]\S+)?(?=\s|$).*$/, "").trim();
}

/** "Komut çalıştırıyor gh pr checks 4121" -- single line, short. */
export function describeAction(a: ToolAction): string {
  let target = (a.target || a.tool || "").replace(/\s+/g, " ").trim();
  if (a.kind === "bash") target = bashCore(target);
  if (target.length > 60) target = `${target.slice(0, 59)}…`;
  return `${VERB[a.kind] ?? VERB.other} ${target}`.trim();
}

// ---------------------------------------------------------------------------
// Observed actions (in-memory only): providers expose just the pending tool call of a running agent,
// so the Radar samples it on every change and remembers edited paths and PR numbers per agent.
// ---------------------------------------------------------------------------

export interface AgentActivity {
  /** directory -> hits */
  paths: Map<string, number>;
  prs: number[];
}

export class ActionMemory {
  private readonly m = new Map<string, AgentActivity>();
  constructor(private readonly maxAgents = 3000) {}

  observe(sessionId: string, agentKey: string, action: ToolAction | undefined, cwd: string, home: string): void {
    if (!action) return;
    const id = `${sessionId}|${agentKey}`;
    let rec = this.m.get(id);
    const isFileWrite = (action.kind === "edit" || action.kind === "write") && action.target;
    const pr = action.kind === "bash" ? extractPrFromCommand(action.target ?? "") : undefined;
    if (!isFileWrite && pr === undefined) return;
    if (!rec) {
      if (this.m.size >= this.maxAgents) this.m.delete(this.m.keys().next().value as string);
      rec = { paths: new Map(), prs: [] };
      this.m.set(id, rec);
    }
    if (isFileWrite) {
      for (const f of action.target.split(/\n/)) {
        const mod = moduleOf(f, cwd, home);
        if (mod && (rec.paths.size < 30 || rec.paths.has(mod))) rec.paths.set(mod, (rec.paths.get(mod) ?? 0) + 1);
      }
    }
    if (pr !== undefined && !rec.prs.includes(pr)) rec.prs.push(pr);
  }

  get(sessionId: string, agentKey: string): AgentActivity | undefined {
    return this.m.get(`${sessionId}|${agentKey}`);
  }
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export interface TopicAgentInput {
  sessionId: string;
  sessionName: string;
  provider: string;
  cwd: string;
  isMain: boolean;
  /** Main agent only: session git branch and last user prompt. */
  gitBranch?: string;
  lastPrompt?: string;
  agentKey: string;
  label: string;
  agentType?: string;
  state: AgentState;
  startedAt?: number;
  lastActivityAt?: number;
  costUsd: number;
  costPartial?: boolean;
  worktreeBranch?: string;
  lastAction?: ToolAction;
  activity?: AgentActivity;
}

export interface TopicAgent {
  sessionId: string;
  sessionName: string;
  key: string;
  label: string;
  provider: string;
  state: AgentState;
  isMain: boolean;
  lastActivityAt: number;
}

export type TopicKind = "ticket" | "pr" | "title" | "orchestration" | "other";

export interface Topic {
  id: string;
  kind: TopicKind;
  /** Ticket key ("PROJ-2742") or "PR #4121"; absent for title/other topics. */
  key?: string;
  title: string;
  project: string;
  providers: string[];
  counts: { running: number; done: number; failed: number; total: number };
  firstAt: number;
  lastAt: number;
  costUsd: number;
  costPartial: boolean;
  modules: string[];
  recent: string[];
  summary: string;
  agents: TopicAgent[];
  llmSummary?: string;
  llmAt?: number;
}

export interface TopicOptions {
  home?: string;
  /** Agents per topic returned in `agents`. */
  maxAgents?: number;
}

interface Classified {
  a: TopicAgentInput;
  project: string;
  slot: string; // grouping key before near-duplicate merge
  kind: TopicKind;
  key?: string;
  title: string;
  ticketLabel: boolean;
}

const JACCARD_MERGE = 0.6;
const RUNNING = new Set<AgentState>(["running", "stalled"]);

function ticketOfAgent(a: TopicAgentInput, prefixes: ReadonlySet<string>, allowPrompt: boolean): string | undefined {
  const sources = a.isMain ? [a.sessionName, a.gitBranch ?? ""] : [a.label, a.worktreeBranch ?? ""];
  for (const s of sources) {
    const t = extractTickets(s)[0];
    if (t) return t;
  }
  if (allowPrompt && a.lastPrompt) return extractTicketsLoose(a.lastPrompt.slice(0, 300), prefixes)[0];
  return undefined;
}

function prOfAgent(a: TopicAgentInput, fromActions: boolean): number | undefined {
  const text = a.isMain ? a.sessionName : a.label;
  const t = extractPrsFromText(text)[0];
  if (t !== undefined) return t;
  if (!fromActions) return undefined;
  const cur = a.lastAction?.kind === "bash" ? extractPrFromCommand(a.lastAction.target ?? "") : undefined;
  return cur ?? a.activity?.prs[a.activity.prs.length - 1];
}

/** Builds the topic list (unordered; see sortTopics). */
export function buildTopics(agents: readonly TopicAgentInput[], opts: TopicOptions = {}): Topic[] {
  const home = opts.home ?? "";
  const maxAgents = opts.maxAgents ?? 200;

  // Ticket prefixes seen in strict matches anywhere: lets "proj-2823" in a prompt count.
  const prefixes = new Set<string>();
  for (const a of agents) for (const t of extractTickets(`${a.sessionName} ${a.label} ${a.gitBranch ?? ""} ${a.worktreeBranch ?? ""}`)) prefixes.add(t.split("-")[0] as string);

  const bySession = new Map<string, TopicAgentInput[]>();
  for (const a of agents) {
    const l = bySession.get(a.sessionId);
    if (l) l.push(a);
    else bySession.set(a.sessionId, [a]);
  }

  const classify = (a: TopicAgentInput, subCount: number): Classified => {
    const project = projectOf(a.cwd, home);
    const base = { a, project } as const;
    const orchestrator = a.isMain && subCount >= 3;
    const ticket = ticketOfAgent(a, prefixes, !(a.isMain && subCount > 0));
    if (ticket) return { ...base, kind: "ticket", key: ticket, slot: `t|${project}|${ticket}`, title: cleanTitle(a.isMain ? a.sessionName : a.label, [ticket]), ticketLabel: true };
    const pr = prOfAgent(a, !orchestrator);
    if (pr !== undefined) return { ...base, kind: "pr", key: `PR #${pr}`, slot: `p|${project}|${pr}`, title: cleanTitle(a.isMain ? a.sessionName : a.label, [`PR #${pr}`, `PR ${pr}`, `#${pr}`]), ticketLabel: false };
    const label = a.isMain ? a.sessionName : a.label;
    if (informativeTitle(label)) return { ...base, kind: "title", slot: `n|${project}`, title: cleanTitle(label), ticketLabel: false };
    return { ...base, kind: "other", slot: `o|${project}`, title: "", ticketLabel: false };
  };

  // 1) Subagents decide their own topics; 2) mains follow their session's dominant topic.
  const cls: Classified[] = [];
  const mains: { a: TopicAgentInput; subs: Classified[] }[] = [];
  for (const list of bySession.values()) {
    const subs = list.filter((x) => !x.isMain);
    const subClassified = subs.map((x) => classify(x, 0));
    cls.push(...subClassified);
    for (const m of list.filter((x) => x.isMain)) mains.push({ a: m, subs: subClassified });
  }
  for (const { a, subs } of mains) {
    const own = classify(a, subs.length);
    const project = projectOf(a.cwd, home);
    const explicit = (own.kind === "ticket" && own.ticketLabel) || own.kind === "pr";
    if (subs.length === 0 || explicit) {
      cls.push(own);
      continue;
    }
    const tally = new Map<string, { n: number; c: Classified }>();
    for (const s of subs) {
      if (s.kind !== "ticket" && s.kind !== "pr") continue;
      const e = tally.get(s.slot);
      if (e) e.n++;
      else tally.set(s.slot, { n: 1, c: s });
    }
    const top = [...tally.values()].sort((x, y) => y.n - x.n)[0];
    if (top && top.n / subs.length >= 0.5) cls.push({ ...top.c, a });
    else if (subs.length >= 3) cls.push({ a, project, kind: "orchestration", slot: `r|${project}`, title: "Orkestrasyon", ticketLabel: false });
    else cls.push(own);
  }

  // Title groups: merge near-duplicates (greedy, largest first) inside a project; weak singletons go to "other".
  const groups = new Map<string, Classified[]>();
  const titleByProject = new Map<string, { tokens: string[]; slot: string }[]>();
  for (const c of cls) {
    let slot = c.slot;
    if (c.kind === "title") {
      const toks = titleTokens(c.title);
      const known = titleByProject.get(c.project) ?? [];
      const hit = known.find((k) => jaccard(k.tokens, toks) >= JACCARD_MERGE);
      if (hit) slot = hit.slot;
      else {
        slot = `n|${c.project}|${toks.slice().sort().join(" ")}`;
        known.push({ tokens: toks, slot });
        titleByProject.set(c.project, known);
      }
    }
    const g = groups.get(slot);
    if (g) g.push(c);
    else groups.set(slot, [c]);
  }
  // A title topic needs a main-agent (session) member or >= 2 members; otherwise it is too weak to be a topic.
  for (const [slot, members] of [...groups]) {
    if (!slot.startsWith("n|")) continue;
    if (members.length >= 2 || members.some((m) => m.a.isMain)) continue;
    groups.delete(slot);
    const project = (members[0] as Classified).project;
    const other = groups.get(`o|${project}`) ?? [];
    other.push(...members.map((m) => ({ ...m, kind: "other" as const, slot: `o|${project}` })));
    groups.set(`o|${project}`, other);
  }

  clusterLoose(groups);

  return [...groups.entries()].map(([slot, members]) => finishTopic(slot, members, home, maxAgents));
}

/**
 * Keyless subagents whose titles share a distinctive word ("Supabase ...", "payment-reconciliation ...")
 * form a topic of their own inside their project: a word must occur in >= 3 of the bucket's subagents,
 * in at most 60% of them, and every agent joins the most widespread such word it carries.
 */
function clusterLoose(groups: Map<string, Classified[]>): void {
  for (const [slot, members] of [...groups]) {
    if (!slot.startsWith("o|")) continue;
    const subs = members.filter((m) => !m.a.isMain);
    if (subs.length < 5) continue;
    const words = new Map<Classified, string[]>();
    const df = new Map<string, number>();
    const shown = new Map<string, Map<string, number>>();
    for (const m of subs) {
      const toks = titleTokens(m.a.label).filter((t) => !DEV.has(t) && !GENERIC.has(t));
      words.set(m, toks);
      for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
      for (const w of m.a.label.toLocaleLowerCase("tr").replace(/[^\p{L}\s]+/gu, " ").split(/\s+/)) {
        const t = w.slice(0, 5);
        if (w.length >= 3 && toks.includes(t)) {
          const f = shown.get(t) ?? new Map<string, number>();
          f.set(w, (f.get(w) ?? 0) + 1);
          shown.set(t, f);
        }
      }
    }
    const usable = (t: string): boolean => (df.get(t) ?? 0) >= 3 && (df.get(t) ?? 0) <= subs.length * 0.6;
    const moved = new Set<Classified>();
    for (const m of subs) {
      const best = (words.get(m) ?? []).filter(usable).sort((x, y) => (df.get(y) ?? 0) - (df.get(x) ?? 0) || y.length - x.length)[0];
      if (!best) continue;
      const project = m.project;
      const target = `c|${project}|${best}`;
      const name = [...(shown.get(best) ?? [])].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0]?.[0] ?? best;
      const g = groups.get(target) ?? [];
      g.push({ ...m, kind: "title", slot: target, title: name.charAt(0).toLocaleUpperCase("tr") + name.slice(1) });
      groups.set(target, g);
      moved.add(m);
    }
    // A cluster that ended up with fewer than 3 agents is not a topic: give its members back.
    for (const [target, g] of [...groups]) {
      if (!target.startsWith(`c|${(members[0] as Classified).project}|`) || g.length >= 3) continue;
      for (const c of g) for (const m of moved) if (m.a === c.a) moved.delete(m);
      groups.delete(target);
    }
    const rest = members.filter((m) => !moved.has(m));
    if (rest.length) groups.set(slot, rest);
    else groups.delete(slot);
  }
}

function finishTopic(slot: string, members: Classified[], home: string, maxAgents: number): Topic {
  const first = members[0] as Classified;
  const project = first.project;
  const kind = first.kind === "other" || slot.startsWith("o|") ? "other" : slot.startsWith("r|") ? "orchestration" : first.kind;

  let title: string;
  if (kind === "other") title = `Diğer · ${project}`;
  else if (kind === "orchestration") {
    const names = [...new Set(members.map((m) => m.a.sessionName))];
    title = `Orkestrasyon · ${cleanTitle(names[0] ?? "").slice(0, 40)}${names.length > 1 ? ` +${names.length - 1}` : ""}`;
  }
  else {
    // Most frequent cleaned label wins; ties go to the longest. Session names only if no subagent label exists.
    const pool = slot.startsWith("c|") ? members : members.filter((m) => m.title).filter((m) => !m.a.isMain || members.every((x) => x.a.isMain));
    const src = pool.length ? pool : members.filter((m) => m.title);
    const freq = new Map<string, number>();
    for (const m of src) freq.set(m.title.toLocaleLowerCase("tr"), (freq.get(m.title.toLocaleLowerCase("tr")) ?? 0) + 1);
    const best = [...src].sort((a, b) => (freq.get(b.title.toLocaleLowerCase("tr")) ?? 0) - (freq.get(a.title.toLocaleLowerCase("tr")) ?? 0) || b.title.length - a.title.length)[0];
    title = best?.title || first.key || project;
  }

  const counts = { running: 0, done: 0, failed: 0, total: members.length };
  const providers = new Set<string>();
  let firstAt = Infinity;
  let lastAt = 0;
  let cost = 0;
  let partial = false;
  const mods = new Map<string, number>();
  const running: { at: number; text: string }[] = [];
  for (const { a } of members) {
    if (RUNNING.has(a.state)) counts.running++;
    else if (a.state === "failed") counts.failed++;
    else counts.done++;
    providers.add(a.provider);
    const act = a.lastActivityAt ?? a.startedAt ?? 0;
    lastAt = Math.max(lastAt, act);
    firstAt = Math.min(firstAt, a.startedAt ?? act ?? Infinity);
    cost += a.costUsd || 0;
    if (a.costPartial) partial = true;
    for (const [mod, n] of a.activity?.paths ?? []) mods.set(mod, (mods.get(mod) ?? 0) + n);
    if (a.lastAction && (a.state === "running" || a.state === "stalled")) running.push({ at: act, text: describeAction(a.lastAction) });
  }
  if (!Number.isFinite(firstAt)) firstAt = lastAt;
  const modules = [...mods.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([m]) => m);
  const recent = running.sort((x, y) => y.at - x.at).slice(0, 3).map((r) => r.text);

  const agents: TopicAgent[] = members
    .map(({ a }) => ({ sessionId: a.sessionId, sessionName: a.sessionName, key: a.agentKey, label: a.isMain ? "Ana ajan" : a.label, provider: a.provider, state: a.state, isMain: a.isMain, lastActivityAt: a.lastActivityAt ?? 0 }))
    .sort((x, y) => Number(RUNNING.has(y.state)) - Number(RUNNING.has(x.state)) || y.lastActivityAt - x.lastActivityAt)
    .slice(0, maxAgents);

  const key = kind === "ticket" || kind === "pr" ? first.key : undefined;
  const id = createHash("sha1").update(slot).digest("hex").slice(0, 10);
  const topic: Topic = { id, kind, ...(key ? { key } : {}), title, project, providers: [...providers].sort(), counts, firstAt, lastAt, costUsd: cost, costPartial: partial, modules, recent, summary: "", agents };
  topic.summary = summarize(topic);
  return topic;
}

/** Deterministic one-liner from the facts. */
export function summarize(t: Topic): string {
  const parts = [`${t.counts.total} ajan`];
  if (t.counts.running) parts.push(`${t.counts.running} çalışıyor`);
  if (t.counts.failed) parts.push(`${t.counts.failed} başarısız`);
  if (t.recent[0]) parts.push(`son: ${t.recent[0]}`);
  if (t.modules.length) parts.push(`modüller: ${t.modules.map(shortModule).join(", ")}`);
  return parts.join(" · ");
}

/** Running topics first, then by last activity; "Diğer" buckets last. */
export function sortTopics(topics: Topic[]): Topic[] {
  const rank = (t: Topic): number => (t.kind === "other" ? 1 : 0);
  return [...topics].sort((a, b) => rank(a) - rank(b) || Number(b.counts.running > 0) - Number(a.counts.running > 0) || b.lastAt - a.lastAt || a.id.localeCompare(b.id));
}

/** "24h" / "90m" / "7d" -> milliseconds; undefined when malformed. */
export function parseWindow(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return 24 * 3600_000;
  const m = /^(\d{1,4})([mhd])$/.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n < 1) return undefined;
  return n * ({ m: 60_000, h: 3600_000, d: 86_400_000 } as Record<string, number>)[m[2] as string]!;
}
