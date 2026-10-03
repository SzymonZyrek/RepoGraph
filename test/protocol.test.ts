import assert from "node:assert/strict";
import test from "node:test";

import {
  REPOGRAPH_PROTOCOL_MAX_NODES,
  REPOGRAPH_PROTOCOL_VERSION,
  buildGraph,
  createTraversalPolicy,
  executeProtocolRequest,
  negotiateProtocol,
  nodeId,
  protocolInfo,
  serializeProtocolResponse,
  type NodeIdentity,
  type Provenance,
} from "../src/index.js";

const provenance: Provenance = {
  repository: "fixture/protocol",
  ref: "main",
  commit: "abc123",
  extractor: { name: "fixture", version: "1" },
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
};

function identity(kind: string, key: string): NodeIdentity {
  return {
    namespace: "fixture/protocol",
    kind,
    key,
  };
}

function fixture() {
  const source = identity("file", "src/a.ts");
  const module = identity("module", "module:a");
  const testNode = identity("file", "src/a.test.ts");
  const unrelated = identity("file", "src/unrelated.ts");
  const ids = {
    source: nodeId(source),
    module: nodeId(module),
    test: nodeId(testNode),
    unrelated: nodeId(unrelated),
  };

  return {
    ids,
    graph: buildGraph({
      nodes: [
        { identity: source, metadata: { path: "src/a.ts" }, provenance: [provenance] },
        { identity: module, metadata: { label: "module a" }, provenance: [provenance] },
        { identity: testNode, metadata: { path: "src/a.test.ts" }, provenance: [provenance] },
        { identity: unrelated, provenance: [provenance] },
      ],
      edges: [
        {
          identity: {
            kind: "contains",
            from: ids.module,
            to: ids.source,
          },
          provenance: [provenance],
        },
        {
          identity: {
            kind: "tests",
            from: ids.test,
            to: ids.module,
          },
          provenance: [provenance],
        },
      ],
    }),
  };
}

test("protocol info supports feature discovery and version negotiation", () => {
  const info = protocolInfo();

  assert.equal(info.protocolVersion, REPOGRAPH_PROTOCOL_VERSION);
  assert.equal(typeof info.releaseVersion, "string");
  assert.equal(info.features.some((feature) => feature.name === "graph-slice"), true);
  assert.equal(
    info.features.some(
      (feature) =>
        feature.name === "cross-repository" &&
        feature.status === "experimental",
    ),
    true,
  );
  assert.equal(
    negotiateProtocol(["repograph.protocol/v0", REPOGRAPH_PROTOCOL_VERSION]),
    REPOGRAPH_PROTOCOL_VERSION,
  );
  assert.equal(negotiateProtocol(["repograph.protocol/v2"]), null);

  const response = executeProtocolRequest({
    operation: "info",
    requestId: "info-1",
    acceptedProtocolVersions: [
      "repograph.protocol/v2",
      REPOGRAPH_PROTOCOL_VERSION,
    ],
    futureAdditiveField: { ignored: true },
  });
  assert.equal(response.ok, true);
  assert.equal(response.requestId, "info-1");
  if (!response.ok || response.data.type !== "protocol-info") {
    assert.fail("expected protocol-info response");
  }
  assert.equal(
    response.data.negotiatedProtocolVersion,
    REPOGRAPH_PROTOCOL_VERSION,
  );
});

