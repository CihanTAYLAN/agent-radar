/**
 * types.ts -- the provider-neutral shapes the HTTP API serves, and the Provider interface every agent
 * tool (Claude Code, Codex, ...) implements. Nothing in here knows any on-disk format.
 *
 * Session ids are global: the `claude-code` provider owns the bare namespace (its ids are UUID-ish and
 * never contain ':'), so existing deep links keep working; every other provider's session id is
 * `<providerId>:<nativeId>`. See sessionKey()/parseSessionKey() in common.ts.
 */

export type ProviderId = string;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Token usage. `input` is uncached input only; cache reads/writes are separate, so
 * `input + output + cacheRead + cacheCreate` is everything the model processed.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Claude only: the part of `cacheCreate` written with the 1-hour TTL (billed at a higher rate). Absent = none. */
  cacheCreate1h?: number;
}

// ---------------------------------------------------------------------------
// Human-readable actions ("Komut çalıştırıyor: npm test") -- structured, the UI localises `kind`.
// ---------------------------------------------------------------------------

export type ActionKind = "bash" | "edit" | "write" | "read" | "search" | "agent" | "web" | "todo" | "message" | "skill" | "mcp" | "other";

export interface ToolAction {
  tool: string;
  kind: ActionKind;
  /** Short, masked, single-line target (command, path, pattern, description, url...). */
  target: string;
  /** bash only: working directory (a stripped leading `cd <dir> &&`, or the tool's workdir; masked). */
  dir?: string;
}

// ---------------------------------------------------------------------------
// Live stream events
// ---------------------------------------------------------------------------

export type EventKind = "user" | "assistant" | "thinking" | "tool_use" | "tool_result" | "notification";

