import { join } from "node:path";
import type { ProviderContext, ProviderFactory } from "../types.js";
import { OpencodeProvider } from "./provider.js";

/** `$XDG_DATA_HOME` or `~/.local/share` -- where opencode and Kilo Code keep their SQLite stores. */
function dataHome(ctx: ProviderContext): string {
  return ctx.env["XDG_DATA_HOME"] || join(ctx.userHome, ".local", "share");
}

/** opencode: `<data>/opencode/opencode.db` (only that file; auth.json / config are never touched). */
export const opencode: ProviderFactory = {
  id: "opencode",
  label: "opencode",
  create: (ctx) =>
    new OpencodeProvider({ id: "opencode", label: "opencode", mark: "OC", dbPath: join(dataHome(ctx), "opencode", "opencode.db"), recentMs: ctx.recentMs, userHome: ctx.userHome }),
};

/** Kilo Code, an opencode fork with the same schema: `<data>/kilo/kilo.db`. */
export const kilo: ProviderFactory = {
  id: "kilo",
  label: "Kilo Code",
  create: (ctx) => new OpencodeProvider({ id: "kilo", label: "Kilo Code", mark: "KI", dbPath: join(dataHome(ctx), "kilo", "kilo.db"), recentMs: ctx.recentMs, userHome: ctx.userHome }),
};

export const opencodeFamily: ProviderFactory[] = [opencode, kilo];
