// Sequential test runner — runs every Node test FILE one at a time.
// Why: the remote Postgres (Supabase pooler) allows only 15 sessions; the node
// `--test` CLI runs each file in its own process CONCURRENTLY, which saturates
// the pool with `FATAL: max clients reached in session mode`. Running each file
// alone keeps every PrismaClient within the pool and gives deterministic gates.
// Output: each child's TAP output streams through; a final aggregate line is
// printed, and the exit code is non-zero if any file failed.

import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Recursive glob: an explicit per-directory list silently SKIPPED whole folders
// (persistence/, security/, orders/, public/ ...) — tests that never ran in the gate.
const files = globSync("apps/api/src/**/*.test.ts").filter((f) => f.endsWith(".test.ts")).sort();
const coverage = process.argv.includes("--coverage");
console.log(`# running ${files.length} test files sequentially${coverage ? " (with coverage)" : ""}\n`);

const failedFiles = [];
for (const file of files) {
  const args = ["--import", "tsx", "--test"];
  if (coverage) args.push("--experimental-test-coverage");
  args.push(file);
  const res = spawnSync(process.execPath, args, {
    stdout: "pipe",
    stderr: "inherit",
    cwd: ROOT,
  });
  if (res.stdout) process.stdout.write(String(res.stdout));
  if (res.status !== 0) failedFiles.push(file);
}

console.log(`\n# files ${files.length}${failedFiles.length ? `  FAILED: ${failedFiles.join(", ")}` : "  all ok"}`);
process.exit(failedFiles.length > 0 ? 1 : 0);