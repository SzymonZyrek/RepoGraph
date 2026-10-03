import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  affected,
  buildGraph,
  explainPath,
  neighbors,
  nodeId,
  reverseNeighbors,
  serializeGraph,
  type Provenance,
} from "../src/index.js";
import { runCli } from "../src/cli-run.js";

const provenance: Provenance = {
  repository: "fixture/repo",
  ref: "main",
  commit: "abc123",
  origin: "derived",
  method: "deterministic-extraction",
  state: "complete",
};

function fixtureGraph() {
  const a = { namespace: "fixture/repo", kind: "file", key: "a.ts" };
  const b = { namespace: "fixture/repo", kind: "file", key: "b.ts" };
  const c = { namespace: "fixture/repo", kind: "file", key: "c.ts" };
  return buildGraph({
    nodes: [
      { identity: a, provenance: [provenance] },
      { identity: b, provenance: [provenance] },
      { identity: c, provenance: [provenance] },
    ],
    edges: [
      {
        identity: {
          kind: "imports",
          from: nodeId(a),
          to: nodeId(b),
        },
        provenance: [provenance],
      },
      {
        identity: {
          kind: "imports",
          from: nodeId(b),
          to: nodeId(c),
        },
        provenance: [provenance],
      },
    ],
  });
}

test("neighbors, reverse traversal, affected closure and explanations are deterministic", () => {
  const graph = fixtureGraph();

  assert.deepEqual(
    neighbors(graph, "a.ts").map((item) => item.node.identity.key),
    ["b.ts"],
  );
  assert.deepEqual(
    reverseNeighbors(graph, "b.ts").map((item) => item.node.identity.key),
    ["a.ts"],
  );
  assert.deepEqual(
    affected(graph, ["c.ts"]).nodes.map((node) => node.identity.key),
    ["c.ts", "b.ts", "a.ts"].sort((left, right) =>
      nodeId({ namespace: "fixture/repo", kind: "file", key: left }).localeCompare(
        nodeId({ namespace: "fixture/repo", kind: "file", key: right }),
      ),
    ),
  );

  const path = explainPath(graph, "a.ts", "c.ts");
  assert.equal(path.found, true);
  assert.deepEqual(path.nodes.map((node) => node.identity.key), [
    "a.ts",
    "b.ts",
    "c.ts",
  ]);
  assert.equal(path.edges.length, 2);
});

test("max depth and edge-kind filters bound traversal", () => {
  const graph = fixtureGraph();
  const bounded = affected(graph, ["c.ts"], {
    edgeKinds: ["imports"],
    maxDepth: 1,
  });
  assert.equal(bounded.truncated, true);
  assert.deepEqual(
    new Set(bounded.nodes.map((node) => node.identity.key)),
    new Set(["b.ts", "c.ts"]),
  );
  assert.equal(
    explainPath(graph, "a.ts", "c.ts", "forward", { maxDepth: 1 }).found,
    false,
  );
});

test("CLI emits deterministic JSON and structured diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "repograph-cli-"));
  const graphPath = join(root, "graph.json");
  writeFileSync(graphPath, serializeGraph(fixtureGraph()));

  let stdout = "";
  let stderr = "";
  const code = runCli(
    ["neighbors", "--graph", graphPath, "--node", "a.ts"],
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as Array<{ node: { identity: { key: string } } }>;
  assert.equal(parsed[0]?.node.identity.key, "b.ts");

  stdout = "";
  stderr = "";
  const invalid = runCli(["wat"], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.equal(invalid, 1);
  assert.equal(stdout, "");
  assert.equal(
    (JSON.parse(stderr) as { code: string }).code,
    "invalid-command",
  );
});

test("CLI version is sourced from package.json", () => {
  let stdout = "";
  const code = runCli(["--version"], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
  });
  assert.equal(code, 0);
  assert.equal(stdout, "0.0.1\n");
});
