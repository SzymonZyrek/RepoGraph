import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraph,
  createTraversalPolicy,
  explainWithPolicy,
  nodeId,
  parseTraversalPolicy,
  serializeTraversalPolicy,
  traverseWithPolicy,
  type Provenance,
} from "../src/index.js";

const source: Provenance = {
  repository: "fixture/policy",
  ref: "main",
  commit: "abc",
  origin: "source",
  method: "source-observation",
  state: "complete",
};

const deterministic: Provenance = {
  repository: "fixture/policy",
  ref: "main",
  commit: "abc",
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
  extractor: { name: "fixture", version: "1" },
};

const external: Provenance = {
  repository: "fixture/policy",
  ref: "main",
  commit: "abc",
  origin: "derived",
  method: "external-index",
  state: "complete",
  extractor: { name: "external", version: "1" },
};

const authoritative: Provenance = {
  repository: "fixture/policy",
  ref: "main",
  commit: "abc",
  origin: "overlay",
  method: "explicit-overlay",
  state: "complete",
  authority: "authoritative",
  overlay: { name: "capabilities", version: "1" },
};

function fixture() {
  const file = { namespace: "fixture/policy", kind: "file", key: "src/a.ts" };
  const module = { namespace: "fixture/policy", kind: "module", key: "module:a" };
  const testNode = { namespace: "fixture/policy", kind: "test", key: "test:a" };
  const capability = { namespace: "fixture/policy", kind: "capability", key: "payments" };
  const owner = { namespace: "fixture/policy", kind: "owner", key: "alice" };

  const ids = {
    file: nodeId(file),
    module: nodeId(module),
    test: nodeId(testNode),
    capability: nodeId(capability),
    owner: nodeId(owner),
  };

  return {
    ids,
    graph: buildGraph({
      nodes: [
        { identity: file, provenance: [source] },
        { identity: module, provenance: [deterministic] },
        { identity: testNode, provenance: [deterministic] },
        { identity: capability, provenance: [authoritative] },
        { identity: owner, provenance: [authoritative] },
      ],
      edges: [
        { identity: { kind: "imports", from: ids.module, to: ids.file }, provenance: [deterministic] },
        { identity: { kind: "tests", from: ids.test, to: ids.module }, provenance: [external] },
        { identity: { kind: "contains", from: ids.capability, to: ids.module }, provenance: [authoritative] },
        { identity: { kind: "owns", from: ids.owner, to: ids.capability }, provenance: [authoritative] },
      ],
    }),
  };
}

test("same graph yields different slices under evidence policies", () => {
  const { graph, ids } = fixture();

  const impact = traverseWithPolicy(graph, ids.file, {
    direction: "in",
    evidenceMethods: ["deterministic-extraction", "explicit-overlay"],
  });
  assert.deepEqual(
    impact.nodes.map((node) => node.identity.kind).sort(),
    ["capability", "module", "owner"],
  );

  const context = traverseWithPolicy(graph, ids.file, {
    direction: "in",
    evidenceMethods: ["deterministic-extraction", "external-index", "explicit-overlay"],
  });
  assert.deepEqual(
    context.nodes.map((node) => node.identity.kind).sort(),
    ["capability", "module", "owner", "test"],
  );
});

test("authority filter preserves consumer overlay semantics", () => {
  const { graph, ids } = fixture();

  const overlayOnly = traverseWithPolicy(graph, ids.module, {
    direction: "in",
    authorities: ["authoritative"],
  });

  assert.deepEqual(
    overlayOnly.nodes.map((node) => node.identity.kind).sort(),
    ["capability", "owner"],
  );
  assert.equal(
    overlayOnly.reasons.every((reason) =>
      reason.matchedProvenance.every((p) => p.authority === "authoritative"),
    ),
    true,
  );
});

test("causal explanation preserves evidence class per hop", () => {
  const { graph, ids } = fixture();
  const path = explainWithPolicy(graph, ids.owner, ids.file, {
    direction: "out",
    evidenceMethods: ["explicit-overlay", "deterministic-extraction"],
  });

  assert.notEqual(path, null);
  assert.deepEqual(
    path!.hops.map((hop) => hop.edge.identity.kind),
    ["owns", "contains", "imports"],
  );
  assert.deepEqual(
    path!.hops.map((hop) => hop.matchedProvenance[0]?.method),
    ["explicit-overlay", "explicit-overlay", "deterministic-extraction"],
  );
});

test("stop node kinds and bounds surface truncation deliberately", () => {
  const { graph, ids } = fixture();

  const stopped = traverseWithPolicy(graph, ids.owner, {
    direction: "out",
    stopNodeKinds: ["capability"],
  });
  assert.deepEqual(stopped.nodes.map((node) => node.identity.kind), ["capability"]);

  const bounded = traverseWithPolicy(graph, ids.owner, {
    direction: "out",
    maxDepth: 1,
  });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.partial, true);
});

test("policy serialization is canonical and round-trips", () => {
  const policy = createTraversalPolicy({
    direction: "in",
    edgeKinds: ["tests", "imports", "tests"],
    evidenceMethods: ["external-index", "deterministic-extraction"],
    maxDepth: 5,
    maxNodes: 100,
  });

  const serialized = serializeTraversalPolicy(policy);
  assert.deepEqual(parseTraversalPolicy(serialized), policy);
  assert.equal(
    serializeTraversalPolicy(parseTraversalPolicy(serialized)),
    serialized,
  );
});
