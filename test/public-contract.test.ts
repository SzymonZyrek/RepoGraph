import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as api from "../src/index.js";
import { createGraphViewModel } from "../src/view.js";

test("one public contract exposes bounded queries, and the optional view uses the same answer", async () => {
  assert.deepEqual(Object.keys(api).sort(), ["CAUSAL_SCHEMA", "VERSION", "affected", "artifact", "boundary", "explain", "indexRepository", "slice"].sort());
  const view = createGraphViewModel({ schemaVersion: api.CAUSAL_SCHEMA, repository: "fixture", commit: "sha", partial: true, truncated: true, diagnostics: [],
    nodes: [api.artifact("a.py"), api.boundary("overlay", "a")],
    edges: [{ from: "boundary:overlay:a", to: "artifact:a.py", kind: "CONTAINS", evidence: ["e"] }],
    evidence: [{ id: "e", provider: "fixture", version: "1", fingerprint: "hash", class: "explicit-overlay", state: "partial", authority: "advisory" }] }, node => node.id);
  assert.equal(view.partial, true); assert.equal(view.truncated, true); assert.equal(view.nodes.length, 2);
  assert.equal(view.nodes[0]!.label, "artifact:a.py"); assert.deepEqual(view.edges[0]!.evidence.authorities, ["advisory"]);
  assert.equal(createGraphViewModel({ schemaVersion: api.CAUSAL_SCHEMA, repository: "r", commit: "s", nodes: [], edges: [], evidence: [], partial: false, truncated: false, diagnostics: [] }).bounds.height, 80);
});

test("CLI executes the current repo/ref contract and rejects obsolete or ambiguous input", () => {
  const root = mkdtempSync(join(tmpdir(), "repograph-cli-"));
  const cache = mkdtempSync(join(tmpdir(), "repograph-cli-cache-"));
  const cli = resolve("dist/src/cli.js");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.org");
    writeFileSync(join(root, "a.py"), "value = 1"); writeFileSync(join(root, "a.md"), "[source](a.py)");
    git("add", "."); git("commit", "-qm", "fixture"); const ref = git("rev-parse", "HEAD");
    const options = ["--repo", root, "--ref", ref, "--cache-dir", cache];
    assert.equal(run("version").trim(), api.VERSION);
    assert.equal(JSON.parse(run("index", ...options)).commit, ref);
    const answer = JSON.parse(run("affected", ...options, "--changed", "a.py"));
    assert.equal(answer.nodes.length, 2);
    assert.equal(JSON.parse(run("slice", ...options, "--start", "artifact:a.py", "--direction", "both", "--edge", "DEPENDS_ON", "--max-depth", "1", "--max-nodes", "2", "--max-edges", "2")).nodes.length, 2);
    assert.equal(JSON.parse(run("explain", ...options, "--from", "artifact:a.py", "--to", "artifact:a.md")).edges.length, 1);
    run("affected", ...options, "--changed", "a.py", "--out", join(root, "answer.json"));
    for (const args of [["build-intelligence"], ["protocol-info"], ["affected", ...options, "--graph", "old.json"], ["index", ...options, "--ref", ref], ["slice", ...options, "--start"], ["affected", ...options]]) {
      const failed = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stderr).error.code, "repograph-error");
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); }
});
