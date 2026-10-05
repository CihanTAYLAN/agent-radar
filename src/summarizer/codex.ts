/**
 * summarizer/codex.ts -- the ONLY module allowed to start a process or create a directory.
 * Backend "codex": one `codex exec` per summary, through the user's own Codex (ChatGPT) subscription.
 *
 * Narrow, deliberate exception to the read-only guarantee (enforced by tests/readonly.test.ts):
 *  - a fixed argv array, no shell; the prompt is a single argv element; stdin is /dev/null;
 *  - `--ephemeral` (no rollout files, so our runs never show up as Codex sessions), `-s read-only`,
 *    `--ignore-user-config`; never a `--dangerously-*` flag;
 *  - the only filesystem write is mkdtemp of our own empty scratch dir under os.tmpdir();
 *  - we never read ~/.codex/auth.json: the CLI does its own auth.
 * Data leaves the machine (masked excerpts to OpenAI) only when AGENT_RADAR_SUMMARIZER=codex.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { SummaryBackend } from "./index.js";

export const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
export const BREW_CODEX = "/opt/homebrew/bin/codex";
export const DEFAULT_MODEL = "gpt-6-luna";

export interface RunResult {
  stdout: string;
  code: number | null;
  timedOut: boolean;
}
/** Runs a binary with a fixed argv (no shell, stdin closed). Injected in tests. */
export type Runner = (bin: string, argv: string[], opts: { timeoutMs: number }) => Promise<RunResult>;

export interface CodexOptions {
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  exists?: (path: string) => boolean;
  /** Defaults to process.platform; only "darwin" uses the macOS app-bundle / Homebrew locations. */
  platform?: NodeJS.Platform;
  /** Creates the scratch dir (once); returns its path. */
  scratch?: () => string;
  timeoutMs?: number;
}

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** `codex` found by scanning the PATH directories (fs.access only, no `which`, no process). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = isExecutable): string | undefined {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolution order. darwin: AGENT_RADAR_CODEX_BIN, the desktop-bundled CLI, Homebrew.
 * Elsewhere (Linux/WSL): AGENT_RADAR_CODEX_BIN, then `codex` on PATH.
 */
export function resolveCodexBin(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = isExecutable,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const fromEnv = env["AGENT_RADAR_CODEX_BIN"]?.trim();
  if (fromEnv && exists(fromEnv)) return fromEnv;
  if (platform === "darwin") return [BUNDLED_CODEX, BREW_CODEX].find((p) => exists(p));
  return findOnPath("codex", env, exists);
}

/** The exact argv of one summary call. */
export function codexArgv(model: string, scratchDir: string, prompt: string): string[] {
  return ["exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only", "-C", scratchDir, "-m", model, "--json", prompt];
}

export interface CodexOutput {
  text?: string;
  error?: string;
  usage?: { input?: number; output?: number; cached?: number };
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Parses `codex exec --json` stdout (JSONL): final agent message, turn usage, error events. Stderr is never read. */
export function parseCodexJsonl(stdout: string): CodexOutput {
  const out: CodexOutput = {};
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = ev["type"];
    if (type === "item.completed") {
      const item = ev["item"] as { type?: unknown; text?: unknown } | undefined;
      if ((item?.type === "agent_message" || item?.type === "message") && typeof item.text === "string") out.text = item.text;
    } else if (type === "turn.completed") {
      const u = ev["usage"] as Record<string, unknown> | undefined;
      if (u) out.usage = { input: num(u["input_tokens"]), output: num(u["output_tokens"]), cached: num(u["cached_input_tokens"]) };
    } else if (type === "error") {
      out.error = str(ev["message"]) ?? "error";
    } else if (type === "turn.failed") {
      out.error = str((ev["error"] as { message?: unknown } | undefined)?.message) ?? "turn.failed";
    }
  }
  return out;
}

const defaultRun: Runner = (bin, argv, { timeoutMs }) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, killSignal: "SIGKILL" });
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size <= 2_000_000) chunks.push(b);
    });
    child.on("error", () => resolve({ stdout: "", code: null, timedOut: false }));
    child.on("close", (code, signal) => resolve({ stdout: Buffer.concat(chunks).toString("utf8"), code, timedOut: signal === "SIGKILL" }));
  });

/** Returns the backend, or a reason when no Codex CLI is available. */
export function createCodexBackend(opts: CodexOptions = {}): { backend?: SummaryBackend; reason?: string } {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const bin = resolveCodexBin(env, opts.exists, platform);
  if (!bin) return { reason: platform === "darwin" ? "Codex CLI bulunamadı (AGENT_RADAR_CODEX_BIN, ChatGPT.app veya Homebrew)" : "Codex CLI bulunamadı (AGENT_RADAR_CODEX_BIN veya PATH üzerinde codex)" };
  const model = env["AGENT_RADAR_SUMMARIZER_MODEL"]?.trim() || DEFAULT_MODEL;
  const run = opts.run ?? defaultRun;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let dir: string | undefined;
  const scratch = opts.scratch ?? (() => mkdtempSync(join(tmpdir(), "agent-radar-summarizer-")));
  return {
    backend: {
      id: "codex",
      label: "Codex",
      model,
      disclosure: "Özetler Codex aboneliği üzerinden OpenAI'ye gönderilir (maskeli)",
      async summarize(prompt: string): Promise<string> {
        dir ??= scratch();
        const r = await run(bin, codexArgv(model, dir, prompt), { timeoutMs });
        if (r.timedOut) throw new Error(`zaman aşımı (${Math.round(timeoutMs / 1000)} sn)`);
        const parsed = parseCodexJsonl(r.stdout);
        if (parsed.text?.trim()) return parsed.text;
        throw new Error(parsed.error ?? `boş yanıt (çıkış kodu ${r.code ?? "?"})`);
      },
    },
  };
}
