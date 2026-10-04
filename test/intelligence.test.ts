import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  LocalArtifactStore,
  REPOGRAPH_PROTOCOL_VERSION,
  buildRepositoryIntelligence,
  createTraversalPolicy,
  executeProtocolRequest,
  graphEquals,
  nodeId,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixtureRepository(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "repograph-intelligence-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");

  write(
    root,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-app",
        version: "1.0.0",
        main: "./src/index.ts",
        types: "./src/index.d.ts",
      },
      null,
      2,
    ) + "\n",
  );
  write(root, "src/core.ts", "export const core = 41;\n");
  write(
    root,
    "src/index.ts",
    'import { core } from "./core.js"; export const answer = core + 1;\n',
  );
  write(root, "src/index.d.ts", "export declare const answer: number;\n");
  write(
    root,
    "src/core.test.ts",
    'import { core } from "./core.js"; if (core !== 41) throw new Error("bad");\n',
  );

  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture");
  return { root, commit: git(root, "rev-parse", "HEAD") };
}

function fileId(path: string): string {
  return nodeId({
    namespace: "fixture/intelligence",
    kind: "file",
    key: path,
  });
}

test("builds one pinned intelligence graph with dependency, test and contract facts", () => {
  const { root, commit } = fixtureRepository();
  const result = buildRepositoryIntelligence({
    repositoryPath: root,
    repository: "fixture/intelligence",
    ref: commit,
  });

  assert.equal(result.commit, commit);
  assert.equal(result.requestedRef, commit);

  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "imports" &&
        edge.identity.from === fileId("src/index.ts") &&
        edge.identity.to === fileId("src/core.ts"),
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

  for (const edge of result.graph.edges) {
    for (const provenance of edge.provenance) {
      assert.equal(provenance.repository, "fixture/intelligence");
      assert.equal(provenance.commit, commit);
    }
  }

  assert.equal(result.metrics.tsjs.resolvedDependencies >= 2, true);
  assert.equal(result.metrics.relationships.testRelations, 1);
  assert.equal(result.metrics.relationships.contractEntrypoints, 1);
  assert.equal(
    result.metrics.composition.skippedDuplicateRelationshipNodes,
    result.metrics.composition.baseNodes,
  );
  assert.equal(
    result.metrics.composition.skippedDuplicateRelationshipEdges,
    result.metrics.composition.baseEdges,
  );
  assert.equal(result.metrics.composition.relationshipOnlyNodes > 0, true);
  assert.equal(result.metrics.composition.relationshipOnlyEdges > 0, true);
});

test("same revision is deterministic and unchanged syntax reuses content-addressed artifacts", () => {
  const { root, commit } = fixtureRepository();
  const store = new LocalArtifactStore(
    mkdtempSync(join(tmpdir(), "repograph-intelligence-cache-")),
  );

  const first = buildRepositoryIntelligence({
    repositoryPath: root,
    repository: "fixture/intelligence",
    ref: commit,
    store,
  });
  const second = buildRepositoryIntelligence({
    repositoryPath: root,
    repository: "fixture/intelligence",
    ref: commit,
    store,
  });

  assert.equal(graphEquals(first.graph, second.graph), true);
  assert.equal(first.metrics.tsjs.parsedFiles > 0, true);
  assert.equal(second.metrics.tsjs.parsedFiles, 0);
  assert.equal(
    second.metrics.tsjs.reusedSyntaxArtifacts,
    second.metrics.tsjs.sourceFiles,
  );
});

test("full intelligence graph can be consumed directly by protocol v1", () => {
  const { root, commit } = fixtureRepository();
  const result = buildRepositoryIntelligence({
    repositoryPath: root,
    repository: "fixture/intelligence",
    ref: commit,
  });

  const response = executeProtocolRequest({
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "slice",
    requestId: "hacka-fixture",
    graph: result.graph,
    start: fileId("src/core.ts"),
    policy: createTraversalPolicy({
      direction: "in",
      edgeKinds: ["imports", "tests"],
      maxDepth: 2,
      maxNodes: 20,
    }),
  });

  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.requestId, "hacka-fixture");
  assert.equal(response.data.type, "graph-slice");
  if (response.data.type !== "graph-slice") return;
  assert.equal(response.data.availability, "available");
  assert.equal(
    response.data.nodes.some((node) => node.key === "src/index.ts"),
    true,
  );
  assert.equal(
    response.data.nodes.some((node) => node.key === "src/core.test.ts"),
    true,
  );
});

test("CLI builds the same intelligence surface and emits pinned metrics", () => {
  const { root, commit } = fixtureRepository();
  const graphPath = join(root, "intelligence.json");
  const metricsPath = join(root, "metrics.json");
  const cachePath = join(root, ".repograph-cache");

  execFileSync(
    process.execPath,
    [
      "dist/src/cli.js",
      "build-intelligence",
      "--repo",
      root,
      "--ref",
      commit,
      "--repository",
      "fixture/intelligence",
      "--cache-dir",
      cachePath,
      "--metrics-out",
      metricsPath,
      "--out",
      graphPath,
    ],
    { encoding: "utf8" },
  );

  const graph = JSON.parse(
    execFileSync(process.execPath, ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(graphPath)}, "utf8"))`], {
      encoding: "utf8",
    }),
  ) as { edges: Array<{ identity: { kind: string } }> };
  const metrics = JSON.parse(
    execFileSync(process.execPath, ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(metricsPath)}, "utf8"))`], {
      encoding: "utf8",
    }),
  ) as {
    commit: string;
    requestedRef: string;
    metrics: { relationships: { testRelations: number } };
  };

  assert.equal(
    graph.edges.some((edge) => edge.identity.kind === "imports"),
    true,
  );
  assert.equal(
    graph.edges.some((edge) => edge.identity.kind === "tests"),
    true,
  );
  assert.equal(metrics.commit, commit);
  assert.equal(metrics.requestedRef, commit);
  assert.equal(metrics.metrics.relationships.testRelations, 1);
});
