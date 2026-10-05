import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlite } from "../src/providers/sqlite.js";
import { AntigravityProvider } from "../src/providers/antigravity/provider.js";
import { firstWorkspace, liveness, parseTime, toConvRow, type ConvRow } from "../src/providers/antigravity/format.js";
import { isDeniedPath, safeToRead } from "../src/providers/guard.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString().replace("T", " ").replace("Z", "000+00:00");
const MIN = 60_000;

const P = "aaaaaaaa-0000-4000-8000-000000000001"; // root
const C = "aaaaaaaa-0000-4000-8000-000000000002"; // child of P
const G = "aaaaaaaa-0000-4000-8000-000000000003"; // grandchild
const B1 = "bbbbbbbb-0000-4000-8000-000000000001"; // battle attempt 1
const B2 = "bbbbbbbb-0000-4000-8000-000000000002"; // battle attempt 2 (winner)
const OLD = "cccccccc-0000-4000-8000-000000000001";
const UNK = "dddddddd-0000-4000-8000-000000000001";
const KIL = "eeeeeeee-0000-4000-8000-000000000001";

interface R {
  id: string;
  title?: string;
  parent?: string;
  battle?: string;
  winner?: string;
  status?: string;
  idle?: number;
  killed?: number;
  lm: string;
  lu?: string;
  ws?: string;
  steps?: number;
  agent?: string;
}

async function makeHome(rows: R[], ide: R[] = []): Promise<string> {
  const mod = await loadSqlite();
  if (!mod) throw new Error("node:sqlite unavailable");
  const home = await mkdtemp(join(tmpdir(), "ag-test-"));
  const build = async (dir: string, list: R[]) => {
    await mkdir(join(home, dir), { recursive: true });
    const db = new mod.DatabaseSync(join(home, dir, "conversation_summaries.db"));
    db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '',
      step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '',
      source text NOT NULL DEFAULT '', agent_name text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '', nesting_depth integer NOT NULL DEFAULT 0,
      battle_id text NOT NULL DEFAULT '', winning_conversation_id text NOT NULL DEFAULT '', not_fully_idle numeric NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT 0,
      last_user_input_time datetime NOT NULL, raw_summary blob)`);
    const ins = db.prepare(
      `INSERT INTO conversation_summaries (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,status,source,agent_name,parent_conversation_id,nesting_depth,battle_id,winning_conversation_id,not_fully_idle,killed,last_user_input_time,raw_summary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of list) {
      ins.run(
        r.id, r.title ?? "", "PREVIEW-SENTINEL", r.steps ?? 3, r.lm, r.ws ?? "", r.status ?? "CASCADE_RUN_STATUS_IDLE", "cli", r.agent ?? "cascade",
        r.parent ?? "", r.parent ? 1 : 0, r.battle ?? "", r.winner ?? "", r.idle ?? 0, r.killed ?? 0, r.lu ?? r.lm, new Uint8Array([1, 2, 3]),
      );
    }
    db.close();
  };
  await build("antigravity", rows);
  if (ide.length > 0) await build("antigravity-ide", ide);
  return home;
}

const ROWS: R[] = [
  { id: P, title: "Ana görev", lm: ago(30_000), lu: ago(20 * MIN), ws: JSON.stringify(["file:///Users/tester/work/my%20proj"]), steps: 12 },
  { id: C, title: "Alt ajan", parent: P, lm: ago(3 * MIN), lu: ago(10 * MIN), status: "CASCADE_RUN_STATUS_RUNNING" },
  { id: G, title: "Torun", parent: C, lm: ago(4 * MIN) },
  { id: B1, title: "Deneme bir", battle: "bt-1", winner: B2, lm: ago(2 * MIN) },
  { id: B2, title: "Deneme iki", battle: "bt-1", winner: B2, lm: ago(5 * MIN) },
  { id: OLD, title: "Eski", lm: ago(72 * 3600_000) },
  { id: UNK, title: "Garip durum", status: "CASCADE_RUN_STATUS_WAITING_FOR_USER", lm: ago(30_000) },
  { id: KIL, title: "Öldürülmüş", killed: 1, lm: ago(30_000) },
];

function mk(home: string, extra: Partial<ConstructorParameters<typeof AntigravityProvider>[0]> = {}) {
  return new AntigravityProvider({ geminiHome: home, appPaths: [], userHome: "/Users/tester", recentMs: 24 * 3600_000, now: () => NOW, ...extra });
}

