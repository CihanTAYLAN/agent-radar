import { join } from "node:path";
import type { ProviderFactory } from "../types.js";
import { CodexProvider, PROVIDER_ID, PROVIDER_LABEL } from "./provider.js";

/** OpenAI Codex CLI + Codex desktop: `$CODEX_HOME` or `~/.codex`. */
export const codex: ProviderFactory = {
  id: PROVIDER_ID,
  label: PROVIDER_LABEL,
  create: (ctx) => new CodexProvider({ codexHome: ctx.env["CODEX_HOME"] || join(ctx.userHome, ".codex"), recentMs: ctx.recentMs, userHome: ctx.userHome }),
};
