import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalArtifactStore,
  buildGraph,
  diffGitRepository,
  incrementalRepositoryUpdate,
  nodeId,
  planIncrementalUpdate,
  repositorySnapshotConfigurationIdentity,
  type GitDiffResult,
  type Provenance,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-incremental-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");
  return root;
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function cacheRoot(): string {
  return mkdtempSync(join(tmpdir(), "repograph-incremental-cache-"));
}

test("Git diff reports narrow modifications with exact object identities", () => {
  const root = repository();
  writeFileSync(join(root, "stable.txt"), "stable\n");
  writeFileSync(join(root, "edited.txt"), "one\n");
  const base = commitAll(root, "base");

  writeFileSync(join(root, "edited.txt"), "two\n");
  const target = commitAll(root, "target");

  const diff = diffGitRepository({
    repositoryPath: root,
    baseRef: base,
    targetRef: target,
  });

  assert.equal(diff.baseCommit, base);
  assert.equal(diff.targetCommit, target);
  assert.deepEqual(
    diff.changes.map((change) => [change.kind, change.path]),
    [["modified", "edited.txt"]],
  );
  assert.equal(diff.changes[0]?.contentChanged, true);
  assert.notEqual(
    diff.changes[0]?.beforeObject,
    diff.changes[0]?.afterObject,
  );
});

test("rename-only keeps identical content identity and moved+edited does not", () => {
  const root = repository();
  const original = Array.from(
    { length: 30 },
    (_, index) => `line-${index.toString().padStart(2, "0")}\n`,
  ).join("");
  writeFileSync(join(root, "old.txt"), original);
  const base = commitAll(root, "base");

  git(root, "mv", "old.txt", "renamed.txt");
  const renamed = commitAll(root, "rename");

  const renameDiff = diffGitRepository({
    repositoryPath: root,
    baseRef: base,
    targetRef: renamed,
  });
  assert.equal(renameDiff.changes.length, 1);
  assert.equal(renameDiff.changes[0]?.kind, "renamed");
  assert.equal(renameDiff.changes[0]?.oldPath, "old.txt");
  assert.equal(renameDiff.changes[0]?.path, "renamed.txt");
  assert.equal(renameDiff.changes[0]?.contentChanged, false);
  assert.equal(renameDiff.changes[0]?.similarity, 100);

  git(root, "mv", "renamed.txt", "moved.txt");
  writeFileSync(
    join(root, "moved.txt"),
    original.replace("line-10", "changed-10").replace("line-11", "changed-11"),
  );
  const movedEdited = commitAll(root, "moved and edited");

  const editedDiff = diffGitRepository({
    repositoryPath: root,
    baseRef: renamed,
    targetRef: movedEdited,
  });
  assert.equal(editedDiff.changes.length, 1);
  assert.equal(editedDiff.changes[0]?.kind, "renamed");
  assert.equal(editedDiff.changes[0]?.oldPath, "renamed.txt");
  assert.equal(editedDiff.changes[0]?.path, "moved.txt");
  assert.equal(editedDiff.changes[0]?.contentChanged, true);
  assert.notEqual(
    editedDiff.changes[0]?.beforeObject,
    editedDiff.changes[0]?.afterObject,
  );
});

test("delete is explicit and merge-base selection excludes unrelated branch work", () => {
  const root = repository();
  writeFileSync(join(root, "shared.txt"), "shared\n");
  writeFileSync(join(root, "delete-me.txt"), "delete\n");
  const common = commitAll(root, "common");

  git(root, "switch", "-c", "feature");
  writeFileSync(join(root, "feature.txt"), "feature\n");
  const feature = commitAll(root, "feature");

  git(root, "switch", "main");
  rmSync(join(root, "delete-me.txt"));
  writeFileSync(join(root, "main-only.txt"), "main\n");
  const main = commitAll(root, "main");

  const directDelete = diffGitRepository({
    repositoryPath: root,
    baseRef: common,
    targetRef: main,
  });
  assert.equal(
    directDelete.changes.some(
      (change) => change.kind === "deleted" && change.path === "delete-me.txt",
    ),
    true,
  );

  const mergeBase = diffGitRepository({
    repositoryPath: root,
    baseRef: main,
    targetRef: feature,
    baseMode: "merge-base",
  });
  assert.equal(mergeBase.baseCommit, common);
  assert.equal(mergeBase.targetCommit, feature);
  assert.deepEqual(
    mergeBase.changes.map((change) => [change.kind, change.path]),
    [["added", "feature.txt"]],
  );
});

test("incremental snapshot reuses unchanged Git artifacts across real commits", () => {
  const root = repository();
  const cache = cacheRoot();
  writeFileSync(join(root, "stable.txt"), "stable\n");
  writeFileSync(join(root, "changed.txt"), "one\n");
  const base = commitAll(root, "base");

  writeFileSync(join(root, "changed.txt"), "two\n");
  const target = commitAll(root, "target");

  const store = new LocalArtifactStore(cache);
  const result = incrementalRepositoryUpdate(store, {
    repositoryPath: root,
    repository: "fixture/incremental",
    baseRef: base,
    targetRef: target,
    discoverCodeowners: false,
  });

  assert.equal(result.plan.metrics.modified, 1);
  assert.equal(result.plan.metrics.changes, 1);
  assert.equal(result.plan.metrics.artifactReuses >= 1, true);
  assert.equal(result.plan.metrics.artifactWrites >= 1, true);
  assert.equal(result.plan.metrics.reusedNodes >= 1, true);

  const configurationIdentity = repositorySnapshotConfigurationIdentity({
    repositoryPath: root,
    repository: "fixture/incremental",
    ref: target,
    discoverCodeowners: false,
  });
  const manifest = store.getManifest({
    repository: "fixture/incremental",
    ref: target,
    commit: target,
    configurationIdentity,
  });
  assert.notEqual(manifest, undefined);
});

