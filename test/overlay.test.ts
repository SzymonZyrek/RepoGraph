import assert from "node:assert/strict";
import test from "node:test";

import {
  GraphValidationError,
  applyOverlay,
  buildGraph,
  graphEquals,
  makeNode,
  nodeId,
  parseGraph,
  serializeGraph,
  shortestPath,
  type GraphDocument,
  type NodeIdentity,
  type Provenance,
} from "../src/index.js";

const sourceProvenance: Provenance = {
  repository: "fixture/repo",
  ref: "main",
  commit: "abc123",
  origin: "source",
  method: "source-observation",
  state: "complete",
};

function fileIdentity(path: string): NodeIdentity {
  return {
    namespace: "fixture/repo",
    kind: "file",
    key: path,
  };
}

function fixtureGraph(paths = ["src/payments/api.ts", "src/payments/db.ts", "src/other.ts"]): GraphDocument {
  return buildGraph({
    nodes: paths.map((path) => ({
      identity: fileIdentity(path),
      metadata: { path },
      provenance: [{ ...sourceProvenance, path }],
    })),
  });
}

test("generic overlays preserve authority/version and participate in causal paths", () => {
  const graph = fixtureGraph();
  const capability: NodeIdentity = {
    namespace: "consumer/vibeguard",
    kind: "capability",
    key: "payments",
  };
  const owner: NodeIdentity = {
    namespace: "consumer/vibeguard",
    kind: "owner",
    key: "alice",
  };

  const applied = applyOverlay(graph, {
    identity: { name: "vibeguard-config", version: "17" },
    authority: "authoritative",
    repository: "fixture/repo",
    ref: "main",
    commit: "abc123",
    nodes: [
      { identity: capability, metadata: { label: "Payments" } },
      { identity: owner, metadata: { label: "Alice" } },
    ],
    edges: [
      {
        identity: {
          kind: "owns",
          from: nodeId(owner),
          to: nodeId(capability),
        },
      },
    ],
    pathEdges: [
      {
        anchor: capability,
        pattern: "src/payments/**",
        edgeKind: "contains",
      },
    ],
  });

  assert.equal(applied.addedNodes, 2);
  assert.equal(applied.addedEdges, 3);
  assert.equal(applied.diagnosticsAdded, 0);

  const capabilityNode = applied.graph.nodes.find(
    (node) => node.id === nodeId(capability),
  );
  assert.equal(capabilityNode?.provenance[0]?.origin, "overlay");
  assert.equal(capabilityNode?.provenance[0]?.method, "explicit-overlay");
  assert.equal(capabilityNode?.provenance[0]?.authority, "authoritative");
  assert.deepEqual(capabilityNode?.provenance[0]?.overlay, {
    name: "vibeguard-config",
    version: "17",
  });

  const path = shortestPath(
    applied.graph,
    nodeId(owner),
    nodeId(fileIdentity("src/payments/api.ts")),
    { edgeKinds: ["owns", "contains"] },
  );
  assert.notEqual(path, null);
  assert.deepEqual(
    path?.edges.map((edge) => edge.identity.kind),
    ["owns", "contains"],
  );
  assert.equal(
    path?.edges.every(
      (edge) => edge.provenance[0]?.authority === "authoritative",
    ),
    true,
  );

  const roundTripped = parseGraph(serializeGraph(applied.graph));
  assert.equal(graphEquals(applied.graph, roundTripped), true);
});

test("advisory overlays remain distinguishable from authoritative configuration", () => {
  const graph = fixtureGraph(["src/payments/api.ts"]);
  const capability: NodeIdentity = {
    namespace: "consumer/research",
    kind: "capability",
    key: "suggested-payments",
  };

  const applied = applyOverlay(graph, {
    identity: { name: "suggested-capabilities", version: "3" },
    authority: "advisory",
    repository: "fixture/repo",
    ref: "main",
    nodes: [{ identity: capability }],
    pathEdges: [
      {
        anchor: capability,
        pattern: "src/payments/**",
        edgeKind: "contains",
      },
    ],
  });

  const edge = applied.graph.edges.find(
    (candidate) => candidate.identity.kind === "contains",
  );
  assert.equal(edge?.provenance[0]?.authority, "advisory");
  assert.equal(edge?.provenance[0]?.overlay?.version, "3");
});

test("overlay conflicts and missing mappings become structured diagnostics without silent precedence", () => {
  const graph = fixtureGraph(["src/existing.ts"]);
  const conflicting: NodeIdentity = {
    namespace: "consumer/config",
    kind: "capability",
    key: "conflict",
  };
  const missingAnchor: NodeIdentity = {
    namespace: "consumer/config",
    kind: "capability",
    key: "missing",
  };

  const applied = applyOverlay(graph, {
    identity: { name: "broken-overlay", version: "1" },
    authority: "authoritative",
    repository: "fixture/repo",
    ref: "main",
    nodes: [
      { identity: conflicting, metadata: { label: "A" } },
      { identity: conflicting, metadata: { label: "B" } },
    ],
    pathEdges: [
      {
        anchor: missingAnchor,
        pattern: "does-not-exist/**",
        edgeKind: "contains",
      },
    ],
  });

  assert.equal(
    applied.graph.nodes.some((node) => node.id === nodeId(conflicting)),
    false,
  );
  assert.equal(
    applied.graph.diagnostics.some(
      (diagnostic) => diagnostic.code === "overlay-conflicting-node",
    ),
    true,
  );
  assert.equal(
    applied.graph.diagnostics.some(
      (diagnostic) => diagnostic.code === "overlay-path-anchor-missing",
    ),
    true,
  );
});

test("path overlays can be reapplied to a new repository snapshot without changing domain identity", () => {
  const capability: NodeIdentity = {
    namespace: "consumer/vibeguard",
    kind: "capability",
    key: "payments",
  };
  const definition = {
    identity: { name: "capabilities", version: "9" },
    authority: "authoritative" as const,
    repository: "fixture/repo",
    ref: "main",
    nodes: [{ identity: capability }],
    pathEdges: [
      {
        anchor: capability,
        pattern: "src/payments/**",
        edgeKind: "contains",
      },
    ],
  };

  const base = applyOverlay(
    fixtureGraph(["src/payments/a.ts", "src/other.ts"]),
    definition,
  ).graph;
  const target = applyOverlay(
    fixtureGraph(["src/payments/a.ts", "src/payments/b.ts", "src/other.ts"]),
    definition,
  ).graph;

  assert.equal(
    base.nodes.some((node) => node.id === nodeId(capability)),
    true,
  );
  assert.equal(
    target.nodes.some((node) => node.id === nodeId(capability)),
    true,
  );
  assert.equal(
    base.edges.filter((edge) => edge.identity.kind === "contains").length,
    1,
  );
  assert.equal(
    target.edges.filter((edge) => edge.identity.kind === "contains").length,
    2,
  );
});

test("overlay authority metadata is valid only on explicit overlay provenance", () => {
  assert.throws(
    () =>
      makeNode({
        identity: {
          namespace: "consumer/test",
          kind: "capability",
          key: "missing-authority",
        },
        provenance: [
          {
            repository: "fixture/repo",
            ref: "main",
            origin: "overlay",
            method: "explicit-overlay",
            state: "complete",
            overlay: { name: "fixture", version: "1" },
          },
        ],
      }),
    GraphValidationError,
  );

  assert.throws(
    () =>
      makeNode({
        identity: fileIdentity("src/a.ts"),
        provenance: [
          {
            ...sourceProvenance,
            authority: "authoritative",
          },
        ],
      }),
    GraphValidationError,
  );
});
