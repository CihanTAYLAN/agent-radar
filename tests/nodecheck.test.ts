import { describe, expect, it } from "vitest";
import { MIN_NODE, nodeVersionProblem } from "../src/nodecheck.js";

describe("node version check", () => {
  it("accepts versions that have node:sqlite without a flag", () => {
    for (const v of ["22.13.0", "22.22.3", "v22.13.1", "23.4.0", "23.11.1", "24.0.0", "26.1.0"]) expect(nodeVersionProblem(v), v).toBeUndefined();
  });
  it("rejects older ones with a clear message", () => {
    for (const v of ["18.20.0", "20.11.0", "22.5.1", "22.12.0", "23.3.0"]) {
      const msg = nodeVersionProblem(v);
      expect(msg, v).toContain(MIN_NODE);
      expect(msg, v).toContain(v);
    }
  });
  it("the running Node passes", () => {
    expect(nodeVersionProblem(process.versions.node)).toBeUndefined();
  });
});
