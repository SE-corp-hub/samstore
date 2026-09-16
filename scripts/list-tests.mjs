// One-off: list the test files the gate will run (verifies the recursive glob).
import { globSync } from "node:fs";
const files = globSync("apps/api/src/**/*.test.ts").sort();
console.log(`files in gate: ${files.length}`);
for (const f of files) console.log(`  ${f}`);
