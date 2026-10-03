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
  extractTypeScriptDependencies,
  ingestGitRepository,
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

function graphAt(root: string, commit: string, repositoryName: string): GraphDocument {
  return ingestGitRepository({
    repositoryPath: root,
    repository: repositoryName,
    ref: commit,
    discoverCodeowners: false,
  }).graph;
}

function moduleId(graph: GraphDocument, path: string): string {
  const node = graph.nodes.find(
    (candidate) =>
      candidate.identity.kind === "module" && candidate.identity.key === path,
  );
  assert.notEqual(node, undefined, `missing module ${path}`);
  return node!.id;
}

function fileId(graph: GraphDocument, path: string): string {
  const node = graph.nodes.find(
    (candidate) =>
      candidate.identity.kind === "file" && candidate.identity.key === path,
  );
  assert.notEqual(node, undefined, `missing file ${path}`);
  return node!.id;
}

test("extracts direct/transitive TS dependencies without sibling false positives", () => {
  const root = repository();
  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(
    join(root, "src", "shared.ts"),
    "export const shared = 1;\n",
  );
  writeFileSync(
    join(root, "src", "b.ts"),
    'import { shared } from "./shared.js";\nexport const b = shared;\n',
  );
  writeFileSync(
    join(root, "src", "a.ts"),
    'import { b } from "./b.js";\nexport { b };\n',
  );
  writeFileSync(
    join(root, "src", "sibling.ts"),
    'import { shared } from "./shared.js";\nexport const sibling = shared;\n',
  );
  const commit = commitAll(root, "dependency fixture");

  const extracted = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/deps",
    ref: commit,
    graph: graphAt(root, commit, "fixture/deps"),
  });

  const imports = extracted.graph.edges.filter(
    (edge) => edge.identity.kind === "imports",
  );
  assert.equal(imports.length, 3);

  const bAffected = affectedClosure(
    extracted.graph,
    fileId(extracted.graph, "src/b.ts"),
    { edgeKinds: ["source-file", "imports"] },
  );
  const bAffectedIds = new Set(bAffected.nodes.map((node) => node.id));
  assert.equal(bAffectedIds.has(moduleId(extracted.graph, "src/b.ts")), true);
  assert.equal(bAffectedIds.has(moduleId(extracted.graph, "src/a.ts")), true);
  assert.equal(
    bAffectedIds.has(moduleId(extracted.graph, "src/sibling.ts")),
    false,
  );

  const sharedAffected = affectedClosure(
    extracted.graph,
    fileId(extracted.graph, "src/shared.ts"),
    { edgeKinds: ["source-file", "imports"] },
  );
  const sharedAffectedIds = new Set(
    sharedAffected.nodes.map((node) => node.id),
  );
  assert.equal(sharedAffectedIds.has(moduleId(extracted.graph, "src/a.ts")), true);
  assert.equal(
    sharedAffectedIds.has(moduleId(extracted.graph, "src/sibling.ts")),
    true,
  );
});

