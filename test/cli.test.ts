import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadGraph, saveGraph } from "../src/index.js";

const cli = "dist/src/cli.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixtureRepository(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "repograph-cli-"));
  git(root, "init");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");
  writeFileSync(join(root, "one.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return { root, commit: git(root, "rev-parse", "HEAD") };
}

test("CLI reports VERSION.txt-derived semantic version", () => {
  const raw = execFileSync(process.execPath, [cli, "version"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(raw), { version: "0.0.1" });
});

test("CLI builds a pinned graph that the library can load", () => {
  const { root, commit } = fixtureRepository();
  const graphPath = join(root, "graph.json");

  execFileSync(
    process.execPath,
    [
      cli,
      "build",
      "--repo",
      root,
      "--ref",
      commit,
      "--repository",
      "fixture/cli",
      "--out",
      graphPath,
    ],
    { encoding: "utf8" },
  );

  const graph = loadGraph(graphPath);
  assert.equal(graph.nodes.some((node) => node.identity.key === "one.txt"), true);

  const copiedPath = join(root, "graph-copy.json");
  saveGraph(copiedPath, graph);
  assert.deepEqual(loadGraph(copiedPath), graph);
});

test("CLI exits non-zero with machine-readable errors", () => {
  const result = spawnSync(process.execPath, [cli, "neighbors", "--graph", "missing.json"], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  const error = JSON.parse(result.stderr) as {
    error: { code: string; message: string };
  };
  assert.equal(error.error.code, "repograph-error");
  assert.equal(typeof error.error.message, "string");
});


test("CLI snapshot and update expose incremental metrics", () => {
  const root = mkdtempSync(join(tmpdir(), "repograph-cli-update-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");
  writeFileSync(join(root, "stable.txt"), "stable\n");
  writeFileSync(join(root, "changed.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "changed.txt"), "two\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "target");
  const target = git(root, "rev-parse", "HEAD");
  const cache = join(root, ".cache");

  const snapshot = JSON.parse(execFileSync(process.execPath, [
    cli, "snapshot", "--repo", root, "--ref", base,
    "--repository", "fixture/cli-update", "--cache-dir", cache,
  ], { encoding: "utf8" })) as {
    manifestKey: string;
    cache: { artifactWrites: number };
  };
  assert.match(snapshot.manifestKey, /^snapshot-sha256-[0-9a-f]{64}$/);
  assert.equal(snapshot.cache.artifactWrites > 0, true);

  const update = JSON.parse(execFileSync(process.execPath, [
    cli, "update", "--repo", root, "--base", base, "--ref", target,
    "--repository", "fixture/cli-update", "--cache-dir", cache,
  ], { encoding: "utf8" })) as {
    plan: { metrics: { changes: number; modified: number; artifactReuses: number } };
  };
  assert.equal(update.plan.metrics.changes, 1);
  assert.equal(update.plan.metrics.modified, 1);
  assert.equal(update.plan.metrics.artifactReuses > 0, true);
});
