import assert from "node:assert/strict";
import test from "node:test";

import {
  affectedClosure,
  buildGraph,
  neighbors,
  nodeId,
  reverseNeighbors,
  shortestPath,
  transitiveClosure,
  type Provenance,
} from "../src/index.js";

const evidence: Provenance = {
  repository: "fixture/graph",
  ref: "deadbeef",
  commit: "deadbeef",
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
};

function fixture() {
  const identities = ["a", "b", "c", "d"].map((key) => ({
    namespace: "fixture/graph",
    kind: "module",
    key,
  }));
  const [a, b, c, d] = identities.map(nodeId);

  return {
    ids: { a: a!, b: b!, c: c!, d: d! },
    graph: buildGraph({
      nodes: identities.map((identity) => ({ identity, provenance: [evidence] })),
      edges: [
        { identity: { kind: "depends-on", from: b!, to: a! }, provenance: [evidence] },
        { identity: { kind: "depends-on", from: c!, to: b! }, provenance: [evidence] },
        { identity: { kind: "depends-on", from: d!, to: a! }, provenance: [evidence] },
        { identity: { kind: "documents", from: c!, to: a! }, provenance: [evidence] },
      ],
    }),
  };
}

test("neighbors and reverse neighbors are deterministic and filterable", () => {
  const { graph, ids } = fixture();

  const incoming = reverseNeighbors(graph, ids.a, ["depends-on"]);
  assert.deepEqual(
    incoming.nodes.map((node) => node.identity.key).sort(),
    ["b", "d"],
  );

  const outgoing = neighbors(graph, ids.c, {
    direction: "out",
    edgeKinds: ["depends-on"],
  });
  assert.deepEqual(outgoing.nodes.map((node) => node.identity.key), ["b"]);
});

test("affected closure traverses reverse dependency edges", () => {
  const { graph, ids } = fixture();

  const affected = affectedClosure(graph, ids.a, {
    edgeKinds: ["depends-on"],
  });

  assert.deepEqual(
    affected.nodes.map((node) => node.identity.key).sort(),
    ["b", "c", "d"],
  );
  assert.equal(affected.truncated, false);
});

test("transitive closure reports bounded truncation", () => {
  const { graph, ids } = fixture();

  const slice = transitiveClosure(graph, ids.a, {
    direction: "in",
    edgeKinds: ["depends-on"],
    maxDepth: 1,
  });

  assert.deepEqual(
    slice.nodes.map((node) => node.identity.key).sort(),
    ["b", "d"],
  );
  assert.equal(slice.truncated, true);
});

test("shortest path returns inspectable causal nodes and edges", () => {
  const { graph, ids } = fixture();

  const path = shortestPath(graph, ids.c, ids.a, {
    direction: "out",
    edgeKinds: ["depends-on"],
  });

  assert.notEqual(path, null);
  assert.deepEqual(path!.nodes.map((node) => node.identity.key), ["c", "b", "a"]);
  assert.deepEqual(path!.edges.map((edge) => edge.identity.kind), [
    "depends-on",
    "depends-on",
  ]);

  assert.equal(
    shortestPath(graph, ids.a, ids.c, {
      direction: "out",
      edgeKinds: ["depends-on"],
    }),
    null,
  );
});
