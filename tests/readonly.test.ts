import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDeniedPath, safeToRead } from "../src/providers/guard.js";

/**
 * Deterministic guard for the "strictly read-only" promise: the server sources must not use any
 * fs mutation API, and must only ever call process.kill with signal 0 (existence check).
 */
const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
/**
 * The single, deliberate exception: the optional Codex summarizer backend spawns `codex exec` (fixed
 * argv, no shell) and creates its own scratch dir under os.tmpdir(). Nothing else may.
 */
const SPAWNER = join("summarizer", "codex.ts");
const FORBIDDEN = [
  "writeFile", "appendFile", "createWriteStream", "unlink", "rmSync", "rmdir", "rename", "mkdir", "copyFile", "ftruncate", "truncateSync",
  "chmod", "chown", "symlink", "utimes", "writeSync", "fsync",
];

/** Every .ts file under src/, recursively (providers live in subfolders), as paths relative to SRC. */
async function sources(dir = SRC, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory()) out.push(...(await sources(join(dir, d.name), join(rel, d.name))));
    else if (d.name.endsWith(".ts")) out.push(join(rel, d.name));
  }
  return out;
}

describe("read-only guarantee", () => {
  it("uses no fs write APIs and only kill(pid, 0)", async () => {
    const files = await sources();
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.startsWith("providers"))).toBe(true);
    for (const f of files) {
      const code = (await readFile(join(SRC, f), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const api of FORBIDDEN) expect(code, `${f} uses ${api}`).not.toMatch(new RegExp(`\\b${api}\\b`));
      expect(code, `${f} opens files writable`).not.toMatch(/open\([^)]*["'`][wa+]/);
      for (const m of code.matchAll(/\.kill\(([^)]*)\)/g)) expect(m[1]?.replace(/\s/g, ""), `${f} kill call`).toMatch(/,0$/);
      if (f !== SPAWNER) expect(code, `${f} runs processes`).not.toMatch(/child_process|(?<![.\w])(exec|execSync|execFile|spawn|spawnSync|fork)\s*\(/);
    }
  });

  it("only the Codex summarizer backend may spawn a process, with a fixed safe argv", async () => {
    const code = (await readFile(join(SRC, SPAWNER), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/import \{ spawn \} from "node:child_process"/);
    expect(code).not.toMatch(/\b(exec|execSync|execFile|spawnSync|fork)\s*\(/);
    expect(code).not.toMatch(/shell\s*:\s*true/);
    expect(code).not.toMatch(/--dangerously|bypass|full-access|danger-full/);
    expect(code).not.toMatch(/auth\.json|config\.toml/);
    expect(code).toContain('"--ephemeral"');
    expect(code).toContain('"--ignore-user-config"');
    expect(code).toContain('"read-only"');
    // the only fs mutation is mkdtemp of our own temp dir
    expect(code).toMatch(/mkdtempSync\(join\(tmpdir\(\)/);
    for (const f of await sources()) if (f !== SPAWNER) expect(await readFile(join(SRC, f), "utf8"), `${f} must not touch child_process`).not.toMatch(/node:child_process/);
  });

  it("deny-lists credential and config files", () => {
    const denied = [
      "/home/u/.codex/auth.json",
      "/home/u/.codex/config.toml",
      "/home/u/.codex/config.toml".toUpperCase(),
      "/x/oauth_tokens.json",
      "/x/token.txt",
      "/x/access-token",
      "/x/credentials.json",
      "/x/client_secret.json",
      "/x/.env",
      "/x/.env.local",
      "/home/u/.claude/sessions/1111.0ba19d9f983bcecffd76badb.key",
      "/x/server.pem",
      "/x/id_ed25519",
      "/x/.netrc",
    ];
    for (const p of denied) expect(isDeniedPath(p), p).toBe(true);
    const allowed = [
      "/home/u/.codex/sessions/2026/09/29/rollout-2026-09-29T18-16-51-01a0edbd-734b-7253-ac40-5f577ebeac92.jsonl",
      "/home/u/.codex/state_5.sqlite",
      "/home/u/.claude/projects/-Users-u-auth-service/aaaaaaaa-0000-4000-8000-000000000001.jsonl",
      "/home/u/.claude/sessions/1111.json",
    ];
    for (const p of allowed) expect(isDeniedPath(p), p).toBe(false);
    const roots = ["/home/u/.codex/sessions", "/home/u/.codex/archived_sessions"];
    expect(safeToRead(allowed[0] as string, roots)).toBe(true);
    expect(safeToRead("/home/u/.codex/sessions/../auth.json", roots)).toBe(false);
    expect(safeToRead("/home/u/.codex/sessions/../state_5.sqlite", roots)).toBe(false);
    expect(safeToRead("/home/u/.codex/sessions-evil/rollout-x.jsonl", roots)).toBe(false);
    expect(safeToRead("/etc/passwd", roots)).toBe(false);
  });

  it("the Codex provider only names secret files via the deny-list", async () => {
    for (const f of (await sources()).filter((x) => x.startsWith(join("providers", "codex")))) {
      const code = await readFile(join(SRC, f), "utf8");
      for (const name of ["auth.json", "config.toml", "thread_history", "logs_2", "immutable"]) {
        const uses = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        expect(uses, `${f} mentions ${name}`).not.toContain(name);
      }
    }
  });

  it("only listens on 127.0.0.1", async () => {
    const server = await readFile(join(SRC, "server.ts"), "utf8");
    const index = await readFile(join(SRC, "index.ts"), "utf8");
    expect(server).toContain('export const HOST = "127.0.0.1"');
    expect(index).toMatch(/listen\(port, HOST/);
    expect(index).not.toMatch(/0\.0\.0\.0/);
  });
});