describe("antigravity format", () => {
  it("parses ISO text with microseconds, epochs and rejects zero times", () => {
    expect(parseTime("2026-09-27 13:36:21.765656+00:00")).toBe(Date.parse("2026-09-27T13:36:21.765Z"));
    expect(parseTime(1_780_000_000)).toBe(1_780_000_000_000);
    expect(parseTime(1_780_000_000_000)).toBe(1_780_000_000_000);
    expect(parseTime("0001-01-01T00:00:00Z")).toBeUndefined();
    expect(parseTime("")).toBeUndefined();
    expect(parseTime("garbage")).toBeUndefined();
  });

  it("extracts the first workspace path from JSON, plain lists and junk", () => {
    expect(firstWorkspace('["file:///Users/a/b%20c","file:///x"]')).toBe("/Users/a/b c");
    expect(firstWorkspace("file:///Users/a/b file:///x")).toBe("/Users/a/b");
    expect(firstWorkspace("")).toBe("");
    expect(firstWorkspace("[]")).toBe("");
    expect(firstWorkspace('[{"uri":"file:///o/p"}]')).toBe("/o/p");
  });

  it("maps statuses by name", () => {
    const base = toConvRow({ conversation_id: P + "", last_modified_time: ago(10_000), status: "CASCADE_RUN_STATUS_IDLE" }) as ConvRow;
    const at = (over: Partial<ConvRow>, ageMs: number) => liveness({ ...base, ...over, lastModified: NOW - ageMs }, NOW);
    expect(at({}, 10_000).state).toBe("idle");
    expect(at({}, 10 * MIN).state).toBe("done");
    expect(at({ status: "CASCADE_RUN_STATUS_RUNNING" }, 60_000).state).toBe("running");
    expect(at({ status: "CASCADE_RUN_STATUS_BUSY" }, 60_000).state).toBe("running");
    expect(at({ status: "CASCADE_RUN_STATUS_RUNNING" }, 30 * MIN).state).toBe("stalled");
    expect(at({ status: "CASCADE_RUN_STATUS_INACTIVE" }, 10 * MIN).state).toBe("done");
    expect(at({ notFullyIdle: true }, 3 * MIN).state).toBe("running");
    expect(at({ notFullyIdle: true }, 30 * MIN).state).toBe("done");
    expect(at({ killed: true }, 1000).state).toBe("stopped");
    const unk = at({ status: "CASCADE_RUN_STATUS_WAITING" }, 1000);
    expect(unk.state).toBe("idle");
    expect(unk.label).toBe("cascade_run_status_waiting");
  });
});

