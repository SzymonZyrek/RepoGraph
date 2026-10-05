import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { affected, indexRepository } from "../dist/src/repository-query.js";

const results = [];
for (const clusters of [20, 80, 320]) {
  const root = mkdtempSync(join(tmpdir(), "repograph-index-eval-"));
  const cache = mkdtempSync(join(tmpdir(), "repograph-index-cache-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (path, value) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), value); };
  try {
    git("init", "-q"); git("config", "core.autocrlf", "false"); git("config", "user.email", "eval@example.org"); git("config", "user.name", "Evaluation");
    for (let index = 0; index < clusters; index++) {
      put(`src/${index}.py`, "# implementation\n");
      put(`docs/${index}.md`, `[Implementation](../src/${index}.py)\n`);
      put(`tests/${index}.md`, `[Validation target](../src/${index}.py)\n`);
    }
    git("add", "."); git("commit", "-qm", "cold"); const first = git("rev-parse", "HEAD");
    const options = { repositoryPath: root, repository: "evaluation", ref: first, cacheDirectory: cache };
    let start = performance.now(); await indexRepository(options); const coldIndexMs = performance.now() - start;
    start = performance.now(); const coldAnswer = await affected(options, ["src/0.py"]); const queryMs = performance.now() - start;
    assert.equal(coldAnswer.nodes.length, 3);
    start = performance.now(); assert.deepEqual(await affected(options, ["src/0.py"]), coldAnswer); const reopenQueryMs = performance.now() - start;
    put("src/0.py", "# one-file edit\n"); git("add", "."); git("commit", "-qm", "edit"); const second = git("rev-parse", "HEAD");
    const edit = { refreshedProviders: 0, reusedProviders: 0, parsedDocumentationBlobs: 0 };
    start = performance.now(); await indexRepository({ ...options, ref: second }, edit); const incrementalMs = performance.now() - start;
    assert.equal(edit.refreshedProviders, 1);
    git("mv", "docs/0.md", "docs/renamed.md"); git("commit", "-qam", "rename"); const third = git("rev-parse", "HEAD");
    const rename = { refreshedProviders: 0, reusedProviders: 0, parsedDocumentationBlobs: 0 };
    await indexRepository({ ...options, ref: third }, rename); assert.equal(rename.parsedDocumentationBlobs, 0);
    const warm = await affected({ ...options, ref: third }, ["src/0.py"]);
    let diskBytes = 0; for (const name of readdirSync(cache)) diskBytes += statSync(join(cache, name)).size;
    rmSync(cache, { recursive: true, force: true }); mkdirSync(cache);
    assert.deepEqual(await affected({ ...options, ref: third }, ["src/0.py"]), warm);
    results.push({ artifacts: clusters * 3, coldIndexMs, incrementalMs, queryMs, reopenQueryMs, diskBytes, resultBytes: Buffer.byteLength(JSON.stringify(warm)), returnedNodes: warm.nodes.length, edit, rename });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); }
}
const path = resolve(".cache/index-query-economics.json");
mkdirSync(resolve(".cache"), { recursive: true });
writeFileSync(path, JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
console.table(results.map(({ edit, rename, ...result }) => result));
console.log(`Raw index/query evaluation written to ${path}`);
