import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const version = readFileSync("VERSION.txt", "utf8").trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid VERSION.txt");
const source = JSON.parse(readFileSync("package.json", "utf8"));
if (source.version !== undefined) throw new Error("Root package must not duplicate VERSION.txt");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (lock.version !== undefined || lock.packages[""].version !== undefined) throw new Error("Lockfile must not duplicate VERSION.txt");
const stage = mkdtempSync(join(tmpdir(), "repograph-pack-"));
const output = resolve(".cache/package"); mkdirSync(output, { recursive: true });
try {
  const { scripts, devDependencies, private: privateGuard, ...metadata } = source;
  writeFileSync(join(stage, "package.json"), JSON.stringify({ ...metadata, version, files: ["dist/src", "VERSION.txt", "README.md", "docs"] }, null, 2));
  for (const path of ["dist/src", "VERSION.txt", "README.md", "docs"]) cpSync(path, join(stage, path), { recursive: true });
  if (!process.env.npm_execpath) throw new Error("Run via npm run package:pack");
  const result = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--json", "--pack-destination", output], { cwd: stage, encoding: "utf8" }));
  const entries = result[0].files.map(file => file.path);
  if (entries.some(path => path.startsWith("src/") || path.startsWith("test/") || /generated-version|protocol\.js|graph\.js|store-lifecycle/.test(path))) throw new Error("Unexpected package contents");
  writeFileSync(join(output, "artifact.json"), JSON.stringify({ version, filename: result[0].filename, integrity: result[0].integrity, files: entries }, null, 2));
  console.log(join(output, result[0].filename));
} finally { rmSync(stage, { recursive: true, force: true }); }
