// P11e: report controller route coverage against docs/openapi.yaml.
// This is intentionally an audit (not a CI failure yet): many legacy routes have
// inline Nest decorators and need schema-by-schema documentation work.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("apps/api/src");
const openapi = await readFile(resolve("docs/openapi.yaml"), "utf8");
const files = [];
async function walk(dir) {
  for (const entry of await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".controller.ts")) files.push(full);
  }
}
await walk(root);

const routes = new Set();
for (const file of files) {
  const source = await readFile(file, "utf8");
  const controller = source.match(/@Controller\((?:"|')([^"']+)(?:"|')\)/)?.[1] ?? "";
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/@(Get|Post|Patch|Put|Delete)\((?:"|')([^"']*)(?:"|')\)/);
    if (!match) continue;
    const method = match[1].toUpperCase();
    const child = match[2];
    const path = `/${[controller, child].filter(Boolean).join("/")}`.replace(/\/+/g, "/");
    routes.add(`${method} ${path}`);
  }
}

const documented = new Set();
for (const match of openapi.matchAll(/^  (\/[^:]+):/gm)) documented.add(match[1]);
const missing = [...routes].filter((r) => !documented.has(r.split(" ").slice(1).join(" ").replace(/:([A-Za-z]+)/g, "{$1}"))).sort();
console.log(`Controller routes discovered: ${routes.size}`);
console.log(`OpenAPI paths documented: ${documented.size}`);
console.log(`Routes without a matching OpenAPI path: ${missing.length}`);
for (const route of missing) console.log(`- ${route}`);
