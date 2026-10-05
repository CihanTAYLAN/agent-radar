import { join } from "node:path";
import type { ProviderFactory } from "../types.js";
import { GeminiCliProvider, PROVIDER_ID, PROVIDER_LABEL } from "./provider.js";

/**
 * Google Gemini CLI: `~/.gemini`. `GEMINI_CLI_HOME` (tests / fixtures) is the directory that contains
 * `.gemini`, like upstream's later home override; only `<that>/.gemini/tmp/**` is ever read.
 */
export const geminiCli: ProviderFactory = {
  id: PROVIDER_ID,
  label: PROVIDER_LABEL,
  create: (ctx) =>
    new GeminiCliProvider({
      geminiHome: join(ctx.env["GEMINI_CLI_HOME"] || ctx.userHome, ".gemini"),
      recentMs: ctx.recentMs,
      userHome: ctx.userHome,
      env: ctx.env,
    }),
};
