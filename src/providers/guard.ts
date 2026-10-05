/**
 * guard.ts -- the file deny-list. Providers call safeToRead() before opening anything, so a path that
 * comes from a tool's own index (e.g. a rollout path stored in a SQLite row) can never make us read
 * credentials. Matching is on the file name, case-insensitive; directories are not matched, so a
 * project called "auth-service" still works.
 */
import { basename, resolve, sep } from "node:path";

const DENY: RegExp[] = [
  /auth/i, // auth.json, oauth tokens, .authinfo ...
  /token/i,
  /credential/i,
  /secret/i,
  /password|passwd/i,
  /^config\.toml$/i, // Codex config may carry API keys / MCP env
  /^\.env(\..*)?$/i,
  /\.(key|pem|p12|pfx|keystore)$/i,
  /^id_(rsa|ecdsa|ed25519|dsa)/i,
  /^\.netrc$/i,
];

/** True when the file name looks like something that may hold a secret. */
export function isDeniedPath(p: string): boolean {
  const name = basename(p);
  return DENY.some((re) => re.test(name));
}

/**
 * A path may be read only when it is not on the deny-list and lies inside one of `roots`
 * (after resolving `..`). Symlinks are followed as fs does (documented limitation).
 */
export function safeToRead(p: string, roots: string[]): boolean {
  if (isDeniedPath(p)) return false;
  const abs = resolve(p);
  return roots.some((r) => {
    const root = resolve(r);
    return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}
