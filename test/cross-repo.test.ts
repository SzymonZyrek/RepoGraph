import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  composeCrossRepositoryGraph,
  coordinateIdentity,
  crossRepositoryAffected,
  extractRepositoryRelationships,
  ingestGitRepository,
  nodeId,
  type CrossRepositoryDependencyMapping,
  type RepositoryGraphSnapshot,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function packageSnapshot(
  repository: string,
  name: string,
  version: string,
  extraFiles: Record<string, string> = {},
): RepositoryGraphSnapshot {
  const root = mkdtempSync(join(tmpdir(), "repograph-cross-repo-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version,
      module: "./index.js",
    }),
  );
  writeFileSync(join(root, "index.js"), "export const value = 1;\n");
  for (const [path, content] of Object.entries(extraFiles)) {
    writeFileSync(join(root, path), content);
  }

  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture");
  const ref = git(root, "rev-parse", "HEAD");
  const ingestion = ingestGitRepository({
    repositoryPath: root,
    repository,
    ref,
    discoverCodeowners: false,
  });
  const graph = extractRepositoryRelationships(ingestion).graph;

  return {
    repository,
    ref: ingestion.requestedRef,
    commit: ingestion.commit,
    graph,
  };
}

function packageLocator(repository: string) {
  return { repository, kind: "package", key: "package.json" };
}

function packageId(repository: string): string {
  return nodeId({
    namespace: repository,
    kind: "package",
    key: "package.json",
  });
}

function mapping(
  id: string,
  consumerRepository: string,
  packageName: string,
  version: string,
): CrossRepositoryDependencyMapping {
  return {
    id,
    consumer: packageLocator(consumerRepository),
    coordinate: {
      kind: "package",
      ecosystem: "npm",
      name: packageName,
      version,
    },
  };
}

const mappingIdentity = {
  identity: { name: "fixture-cross-repo", version: "1" },
};

test("a shared package yields a bounded downstream slice across supplied repositories only", () => {
  const shared = packageSnapshot(
    "fixture/shared",
    "@fixture/shared",
    "1.0.0",
  );
  const mid = packageSnapshot("fixture/mid", "@fixture/mid", "1.0.0");
  const app = packageSnapshot("fixture/app", "@fixture/app", "1.0.0");
  const unrelated = packageSnapshot(
    "fixture/unrelated",
    "@fixture/unrelated",
    "1.0.0",
  );

  const composed = composeCrossRepositoryGraph(
    [shared, mid, app, unrelated],
    {
      ...mappingIdentity,
      mappings: [
        mapping("mid->shared", "fixture/mid", "@fixture/shared", "1.0.0"),
        mapping("app->mid", "fixture/app", "@fixture/mid", "1.0.0"),
      ],
    },
  );

  assert.deepEqual(composed.metrics, {
    mappings: 2,
    connected: 2,
    unresolved: 0,
    ambiguous: 0,
  });

  const oneHop = crossRepositoryAffected(
    composed.graph,
    packageId("fixture/shared"),
    { maxRepositoryHops: 1 },
  );
  const oneHopIds = new Set(oneHop.nodes.map((node) => node.id));

  assert.equal(oneHopIds.has(packageId("fixture/mid")), true);
  assert.equal(oneHopIds.has(packageId("fixture/app")), false);
  assert.equal(oneHopIds.has(packageId("fixture/unrelated")), false);
  assert.equal(oneHop.truncated, true);

  const twoHops = crossRepositoryAffected(
    composed.graph,
    packageId("fixture/shared"),
    { maxRepositoryHops: 2 },
  );
  const twoHopIds = new Set(twoHops.nodes.map((node) => node.id));

  assert.equal(twoHopIds.has(packageId("fixture/mid")), true);
  assert.equal(twoHopIds.has(packageId("fixture/app")), true);
  assert.equal(twoHopIds.has(packageId("fixture/unrelated")), false);
  assert.equal(twoHops.truncated, false);

  const sharedCoordinate = nodeId(
    coordinateIdentity({
      kind: "package",
      ecosystem: "npm",
      name: "@fixture/shared",
      version: "1.0.0",
    }),
  );
  assert.equal(twoHopIds.has(sharedCoordinate), true);
});

test("unresolved coordinates stay explicit and never trigger remote resolution", () => {
  const app = packageSnapshot("fixture/app", "@fixture/app", "1.0.0");

  const composed = composeCrossRepositoryGraph([app], {
    ...mappingIdentity,
    mappings: [
      mapping(
        "app->missing",
        "fixture/app",
        "@fixture/not-supplied",
        "9.9.9",
      ),
    ],
  });

  assert.equal(composed.metrics.connected, 0);
  assert.equal(composed.metrics.unresolved, 1);
  assert.equal(
    composed.graph.diagnostics.some(
      (item) =>
        item.code === "cross-repo-producer-unresolved" &&
        item.message.includes("remote resolution is not attempted"),
    ),
    true,
  );
  assert.equal(
    composed.graph.nodes.some(
      (node) => node.identity.namespace === "fixture/not-supplied",
    ),
    false,
  );
});

