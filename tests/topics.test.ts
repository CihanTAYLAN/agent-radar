import { describe, expect, it } from "vitest";
import {
  ActionMemory,
  buildTopics,
  cleanTitle,
  describeAction,
  extractPrFromCommand,
  extractPrsFromText,
  extractTickets,
  extractTicketsLoose,
  informativeTitle,
  jaccard,
  moduleOf,
  parseWindow,
  projectOf,
  shortModule,
  sortTopics,
  titleTokens,
  type TopicAgentInput,
} from "../src/topics.js";

const NOW = 1_800_000_000_000;
let n = 0;
function agent(o: Partial<TopicAgentInput> & { label?: string }): TopicAgentInput {
  n++;
  return {
    sessionId: "s1",
    sessionName: "Selam",
    provider: "claude-code",
    cwd: "/w/projects/acme-app",
    isMain: false,
    agentKey: `a${n}`,
    label: "x",
    state: "done",
    lastActivityAt: NOW - 1000 * n,
    costUsd: 1,
    ...o,
  };
}
const main = (o: Partial<TopicAgentInput> = {}): TopicAgentInput => agent({ isMain: true, agentKey: "main", label: "Ana ajan", ...o });

describe("ticket extraction", () => {
  it("finds ticket keys", () => {
    expect(extractTickets("PROJ-2742 IMAP next slice")).toEqual(["PROJ-2742"]);
    expect(extractTickets("feat/ABC1-12-thing and PROJ-9")).toEqual(["ABC1-12", "PROJ-9"]);
  });
  it("skips standards, algorithms and versions", () => {
    expect(extractTickets("UTF-8 SHA-256 ISO-8601 HTTP-2 AES-256 TLS-1 CVE-2024 GPT-4 RFC-7231")).toEqual([]);
    expect(extractTickets("uses UTF-8 and PROJ-1")).toEqual(["PROJ-1"]);
  });
  it("does not match inside longer tokens or dashed sequences", () => {
    expect(extractTickets("xPROJ-12 and ISO-8601-1 and PROJ-12abc")).toEqual([]);
  });
  it("loose mode accepts lowercase keys only for known prefixes", () => {
    const known = new Set(["PROJ"]);
    expect(extractTicketsLoose("baktım proj-2823 ve utf-8 ve abc-12", known)).toEqual(["PROJ-2823"]);
  });
});

describe("PR extraction", () => {
  it("reads gh pr commands", () => {
    expect(extractPrFromCommand("gh pr checks 4121 --watch")).toBe(4121);
    expect(extractPrFromCommand("cd x && timeout 590 gh pr view 4108 --json state")).toBe(4108);
    expect(extractPrFromCommand("gh pr list --limit 30 --state open")).toBeUndefined();
    expect(extractPrFromCommand("gh pr merge --squash #77")).toBe(77);
    expect(extractPrFromCommand("gh pr view https://github.com/o/r/pull/12")).toBe(12);
    expect(extractPrFromCommand("npm test")).toBeUndefined();
  });
  it("reads titles", () => {
    expect(extractPrsFromText("Fix PR 4069 test failures")).toEqual([4069]);
    expect(extractPrsFromText("review #55 and PR #56")).toContain(55);
    expect(extractPrsFromText("&#x20; keep")).toEqual([]);
  });
});

