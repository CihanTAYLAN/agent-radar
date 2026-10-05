/** Imported first by index.ts: stops with a clear message on a Node that is too old. */
import { nodeVersionProblem } from "./nodecheck.js";

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}
