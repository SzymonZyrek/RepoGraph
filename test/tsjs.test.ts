import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  LocalArtifactStore,
  extractTypeScriptJavaScriptDependencies,
  graphEquals,
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
  const root = mkdtempSync(join(tmpdir(), "repograph-tsjs-"));
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

function extract(root: string, ref: string, store?: LocalArtifactStore) {
  const ingestion = ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/tsjs",
    ref,
    discoverCodeowners: false,
  });
  return extractTypeScriptJavaScriptDependencies(ingestion, {
    ...(store === undefined ? {} : { store }),
  });
}

function fileId(path: string): string {
  return nodeId({
    namespace: "fixture/tsjs",
    kind: "file",
    key: path,
  });
}

test("extracts direct/transitive module dependencies without sibling false positives", () => {
  const root = repository();
  file(root, "src/shared.ts", "export const shared = 1;\n");
  file(root, "src/a.ts", 'import { shared } from "./shared"; export const a = shared;\n');
  file(root, "src/b.ts", 'import { shared } from "./shared"; export const b = shared;\n');
  file(root, "src/root.ts", 'import { a } from "./a"; export const root = a;\n');
  const ref = commit(root, "fixture");

  const result = extract(root, ref);
  const dependencies = result.graph.edges
    .filter((edge) => edge.identity.kind === "imports")
    .map((edge) => [edge.identity.from, edge.identity.to]);

  assert.equal(
    dependencies.some(([from, to]) => from === fileId("src/root.ts") && to === fileId("src/a.ts")),
    true,
  );
  assert.equal(
    dependencies.some(([from, to]) => from === fileId("src/a.ts") && to === fileId("src/shared.ts")),
    true,
  );
  assert.equal(
    dependencies.some(([from, to]) => from === fileId("src/b.ts") && to === fileId("src/shared.ts")),
    true,
  );
  assert.equal(
    dependencies.some(([from, to]) => from === fileId("src/a.ts") && to === fileId("src/b.ts")),
    false,
  );
});

test("resolves root tsconfig path aliases and emits exported symbol identities", () => {
  const root = repository();
  file(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@core/*": ["src/core/*"] },
      },
    }),
  );
  file(root, "src/core/util.ts", "export function util() { return 1; }\n");
  file(root, "src/app.ts", 'import { util } from "@core/util"; export default util;\n');
  const ref = commit(root, "alias");

  const result = extract(root, ref);
  const aliasEdge = result.graph.edges.find(
    (edge) =>
      edge.identity.kind === "imports" &&
      edge.identity.from === fileId("src/app.ts") &&
      edge.identity.to === fileId("src/core/util.ts"),
  );
  assert.notEqual(aliasEdge, undefined);

  assert.equal(
    result.graph.nodes.some(
      (node) =>
        node.identity.kind === "symbol" &&
        node.identity.key === "src/core/util.ts#export:util",
    ),
    true,
  );
  assert.equal(
    result.graph.nodes.some(
      (node) =>
        node.identity.kind === "symbol" &&
        node.identity.key === "src/app.ts#export:default",
    ),
    true,
  );
});

test("unresolved internal imports degrade to diagnostics without invented edges", () => {
  const root = repository();
  file(root, "src/app.ts", 'import { missing } from "./missing"; export { missing };\n');
  const ref = commit(root, "unresolved");

  const result = extract(root, ref);
  assert.equal(result.metrics.unresolvedDependencies, 1);
  assert.equal(
    result.graph.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "tsjs-unresolved-import" &&
        diagnostic.state === "unresolved",
    ),
    true,
  );
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "imports" &&
        edge.identity.from === fileId("src/app.ts"),
    ),
    false,
  );
});

test("external packages are visible partial evidence, not fake internal edges", () => {
  const root = repository();
  file(root, "src/app.ts", 'import React from "react"; export default React;\n');
  const ref = commit(root, "external");

  const result = extract(root, ref);
  assert.equal(result.metrics.externalDependencies, 1);
  assert.equal(
    result.graph.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "tsjs-external-module" &&
        diagnostic.state === "partial",
    ),
    true,
  );
});

test("syntax output is deterministic", () => {
  const root = repository();
  file(root, "src/a.ts", 'export const z = 1; export const a = 2;\n');
  file(root, "src/b.ts", 'export { z } from "./a";\n');
  const ref = commit(root, "deterministic");

  const first = extract(root, ref);
  const second = extract(root, ref);
  assert.equal(graphEquals(first.graph, second.graph), true);
});

test("content-addressed syntax cache reparses only changed blobs", () => {
  const root = repository();
  const cache = new LocalArtifactStore(mkdtempSync(join(tmpdir(), "repograph-tsjs-cache-")));
  file(root, "src/stable.ts", "export const stable = 1;\n");
  file(root, "src/changed.ts", "export const changed = 1;\n");
  const base = commit(root, "base");

  const first = extract(root, base, cache);
  assert.equal(first.metrics.parsedFiles, 2);
  assert.equal(first.metrics.reusedSyntaxArtifacts, 0);

  file(root, "src/changed.ts", "export const changed = 2;\n");
  const target = commit(root, "target");
  const second = extract(root, target, cache);

  assert.equal(second.metrics.parsedFiles, 1);
  assert.equal(second.metrics.reusedSyntaxArtifacts, 1);
  assert.equal(second.metrics.sourceFiles, 2);
});