describe("modules", () => {
  it("collapses to the directory, relative to the repo", () => {
    expect(moduleOf("/w/projects/acme-app/apps/api/src/modules/email/service.ts", "/w/projects/acme-app")).toBe("apps/api/src/modules/email");
    expect(moduleOf("/w/projects/acme-app/apps/api/src/modules/email/__tests__/a.test.ts", "/w/projects/acme-app")).toBe("apps/api/src/modules/email");
    expect(moduleOf("/w/projects/acme-app/.claude/worktrees/agent-x1/packages/db/prisma/schema.prisma", "/w/projects/acme-app")).toBe("packages/db/prisma");
    expect(moduleOf("/w/projects/acme-app/a/b/c/d/e/f/g.ts", "/w/projects/acme-app")).toBe("a/b/c/d/e");
    expect(moduleOf("/w/projects/acme-app/package.json", "/w/projects/acme-app")).toBeUndefined();
  });
  it("shortens for display", () => {
    expect(shortModule("apps/api/src/modules/email")).toBe("api/email");
    expect(shortModule("packages/db/prisma")).toBe("db/prisma");
    expect(shortModule("src")).toBe("src");
  });
  it("project is the last cwd folder; worktree suffix and home are normalised", () => {
    expect(projectOf("/w/projects/acme-app/.claude/worktrees/agent-1")).toBe("acme-app");
    expect(projectOf("/Users/u", "/Users/u")).toBe("~");
  });
  it("memory keeps edit dirs and PR numbers per agent, bounded", () => {
    const m = new ActionMemory(2);
    m.observe("s", "a", { tool: "Edit", kind: "edit", target: "/r/apps/x/src/a.ts" }, "/r", "/h");
    m.observe("s", "a", { tool: "Bash", kind: "bash", target: "gh pr checks 9" }, "/r", "/h");
    m.observe("s", "a", { tool: "Read", kind: "read", target: "/r/zzz.ts" }, "/r", "/h");
    expect([...(m.get("s", "a")?.paths.keys() ?? [])]).toEqual(["apps/x/src"]);
    expect(m.get("s", "a")?.prs).toEqual([9]);
    m.observe("s", "b", { tool: "Edit", kind: "edit", target: "/r/q/a.ts" }, "/r", "/h");
    m.observe("s", "c", { tool: "Edit", kind: "edit", target: "/r/q/a.ts" }, "/r", "/h");
    expect(m.get("s", "a")).toBeUndefined();
  });
});

