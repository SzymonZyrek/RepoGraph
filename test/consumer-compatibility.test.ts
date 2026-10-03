import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  applyOverlay,
  buildGraph,
  explainWithPolicy,
  extractRepositoryRelationships,
  extractTypeScriptJavaScriptDependencies,
  graphEquals,
  ingestGitRepository,
  nodeId,
  traverseWithPolicy,
  type GraphDocument,
  type GraphInput,
  type NodeIdentity,
} from "../src/index.js";

const REPOSITORY = "fixture/consumer-proof";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-consumer-proof-"));
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

function graphInput(graph: GraphDocument): GraphInput {
  return {
    nodes: graph.nodes.map((node) => ({
      identity: node.identity,
      ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
      provenance: node.provenance,
    })),
    edges: graph.edges.map((edge) => ({
      identity: edge.identity,
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
      provenance: edge.provenance,
    })),
    diagnostics: graph.diagnostics,
  };
}

function mergeGraphs(...graphs: GraphDocument[]): GraphDocument {
  return buildGraph({
    nodes: graphs.flatMap((graph) => graphInput(graph).nodes ?? []),
    edges: graphs.flatMap((graph) => graphInput(graph).edges ?? []),
    diagnostics: graphs.flatMap((graph) => graph.diagnostics),
  });
}

function repositoryGraph(root: string, ref: string): GraphDocument {
  const ingestion = ingestGitRepository({
    repositoryPath: root,
    repository: REPOSITORY,
    ref,
    discoverCodeowners: false,
  });

  const tsjs = extractTypeScriptJavaScriptDependencies(ingestion).graph;
  const relations = extractRepositoryRelationships(ingestion).graph;
  return mergeGraphs(tsjs, relations);
}

function fileIdentity(path: string): NodeIdentity {
  return {
    namespace: REPOSITORY,
    kind: "file",
    key: path,
  };
}

function fileId(path: string): string {
  return nodeId(fileIdentity(path));
}

function domainIdentity(kind: string, key: string): NodeIdentity {
  return {
    namespace: "consumer/vibeguard",
    kind,
    key,
  };
}

function withVibeGuardOverlay(graph: GraphDocument, ref: string): GraphDocument {
  const payments = domainIdentity("capability", "payments");
  const analytics = domainIdentity("capability", "analytics");
  const paymentsOwner = domainIdentity("owner", "owner-payments");
  const analyticsOwner = domainIdentity("owner", "owner-analytics");

  return applyOverlay(graph, {
    identity: { name: "vibeguard-confirmed-topology", version: "1" },
    authority: "authoritative",
    repository: REPOSITORY,
    ref,
    commit: ref,
    nodes: [
      { identity: payments, metadata: { label: "Payments" } },
      { identity: analytics, metadata: { label: "Analytics" } },
      { identity: paymentsOwner, metadata: { label: "Payments Owner" } },
      { identity: analyticsOwner, metadata: { label: "Analytics Owner" } },
    ],
    edges: [
      {
        identity: {
          kind: "owns",
          from: nodeId(paymentsOwner),
          to: nodeId(payments),
        },
      },
      {
        identity: {
          kind: "owns",
          from: nodeId(analyticsOwner),
          to: nodeId(analytics),
        },
      },
    ],
    pathEdges: [
      {
        anchor: payments,
        pattern: "src/payments/**",
        edgeKind: "contains",
      },
      {
        anchor: analytics,
        pattern: "src/analytics/**",
        edgeKind: "contains",
      },
    ],
  }).graph;
}

function fixture(root: string): string {
  file(
    root,
    "package.json",
    JSON.stringify({
      name: "@fixture/service",
      version: "1.0.0",
      module: "./src/index.ts",
      types: "./src/index.d.ts",
    }),
  );
  file(
    root,
    "src/index.ts",
    'export { charge } from "./payments/core.js";\nexport { report } from "./analytics/core.js";\n',
  );
  file(
    root,
    "src/index.d.ts",
    "export declare function charge(amount: number): number;\nexport declare function report(): string;\n",
  );
  file(
    root,
    "src/payments/core.ts",
    "export function charge(amount: number) { return amount; }\n",
  );
  file(
    root,
    "src/payments/core.test.ts",
    'import { charge } from "./core.js"; export const result = charge(1);\n',
  );
  file(
    root,
    "src/analytics/core.ts",
    'export function report() { return "ok"; }\n',
  );
  file(
    root,
    "src/analytics/core.test.ts",
    'import { report } from "./core.js"; export const result = report();\n',
  );
  return commit(root, "consumer proof fixture");
}

