// P11f: generate a complete controller-route inventory without a YAML dependency.
// Hand-authored docs/openapi.yaml remains the detailed contract; this artifact makes
// undocumented legacy routes visible and gives Swagger consumers a complete path set.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("apps/api/src");
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".controller.ts")) files.push(full);
  }
}
await walk(root);

const routes = new Map();
for (const file of files) {
  const source = await readFile(file, "utf8");
  const controller = source.match(/@Controller\((?:"|')([^"']+)(?:"|')\)/)?.[1] ?? "";
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/@(Get|Post|Patch|Put|Delete)\((?:"|')([^"']*)(?:"|')\)/);
    if (!match) continue;
    const method = match[1].toLowerCase();
    const child = match[2];
    const path = `/${[controller, child].filter(Boolean).join("/")}`.replace(/\/+/g, "/").replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    routes.set(`${method.toUpperCase()} ${path}`, { method, path, file: file.replace(`${resolve("apps/api/src")}\\`, "apps/api/src/") });
  }
}

const grouped = new Map();
for (const route of [...routes.values()].sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`))) {
  const list = grouped.get(route.path) ?? [];
  list.push(route);
  grouped.set(route.path, list);
}

const out = [
  "# GENERATED FILE — run `npm run generate:openapi-inventory`.",
  "# Generic route inventory; detailed schemas live in docs/openapi.yaml.",
  "openapi: 3.0.3",
  "info:",
  "  title: PINDIAN API Route Inventory",
  "  version: 0.1.0",
  "paths:",
];
for (const [path, methods] of grouped) {
  out.push(`  ${path}:`);
  for (const route of methods) {
    out.push(`    ${route.method}:`, `      summary: Controller route (${route.file})`, "      responses:", "        '200': { description: Successful response }", "        '400': { description: Validation error }", "        '401': { description: Unauthorized }", "        '404': { description: Not found }");
    if (route.path.startsWith("/admin")) out.push("      security: [{ bearerAuth: [] }]");
  }
}
out.push("components:", "  securitySchemes:", "    bearerAuth:", "      type: http", "      scheme: bearer", "      bearerFormat: JWT", "");
await writeFile(resolve("docs/openapi-route-inventory.yaml"), out.join("\n"), "utf8");
console.log(`Generated ${routes.size} controller route entries`);
