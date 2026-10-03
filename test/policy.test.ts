import assert from "node:assert/strict";
import test from "node:test";

import {
  GraphValidationError,
  affectedWithPolicy,
  applyOverlay,
  buildGraph,
  explainWithPolicy,
  nodeId,
  parseTraversalPolicy,
  serializeTraversalPolicy,
  traverseWithPolicy,
  type GraphDocument,
  type NodeIdentity,
  type Provenance,
} from "../src/index.js";

const source = (path: string): Provenance => ({
  repository: "fixture/repo",
  ref: "main",
  commit: "abc",
  path,
  origin: "source",
  method: "source-observation",
  state: "complete",
});

const derived = (path: string): Provenance => ({
  repository: "fixture/repo",
  ref: "main",
  commit: "abc",
  path,
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
  extractor: { name: "fixture", version: "1" },
});

function identity(kind: string, key: string): NodeIdentity {
  return { namespace: "fixture/repo", kind, key };
}

function id(kind: string, key: string): string {
  return nodeId(identity(kind, key));
}

function graph(): GraphDocument {
  const changed = identity("file", "src/core.ts");
  const dependent = identity("file", "src/app.ts");
  const testNode = identity("test", "test/app.test.ts");

  const base = buildGraph({
    nodes: [
      { identity: changed, provenance: [source("src/core.ts")] },
      { identity: dependent, provenance: [source("src/app.ts")] },
      { identity: testNode, provenance: [source("test/app.test.ts")] },
    ],
    edges: [
      {
        identity: {
          kind: "imports",
          from: nodeId(dependent),
          to: nodeId(changed),
        },
        provenance: [derived("src/app.ts")],
      },
      {
        identity: {
          kind: "covers",
          from: nodeId(testNode),
          to: nodeId(dependent),
        },
        provenance: [derived("test/app.test.ts")],
      },
    ],
  });

  const capability = identity("capability", "payments");
  const owner = identity("owner", "alice");
  return applyOverlay(base, {
    identity: { name: "consumer-config", version: "7" },
    authority: "authoritative",
    repository: "fixture/repo",
    ref: "main",
    commit: "abc",
    nodes: [
      { identity: capability },
      { identity: owner },
    ],
    edges: [
      {
        identity: {
          kind: "contains",
          from: nodeId(capability),
          to: nodeId(changed),
        },
      },
      {
        identity: {
          kind: "owns",
          from: nodeId(owner),
          to: nodeId(capability),
        },
      },
    ],
  }).graph;
}

test("the same graph yields distinct slices from policy changes only", () => {
  const fixture = graph();
  const changed = id("file", "src/core.ts");

  const invalidation = affectedWithPolicy(fixture, changed, {
    edgeKinds: ["imports"],
    edgeEvidence: { methods: ["deterministic-extraction"] },
  });
  assert.deepEqual(
    invalidation.nodes.map((node) => node.identity.key),
    ["src/app.ts"],
  );

  const ownershipImpact = affectedWithPolicy(fixture, changed, {
    edgeKinds: ["contains", "owns"],
    edgeEvidence: { authorities: ["authoritative"] },
  });
  assert.deepEqual(
    new Set(ownershipImpact.nodes.map((node) => node.identity.kind)),
    new Set(["capability", "owner"]),
  );

  const testSelection = affectedWithPolicy(
    fixture,
    id("file", "src/app.ts"),
    {
      edgeKinds: ["covers"],
      nodeKinds: ["test"],
      edgeEvidence: { methods: ["deterministic-extraction"] },
    },
  );
  assert.deepEqual(
    testSelection.nodes.map((node) => node.identity.key),
    ["test/app.test.ts"],
  );

  const context = traverseWithPolicy(fixture, changed, {
    direction: "both",
    edgeKinds: ["imports", "covers", "contains", "owns"],
    maxDepth: 3,
  });
  assert.equal(context.nodes.length > invalidation.nodes.length, true);
});

