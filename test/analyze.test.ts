import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  analyzeRepository,
  nodeId,
  traverseWithPolicy,
  type GraphDocument,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-analyze-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");
  return root;
}

function file(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
}

function fixture(): { root: string; ref: string } {
  const root = repository();
  file(
    root,
    "package.json",
    JSON.stringify({
      name: "@fixture/analyze",
      version: "1.0.0",
      module: "./src/index.ts",
      types: "./src/index.d.ts",
    }),
  );
  file(
    root,
    "src/index.ts",
    'export { compute } from "./core.js";\n',
  );
  file(
    root,
    "src/index.d.ts",
    "export declare function compute(value: number): number;\n",
  );
  file(
    root,
    "src/core.ts",
    'import { helper } from "./helper.js"; export const compute = (value: number) => helper(value);\n',
  );
  file(
    root,
    "src/helper.ts",
    "export const helper = (value: number) => value + 1;\n",
  );
  file(
    root,
    "src/core.test.ts",
    'import { compute } from "./core.js"; export const result = compute(1);\n',
  );
  file(
    root,
    "src/unrelated.ts",
    "export const unrelated = true;\n",
  );
  return { root, ref: commit(root) };
}

function fileId(path: string): string {
  return nodeId({
    namespace: "fixture/analyze",
    kind: "file",
    key: path,
  });
}

test("analyzeRepository composes imports, tests and package contracts", () => {
  const { root, ref } = fixture();
  const result = analyzeRepository({
    repositoryPath: root,
    repository: "fixture/analyze",
    ref,
    discoverCodeowners: false,
  });

  assert.equal(result.commit, ref);
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "imports" &&
        edge.identity.from === fileId("src/core.ts") &&
        edge.identity.to === fileId("src/helper.ts"),
    ),
    true,
  );
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "tests" &&
        edge.identity.from === fileId("src/core.test.ts") &&
        edge.identity.to === fileId("src/core.ts"),
    ),
    true,
  );
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "package-contract" &&
        edge.identity.to === fileId("src/index.d.ts"),
    ),
    true,
  );

  const context = traverseWithPolicy(result.graph, fileId("src/core.ts"), {
    direction: "both",
    edgeKinds: ["imports", "reexports", "tests"],
    evidenceMethods: ["deterministic-extraction"],
    maxDepth: 3,
    maxNodes: 20,
  });
  const ids = new Set(context.nodes.map((node) => node.id));
  assert.equal(ids.has(fileId("src/core.test.ts")), true);
  assert.equal(ids.has(fileId("src/helper.ts")), true);
  assert.equal(ids.has(fileId("src/unrelated.ts")), false);
});

test("CLI analyze emits the same enriched graph surface for non-TypeScript consumers", () => {
  const { root, ref } = fixture();
  const outputPath = join(root, "analysis.json");

  execFileSync(
    process.execPath,
    [
      "dist/src/cli.js",
      "analyze",
      "--repo",
      root,
      "--ref",
      ref,
      "--repository",
      "fixture/analyze",
      "--out",
      outputPath,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const graph = JSON.parse(readFileSync(outputPath, "utf8")) as GraphDocument;
  assert.equal(
    graph.edges.some((edge) => edge.identity.kind === "imports"),
    true,
  );
  assert.equal(
    graph.edges.some((edge) => edge.identity.kind === "tests"),
    true,
  );
  assert.equal(
    graph.edges.some((edge) => edge.identity.kind === "package-contract"),
    true,
  );
});
