import "./preflight.js";
import { homedir } from "node:os";
import { HOST, createRadarServer } from "./server.js";
import { Radar } from "./store.js";
import { createProviders } from "./providers/index.js";
import { createSummarizer } from "./summarizer/index.js";

function parsePort(argv: string[]): number {
  const i = argv.indexOf("--port");
  const raw = (i >= 0 ? argv[i + 1] : undefined) ?? process.env["AGENT_RADAR_PORT"] ?? process.env["PORT"] ?? "4747";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port: ${raw}`);
  return n;
}

const port = parsePort(process.argv.slice(2));
const recentHours = Number(process.env["AGENT_RADAR_RECENT_HOURS"] ?? "24");
const recentMs = (Number.isFinite(recentHours) ? recentHours : 24) * 3600 * 1000;

const summarizer = createSummarizer(process.env, { onUpdate: () => radar.emit("change", []) });
const radar = new Radar({ providers: createProviders({ env: process.env, userHome: homedir(), recentMs }), summarizer });
const server = createRadarServer(radar);

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `agent-radar: port ${port} is already in use` : `agent-radar: ${err.message}`);
  process.exit(1);
});

server.listen(port, HOST, () => {
  const addr = server.address();
  const p = typeof addr === "object" && addr ? addr.port : port;
  const statuses = radar.providerStatus();
  const width = Math.max(...statuses.map((s) => s.label.length));
  const sources = statuses.map((s) => `  ${s.label.padEnd(width)}  ${s.home ?? "?"}${s.installed ? "" : "  (not found)"}`).join("\n");
  console.log(`agent-radar listening on http://${HOST}:${p}  (read-only; ${statuses.length} providers)\n${sources}`);
  radar.start();
});

const shutdown = (): void => {
  radar.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
