import { join } from "node:path";
import type { ProviderFactory } from "../types.js";
import { ClaudeCodeProvider, PROVIDER_ID, PROVIDER_LABEL } from "./provider.js";

/** Claude Code: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export const claudeCode: ProviderFactory = {
  id: PROVIDER_ID,
  label: PROVIDER_LABEL,
  create: (ctx) => new ClaudeCodeProvider({ claudeHome: ctx.env["CLAUDE_CONFIG_DIR"] || join(ctx.userHome, ".claude"), recentMs: ctx.recentMs }),
};
