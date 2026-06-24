#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const extensionId = `${packageJson.publisher}.${packageJson.name}`;
const explicitTarget = process.env.SYMPOSIUM_EXTENSION_DIR?.trim();

function existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listCandidateDirs() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor-server", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];
  const out = [];
  for (const root of roots) {
    if (!existsDir(root)) { continue; }
    for (const name of fs.readdirSync(root)) {
      if (name === extensionId || name.startsWith(`${extensionId}-`)) {
        out.push(path.join(root, name));
      }
    }
  }
  return out;
}

function newestDir(dirs) {
  return dirs
    .map((dir) => {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { /* ignore */ }
      return { dir, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.dir;
}

const targetDir = explicitTarget || newestDir(listCandidateDirs());
if (!targetDir) {
  console.error(`No installed extension directory found for ${extensionId}.`);
  console.error("Install the extension once via VSIX first, or set SYMPOSIUM_EXTENSION_DIR.");
  process.exit(1);
}

const entries = [
  "package.json",
  "readme.md",
  "LICENSE",
  "LICENSE.txt",
  "media",
  "out",
  "scripts",
  "tsconfig.webview.json",
];

function copyEntry(name) {
  const src = path.join(repoRoot, name);
  if (!fs.existsSync(src)) { return; }
  const dest = path.join(targetDir, name === "LICENSE" ? "LICENSE.txt" : name);
  fs.rmSync(dest, { recursive: true, force: true });
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true, force: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

for (const entry of entries) copyEntry(entry);

console.log(`Synced ${extensionId} into ${targetDir}`);
console.log("Now reload VS Code window: Developer: Reload Window");
