import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GRAPH_SCHEMA_VERSION,
  GraphConflictError,
  GraphValidationError,
  buildGraph,
  graphEquals,
  makeNode,
  nodeId,
  parseGraph,
  serializeGraph,
  type Provenance,
} from "../src/index.js";

const source: Provenance = {
  repository: "github.com/acme/shop",
  ref: "refs/heads/main",
  commit: "abc123",
  path: "src/cart.ts",
  origin: "source",
  method: "source-observation",
  state: "complete",
};

const derived: Provenance = {
  repository: "github.com/acme/shop",
  ref: "refs/heads/main",
  commit: "abc123",
  path: "src/cart.ts",
  extractor: { name: "ts-imports", version: "1.0.0" },
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
};

test("stable ids and serialization do not depend on insertion order", () => {
  const cartIdentity = {
    namespace: "github.com/acme/shop",
    kind: "file",
    key: "src/cart.ts",
  };
  const moneyIdentity = {
    namespace: "github.com/acme/shop",
    kind: "file",
    key: "src/money.ts",
  };

  const cartId = nodeId(cartIdentity);
  const moneyId = nodeId(moneyIdentity);

  const first = buildGraph({
    nodes: [
      { identity: cartIdentity, provenance: [derived] },
      { identity: moneyIdentity, provenance: [source] },
      { identity: cartIdentity, provenance: [source, derived] },
    ],
    edges: [
      {
        identity: { kind: "imports", from: cartId, to: moneyId },
        provenance: [derived],
      },
    ],
  });

  const second = buildGraph({
    nodes: [
      { identity: cartIdentity, provenance: [source] },
      { identity: cartIdentity, provenance: [derived] },
      { identity: moneyIdentity, provenance: [source] },
    ].reverse(),
    edges: [
      {
        identity: { kind: "imports", from: cartId, to: moneyId },
        provenance: [derived, derived],
      },
    ],
  });

  assert.equal(serializeGraph(first), serializeGraph(second));
  assert.equal(graphEquals(first, second), true);
  assert.equal(first.nodes.length, 2);
  assert.equal(first.nodes.find((node) => node.id === cartId)?.provenance.length, 2);
});

test("checked-in golden fixture round-trips byte-for-byte", () => {
  const fixtureUrl = new URL("./fixtures/minimal.golden.json", import.meta.url);
  const fixture = readFileSync(fixtureUrl, "utf8").trim();
  assert.equal(serializeGraph(parseGraph(fixture)), fixture);
});

test("round trip preserves external evidence fidelity and partial state", () => {
  const indexed: Provenance = {
    repository: "github.com/acme/shop",
    ref: "refs/heads/main",
    commit: "abc123",
    path: "src/cart.ts",
    extractor: { name: "scip-typescript", version: "0.4.0" },
    origin: "derived",
    method: "external-index",
    state: "partial",
    diagnostic: "index omitted generated declaration targets",
  };

  const graph = buildGraph({
    nodes: [
      {
        identity: {
          namespace: "github.com/acme/shop",
          kind: "symbol",
          key: "src/cart.ts#Cart",
        },
        metadata: { language: "typescript" },
        provenance: [indexed],
      },
    ],
    diagnostics: [
      {
        code: "external-index-partial",
        message: "External index was incomplete",
        state: "partial",
        provenance: indexed,
      },
    ],
  });

  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored, graph);
  assert.equal(restored.schemaVersion, GRAPH_SCHEMA_VERSION);
  assert.equal(restored.nodes[0]?.provenance[0]?.method, "external-index");
  assert.equal(restored.nodes[0]?.provenance[0]?.state, "partial");
});

test("duplicate identities with conflicting metadata fail explicitly", () => {
  const identity = {
    namespace: "github.com/acme/shop",
    kind: "file",
    key: "src/cart.ts",
  };

  assert.throws(
    () =>
      buildGraph({
        nodes: [
          { identity, metadata: { generated: false }, provenance: [source] },
          { identity, metadata: { generated: true }, provenance: [source] },
        ],
      }),
    GraphConflictError,
  );
});

test("every node and edge fact requires provenance", () => {
  assert.throws(
    () =>
      buildGraph({
        nodes: [
          {
            identity: {
              namespace: "github.com/acme/shop",
              kind: "file",
              key: "src/no-evidence.ts",
            },
            provenance: [],
          },
        ],
      }),
    /at least one provenance record/,
  );
});

test("edge endpoints must exist", () => {
  const identity = {
    namespace: "github.com/acme/shop",
    kind: "file",
    key: "src/cart.ts",
  };
  const node = makeNode({ identity, provenance: [source] });

  assert.throws(
    () =>
      buildGraph({
        nodes: [{ identity, provenance: [source] }],
        edges: [
          {
            identity: {
              kind: "imports",
              from: node.id,
              to: "node:missing",
            },
            provenance: [derived],
          },
        ],
      }),
    GraphValidationError,
  );
});

test("unknown schema and tampered ids are rejected", () => {
  const graph = buildGraph({
    nodes: [
      {
        identity: {
          namespace: "github.com/acme/shop",
          kind: "file",
          key: "src/cart.ts",
        },
        provenance: [source],
      },
    ],
  });

  const unknownSchema = JSON.parse(serializeGraph(graph)) as Record<string, unknown>;
  unknownSchema.schemaVersion = "repograph.graph/v999";
  assert.throws(
    () => parseGraph(JSON.stringify(unknownSchema)),
    /Unsupported schema version/,
  );

  const tampered = JSON.parse(serializeGraph(graph)) as {
    nodes: Array<{ id: string }>;
  };
  tampered.nodes[0]!.id = "node:tampered";
  assert.throws(
    () => parseGraph(JSON.stringify(tampered)),
    /id does not match its stable identity/,
  );
});
