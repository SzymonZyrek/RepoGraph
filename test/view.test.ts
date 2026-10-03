import assert from "node:assert/strict";
import test from "node:test";

import {
  createTraversalPolicy,
  type ProtocolExplanationDto,
  type ProtocolNodeDto,
  type ProtocolProvenanceDto,
  type ProtocolSliceDto,
} from "../src/index.js";
import {
  GRAPH_VIEW_SCHEMA_VERSION,
  GraphViewController,
  createGraphViewModel,
  renderGraphViewSvg,
} from "../src/view.js";

const provenance: ProtocolProvenanceDto = {
  repository: "fixture/view",
  ref: "main",
  commit: "abc123",
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
  extractor: { name: "fixture", version: "1" },
};

const overlay: ProtocolProvenanceDto = {
  repository: "fixture/view",
  ref: "main",
  commit: "abc123",
  origin: "overlay",
  method: "explicit-overlay",
  state: "complete",
  authority: "authoritative",
  overlay: { name: "fixture-overlay", version: "1" },
};

function node(id: string, kind: string, key: string, p = provenance): ProtocolNodeDto {
  return {
    id,
    namespace: "fixture/view",
    kind,
    key,
    provenance: [p],
  };
}

function sliceFixture(): ProtocolSliceDto {
  return {
    type: "graph-slice",
    availability: "available",
    start: "node:changed",
    policy: createTraversalPolicy({
      direction: "in",
      maxDepth: 4,
      maxNodes: 20,
    }),
    nodes: [
      {
        ...node("node:module", "module", "payments"),
        metadata: { label: "Payments <module>" },
      },
      node("node:test", "test", "payments.test"),
    ],
    edges: [
      {
        id: "edge:module-changed",
        kind: "imports",
        from: "node:module",
        to: "node:changed",
        provenance: [provenance],
      },
      {
        id: "edge:test-module",
        kind: "tests",
        from: "node:test",
        to: "node:module",
        provenance: [provenance],
      },
    ],
    partial: false,
    truncated: false,
  };
}

function explanationFixture(): ProtocolExplanationDto {
  return {
    type: "causal-explanation",
    availability: "available",
    from: "node:file",
    to: "node:owner",
    policy: createTraversalPolicy({
      direction: "in",
      maxDepth: 3,
      maxNodes: 20,
    }),
    nodes: [
      node("node:file", "file", "src/payments.ts"),
      node("node:capability", "capability", "payments", overlay),
      node("node:owner", "owner", "alice", overlay),
    ],
    hops: [
      {
        fromNodeId: "node:file",
        toNodeId: "node:capability",
        edge: {
          id: "edge:contains",
          kind: "contains",
          from: "node:capability",
          to: "node:file",
          provenance: [overlay],
        },
        matchedProvenance: [overlay],
      },
      {
        fromNodeId: "node:capability",
        toNodeId: "node:owner",
        edge: {
          id: "edge:owns",
          kind: "owns",
          from: "node:owner",
          to: "node:capability",
          provenance: [overlay],
        },
        matchedProvenance: [overlay],
      },
    ],
    partial: false,
    truncated: false,
  };
}

test("graph view renders a bounded slice and keeps missing endpoint explicit", () => {
  const model = createGraphViewModel(sliceFixture(), {
    target: (source, id) =>
      source?.kind === "module" ? "repo://module/" + id : undefined,
  });

  assert.equal(model.schemaVersion, GRAPH_VIEW_SCHEMA_VERSION);
  assert.equal(model.availability, "available");
  assert.equal(model.nodes.length, 3);
  const changed = model.nodes.find((candidate) => candidate.id === "node:changed");
  assert.equal(changed?.referenceOnly, true);
  assert.equal(changed?.kind, "reference");

  const module = model.nodes.find((candidate) => candidate.id === "node:module");
  assert.equal(module?.referenceOnly, false);
  assert.equal(module?.label, "Payments <module>");
  assert.equal(module?.target, "repo://module/node:module");
  assert.deepEqual(module?.evidence.methods, ["deterministic-extraction"]);

  assert.deepEqual(
    model.edges.map((edge) => edge.kind).sort(),
    ["imports", "tests"],
  );
});

