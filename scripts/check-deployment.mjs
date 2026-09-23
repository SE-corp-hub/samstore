// P11g: static deployment-artifact validation. Does not run Docker or connect to
// infrastructure; operator deployment validation remains manual.
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const requiredFiles = ["docker/api.Dockerfile", "docker/web.Dockerfile", "docker/worker.Dockerfile", "docker/nginx.conf", "docker-compose.yml", "docs/deployment.md", "docs/openapi.yaml"];
for (const file of requiredFiles) {
  try { await access(resolve(file)); } catch { console.error(`Missing deployment artifact: ${file}`); process.exit(1); }
}
const compose = await readFile(resolve("docker-compose.yml"), "utf8");
const nginx = await readFile(resolve("docker/nginx.conf"), "utf8");
const apiDocker = await readFile(resolve("docker/api.Dockerfile"), "utf8");
const checks = [
  [compose.includes("worker:") && compose.includes("OUTBOX_WORKER_EMBEDDED: \"false\""), "Compose must define a separate worker and disable the embedded API worker"],
  [compose.includes("DATABASE_URL:") && !/postgres:\s*\n/.test(compose), "Compose must use managed DATABASE_URL and must not define local Postgres"],
  [nginx.includes("proxy_pass http://api") && nginx.includes("proxy_pass http://web"), "nginx must proxy both API and web"],
  [apiDocker.includes("prisma generate") && apiDocker.includes("apps/api/src/main.ts"), "API image must generate Prisma and start the API"],
];
const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) { for (const failure of failures) console.error(failure); process.exit(1); }
console.log(`Deployment artifact check passed (${requiredFiles.length} files, ${checks.length} invariants)`);
