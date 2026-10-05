/**
 * providers/index.ts -- the provider registry. Adding a provider = one import + one entry here
 * (see README.md in this folder).
 */
import { claudeCode } from "./claude-code/index.js";
import { antigravity } from "./antigravity/index.js";
import { bionic } from "./bionic/index.js";
import { codex } from "./codex/index.js";
import { geminiCli } from "./gemini-cli/index.js";
import { opencodeFamily } from "./opencode/index.js";
import type { Provider, ProviderContext, ProviderFactory } from "./types.js";

export const PROVIDERS: ProviderFactory[] = [claudeCode, codex, antigravity, ...opencodeFamily, bionic, geminiCli];

export function createProviders(ctx: ProviderContext): Provider[] {
  return PROVIDERS.map((f) => f.create(ctx));
}