test("causal explanation focus preserves authoritative overlay evidence", () => {
  const model = createGraphViewModel(explanationFixture());

  assert.equal(model.nodes.every((item) => item.causal), true);
  assert.equal(model.edges.every((item) => item.causal), true);
  assert.deepEqual(
    model.nodes
      .filter((item) => item.kind === "owner" || item.kind === "capability")
      .flatMap((item) => item.evidence.authorities),
    ["authoritative", "authoritative"],
  );
});

test("controller exposes selection, pan, zoom, fit and host open callback", () => {
  const opened: string[] = [];
  const controller = new GraphViewController(sliceFixture(), {
    onOpen: (viewNode) => opened.push(viewNode.id),
  });

  const selected = controller.select("node:module");
  assert.equal(selected.selectedNodeId, "node:module");

  const panned = controller.panBy(20, -10);
  assert.notDeepEqual(panned.viewport, selected.viewport);

  const zoomed = controller.zoomBy(2);
  assert.equal(zoomed.viewport.width < panned.viewport.width, true);

  const fitted = controller.fit();
  assert.equal(fitted.viewport.width > 0, true);
  assert.equal(controller.open(), true);
  assert.deepEqual(opened, ["node:module"]);
  assert.equal(controller.open("node:test"), true);
  assert.deepEqual(opened, ["node:module", "node:test"]);
});

test("SVG renderer is deterministic, embeddable and escapes host labels", () => {
  const controller = new GraphViewController(sliceFixture());
  controller.select("node:module");

  const first = renderGraphViewSvg(controller.snapshot(), {
    width: 800,
    height: 450,
  });
  const second = renderGraphViewSvg(controller.snapshot(), {
    width: 800,
    height: 450,
  });

  assert.equal(first, second);
  assert.match(first, /role="img"/);
  assert.match(first, /data-node-id="node:module"/);
  assert.match(first, /rg-selected/);
  assert.match(first, /Payments &lt;module&gt;/);
  assert.equal(first.includes("<iframe"), false);
  assert.equal(first.includes("<script"), false);
});

test("unavailable evidence remains unavailable instead of inventing graph content", () => {
  const input: ProtocolSliceDto = {
    type: "graph-slice",
    availability: "unavailable",
    start: "node:missing",
    policy: createTraversalPolicy(),
    nodes: [],
    edges: [],
    partial: true,
    truncated: false,
    unavailable: {
      code: "unknown-node",
      message: "No <evidence> for requested node",
    },
  };

  const controller = new GraphViewController(input);
  assert.deepEqual(controller.model.nodes, []);
  assert.deepEqual(controller.model.edges, []);
  const svg = renderGraphViewSvg(controller.snapshot());
  assert.match(svg, /No &lt;evidence&gt; for requested node/);
});

test("VibeGuard-shaped and Hacka-shaped DTOs use the same generic view contract", () => {
  const vibe = createGraphViewModel(explanationFixture());

  const hackaInput: ProtocolSliceDto = {
    type: "graph-slice",
    availability: "available",
    start: "node:source",
    policy: createTraversalPolicy({ direction: "both" }),
    nodes: [
      node("node:source", "file", "src/core.ts"),
      node("node:test-context", "test", "src/core.test.ts"),
      node("node:contract", "contract", "openapi.yaml"),
    ],
    edges: [
      {
        id: "edge:test",
        kind: "tests",
        from: "node:test-context",
        to: "node:source",
        provenance: [provenance],
      },
      {
        id: "edge:contract",
        kind: "contract-for",
        from: "node:contract",
        to: "node:source",
        provenance: [provenance],
      },
    ],
    partial: false,
    truncated: false,
  };
  const hacka = createGraphViewModel(hackaInput);

  assert.equal(vibe.schemaVersion, hacka.schemaVersion);
  assert.equal(vibe.nodes.some((item) => item.kind === "capability"), true);
  assert.equal(hacka.nodes.some((item) => item.kind === "contract"), true);
  assert.equal(
    [...vibe.nodes, ...hacka.nodes].some((item) =>
      "productPolicy" in (item as unknown as Record<string, unknown>),
    ),
    false,
  );
});
