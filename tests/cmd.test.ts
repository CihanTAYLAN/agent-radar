import { describe, expect, it } from "vitest";
import { humanizeCommand, shortenPath, shortenPaths, splitCd } from "../public/cmd.js";

const ctx = { home: "/Users/me", cwd: "/Users/me/work/proj" };

describe("splitCd", () => {
  it("strips a leading cd with && or ;", () => {
    expect(splitCd("cd /a/b && npm test")).toEqual({ dir: "/a/b", rest: "npm test" });
    expect(splitCd("cd /a/b; ls")).toEqual({ dir: "/a/b", rest: "ls" });
    expect(splitCd(`cd "/a b/c" && ls`)).toEqual({ dir: "/a b/c", rest: "ls" });
  });
  it("keeps the last of chained cds and leaves other commands alone", () => {
    expect(splitCd("cd /a && cd sub && make")).toEqual({ dir: "sub", rest: "make" });
    expect(splitCd("npm test && cd /x")).toEqual({ dir: null, rest: "npm test && cd /x" });
    expect(splitCd("cd /only/dir")).toEqual({ dir: null, rest: "cd /only/dir" });
  });
});

describe("shortenPath", () => {
  it("collapses worktrees, claude tmp dirs, cwd and home", () => {
    expect(shortenPath("/Users/me/work/proj/.claude/worktrees/agent-a1b2/api/src", ctx)).toBe("wt:agent-a1b2/api/src");
    expect(shortenPath("/Users/me/work/proj/.claude/worktrees/agent-a1b2", ctx)).toBe("wt:agent-a1b2");
    expect(shortenPath("/private/tmp/claude-501/-Users-me-work-proj/3379f1c4-c632-4d52-856f-7e982f06b5c0/tasks/b1.output", ctx)).toBe("tmp:/tasks/b1.output");
    expect(shortenPath("/tmp/claude-501/-Users-me-work-proj/scratch/x.log", ctx)).toBe("tmp:/scratch/x.log");
    expect(shortenPath("/private/tmp/claude-501", ctx)).toBe("tmp:/");
    expect(shortenPath("/Users/me/work/proj/src/a.ts", ctx)).toBe("./src/a.ts");
    expect(shortenPath("/Users/me/work/proj", ctx)).toBe(".");
    expect(shortenPath("/Users/me/other/x", ctx)).toBe("~/other/x");
    expect(shortenPath("/etc/hosts", ctx)).toBe("/etc/hosts");
  });
  it("does not treat a sibling prefix as the cwd", () => {
    expect(shortenPath("/Users/me/work/project2/a", ctx)).toBe("~/work/project2/a");
  });
  it("works without context", () => {
    expect(shortenPath("/Users/me/x")).toBe("/Users/me/x");
    expect(shortenPath("relative/x", ctx)).toBe("relative/x");
  });
});

describe("shortenPaths", () => {
  it("rewrites every absolute path token and leaves urls alone", () => {
    expect(shortenPaths(`cat "/Users/me/work/proj/a.txt" > /private/tmp/claude-501/p/out.txt`, ctx)).toBe(`cat "./a.txt" > tmp:/out.txt`);
    expect(shortenPaths("curl https://example.com/Users/me/x", ctx)).toBe("curl https://example.com/Users/me/x");
    expect(shortenPaths("FOO=/Users/me/bin make", ctx)).toBe("FOO=~/bin make");
  });
});

describe("humanizeCommand", () => {
  it("splits the cd into a short dir chip and shortens the rest", () => {
    const r = humanizeCommand("cd /Users/me/work/proj/.claude/worktrees/agent-x/api && npx jest /Users/me/work/proj/.claude/worktrees/agent-x/api/src/a.test.ts", ctx);
    expect(r.dir).toBe("wt:agent-x/api");
    expect(r.rawDir).toBe("/Users/me/work/proj/.claude/worktrees/agent-x/api");
    expect(r.head).toBe("npx jest wt:agent-x/api/src/a.test.ts");
    expect(r.changed).toBe(true);
    expect(r.full.startsWith("cd /Users/me")).toBe(true);
  });
  it("hides the chip when the cd target is the session cwd", () => {
    expect(humanizeCommand("cd /Users/me/work/proj && git status", ctx)).toMatchObject({ dir: null, head: "git status", changed: true });
  });
  it("uses a dir split off upstream and marks multi-line commands", () => {
    const r = humanizeCommand("for f in a b; do\n  echo $f\ndone", ctx, "/Users/me/elsewhere");
    expect(r.dir).toBe("~/elsewhere");
    expect(r.head).toBe("for f in a b; do …");
    expect(r.body).toBe("for f in a b; do\n  echo $f\ndone");
  });
  it("reports unchanged commands", () => {
    expect(humanizeCommand("npm test", ctx)).toMatchObject({ dir: null, head: "npm test", body: "npm test", changed: false });
    expect(humanizeCommand("", ctx)).toMatchObject({ head: "", changed: false });
  });
});