test("ambiguous package producers require an explicit producer locator", () => {
  const sharedA = packageSnapshot(
    "fixture/shared-a",
    "@fixture/shared",
    "1.0.0",
  );
  const sharedB = packageSnapshot(
    "fixture/shared-b",
    "@fixture/shared",
    "1.0.0",
  );
  const app = packageSnapshot("fixture/app", "@fixture/app", "1.0.0");
  const base = mapping(
    "app->shared",
    "fixture/app",
    "@fixture/shared",
    "1.0.0",
  );

  const ambiguous = composeCrossRepositoryGraph(
    [sharedA, sharedB, app],
    {
      ...mappingIdentity,
      mappings: [base],
    },
  );

  assert.equal(ambiguous.metrics.ambiguous, 1);
  assert.equal(ambiguous.metrics.connected, 0);
  assert.equal(
    ambiguous.graph.diagnostics.some(
      (item) => item.code === "cross-repo-producer-ambiguous",
    ),
    true,
  );

  const explicit = composeCrossRepositoryGraph(
    [sharedA, sharedB, app],
    {
      ...mappingIdentity,
      mappings: [
        {
          ...base,
          producer: packageLocator("fixture/shared-a"),
        },
      ],
    },
  );

  assert.equal(explicit.metrics.connected, 1);
  const affected = crossRepositoryAffected(
    explicit.graph,
    packageId("fixture/shared-a"),
    { maxRepositoryHops: 1 },
  );
  assert.equal(
    affected.nodes.some((node) => node.id === packageId("fixture/app")),
    true,
  );

  const other = crossRepositoryAffected(
    explicit.graph,
    packageId("fixture/shared-b"),
    { maxRepositoryHops: 1 },
  );
  assert.equal(
    other.nodes.some((node) => node.id === packageId("fixture/app")),
    false,
  );
});

test("artifact coordinates work only with an explicit producer target", () => {
  const producer = packageSnapshot(
    "fixture/schema",
    "@fixture/schema",
    "1.0.0",
    { "contract.json": "{\"type\":\"object\"}\n" },
  );
  const consumer = packageSnapshot(
    "fixture/consumer",
    "@fixture/consumer",
    "1.0.0",
  );

  const result = composeCrossRepositoryGraph(
    [producer, consumer],
    {
      ...mappingIdentity,
      mappings: [
        {
          id: "consumer->schema-contract",
          consumer: packageLocator("fixture/consumer"),
          coordinate: {
            kind: "artifact",
            ecosystem: "json-schema",
            name: "fixture-contract",
            version: "1.0.0",
          },
          producer: {
            repository: "fixture/schema",
            kind: "file",
            key: "contract.json",
          },
        },
      ],
    },
  );

  assert.equal(result.metrics.connected, 1);
  const artifactId = nodeId({
    namespace: "fixture/schema",
    kind: "file",
    key: "contract.json",
  });
  const affected = crossRepositoryAffected(result.graph, artifactId, {
    maxRepositoryHops: 1,
  });
  assert.equal(
    affected.nodes.some(
      (node) => node.id === packageId("fixture/consumer"),
    ),
    true,
  );
});

test("cross-repository traversal enforces repository and node budgets", () => {
  const shared = packageSnapshot(
    "fixture/shared",
    "@fixture/shared",
    "1.0.0",
  );
  const app = packageSnapshot("fixture/app", "@fixture/app", "1.0.0");
  const composed = composeCrossRepositoryGraph([shared, app], {
    ...mappingIdentity,
    mappings: [
      mapping("app->shared", "fixture/app", "@fixture/shared", "1.0.0"),
    ],
  });

  const zeroHop = crossRepositoryAffected(
    composed.graph,
    packageId("fixture/shared"),
    { maxRepositoryHops: 0 },
  );
  assert.equal(zeroHop.nodes.length, 0);
  assert.equal(zeroHop.truncated, true);

  const oneNode = crossRepositoryAffected(
    composed.graph,
    packageId("fixture/shared"),
    { maxRepositoryHops: 1, maxNodes: 1 },
  );
  assert.equal(oneNode.truncated, true);
  assert.equal(oneNode.nodes.length, 0);

  assert.throws(() =>
    crossRepositoryAffected(composed.graph, packageId("fixture/shared"), {
      maxRepositoryHops: -1,
    }),
  );
});
