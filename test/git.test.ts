import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  graphEquals,
  ingestGitRepository,
  type GraphDocument,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-git-"));
  git(root, "init");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");
  return root;
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function nodeByPath(graph: GraphDocument, path: string) {
  return graph.nodes.find((node) => node.identity.key === path);
}

test("ingests a pinned nested tree with filters, CODEOWNERS precedence and symlinks", () => {
  const root = initRepository();

  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "vendor"), { recursive: true });
  mkdirSync(join(root, "generated"), { recursive: true });
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "vendor", "lib.js"), "vendor();\n");
  writeFileSync(join(root, "generated", "api.ts"), "generated();\n");
  writeFileSync(join(root, "assets", "binary.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, "docs", "readme.md"), "docs\n");
  writeFileSync(
    join(root, "CODEOWNERS"),
    "* @all\n/src/** @src\n/src/nested/** @nested\n",
  );
  symlinkSync("src/a.ts", join(root, "link-to-a"));

  const pinned = commitAll(root, "fixture");

  const first = ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/repo",
    ref: pinned,
    policy: {
      exclude: ["docs/**"],
      generated: ["generated/**"],
      vendor: ["vendor/**"],
      binary: { exclude: true },
    },
  });

  assert.equal(first.commit, pinned);
  assert.equal(first.codeownersPath, "CODEOWNERS");
  assert.equal(nodeByPath(first.graph, "src")?.identity.kind, "directory");
  assert.equal(nodeByPath(first.graph, "src/nested/b.ts")?.identity.kind, "file");
  assert.equal(nodeByPath(first.graph, "link-to-a")?.identity.kind, "symlink");
  assert.equal(nodeByPath(first.graph, "link-to-a")?.metadata?.target, "src/a.ts");

  assert.equal(nodeByPath(first.graph, "vendor/lib.js"), undefined);
  assert.equal(nodeByPath(first.graph, "generated/api.ts"), undefined);
  assert.equal(nodeByPath(first.graph, "assets/binary.bin"), undefined);
  assert.equal(nodeByPath(first.graph, "docs/readme.md"), undefined);

  const diagnosticCodes = new Set(first.graph.diagnostics.map((item) => item.code));
  assert.equal(diagnosticCodes.has("vendor-excluded"), true);
  assert.equal(diagnosticCodes.has("generated-excluded"), true);
  assert.equal(diagnosticCodes.has("binary-excluded"), true);
  assert.equal(diagnosticCodes.has("path-excluded"), true);

  const nestedNode = nodeByPath(first.graph, "src/nested/b.ts");
  assert.notEqual(nestedNode, undefined);

  const effectiveRules = first.graph.edges
    .filter(
      (edge) =>
        edge.identity.kind === "path-rule-match" &&
        edge.identity.to === nestedNode!.id &&
        edge.metadata?.effective === true,
    )
    .map((edge) =>
      first.graph.nodes.find((node) => node.id === edge.identity.from),
    );

  assert.equal(effectiveRules.length, 1);
  assert.equal(effectiveRules[0]?.metadata?.pattern, "/src/nested/**");
  assert.deepEqual(effectiveRules[0]?.metadata?.targets, ["@nested"]);

  writeFileSync(join(root, "src", "a.ts"), "working tree drift\n");
  const second = ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/repo",
    ref: pinned,
    policy: {
      exclude: ["docs/**"],
      generated: ["generated/**"],
      vendor: ["vendor/**"],
      binary: { exclude: true },
    },
  });

  assert.equal(graphEquals(first.graph, second.graph), true);
});

test("rename changes path identity but preserves Git blob identity", () => {
  const root = initRepository();
  writeFileSync(join(root, "before.txt"), "same content\n");
  const before = commitAll(root, "before");

  git(root, "mv", "before.txt", "after.txt");
  const after = commitAll(root, "after");

  const beforeGraph = ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/rename",
    ref: before,
  }).graph;
  const afterGraph = ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/rename",
    ref: after,
  }).graph;

  const beforeNode = nodeByPath(beforeGraph, "before.txt");
  const afterNode = nodeByPath(afterGraph, "after.txt");

  assert.notEqual(beforeNode, undefined);
  assert.notEqual(afterNode, undefined);
  assert.notEqual(beforeNode!.id, afterNode!.id);
  assert.equal(beforeNode!.metadata?.blobSha, afterNode!.metadata?.blobSha);
});

test("include filters retain required ancestor directories", () => {
  const root = initRepository();
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  writeFileSync(join(root, "src", "deep", "keep.ts"), "keep\n");
  writeFileSync(join(root, "other", "drop.ts"), "drop\n");
  const commit = commitAll(root, "include fixture");

  const graph = ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/include",
    ref: commit,
    policy: { include: ["src/**"] },
    discoverCodeowners: false,
  }).graph;

  assert.notEqual(nodeByPath(graph, "src"), undefined);
  assert.notEqual(nodeByPath(graph, "src/deep"), undefined);
  assert.notEqual(nodeByPath(graph, "src/deep/keep.ts"), undefined);
  assert.equal(nodeByPath(graph, "other/drop.ts"), undefined);
});

test("represents gitlinks as submodule nodes without resolving their working tree", () => {
  const nested = initRepository();
  writeFileSync(join(nested, "README.md"), "nested\n");
  const nestedCommit = commitAll(nested, "nested");

  const root = initRepository();
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${nestedCommit},deps/nested`,
  );
  git(root, "commit", "-m", "gitlink");
  const commit = git(root, "rev-parse", "HEAD");

  const graph = ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/submodule",
    ref: commit,
  }).graph;

  const submodule = nodeByPath(graph, "deps/nested");
  assert.equal(submodule?.identity.kind, "submodule");
  assert.equal(submodule?.metadata?.commitSha, nestedCommit);
});
