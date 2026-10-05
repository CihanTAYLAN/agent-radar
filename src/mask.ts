/**
 * Best-effort secret masking for anything that is served to the UI.
 * This is a safety net, not a guarantee: unknown secret shapes will pass through.
 */

const REDACTED = "[REDACTED]";

interface Rule {
  re: RegExp;
  replace: string | ((substring: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  // PEM private key blocks (multi-line)
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: "[REDACTED PRIVATE KEY]",
  },
  // Authorization / Bearer tokens
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "$1 " + REDACTED },
  // Anthropic / OpenAI style keys (sk-..., sk-ant-..., sk-proj-...)
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: "sk-" + REDACTED },
  // GitHub tokens
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: "gh_" + REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "github_pat_" + REDACTED },
  // AWS access key ids
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "AKIA" + REDACTED },
  // Google API keys
  { re: /\bAIza[A-Za-z0-9_-]{30,}/g, replace: "AIza" + REDACTED },
  // Slack tokens
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "xox-" + REDACTED },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: "jwt." + REDACTED },
  // URL userinfo: scheme://user:SECRET@host and scheme://:SECRET@host. The password may hold ':' and
  // '@' (greedy up to the last '@' before the path) and %-escapes; it never holds '/', '?', '#' or
  // whitespace. Needs "://" and a ':' inside the userinfo, so https://user@host, git@host:org/repo,
  // host:port, IPv6 literals and 12:30:45@ stay untouched.
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#"'`<>\\]*:)[^\s/?#"'`<>\\]+@/gi,
    replace: (_m: string, head: string) => `${head}${REDACTED}@`,
  },
  // CLI: --password secret / --passwd 'secret' (--password=secret is covered by the KEY=value rule).
  // A value starting with '-' is another flag and is left alone.
  {
    re: /(--(?:password|passwd|pass|pwd)\s+)(?!-)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    replace: (_m: string, flag: string) => `${flag}${REDACTED}`,
  },
  // KEY=value,"token": "value", PASSWORD: value ... (name must contain a sensitive word)
  {
    re: /\b([A-Za-z0-9_.-]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIALS?)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi,
    replace: (_m: string, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  },
];

export function maskSecrets(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace as string);
  }
  return out;
}

/** Truncate to at most `max` UTF-16 code units, appending a note about the cut. */
export function truncate(text: string, max: number, originalLength = text.length): string {
  if (text.length <= max && originalLength <= max) return text;
  const cut = text.slice(0, max);
  return `${cut}\n… [truncated ${originalLength - max} chars]`;
}

const PRECUT_SLACK = 512;

/**
 * Mask first, then truncate, so a secret can never be split across the cut and survive.
 * Huge inputs are pre-cut (with slack beyond `max`) so masking stays cheap; the slack region is
 * discarded by the final truncation, so a secret split by the pre-cut cannot reach the output.
 */
export function safeText(input: string, max: number): string {
  const originalLength = input.length;
  const pre = originalLength > max + PRECUT_SLACK ? input.slice(0, max + PRECUT_SLACK) : input;
  return truncate(maskSecrets(pre), max, originalLength);
}
