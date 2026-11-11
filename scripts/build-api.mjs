#!/usr/bin/env node
// Faster wake on the free Render plan: bundle the API into one plain JavaScript file.
//
//   npm run build:api            (also runs by itself after `npm install`)
//   node apps/api/dist/main.mjs  (Render start command)
//
// `node --import tsx apps/api/src/main.ts` translates all the API's TypeScript every time
// the server starts, and a sleeping free server starts on 0.1 CPU: about 20 s of the wake.
// The bundle is translated once, at build time, and starts in about 7 s on the same CPU.
// Same esbuild settings tsx uses (decorators from apps/api/tsconfig.json, names kept for
// Nest); npm packages stay in node_modules, the workspace's own @sam-store/contracts is
// built in. dist/ is gitignored. `npm run dev:api` and the tests still run the TypeScript.

import { fileURLToPath } from "node:url";

const api = fileURLToPath(new URL("../apps/api/", import.meta.url));

// An install without dev packages (the web service, `npm install --omit=dev`) has no esbuild:
// nothing to build there, and `npm install` must not fail because of it.
let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  console.log("[build:api] esbuild is not installed: skipped (the API still starts with `npm run start:api`).");
  process.exit(0);
}

const started = Date.now();
await build({
  absWorkingDir: api,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  tsconfig: "tsconfig.json",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  keepNames: true,
  // Packages in node_modules stay external (Prisma, Nest, express …); the workspace's
  // @sam-store/contracts links outside node_modules, so esbuild builds it in.
  packages: "external",
  logLevel: "warning",
});
console.log(`[build:api] apps/api/dist/main.mjs built in ${Date.now() - started} ms`);