test("slice response is bounded, normalized and ignores additive request fields", () => {
  const { graph, ids } = fixture();
  const policy = createTraversalPolicy({
    direction: "in",
    edgeKinds: ["contains", "tests"],
    maxDepth: 4,
    maxNodes: 20,
  });

  const response = executeProtocolRequest({
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "slice",
    requestId: "slice-1",
    graph,
    start: ids.source,
    policy,
    futureMinorField: "ignored",
  });

  assert.equal(response.ok, true);
  if (!response.ok || response.data.type !== "graph-slice") {
    assert.fail("expected graph-slice response");
  }

  assert.equal(response.data.availability, "available");
  assert.equal(response.data.truncated, false);
  assert.equal(response.data.partial, false);
  assert.deepEqual(
    response.data.nodes.map((node) => [node.kind, node.key]),
    [
      ["file", "src/a.test.ts"],
      ["module", "module:a"],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  );
  assert.equal(
    response.data.nodes.every(
      (node) =>
        "identity" in (node as unknown as Record<string, unknown>) === false,
    ),
    true,
  );
  assert.equal(
    response.data.edges.every(
      (edge) =>
        edge.provenance[0]?.repository === "fixture/protocol" &&
        edge.provenance[0]?.method === "deterministic-extraction",
    ),
    true,
  );

  assert.equal(
    serializeProtocolResponse(response),
    serializeProtocolResponse(
      executeProtocolRequest({
        protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
        operation: "slice",
        requestId: "slice-1",
        graph,
        start: ids.source,
        policy,
      }),
    ),
  );
});

test("explanation returns a generic causal DTO with per-hop matched provenance", () => {
  const { graph, ids } = fixture();
  const policy = createTraversalPolicy({
    direction: "in",
    edgeKinds: ["contains", "tests"],
    maxDepth: 4,
    maxNodes: 20,
  });

  const response = executeProtocolRequest({
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "explain",
    graph,
    from: ids.source,
    to: ids.test,
    policy,
  });

  assert.equal(response.ok, true);
  if (!response.ok || response.data.type !== "causal-explanation") {
    assert.fail("expected causal-explanation response");
  }

  assert.equal(response.data.availability, "available");
  assert.deepEqual(
    response.data.hops.map((hop) => hop.edge.kind),
    ["contains", "tests"],
  );
  assert.equal(
    response.data.hops.every(
      (hop) =>
        hop.matchedProvenance[0]?.method === "deterministic-extraction",
    ),
    true,
  );
});

test("missing evidence is represented as unavailable rather than a protocol failure", () => {
  const { graph, ids } = fixture();

  const unknown = executeProtocolRequest({
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "slice",
    graph,
    start: "node:does-not-exist",
  });
  assert.equal(unknown.ok, true);
  if (!unknown.ok || unknown.data.type !== "graph-slice") {
    assert.fail("expected graph-slice response");
  }
  assert.equal(unknown.data.availability, "unavailable");
  assert.equal(unknown.data.unavailable?.code, "unknown-node");

  const noPath = executeProtocolRequest({
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "explain",
    graph,
    from: ids.source,
    to: ids.unrelated,
  });
  assert.equal(noPath.ok, true);
  if (!noPath.ok || noPath.data.type !== "causal-explanation") {
    assert.fail("expected causal-explanation response");
  }
  assert.equal(noPath.data.availability, "unavailable");
  assert.equal(noPath.data.unavailable?.code, "no-path");
});

test("unsupported protocol versions and excessive traversal budgets are machine failures", () => {
  const { graph, ids } = fixture();

  const unsupported = executeProtocolRequest({
    protocolVersion: "repograph.protocol/v99",
    operation: "slice",
    requestId: "unsupported",
    graph,
    start: ids.source,
  });
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) assert.fail("expected failure");
  assert.equal(unsupported.requestId, "unsupported");
  assert.equal(unsupported.error.code, "unsupported-protocol");

  const tooLarge = executeProtocolRequest({
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "slice",
    graph,
    start: ids.source,
    policy: createTraversalPolicy({
      maxNodes: REPOGRAPH_PROTOCOL_MAX_NODES + 1,
    }),
  });
  assert.equal(tooLarge.ok, false);
  if (tooLarge.ok) assert.fail("expected failure");
  assert.equal(tooLarge.error.code, "invalid-request");
  assert.match(tooLarge.error.message, /maxNodes exceeds protocol maximum/);
});

test("malformed graph requests fail without leaking an implementation stack", () => {
  const response = executeProtocolRequest({
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "slice",
    graph: { schemaVersion: "repograph.graph/v999" },
    start: "anything",
  });

  assert.equal(response.ok, false);
  if (response.ok) assert.fail("expected failure");
  assert.equal(response.error.code, "invalid-request");
  assert.equal(typeof response.error.message, "string");
  assert.equal("stack" in response.error, false);
});