test("rename-only reuses the same content artifact under the new logical path", () => {
  const root = repository();
  const cache = cacheRoot();
  writeFileSync(join(root, "before.txt"), "same\n");
  const base = commitAll(root, "base");

  git(root, "mv", "before.txt", "after.txt");
  const target = commitAll(root, "rename");

  const store = new LocalArtifactStore(cache);
  const result = incrementalRepositoryUpdate(store, {
    repositoryPath: root,
    repository: "fixture/rename",
    baseRef: base,
    targetRef: target,
    discoverCodeowners: false,
  });

  assert.equal(result.plan.metrics.renamed, 1);
  assert.equal(result.plan.metrics.renameOnly, 1);
  assert.equal(result.plan.metrics.artifactReuses >= 1, true);

  const baseConfig = repositorySnapshotConfigurationIdentity({
    repositoryPath: root,
    repository: "fixture/rename",
    ref: base,
    discoverCodeowners: false,
  });
  const targetConfig = repositorySnapshotConfigurationIdentity({
    repositoryPath: root,
    repository: "fixture/rename",
    ref: target,
    discoverCodeowners: false,
  });
  assert.equal(baseConfig, targetConfig);

  const baseManifest = store.getManifest({
    repository: "fixture/rename",
    ref: base,
    commit: base,
    configurationIdentity: baseConfig,
  });
  const targetManifest = store.getManifest({
    repository: "fixture/rename",
    ref: target,
    commit: target,
    configurationIdentity: targetConfig,
  });
  const before = baseManifest?.artifacts.find(
    (artifact) => artifact.logicalKey === "git:file:before.txt",
  );
  const after = targetManifest?.artifacts.find(
    (artifact) => artifact.logicalKey === "git:file:after.txt",
  );
  assert.equal(before?.artifactKey, after?.artifactKey);
});

const evidence: Provenance = {
  repository: "fixture/deps",
  ref: "base",
  commit: "base",
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
};

function dependencyFixture() {
  const a = { namespace: "fixture/deps", kind: "file", key: "a.ts" };
  const b = { namespace: "fixture/deps", kind: "file", key: "b.ts" };
  const c = { namespace: "fixture/deps", kind: "file", key: "c.ts" };
  const d = { namespace: "fixture/deps", kind: "file", key: "d.ts" };
  const ids = {
    a: nodeId(a),
    b: nodeId(b),
    c: nodeId(c),
    d: nodeId(d),
  };

  const nodes = [a, b, c, d].map((identity) => ({
    identity,
    provenance: [evidence],
  }));

  const baseGraph = buildGraph({
    nodes,
    edges: [
      {
        identity: { kind: "depends-on", from: ids.a, to: ids.b },
        provenance: [evidence],
      },
      {
        identity: { kind: "depends-on", from: ids.d, to: ids.a },
        provenance: [evidence],
      },
    ],
  });
  const targetGraph = buildGraph({
    nodes,
    edges: [
      {
        identity: { kind: "depends-on", from: ids.a, to: ids.c },
        provenance: [evidence],
      },
      {
        identity: { kind: "depends-on", from: ids.d, to: ids.a },
        provenance: [evidence],
      },
    ],
  });

  const diff: GitDiffResult = {
    repositoryRoot: "/fixture",
    requestedBaseRef: "base",
    requestedTargetRef: "target",
    baseCommit: "base",
    targetCommit: "target",
    baseMode: "direct",
    changes: [
      {
        kind: "modified",
        path: "a.ts",
        beforeObject: "old",
        afterObject: "new",
        contentChanged: true,
      },
    ],
  };

  return { baseGraph, targetGraph, diff, ids };
}

test("dependency relationship changes touch originating edges and reverse dependents", () => {
  const { baseGraph, targetGraph, diff, ids } = dependencyFixture();
  const plan = planIncrementalUpdate({
    baseGraph,
    targetGraph,
    diff,
    invalidationEdgeKinds: ["depends-on"],
  });

  assert.equal(plan.globalInvalidation, false);
  assert.equal(plan.touchedEdgeIds.length, 2);
  assert.equal(plan.invalidatedNodeIds.includes(ids.a), true);
  assert.equal(plan.invalidatedNodeIds.includes(ids.d), true);
});

test("extractor/parser/chunk/schema version changes are explicit global invalidators", () => {
  const { baseGraph, targetGraph, diff } = dependencyFixture();
  const plan = planIncrementalUpdate({
    baseGraph,
    targetGraph,
    diff,
    previousAnalysis: {
      extractor: { name: "ts", version: "1" },
      parser: { name: "typescript", version: "5.7" },
      chunkVersion: "1",
      schemaVersion: "deps/v1",
    },
    analysis: {
      extractor: { name: "ts", version: "2" },
      parser: { name: "typescript", version: "5.8" },
      chunkVersion: "2",
      schemaVersion: "deps/v2",
    },
  });

  assert.equal(plan.globalInvalidation, true);
  assert.deepEqual(plan.globalInvalidationReasons, [
    "analysis-schema",
    "extractor",
    "parser",
    "chunk",
  ]);
  assert.equal(plan.invalidatedNodeIds.length, targetGraph.nodes.length);
});
