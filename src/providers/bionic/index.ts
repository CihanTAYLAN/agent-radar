import { join } from "node:path";
import type { ProviderFactory } from "../types.js";
import { BionicProvider, PROVIDER_ID, PROVIDER_LABEL } from "./provider.js";

/** Bionic (LM Studio based desktop app): `$BIONIC_HOME` or `~/.lmstudio/apps/bionic`. */
export const bionic: ProviderFactory = {
  id: PROVIDER_ID,
  label: PROVIDER_LABEL,
  create: (ctx) =>
    new BionicProvider({
      bionicHome: ctx.env["BIONIC_HOME"] || join(ctx.userHome, ".lmstudio", "apps", "bionic"),
      recentMs: ctx.recentMs,
      userHome: ctx.userHome,
    }),
};
