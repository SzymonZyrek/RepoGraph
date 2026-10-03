import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  extractRepositoryRelationships,
  ingestGitRepository,
  nodeId,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-relations-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");
  return root;
}

function file(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function extract(root: string, ref: string) {
  return extractRepositoryRelationships(
    ingestGitRepository({
      repositoryPath: root,
      repository: "fixture/relations",
      ref,
      discoverCodeowners: false,
    }),
  );
}

function fileId(path: string): string {
  return nodeId({
    namespace: "fixture/relations",
    kind: "file",
    key: path,
  });
}

function packageId(path: string): string {
  return nodeId({
    namespace: "fixture/relations",
    kind: "package",
    key: path,
  });
}

test("extracts explicit local package dependencies plus build and contract entrypoints", () => {
  const root = repository();

  file(
    root,
    "packages/core/package.json",
    JSON.stringify({
      name: "@fixture/core",
      version: "1.0.0",
      module: "./src/index.js",
      types: "./src/index.d.ts",
      exports: {
        ".": {
          types: "./src/index.d.ts",
          import: "./src/index.js",
        },
      },
    }),
  );
  file(root, "packages/core/src/index.js", "export const core = 1;\n");
  file(root, "packages/core/src/index.d.ts", "export declare const core: number;\n");

  file(
    root,
    "packages/app/package.json",
    JSON.stringify({
      name: "@fixture/app",
      version: "1.0.0",
      dependencies: {
        "@fixture/core": "workspace:*",
        external: "^1.0.0",
      },
    }),
  );
  file(root, "packages/app/src/index.ts", "export const app = 1;\n");

  const ref = commit(root, "workspace");
  const result = extract(root, ref);

  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "package-dependency" &&
        edge.identity.from === packageId("packages/app/package.json") &&
        edge.identity.to === packageId("packages/core/package.json"),
    ),
    true,
  );

  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "package-build-entrypoint" &&
        edge.identity.from === packageId("packages/core/package.json") &&
        edge.identity.to === fileId("packages/core/src/index.js"),
    ),
    true,
  );

  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "package-contract" &&
        edge.identity.from === packageId("packages/core/package.json") &&
        edge.identity.to === fileId("packages/core/src/index.d.ts"),
    ),
    true,
  );

  assert.equal(result.metrics.packageDependencies, 1);
  assert.equal(result.metrics.packageMemberships > 0, true);
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "belongs-to-package" &&
        edge.identity.from === fileId("packages/app/src/index.ts") &&
        edge.identity.to === packageId("packages/app/package.json"),
    ),
    true,
  );
  assert.equal(result.metrics.buildEntrypoints >= 1, true);
  assert.equal(result.metrics.contractEntrypoints >= 1, true);
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "package-dependency" &&
        edge.metadata?.dependencyName === "external",
    ),
    false,
  );
});

test("emits test-to-source edges only for an unambiguous filename convention", () => {
  const root = repository();

  file(root, "src/math.ts", "export const add = (a: number, b: number) => a + b;\n");
  file(root, "src/math.test.ts", "export const caseName = 'math';\n");
  file(root, "src/parser.ts", "export const parse = () => 1;\n");
  file(root, "src/__tests__/parser.spec.ts", "export const caseName = 'parser';\n");
  file(root, "test/math.test.ts", "export const detached = true;\n");

  const ref = commit(root, "tests");
  const result = extract(root, ref);
  const testEdges = result.graph.edges.filter(
    (edge) => edge.identity.kind === "tests",
  );

  assert.equal(testEdges.length, 2);
  assert.equal(
    testEdges.some(
      (edge) =>
        edge.identity.from === fileId("src/math.test.ts") &&
        edge.identity.to === fileId("src/math.ts"),
    ),
    true,
  );
  assert.equal(
    testEdges.some(
      (edge) =>
        edge.identity.from === fileId("src/__tests__/parser.spec.ts") &&
        edge.identity.to === fileId("src/parser.ts"),
    ),
    true,
  );
  assert.equal(
    testEdges.some((edge) => edge.identity.from === fileId("test/math.test.ts")),
    false,
  );
  assert.equal(result.metrics.testRelations, 2);
});

test("unresolved explicit relationships become diagnostics instead of invented edges", () => {
  const root = repository();

  file(
    root,
    "packages/app/package.json",
    JSON.stringify({
      name: "@fixture/app",
      dependencies: {
        "@fixture/missing": "workspace:*",
      },
      module: "./dist/index.js",
    }),
  );
  file(root, "packages/app/src/index.ts", "export const app = 1;\n");

  const ref = commit(root, "unresolved");
  const result = extract(root, ref);

  assert.equal(result.metrics.packageDependencies, 0);
  assert.equal(result.metrics.buildEntrypoints, 0);
  assert.equal(
    result.graph.diagnostics.some(
      (item) =>
        item.code === "repository-relations-unresolved-workspace-dependency" &&
        item.state === "unresolved",
    ),
    true,
  );
  assert.equal(
    result.graph.diagnostics.some(
      (item) =>
        item.code === "repository-relations-unresolved-entrypoint" &&
        item.state === "partial",
    ),
    true,
  );
});
