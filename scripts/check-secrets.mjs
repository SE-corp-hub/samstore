// Secret / PII scan (Module 11 gate) — reports FILENAMES and CATEGORIES only,
// never the offending value. Run with: npm run check:secrets
//
// It scans TRACKED files (git ls-files) so build output, node_modules and .env
// (which must never be committed) are out of scope, and it ignores this file and
// the docs that intentionally describe patterns.
//
// Exit code 1 = at least one HIGH finding (a real-looking credential in the repo).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
  { id: "private-key", severity: "high", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "aws-access-key", severity: "high", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "google-api-key", severity: "high", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "slack-token", severity: "high", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: "github-token", severity: "high", re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/ },
  { id: "stripe-key", severity: "high", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { id: "openai-key", severity: "high", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: "meta-app-secret", severity: "high", re: /\b(?:app_secret|APP_SECRET|META_APP_SECRET)\s*[:=]\s*["'][0-9a-f]{32}["']/i },
  { id: "connection-string-with-password", severity: "high", re: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{6,}@/i },
  { id: "jwt-literal", severity: "medium", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "ph-phone-number", severity: "low", re: /\+63\d{10}\b/ },
];

// A match inside one of these is a documented placeholder, not a credential.
const PLACEHOLDER_HINT = /\b(?:USER|PASSWORD|PASS|SECRET|HOST|YOUR_|CHANGE_?ME|EXAMPLE|localhost|xxxx|placeholder|<[a-z_]+>)\b/i;

const ALLOW_FILES = [
  "scripts/check-secrets.mjs",
  "docs/runbooks.md",
  "AGENTS.md",
];

// Demo credentials intentionally committed by the seed for local development.
const ALLOW_LINES = [
  "admin-pass-123",
  "admin@samstore.test",
  ".env.example",
  "process.env",
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => !ALLOW_FILES.includes(f))
  .filter((f) => !f.endsWith(".lock") && !f.endsWith("package-lock.json"));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // binary
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ALLOW_LINES.some((a) => line.includes(a))) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        // Placeholders (USER:PASSWORD@HOST, .env.example templates) are not secrets.
        if (rule.severity === "high" && PLACEHOLDER_HINT.test(line)) continue;
        findings.push({ file, line: i + 1, id: rule.id, severity: rule.severity });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`check:secrets — scanned ${files.length} tracked files · 0 findings`);
  process.exit(0);
}

console.log(`check:secrets — scanned ${files.length} tracked files · ${findings.length} finding(s) (values NOT printed):`);
for (const f of findings) {
  console.log(`  [${f.severity}] ${f.id} → ${f.file}:${f.line}`);
}
const high = findings.filter((f) => f.severity === "high").length;
console.log(`\n${high} high-severity finding(s). Review before committing.`);
process.exit(high > 0 ? 1 : 0);
