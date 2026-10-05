/**
 * sqlite.ts -- one-time, warning-free loader for `node:sqlite`, shared by every provider that reads a
 * SQLite database (codex, antigravity, opencode family, bionic). Callers open databases read-only.
 */
export type SqliteModule = typeof import("node:sqlite");
let sqliteMod: Promise<SqliteModule | null> | undefined;

/** Loads node:sqlite once, without letting its ExperimentalWarning reach stderr. null if unavailable. */
export function loadSqlite(): Promise<SqliteModule | null> {
  sqliteMod ??= (async () => {
    const orig = process.emitWarning;
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      const msg = typeof warning === "string" ? warning : warning?.message;
      if (/SQLite is an experimental feature/i.test(String(msg))) return;
      return (orig as (...a: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } catch {
      return null;
    } finally {
      process.emitWarning = orig;
    }
  })();
  return sqliteMod;
}