test("authoritative overlay and deterministic-derived evidence remain distinguishable", () => {
  const fixture = graph();
  const changed = id("file", "src/core.ts");

  const overlayOnly = affectedWithPolicy(fixture, changed, {
    edgeKinds: ["contains", "owns", "imports"],
    edgeEvidence: {
      origins: ["overlay"],
      methods: ["explicit-overlay"],
      authorities: ["authoritative"],
    },
  });

  assert.equal(
    overlayOnly.nodes.some((node) => node.identity.key === "src/app.ts"),
    false,
  );
  assert.equal(
    overlayOnly.nodes.some((node) => node.identity.kind === "owner"),
    true,
  );

  const derivedOnly = affectedWithPolicy(fixture, changed, {
    edgeKinds: ["imports", "contains"],
    edgeEvidence: {
      origins: ["derived"],
      methods: ["deterministic-extraction"],
    },
  });
  assert.deepEqual(
    derivedOnly.nodes.map((node) => node.identity.key),
    ["src/app.ts"],
  );
});

test("causal explanations expose the exact matched provenance for every step", () => {
  const fixture = graph();
  const result = explainWithPolicy(
    fixture,
    id("file", "src/core.ts"),
    id("owner", "alice"),
    {
      direction: "in",
      edgeKinds: ["contains", "owns"],
      edgeEvidence: {
        methods: ["explicit-overlay"],
        authorities: ["authoritative"],
        overlayNames: ["consumer-config"],
      },
    },
  );

  assert.equal(result.found, true);
  assert.deepEqual(
    result.steps.map((step) => step.edge.identity.kind),
    ["contains", "owns"],
  );
  for (const step of result.steps) {
    assert.equal(step.matchedEdgeProvenance.length, 1);
    assert.equal(
      step.matchedEdgeProvenance[0]?.authority,
      "authoritative",
    );
    assert.equal(
      step.matchedEdgeProvenance[0]?.overlay?.name,
      "consumer-config",
    );
  }
});

test("stop kinds and budgets produce explicit deterministic partial results", () => {
  const fixture = graph();
  const changed = id("file", "src/core.ts");

  const stopped = affectedWithPolicy(fixture, changed, {
    edgeKinds: ["contains", "owns"],
    stopNodeKinds: ["capability"],
  });
  assert.deepEqual(
    stopped.nodes.map((node) => node.identity.kind),
    ["capability"],
  );
  assert.equal(stopped.truncated, false);

  const limited = affectedWithPolicy(fixture, changed, {
    edgeKinds: ["imports", "contains", "owns"],
    maxNodes: 1,
  });
  assert.equal(limited.nodes.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.truncationReasons.includes("max-nodes"), true);

  const depthLimited = affectedWithPolicy(fixture, changed, {
    edgeKinds: ["contains", "owns"],
    maxDepth: 1,
  });
  assert.equal(depthLimited.truncated, true);
  assert.equal(
    depthLimited.truncationReasons.includes("max-depth"),
    true,
  );
});

test("policy serialization is canonical, round-trippable and rejects unknown evidence classes", () => {
  const policy = {
    direction: "in" as const,
    edgeKinds: ["owns", "contains", "owns"],
    edgeEvidence: {
      methods: ["explicit-overlay" as const],
      authorities: ["authoritative" as const],
    },
    maxDepth: 3,
  };
  const serialized = serializeTraversalPolicy(policy);
  const parsed = parseTraversalPolicy(serialized);

  assert.equal(parsed.schemaVersion, "repograph.traversal-policy/v1");
  assert.deepEqual(parsed.edgeKinds, ["contains", "owns"]);
  assert.deepEqual(parsed.edgeEvidence.methods, ["explicit-overlay"]);
  assert.equal(serializeTraversalPolicy(parsed), serialized);

  assert.throws(
    () =>
      parseTraversalPolicy(
        JSON.stringify({
          edgeEvidence: { methods: ["llm-guessed-it"] },
        }),
      ),
    GraphValidationError,
  );
});