test("VibeGuard-shaped impact keeps authoritative ownership separate from derived evidence", () => {
  const root = repository();
  const ref = fixture(root);

  const repositoryEvidence = repositoryGraph(root, ref);
  const graph = withVibeGuardOverlay(repositoryEvidence, ref);
  const changed = fileId("src/payments/core.ts");

  const impact = traverseWithPolicy(graph, changed, {
    direction: "in",
    edgeKinds: ["imports", "reexports", "tests", "contains", "owns"],
    evidenceMethods: ["deterministic-extraction", "explicit-overlay"],
    maxDepth: 4,
    maxNodes: 50,
  });

  const ids = new Set(impact.nodes.map((node) => node.id));
  assert.equal(ids.has(nodeId(domainIdentity("capability", "payments"))), true);
  assert.equal(ids.has(nodeId(domainIdentity("owner", "owner-payments"))), true);
  assert.equal(ids.has(fileId("src/payments/core.test.ts")), true);

  assert.equal(ids.has(nodeId(domainIdentity("capability", "analytics"))), false);
  assert.equal(ids.has(nodeId(domainIdentity("owner", "owner-analytics"))), false);
  assert.equal(ids.has(fileId("src/analytics/core.test.ts")), false);

  const owner = graph.nodes.find(
    (node) => node.id === nodeId(domainIdentity("owner", "owner-payments")),
  );
  assert.equal(owner?.provenance[0]?.origin, "overlay");
  assert.equal(owner?.provenance[0]?.authority, "authoritative");

  const testEdge = graph.edges.find(
    (edge) =>
      edge.identity.kind === "tests" &&
      edge.identity.from === fileId("src/payments/core.test.ts") &&
      edge.identity.to === changed,
  );
  assert.equal(testEdge?.provenance[0]?.origin, "derived");
  assert.equal(testEdge?.provenance[0]?.method, "deterministic-extraction");

  const explanation = explainWithPolicy(
    graph,
    changed,
    nodeId(domainIdentity("owner", "owner-payments")),
    {
      direction: "in",
      edgeKinds: ["contains", "owns"],
      evidenceMethods: ["explicit-overlay"],
      maxDepth: 2,
    },
  );
  assert.notEqual(explanation, null);
  assert.deepEqual(
    explanation!.hops.map((hop) => hop.edge.identity.kind),
    ["contains", "owns"],
  );
});

test("Hacka-shaped bounded context recovers source, tests and contract without product overlays", () => {
  const root = repository();
  const ref = fixture(root);
  const graph = repositoryGraph(root, ref);
  const changed = fileId("src/payments/core.ts");

  const context = traverseWithPolicy(graph, changed, {
    direction: "both",
    edgeKinds: [
      "imports",
      "reexports",
      "tests",
      "package-build-entrypoint",
      "package-contract",
      "declares-package",
    ],
    evidenceMethods: ["deterministic-extraction"],
    maxDepth: 4,
    maxNodes: 50,
  });

  const ids = new Set(context.nodes.map((node) => node.id));
  assert.equal(ids.has(fileId("src/payments/core.test.ts")), true);
  assert.equal(ids.has(fileId("src/index.ts")), true);
  assert.equal(ids.has(fileId("src/index.d.ts")), true);
  assert.equal(
    context.nodes.some((node) => node.identity.namespace === "consumer/vibeguard"),
    false,
  );
});

test("independent consumers get compatible repository identities and can resolve pinned evidence references", () => {
  const root = repository();
  const ref = fixture(root);

  const vibeGuardEvidence = repositoryGraph(root, ref);
  const hackaEvidence = repositoryGraph(root, ref);
  assert.equal(graphEquals(vibeGuardEvidence, hackaEvidence), true);

  const evidenceNodeId = fileId("src/payments/core.ts");
  const durableWorkRequest = {
    schema: "hacka.work-request/v1",
    repository: REPOSITORY,
    baseSha: ref,
    evidenceNodeId,
  };

  const executionGraph = repositoryGraph(root, durableWorkRequest.baseSha);
  const resolved = executionGraph.nodes.find(
    (node) => node.id === durableWorkRequest.evidenceNodeId,
  );

  assert.notEqual(resolved, undefined);
  assert.equal(resolved?.identity.key, "src/payments/core.ts");
  assert.equal(
    resolved?.provenance.some(
      (provenance) =>
        provenance.repository === durableWorkRequest.repository &&
        provenance.commit === durableWorkRequest.baseSha,
    ),
    true,
  );
});
