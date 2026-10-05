/**
 * nodecheck.ts -- minimum Node version for agent-radar. `node:sqlite` (used by the Codex, opencode, Kilo,
 * Bionic and Antigravity providers) loads without `--experimental-sqlite` from Node 22.13.0 (22.12.0 and
 * older throw ERR_UNKNOWN_BUILTIN_MODULE), and from 23.4.0 on the 23 line.
 */
export const MIN_NODE = "22.13.0";

/** Returns an error message when `version` (e.g. "22.12.0") cannot run agent-radar, else undefined. */
export function nodeVersionProblem(version: string): string | undefined {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const ok = major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
  if (ok) return undefined;
  return `agent-radar needs Node ${MIN_NODE} or newer (this is ${version}): older versions have no node:sqlite without a flag. Install it with nvm: "nvm install" (reads .nvmrc), then run again.`;
}