describe("titles", () => {
  it("tokenises, stems and judges informativeness", () => {
    expect(titleTokens("Fix PR 4069 test failures!")).toContain("failu");
    expect(informativeTitle("Cron Sadeleştirme")).toBe(true);
    expect(informativeTitle("Selam")).toBe(false);
    expect(informativeTitle("Masteng")).toBe(false);
    expect(informativeTitle("Turkish Greeting")).toBe(false);
    expect(informativeTitle("Gemini 3c29cff4")).toBe(false);
    expect(informativeTitle("6101dfc2")).toBe(false);
    expect(informativeTitle("<realtime_delegation> foo bar")).toBe(false);
  });
  it("jaccard and cleaning", () => {
    expect(jaccard(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(0.5);
    expect(jaccard([], ["a"])).toBe(0);
    expect(cleanTitle("PROJ-2742: IMAP next slice", ["PROJ-2742"])).toBe("IMAP next slice");
    expect(cleanTitle("/goal Foo bar")).toBe("Foo bar");
  });
  it("describes actions and windows", () => {
    expect(describeAction({ tool: "Bash", kind: "bash", target: "cd /x && gh pr checks 4121" })).toBe("Komut çalıştırıyor gh pr checks 4121");
    expect(describeAction({ tool: "Bash", kind: "bash", target: "cd /x && timeout 590 gh pr checks 4120 --watch --interval 45 >/dev/null" })).toBe("Komut çalıştırıyor gh pr checks 4120");
    expect(describeAction({ tool: "Bash", kind: "bash", target: "gh pr checks 4121 2>&1 | grep -q pending" })).toBe("Komut çalıştırıyor gh pr checks 4121");
    expect(describeAction({ tool: "Bash", kind: "bash", target: "npm test" })).toBe("Komut çalıştırıyor npm test");
    expect(describeAction({ tool: "Edit", kind: "edit", target: "/a/b.ts" })).toBe("Düzenliyor /a/b.ts");
    expect(parseWindow("24h")).toBe(86_400_000);
    expect(parseWindow("90m")).toBe(5_400_000);
    expect(parseWindow(undefined)).toBe(86_400_000);
    expect(parseWindow("banana")).toBeUndefined();
    expect(parseWindow("0h")).toBeUndefined();
  });
});

describe("grouping", () => {
  it("groups by project + ticket key and keeps projects apart", () => {
    const topics = buildTopics([
      agent({ label: "PROJ-2742 IMAP next slice", state: "running" }),
      agent({ label: "PROJ-2742 decision-free slices" }),
      agent({ label: "PROJ-2827 flaky 2FA test" }),
      agent({ label: "PROJ-2742 other repo", cwd: "/w/other" }),
    ]);
    const t = topics.filter((x) => x.key === "PROJ-2742");
    expect(t).toHaveLength(2);
    const jax = t.find((x) => x.project === "acme-app");
    expect(jax?.counts).toMatchObject({ total: 2, running: 1, done: 2 - 1, failed: 0 });
    expect(topics.find((x) => x.key === "PROJ-2827")?.counts.total).toBe(1);
  });

  it("takes the ticket from the worktree branch and counts failures", () => {
    const [t] = buildTopics([agent({ label: "warmup fix", worktreeBranch: "worktree-PROJ-2700-warmup", state: "failed" })]);
    expect(t?.key).toBe("PROJ-2700");
    expect(t?.counts.failed).toBe(1);
  });

  it("falls back to a PR from the title or observed gh commands", () => {
    const mem = new ActionMemory();
    mem.observe("s1", "px", { tool: "Bash", kind: "bash", target: "gh pr checks 4121" }, "/w", "/h");
    const topics = buildTopics([
      agent({ label: "Fix PR 4069 test failures" }),
      agent({ label: "Watch CI green", agentKey: "px", activity: mem.get("s1", "px") }),
      agent({ label: "Another one", lastAction: { tool: "Bash", kind: "bash", target: "gh pr checks 4121" }, state: "running" }),
    ]);
    expect(topics.map((t) => t.key).sort()).toEqual(["PR #4069", "PR #4121"]);
    expect(topics.find((t) => t.key === "PR #4121")?.counts.total).toBe(2);
  });

  it("merges near-duplicate titles (Jaccard >= 0.6) within a project, not across projects", () => {
    const topics = buildTopics([
      main({ sessionId: "a", sessionName: "Ajan paralel çalışma görselleştirmesi" }),
      main({ sessionId: "b", sessionName: "Ajan paralel çalışma görselleştirme" }),
      main({ sessionId: "c", sessionName: "Ajan paralel çalışma görselleştirmesi", cwd: "/w/other" }),
      main({ sessionId: "d", sessionName: "Cron Sadeleştirme" }),
    ]);
    const jax = topics.filter((t) => t.project === "acme-app");
    expect(jax).toHaveLength(2);
    expect(jax.find((t) => t.title.startsWith("Ajan"))?.counts.total).toBe(2);
    expect(topics.filter((t) => t.title.startsWith("Ajan"))).toHaveLength(2);
  });

  it("puts weak singleton subagents and greetings in 'Diğer · project'", () => {
    const topics = buildTopics([main({ sessionName: "Selam" }), agent({ label: "Explore code" }), agent({ label: "Check things" })]);
    const other = topics.filter((t) => t.kind === "other");
    expect(other).toHaveLength(1);
    expect(other[0]?.title).toBe("Diğer · acme-app");
    expect(other[0]?.counts.total).toBe(3);
  });

  it("clusters keyless subagents sharing a distinctive word", () => {
    const topics = buildTopics([
      agent({ label: "Supabase pre-delete E1-E3" }),
      agent({ label: "Fix stale Supabase facts" }),
      agent({ label: "Supabase Cloud shutdown" }),
      agent({ label: "Random alpha thing" }),
      agent({ label: "Another beta task" }),
      agent({ label: "Gamma delta work" }),
    ]);
    const s = topics.find((t) => t.title === "Supabase");
    expect(s?.counts.total).toBe(3);
    expect(topics.find((t) => t.kind === "other")?.counts.total).toBe(3);
  });

  it("orchestration: subagents decide their topics; the main agent follows a >=50% dominant topic", () => {
    const subs = [
      ...Array.from({ length: 6 }, (_, i) => agent({ label: `PROJ-2000 part ${i}` })),
      agent({ label: "PROJ-2001 lone" }),
      agent({ label: "PROJ-2002 lone" }),
    ];
    const topics = buildTopics([main({ state: "running" }), ...subs]);
    const dom = topics.find((t) => t.key === "PROJ-2000");
    expect(dom?.counts.total).toBe(7); // six subagents + the main agent
    expect(dom?.agents.some((a) => a.isMain)).toBe(true);
    expect(topics.find((t) => t.key === "PROJ-2001")?.counts.total).toBe(1);
  });

  it("orchestration: without a dominant topic the main agent lands in 'Orkestrasyon'", () => {
    const subs = Array.from({ length: 8 }, (_, i) => agent({ label: `PROJ-${3000 + i} thing` }));
    const topics = buildTopics([main({ sessionName: "Selam" }), ...subs]);
    expect(topics.filter((t) => t.key?.startsWith("PROJ-3"))).toHaveLength(8);
    const orch = topics.find((t) => t.kind === "orchestration");
    expect(orch?.title).toBe("Orkestrasyon · Selam");
    expect(orch?.counts.total).toBe(1);
    // one agent belongs to exactly one topic
    const all = topics.flatMap((t) => t.agents.map((a) => `${a.sessionId}|${a.key}`));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(9);
  });

  it("a main agent with an explicit ticket in its name keeps it even with many subagents", () => {
    const topics = buildTopics([main({ sessionName: "PROJ-9000 big refactor" }), ...Array.from({ length: 5 }, (_, i) => agent({ label: `PROJ-${4000 + i} x` }))]);
    expect(topics.find((t) => t.key === "PROJ-9000")?.agents.some((a) => a.isMain)).toBe(true);
    expect(topics.some((t) => t.kind === "orchestration")).toBe(false);
  });

  it("a session prompt with a lowercase key of a known prefix attributes a subagent-less main agent", () => {
    const topics = buildTopics([agent({ sessionId: "other", label: "PROJ-1 seed" }), main({ sessionName: "Masteng", lastPrompt: "bir tane background task var, proj-2823" })]);
    expect(topics.some((t) => t.key === "PROJ-2823")).toBe(true);
  });

  it("builds identity, counts, cost, modules, recent actions and a deterministic summary", () => {
    const mem = new ActionMemory();
    mem.observe("s1", "r1", { tool: "Edit", kind: "edit", target: "/w/projects/acme-app/apps/api/src/modules/email/a.ts" }, "/w/projects/acme-app", "/h");
    mem.observe("s1", "r1", { tool: "Edit", kind: "edit", target: "/w/projects/acme-app/apps/api/src/modules/email/b.ts" }, "/w/projects/acme-app", "/h");
    mem.observe("s1", "r1", { tool: "Write", kind: "write", target: "/w/projects/acme-app/packages/db/prisma/x.sql" }, "/w/projects/acme-app", "/h");
    const topics = buildTopics([
      agent({ agentKey: "r1", label: "PROJ-2742 IMAP next slice", state: "running", startedAt: NOW - 5000, lastActivityAt: NOW - 10, costUsd: 2.5, activity: mem.get("s1", "r1"), lastAction: { tool: "Bash", kind: "bash", target: "gh pr checks 4121" } }),
      agent({ label: "PROJ-2742 IMAP next slice", provider: "codex", costUsd: 0.5, startedAt: NOW - 9000, costPartial: true }),
    ]);
    const t = topics[0];
    expect(t).toMatchObject({ kind: "ticket", key: "PROJ-2742", title: "IMAP next slice", project: "acme-app", providers: ["claude-code", "codex"], costUsd: 3, costPartial: true, firstAt: NOW - 9000, lastAt: NOW - 10 });
    expect(t?.modules).toEqual(["apps/api/src/modules/email", "packages/db/prisma"]);
    expect(t?.recent).toEqual(["Komut çalıştırıyor gh pr checks 4121"]);
    expect(t?.summary).toBe("2 ajan · 1 çalışıyor · son: Komut çalıştırıyor gh pr checks 4121 · modüller: api/email, db/prisma");
  });

  it("orders running topics first, then by recency, 'Diğer' last", () => {
    const topics = sortTopics(
      buildTopics([
        agent({ label: "PROJ-1 old", lastActivityAt: NOW - 9000 }),
        agent({ label: "PROJ-2 new", lastActivityAt: NOW - 100 }),
        agent({ label: "PROJ-3 live", state: "running", lastActivityAt: NOW - 8000 }),
        agent({ label: "Explore code", lastActivityAt: NOW, state: "running" }),
      ]),
    );
    expect(topics.map((t) => t.key ?? t.title)).toEqual(["PROJ-3", "PROJ-2", "PROJ-1", "Diğer · acme-app"]);
  });
});