test("resolves tsconfig paths with specific aliases before broad aliases", () => {
  const root = repository();
  mkdirSync(join(root, "src", "lib", "special"), { recursive: true });
  mkdirSync(join(root, "src", "special"), { recursive: true });

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@lib/*": ["src/lib/*"],
            "@lib/special/*": ["src/special/*"],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "src", "lib", "special", "value.ts"),
    "export const wrong = 1;\n",
  );
  writeFileSync(
    join(root, "src", "special", "value.ts"),
    "export const right = 1;\n",
  );
  writeFileSync(
    join(root, "src", "main.ts"),
    'import { right } from "@lib/special/value";\nexport const result = right;\n',
  );
  const commit = commitAll(root, "alias fixture");

  const extracted = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/alias",
    ref: commit,
    graph: graphAt(root, commit, "fixture/alias"),
  });

  const from = moduleId(extracted.graph, "src/main.ts");
  const right = moduleId(extracted.graph, "src/special/value.ts");
  const wrong = moduleId(extracted.graph, "src/lib/special/value.ts");
  const importEdges = extracted.graph.edges.filter(
    (edge) => edge.identity.kind === "imports" && edge.identity.from === from,
  );

  assert.equal(importEdges.length, 1);
  assert.equal(importEdges[0]?.identity.to, right);
  assert.notEqual(importEdges[0]?.identity.to, wrong);
  assert.equal(extracted.metrics.unresolvedImports, 0);
});

test("emits export symbols and degrades unresolved imports visibly", () => {
  const root = repository();
  writeFileSync(
    join(root, "module.ts"),
    [
      'import missing from "@external/pkg";',
      "export const named = 1;",
      "export function run() { return named; }",
      "export default class Example {}",
      "void missing;",
      "",
    ].join("\n"),
  );
  const commit = commitAll(root, "exports fixture");

  const extracted = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/exports",
    ref: commit,
    graph: graphAt(root, commit, "fixture/exports"),
  });

  const symbols = extracted.graph.nodes
    .filter((node) => node.identity.kind === "symbol")
    .map((node) => node.metadata?.name)
    .sort();

  assert.deepEqual(symbols, ["default", "named", "run"]);
  assert.equal(
    extracted.graph.edges.some((edge) => edge.identity.kind === "imports"),
    false,
  );
  assert.equal(extracted.metrics.unresolvedImports, 1);
  assert.equal(
    extracted.graph.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ts-import-unresolved" &&
        diagnostic.state === "unresolved",
    ),
    true,
  );
});

test("reports unsupported tsconfig composition as partial evidence", () => {
  const root = repository();
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: "./base.json",
      references: [{ path: "./packages/a" }],
      compilerOptions: { baseUrl: "." },
    }),
  );
  writeFileSync(join(root, "main.ts"), "export const main = 1;\n");
  const commit = commitAll(root, "config diagnostics");

  const extracted = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/config",
    ref: commit,
    graph: graphAt(root, commit, "fixture/config"),
  });

  const codes = new Set(
    extracted.graph.diagnostics.map((diagnostic) => diagnostic.code),
  );
  assert.equal(codes.has("tsconfig-extends-not-expanded"), true);
  assert.equal(codes.has("tsconfig-project-references-not-expanded"), true);
});

test("syntax artifacts are reused by Git blob identity across incremental commits", () => {
  const root = repository();
  const cache = mkdtempSync(join(tmpdir(), "repograph-ts-cache-"));
  writeFileSync(
    join(root, "stable.ts"),
    "export const stable = 1;\n",
  );
  writeFileSync(
    join(root, "changing.ts"),
    'import { stable } from "./stable";\nexport const value = stable;\n',
  );
  const firstCommit = commitAll(root, "first");

  const store = new LocalArtifactStore(cache);
  const first = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/cache",
    ref: firstCommit,
    graph: graphAt(root, firstCommit, "fixture/cache"),
    store,
  });
  assert.equal(first.metrics.parsedArtifacts, 2);
  assert.equal(first.metrics.reusedArtifacts, 0);

  writeFileSync(
    join(root, "changing.ts"),
    'import { stable } from "./stable";\nexport const value = stable + 1;\n',
  );
  const secondCommit = commitAll(root, "second");

  const second = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/cache",
    ref: secondCommit,
    graph: graphAt(root, secondCommit, "fixture/cache"),
    store,
  });

  assert.equal(second.metrics.parsedArtifacts, 1);
  assert.equal(second.metrics.reusedArtifacts, 1);
  assert.equal(second.metrics.resolvedImports, 1);
});

test("extractor output is deterministic and supports require/dynamic import/re-export", () => {
  const root = repository();
  writeFileSync(join(root, "dep.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "main.ts"),
    [
      'const dep = require("./dep");',
      'void import("./dep");',
      'export { value as renamed } from "./dep";',
      "exports.cjs = dep.value;",
      "",
    ].join("\n"),
  );
  const commit = commitAll(root, "mixed syntax");
  const baseGraph = graphAt(root, commit, "fixture/deterministic");

  const first = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/deterministic",
    ref: commit,
    graph: baseGraph,
  });
  const second = extractTypeScriptDependencies({
    repositoryPath: root,
    repository: "fixture/deterministic",
    ref: commit,
    graph: baseGraph,
  });

  assert.equal(serializeGraph(first.graph), serializeGraph(second.graph));
  assert.equal(first.metrics.resolvedImports, 3);
  const mainImports = first.graph.edges.filter(
    (edge) =>
      edge.identity.kind === "imports" &&
      edge.identity.from === moduleId(first.graph, "main.ts"),
  );
  assert.equal(mainImports.length, 1);
  const exportedNames = first.graph.nodes
    .filter(
      (node) =>
        node.identity.kind === "symbol" &&
        node.identity.key.startsWith("main.ts#"),
    )
    .map((node) => node.metadata?.name)
    .sort();
  assert.deepEqual(exportedNames, ["cjs", "renamed"]);
});
