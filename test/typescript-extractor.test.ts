import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalArtifactStore,
  affectedClosure,
  extractTypeScriptRepository,
  incrementalTypeScriptRepositoryUpdate,
  serializeGraph,
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
  const root = mkdtempSync(join(tmpdir(), "repograph-ts-"));
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
  return mkdtempSync(join(tmpdir(), "repograph-ts-cache-"));
}

function fileNode(graph: GraphDocument, path: string) {
  return graph.nodes.find(
    (node) => node.identity.kind === "file" && node.identity.key === path,
  );
}

function edgeBetween(
  graph: GraphDocument,
  kind: string,
  fromPath: string,
  toPath: string,
) {
  const from = fileNode(graph, fromPath);
  const to = fileNode(graph, toPath);
  if (from === undefined || to === undefined) return undefined;
  return graph.edges.find(
    (edge) =>
      edge.identity.kind === kind &&
      edge.identity.from === from.id &&
      edge.identity.to === to.id,
  );
}

test("extracts deterministic TS/JS dependencies, aliases, exports and projects", () => {
  const root = repository();
  const cache = cacheRoot();

  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "packages", "sub"), { recursive: true });

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@lib/*": ["src/lib/*"],
          },
        },
        references: [{ path: "./packages/sub" }],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "packages", "sub", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { composite: true } }),
  );
  writeFileSync(
    join(root, "packages", "sub", "index.ts"),
    "export const sub = 1;\n",
  );
  writeFileSync(
    join(root, "src", "lib", "shared.ts"),
    [
      "export const shared = 1;",
      "export type Shared = number;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "feature.ts"),
    [
      'import { shared } from "@lib/shared";',
      "export const feature = shared;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "page.ts"),
    [
      'import { feature } from "./feature";',
      "export default feature;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "sibling.ts"),
    [
      'import { shared } from "@lib/shared";',
      "export const sibling = shared;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "reexport.ts"),
    'export { shared as sharedAgain } from "@lib/shared";\n',
  );
  writeFileSync(
    join(root, "src", "dynamic.js"),
    [
      'const shared = require("./lib/shared");',
      'export const load = () => import("./feature");',
      "export default shared;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "external.ts"),
    [
      'import React from "react";',
      "export const external = React;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "unresolved.ts"),
    [
      'import "./missing";',
      "export const unresolved = true;",
      "",
    ].join("\n"),
  );

  const commit = commitAll(root, "fixture");
  const store = new LocalArtifactStore(cache);
  const first = extractTypeScriptRepository(store, {
    repositoryPath: root,
    repository: "fixture/typescript",
    ref: commit,
    discoverCodeowners: false,
  });

  assert.equal(first.metrics.candidateFiles, 9);
  assert.equal(first.metrics.parsedFiles, 9);
  assert.equal(first.metrics.reusedSyntaxArtifacts, 0);
  assert.equal(first.metrics.projects, 2);
  assert.equal(first.metrics.projectReferences, 1);
  assert.equal(first.metrics.unresolvedDependencies, 1);

  const aliasEdge = edgeBetween(
    first.graph,
    "imports",
    "src/feature.ts",
    "src/lib/shared.ts",
  );
  assert.notEqual(aliasEdge, undefined);
  assert.equal(aliasEdge?.metadata?.specifier, "@lib/shared");

  assert.notEqual(
    edgeBetween(first.graph, "imports", "src/page.ts", "src/feature.ts"),
    undefined,
  );
  assert.notEqual(
    edgeBetween(first.graph, "imports", "src/dynamic.js", "src/lib/shared.ts"),
    undefined,
  );
  assert.notEqual(
    edgeBetween(first.graph, "imports", "src/dynamic.js", "src/feature.ts"),
    undefined,
  );
  assert.notEqual(
    edgeBetween(
      first.graph,
      "re-exports",
      "src/reexport.ts",
      "src/lib/shared.ts",
    ),
    undefined,
  );

  const external = first.graph.nodes.find(
    (node) =>
      node.identity.kind === "external-module" &&
      node.identity.key === "react",
  );
  assert.notEqual(external, undefined);
  assert.equal(
    first.graph.edges.some(
      (edge) =>
        edge.identity.kind === "imports-external" &&
        edge.identity.to === external?.id,
    ),
    true,
  );

  assert.equal(
    first.graph.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ts-import-unresolved" &&
        diagnostic.message.includes("./missing"),
    ),
    true,
  );

  const sharedSymbols = first.graph.nodes
    .filter(
      (node) =>
        node.identity.kind === "symbol" &&
        node.identity.key.startsWith("src/lib/shared.ts#export:"),
    )
    .map((node) => node.metadata?.name)
    .sort();
  assert.deepEqual(sharedSymbols, ["Shared", "shared"]);

  const projects = first.graph.nodes.filter(
    (node) => node.identity.kind === "ts-project",
  );
  assert.equal(projects.length, 2);
  assert.equal(
    first.graph.edges.filter(
      (edge) => edge.identity.kind === "project-reference",
    ).length,
    1,
  );

  const shared = fileNode(first.graph, "src/lib/shared.ts")!;
  const affectedByShared = affectedClosure(first.graph, shared.id, {
    edgeKinds: ["imports", "re-exports"],
  });
  const affectedSharedPaths = new Set(
    affectedByShared.nodes
      .filter((node) => node.identity.kind === "file")
      .map((node) => node.identity.key),
  );
  assert.equal(affectedSharedPaths.has("src/feature.ts"), true);
  assert.equal(affectedSharedPaths.has("src/page.ts"), true);
  assert.equal(affectedSharedPaths.has("src/sibling.ts"), true);
  assert.equal(affectedSharedPaths.has("src/reexport.ts"), true);

  const feature = fileNode(first.graph, "src/feature.ts")!;
  const affectedByFeature = affectedClosure(first.graph, feature.id, {
    edgeKinds: ["imports", "re-exports"],
  });
  const affectedFeaturePaths = new Set(
    affectedByFeature.nodes
      .filter((node) => node.identity.kind === "file")
      .map((node) => node.identity.key),
  );
  assert.equal(affectedFeaturePaths.has("src/page.ts"), true);
  assert.equal(affectedFeaturePaths.has("src/dynamic.js"), true);
  assert.equal(affectedFeaturePaths.has("src/sibling.ts"), false);

  const restarted = new LocalArtifactStore(cache);
  const second = extractTypeScriptRepository(restarted, {
    repositoryPath: root,
    repository: "fixture/typescript",
    ref: commit,
    discoverCodeowners: false,
  });

  assert.equal(second.metrics.parsedFiles, 0);
  assert.equal(second.metrics.reusedSyntaxArtifacts, 9);
  assert.equal(serializeGraph(second.graph), serializeGraph(first.graph));
});

test("incremental TS extraction reparses only changed blobs", () => {
  const root = repository();
  const cache = cacheRoot();

  writeFileSync(
    join(root, "stable.ts"),
    "export const stable = 1;\n",
  );
  writeFileSync(
    join(root, "changed.ts"),
    [
      'import { stable } from "./stable";',
      "export const changed = stable;",
      "",
    ].join("\n"),
  );
  const base = commitAll(root, "base");

  const warmStore = new LocalArtifactStore(cache);
  const warm = extractTypeScriptRepository(warmStore, {
    repositoryPath: root,
    repository: "fixture/incremental-ts",
    ref: base,
    discoverCodeowners: false,
  });
  assert.equal(warm.metrics.parsedFiles, 2);

  writeFileSync(
    join(root, "changed.ts"),
    [
      'import { stable } from "./stable";',
      "export const changed = stable + 1;",
      "",
    ].join("\n"),
  );
  const target = commitAll(root, "target");

  const restarted = new LocalArtifactStore(cache);
  const result = incrementalTypeScriptRepositoryUpdate(restarted, {
    repositoryPath: root,
    repository: "fixture/incremental-ts",
    baseRef: base,
    targetRef: target,
    discoverCodeowners: false,
  });

  assert.equal(result.plan.globalInvalidation, false);
  assert.equal(result.plan.metrics.modified, 1);
  assert.equal(result.targetExtraction.parsedFiles, 1);
  assert.equal(result.targetExtraction.reusedSyntaxArtifacts, 1);
  assert.notEqual(
    edgeBetween(result.targetGraph, "imports", "changed.ts", "stable.ts"),
    undefined,
  );
});
