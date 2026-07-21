// Guardrail: no source file may exceed MAX_LINES.
// Part of PLAN-namespace-restructure — keeps the 400-line rule permanent.
// Webview blob files are temporarily exempt until Phase 2 extracts them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const MAX_LINES = 400;
const ROOT = "src";
// Legacy webview blobs awaiting the Phase 2 extraction mentioned above.
// New files and every other source file remain capped at 400 lines.
const EXEMPT = new Set([
  "src/ui/webview/pwaShim.ts",
  "src/ui/webview/voice.ts",
]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (extname(full) === ".ts") out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk(ROOT)) {
  if (EXEMPT.has(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n").length;
  if (lines > MAX_LINES) offenders.push({ file, lines });
}

if (offenders.length) {
  offenders.sort((a, b) => b.lines - a.lines);
  console.error(`✗ ${offenders.length} file(s) over ${MAX_LINES} lines:`);
  for (const { file, lines } of offenders) console.error(`  ${lines}\t${file}`);
  process.exit(1);
}
console.log(`✓ all source files <= ${MAX_LINES} lines`);