export interface StreamEvent {
  /** Stable within a file. */
  id: string;
  ts?: string;
  kind: EventKind;
  tool?: string;
  /**
   * tool_use only: how the UI should render the call. Omitted when the UI can infer it from `tool`
   * (Claude Code tool names); providers with other tool vocabularies set it.
   */
  action?: ActionKind;
  toolUseId?: string;
  text: string;
  isError?: boolean;
  /** tool_use only: selected, masked and truncated input fields for rich rendering. */
  detail?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Sessions and agent trees
// ---------------------------------------------------------------------------

export type AgentState = "running" | "idle" | "done" | "failed" | "stopped" | "stalled";

export interface AgentNode {
  /** "main" or the agent id (unique within the session). */
  key: string;
  provider: ProviderId;
  label: string;
  agentType: string;
  model?: string;
  mode: "main" | "background" | "foreground" | "unknown";
  state: AgentState;
  startedAt?: number;
  lastActivityAt?: number;
  durationMs: number;
  usage: Usage;
  totalTokens: number;
  messages: number;
  toolCalls: number;
  lastTool?: string;
  /** Latest tool call as a structured action (only while running). */
  lastAction?: ToolAction;
  /** failed/stopped only: why it ended (masked). */
  endReason?: string;
  /** Last activity for finished agents (bar end on the timeline); absent while running. */
  endedAt?: number;
  /** Tool-call times as whole seconds after startedAt (deduplicated, ascending). */
  ticks: number[];
  /** Estimated cost in USD (see pricing.ts) of the usage whose model price is known. */
  costUsd: number;
  /** Some usage has no known price: costUsd is then a lower bound (0 = unknown, shown as "—"). */
  costPartial?: boolean;
  /** The tool call id that spawned this agent (links spawn cards to agents). */
  toolUseId?: string;
  spawnDepth?: number;
  workflow?: string;
  worktreeBranch?: string;
  /** Provider-specific summary facts (Turkish label -> value, masked) shown as an "Özet" block in the drawer. */
  meta?: Record<string, string | number>;
  parentKey: string | null;
  children: AgentNode[];
}

export interface ActivityBuckets {
  /** Epoch ms of the start of the newest bucket. */
  end: number;
  counts: number[];
}

export interface SessionSummary {
  /** Global session id (see the header comment). */
  id: string;
  provider: ProviderId;
  projectDir: string;
  cwd: string;
  live: boolean;
  pid?: number;
  status?: string;
  statusUpdatedAt?: number;
  name: string;
  entrypoint?: string;
  version?: string;
  kind?: string;
  startedAt?: number;
  firstActivityAt?: number;
  lastActivityAt: number;
  hasTranscript: boolean;
  gitBranch?: string;
  model?: string;
  lastPrompt?: string;
  agentCount: number;
  runningAgents: number;
  usage: Usage;
  totalTokens: number;
  /** Estimated cost in USD (see pricing.ts) of the usage whose model price is known. */
  costUsd: number;
  /** Some usage has no known price: costUsd is then a lower bound (0 = unknown, shown as "—"). */
  costPartial?: boolean;
  /** Transcript entries per minute; `counts[counts.length - 1]` is the minute starting at `end`. */
  activity: ActivityBuckets;
}

export interface SessionDetail extends SessionSummary {
  tree: AgentNode;
  usageByModel: Record<string, Usage>;
  /** null for a model whose price is unknown. */
  costByModel: Record<string, number | null>;
  usageMain: Usage;
  usageSubagents: Usage;
}

/** Machine-wide counters for the top bar. "Today" is the server's local calendar day. */
export interface MachineSummary {
  liveSessions: number;
  runningAgents: number;
  finishedToday: number;
  outputToday: number;
  /** Sum of the known estimates (unknown-price usage is left out). */
  costToday: number;
}

export interface EventQuery {
  tail?: number;
  after?: number;
  before?: number;
}

export interface EventsResult {
  events: StreamEvent[];
  /** Byte cursor: pass as `after` to get only newer events. */
  cursor: number;
  /** Byte offset where the returned window starts: pass as `before` to page older events. */
  start: number;
  /** True when older events than the returned window exist (tail mode) or events were skipped (after mode). */
  truncated: boolean;
  /** The file shrank/was replaced; the client should discard what it has. */
  reset: boolean;
}

// ---------------------------------------------------------------------------
// Provider health
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Event stream (text / tool calls / results) per agent. */
  transcript: boolean;
  /** Token usage. */
  tokens: boolean;
  /** Tool calls are visible (current action, tool counts). */
  tools: boolean;
  /** Agent tree beyond the main agent. */
  subagents: boolean;
  /** Dollar estimates exist for (at least some of) its models. */
  cost: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  /** Neutral 1-3 letter mark for badges (never a vendor logo). */
  mark: string;
  /** The tool's home directory exists. */
  installed: boolean;
  /** Session data was found in it. */
  dataFound: boolean;
  /** Sessions currently listed / live. */
  sessions: number;
  active: number;
  lastActivityAt?: number;
  capabilities: ProviderCapabilities;
  /** Short Turkish notes, e.g. "yalnızca özet", "doğrulanmadı". */
  notes: string[];
  /** Home directory shown in the panel (masked, `~`-relative when under the user's home). */
  home?: string;
}

// ---------------------------------------------------------------------------
// The provider interface
// ---------------------------------------------------------------------------

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** True until the first discovery pass completed. */
  readonly loading: boolean;

  start(): void;
  stop(): void;
  /** One scan pass; `full` forces re-discovery. Safe to call concurrently. */
  scan(full?: boolean): Promise<void>;
  /** Called after a scan with the (global) ids of sessions that changed. */
  onChange(fn: (sessionIds: string[]) => void): void;

  /** Every listed session, with global ids and `provider` set. */
  listSessions(): SessionSummary[];
  /** `nativeId` is the id without the provider prefix. */
  isSessionId(nativeId: string): boolean;
  getSession(nativeId: string): SessionDetail | undefined;
  readEvents(nativeId: string, agentKey: string, q: EventQuery): Promise<EventsResult | undefined>;

  machine(): MachineSummary;
  status(): ProviderStatus;
}

/** What a provider factory gets from the entry point. */
export interface ProviderContext {
  env: NodeJS.ProcessEnv;
  userHome: string;
  recentMs: number;
}

export interface ProviderFactory {
  id: ProviderId;
  label: string;
  create(ctx: ProviderContext): Provider;
}
