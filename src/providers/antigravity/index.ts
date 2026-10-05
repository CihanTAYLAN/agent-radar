import { join } from "node:path";
import type { ProviderFactory } from "../types.js";
import { AntigravityProvider, PROVIDER_ID, PROVIDER_LABEL } from "./provider.js";

/** Google Antigravity: `$ANTIGRAVITY_HOME` or `~/.gemini` (data in `antigravity/` and `antigravity-ide/`). */
export const antigravity: ProviderFactory = {
  id: PROVIDER_ID,
  label: PROVIDER_LABEL,
  create: (ctx) => new AntigravityProvider({ geminiHome: ctx.env["ANTIGRAVITY_HOME"] || join(ctx.userHome, ".gemini"), recentMs: ctx.recentMs, userHome: ctx.userHome }),
};