describe("antigravity provider", () => {
  it("lists sessions with title, cwd, status; nests children; groups battles", async () => {
    const p = mk(await makeHome(ROWS));
    await p.scan(true);
    const list = p.listSessions();
    const byName = new Map(list.map((s) => [s.name, s]));

    const main = byName.get("Ana görev");
    expect(main?.cwd).toBe("~/work/my proj");
    expect(main?.provider).toBe("antigravity");
    expect(main?.id).toBe(`antigravity:${P}`);
    expect(main?.agentCount).toBe(2);
    expect(main?.runningAgents).toBe(1);
    expect(main?.live).toBe(true);
    expect(main?.status).toBe("busy"); // a running subagent makes the session busy
    expect(main?.hasTranscript).toBe(true);
    expect(main?.totalTokens).toBe(0);

    // Child and grandchild are not sessions of their own; the old one is outside the window.
    expect(byName.has("Alt ajan")).toBe(false);
    expect(byName.has("Torun")).toBe(false);
    expect(byName.has("Eski")).toBe(false);

    // Battle: winner B2 is the session's main agent, B1 is a sibling attempt under it.
    expect(byName.has("Deneme iki")).toBe(true);
    expect(byName.has("Deneme bir")).toBe(false);
    const bd = p.getSession(B2);
    expect(bd?.tree.agentType).toContain("kazanan");
    expect(bd?.tree.children.map((c) => c.key)).toEqual([B1]);
    expect(bd?.tree.children[0]?.agentType).toContain("paralel deneme");

    // Unknown status is shown raw, lowercased; killed is stopped.
    expect(byName.get("Garip durum")?.status).toBe("cascade_run_status_waiting_for_user");
    const kd = p.getSession(KIL);
    expect(kd?.tree.state).toBe("stopped");
    expect(kd?.tree.endReason).toBeTruthy();
  });

  it("builds the nested tree with bars (start/end) and step count as messages", async () => {
    const p = mk(await makeHome(ROWS));
    await p.scan(true);
    const d = p.getSession(P);
    expect(d).toBeDefined();
    const t = d?.tree;
    expect(t?.key).toBe("main");
    expect(t?.messages).toBe(12);
    expect(t?.startedAt).toBe(NOW - 20 * MIN);
    expect(t?.children).toHaveLength(1);
    const child = t?.children[0];
    expect(child?.key).toBe(C);
    expect(child?.state).toBe("running");
    expect(child?.parentKey).toBe("main");
    expect(child?.startedAt).toBe(NOW - 10 * MIN);
    expect(child?.children[0]?.key).toBe(G);
    expect(child?.children[0]?.parentKey).toBe(C);
    expect(child?.children[0]?.state).toBe("done");
    expect(child?.children[0]?.endedAt).toBe(NOW - 4 * MIN);
  });

  it("reports honest capabilities and status even when every row is outside the window", async () => {
    const home = await makeHome(ROWS);
    const p = mk(home, { recentMs: 1000 });
    await p.scan(true);
    const st = p.status();
    expect(p.listSessions().length).toBe(0);
    expect(st.mark).toBe("AG");
    expect(st.installed).toBe(true);
    expect(st.dataFound).toBe(true);
    expect(st.lastActivityAt).toBe(NOW - 30_000);
    expect(st.capabilities).toEqual({ transcript: false, tokens: false, tools: false, subagents: true, cost: false });
    expect(st.notes.join(" ")).toContain("yalnızca özet (konuşmalar şifreli protobuf)");
  });

  it("re-queries on every pass (sees new rows) and includes the antigravity-ide DB", async () => {
    const home = await makeHome([{ id: P, title: "Bir", lm: ago(10_000) }], [{ id: OLD, title: "IDE oturumu", lm: ago(60_000) }]);
    const p = mk(home);
    const seen: string[][] = [];
    p.onChange((ids) => seen.push(ids));
    await p.scan(true);
    expect(p.listSessions().map((s) => s.name).sort()).toEqual(["Bir", "IDE oturumu"]);
    expect(seen.length).toBe(1);

    const mod = await loadSqlite();
    const db = new (mod as NonNullable<typeof mod>).DatabaseSync(join(home, "antigravity", "conversation_summaries.db"));
    db.prepare("INSERT INTO conversation_summaries (conversation_id,title,last_modified_time,last_user_input_time) VALUES (?,?,?,?)").run(G, "Yeni", ago(1000), ago(1000));
    db.close();
    await p.scan(false);
    expect(p.listSessions().map((s) => s.name)).toContain("Yeni");
    expect(seen.length).toBe(2);
  });

  it("never serves preview or the raw_summary blob", async () => {
    const p = mk(await makeHome(ROWS));
    await p.scan(true);
    const json = JSON.stringify([p.listSessions(), p.getSession(P), p.getSession(B2)]);
    expect(json).not.toContain("PREVIEW-SENTINEL");
  });

  it("degrades gracefully with no data at all", async () => {
    const home = await mkdtemp(join(tmpdir(), "ag-empty-"));
    const p = mk(home);
    await p.scan(true);
    const st = p.status();
    expect(p.loading).toBe(false);
    expect(st.installed).toBe(false);
    expect(st.dataFound).toBe(false);
    expect(p.listSessions()).toEqual([]);
    expect(await p.readEvents("nope-nope-nope", "main", {})).toBeUndefined();
  });

  it("readEvents is an empty page for a known session", async () => {
    const p = mk(await makeHome(ROWS));
    await p.scan(true);
    const r = await p.readEvents(P, "main", { tail: 10 });
    expect(r?.events).toEqual([]);
  });
});

describe("antigravity guard (deny-list)", () => {
  const home = "/Users/tester/.gemini";
  const roots = [`${home}/antigravity/conversation_summaries.db`, `${home}/antigravity-ide/conversation_summaries.db`];
  it("allows only the two summaries DBs", () => {
    for (const r of roots) expect(safeToRead(r, roots)).toBe(true);
  });
  it("refuses everything else under the data dir and home", () => {
    const denied = [
      `${home}/antigravity/agyhub_summaries_proto.pb`,
      `${home}/antigravity/conversations/abc.pb`,
      `${home}/antigravity/brain/x.md`,
      `${home}/antigravity/browser_recordings/r.webm`,
      `${home}/antigravity/annotations/a`,
      `${home}/antigravity/implicit/i`,
      `${home}/antigravity/knowledge/k`,
      `${home}/antigravity/code_tracker/c`,
      `${home}/antigravity/conversation_summaries.db-wal`,
      `${home}/jetski-standalone-oauth-token`,
      `${home}/antigravity-browser-profile/Default/Cookies`,
      `${home}/config/settings.json`,
      "/Users/tester/Library/Application Support/Antigravity/User/settings.json",
      `${home}/antigravity/../jetski-standalone-oauth-token`,
      `${home}/antigravity/conversation_summaries.db/../../config/x`,
    ];
    for (const p of denied) expect(safeToRead(p, roots), p).toBe(false);
    expect(isDeniedPath(`${home}/jetski-standalone-oauth-token`)).toBe(true);
  });
});
