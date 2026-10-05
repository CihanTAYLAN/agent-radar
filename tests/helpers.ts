import { cp, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_HOME = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "claude-home");
export const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
export const S2 = "bbbbbbbb-0000-4000-8000-000000000002";
/** Fixture transcripts end at 10:03:00Z; the fake clock is one minute later. */
export const T_LAST = Date.parse("2026-01-01T10:03:00.000Z");
export const T_NOW = T_LAST + 60_000;

async function walk(dir: string, fn: (p: string) => Promise<void>): Promise<void> {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) await walk(p, fn);
    else await fn(p);
  }
}

/**
 * Copies the static fixture into a temp dir (so the real fixture is never touched),
 * pins every mtime to T_LAST and makes the "live" registry entry point at this process.
 */
export async function makeHome(): Promise<{ home: string; livePid: number; deadPid: number }> {
  const home = await mkdtemp(join(tmpdir(), "radar-home-"));
  await cp(FIXTURE_HOME, home, { recursive: true });
  const livePid = process.pid;
  const deadPid = 2_147_483_000; // far above any real pid
  for (const [file, pid] of [["1111.json", livePid], ["2222.json", deadPid]] as const) {
    const p = join(home, "sessions", file);
    const j = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
    j["pid"] = pid;
    await writeFile(p, JSON.stringify(j));
  }
  const t = new Date(T_LAST);
  await walk(home, (p) => utimes(p, t, t));
  return { home, livePid, deadPid };
}
