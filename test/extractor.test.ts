import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  EXTRACTOR_PROTOCOL_VERSION,
  artifactKey,
  createExternalProcessExtractor,
  extractorArtifactIdentity,
  ingestGitRepository,
  nodeId,
  normalizeExtractorDescriptor,
  runExtractors,
  type ExtractorDescriptor,
  type ExtractorPlugin,
  type Provenance,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-extractor-"));
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

function ingestion() {
  const root = repository();
  file(root, "src/a.ts", "export const a = 1;\n");
  const ref = commit(root, "fixture");
  return ingestGitRepository({
    repositoryPath: root,
    repository: "fixture/extractors",
    ref,
    discoverCodeowners: false,
  });
}

function descriptor(
  name: string,
  version: string,
  boundary: "in-process" | "external-process",
  method: "deterministic-extraction" | "external-index",
): ExtractorDescriptor {
  return {
    protocolVersion: EXTRACTOR_PROTOCOL_VERSION,
    name,
    version,
    outputSchemaVersion: "fixture.extractor-output/v1",
    capabilities: {
      nodeKinds: ["symbol"],
      edgeKinds: ["indexes"],
      evidenceMethods: [method],
      fidelity: [method === "external-index" ? "compiler-index" : "syntax"],
      boundary,
    },
  };
}

function provenance(
  ingested: ReturnType<typeof ingestion>,
  desc: ExtractorDescriptor,
  method: "deterministic-extraction" | "external-index",
): Provenance {
  return {
    repository: ingested.repository,
    ref: ingested.requestedRef,
    commit: ingested.commit,
    extractor: { name: desc.name, version: desc.version },
    origin: "derived",
    method,
    state: "complete",
  };
}

function nativePlugin(
  ingested: ReturnType<typeof ingestion>,
  desc = descriptor(
    "native-fixture",
    "1",
    "in-process",
    "deterministic-extraction",
  ),
): ExtractorPlugin {
  const symbolIdentity = {
    namespace: ingested.repository,
    kind: "symbol",
    key: "src/a.ts#fixture:a",
  };
  return {
    descriptor: desc,
    extract() {
      return {
        nodes: [
          {
            identity: symbolIdentity,
            metadata: { name: "a", precision: "exact" },
            provenance: [
              provenance(ingested, desc, "deterministic-extraction"),
            ],
          },
        ],
        edges: [
          {
            identity: {
              kind: "indexes",
              from: nodeId({
                namespace: ingested.repository,
                kind: "file",
                key: "src/a.ts",
              }),
              to: nodeId(symbolIdentity),
              key: "fixture:a",
            },
            metadata: { precision: "exact" },
            provenance: [
              provenance(ingested, desc, "deterministic-extraction"),
            ],
          },
        ],
      };
    },
  };
}

function externalFixture(
  ingested: ReturnType<typeof ingestion>,
  desc: ExtractorDescriptor,
  metadata: Record<string, string>,
) {
  const root = mkdtempSync(join(tmpdir(), "repograph-external-extractor-"));
  const script = join(root, "fixture.mjs");
  const symbolIdentity = {
    namespace: ingested.repository,
    kind: "symbol",
    key: "src/a.ts#fixture:a",
  };
  const fileNodeId = nodeId({
    namespace: ingested.repository,
    kind: "file",
    key: "src/a.ts",
  });
  const symbolNodeId = nodeId(symbolIdentity);

  writeFileSync(
    script,
    `let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const descriptor = ${JSON.stringify(normalizeExtractorDescriptor(desc))};
const provenance = {
  repository: request.repository,
  ref: request.ref,
  commit: request.commit,
  extractor: { name: descriptor.name, version: descriptor.version },
  origin: "derived",
  method: "external-index",
  state: "complete"
};
process.stdout.write(JSON.stringify({
  descriptor,
  output: {
    nodes: [{
      identity: ${JSON.stringify(symbolIdentity)},
      metadata: ${JSON.stringify(metadata)},
      provenance: [provenance]
    }],
    edges: [{
      identity: {
        kind: "indexes",
        from: ${JSON.stringify(fileNodeId)},
        to: ${JSON.stringify(symbolNodeId)},
        key: "fixture:a"
      },
      metadata: { precision: "exact" },
      provenance: [provenance]
    }]
  }
}));
`,
  );

  return createExternalProcessExtractor({
    descriptor: desc,
    command: process.execPath,
    args: [script],
  });
}

test("descriptor normalization is canonical and rejects extractor-only overlay authority", () => {
  const normalized = normalizeExtractorDescriptor({
    ...descriptor(
      "fixture",
      "1",
      "in-process",
      "deterministic-extraction",
    ),
    capabilities: {
      ...descriptor(
        "fixture",
        "1",
        "in-process",
        "deterministic-extraction",
      ).capabilities,
      nodeKinds: ["symbol", "symbol", "module"],
      fidelity: ["syntax", "syntax"],
    },
  });

  assert.deepEqual(normalized.capabilities.nodeKinds, ["module", "symbol"]);
  assert.deepEqual(normalized.capabilities.fidelity, ["syntax"]);

  assert.throws(() =>
    normalizeExtractorDescriptor({
      ...normalized,
      capabilities: {
        ...normalized.capabilities,
        evidenceMethods: ["explicit-overlay"],
      },
    }),
  );
});

test("native and external-index facts converge deterministically with both provenances preserved", () => {
  const ingested = ingestion();
  const native = nativePlugin(ingested);
  const externalDesc = descriptor(
    "external-index-fixture",
    "7",
    "external-process",
    "external-index",
  );
  const external = externalFixture(ingested, externalDesc, {
    name: "a",
    precision: "exact",
  });

  const first = runExtractors(ingested, [native, external]);
  const second = runExtractors(ingested, [external, native]);

  assert.deepEqual(first, second);

  const symbol = first.nodes.find(
    (node) => node.identity.key === "src/a.ts#fixture:a",
  );
  assert.notEqual(symbol, undefined);
  assert.deepEqual(
    symbol!.provenance.map((item) => item.method).sort(),
    ["deterministic-extraction", "external-index"],
  );

  const edge = first.edges.find(
    (item) =>
      item.identity.kind === "indexes" &&
      item.identity.key === "fixture:a",
  );
  assert.notEqual(edge, undefined);
  assert.deepEqual(
    edge!.provenance.map((item) => item.method).sort(),
    ["deterministic-extraction", "external-index"],
  );
});

test("conflicting external facts remain inspectable and never silently replace native facts", () => {
  const ingested = ingestion();
  const native = nativePlugin(ingested);
  const conflictDesc = descriptor(
    "z-conflicting-index",
    "1",
    "external-process",
    "external-index",
  );
  const conflict = externalFixture(ingested, conflictDesc, {
    name: "different",
    precision: "exact",
  });

  const graph = runExtractors(ingested, [native, conflict]);
  const symbol = graph.nodes.find(
    (node) => node.identity.key === "src/a.ts#fixture:a",
  );

  assert.equal(symbol?.metadata?.name, "a");
  assert.equal(
    graph.diagnostics.some(
      (item) => item.code === "extractor-node-conflict",
    ),
    true,
  );
});

test("invalid or failed plugins degrade to diagnostics without blocking other extractors", () => {
  const ingested = ingestion();
  const native = nativePlugin(ingested);
  const invalidDescriptor = descriptor(
    "z-invalid-fixture",
    "1",
    "in-process",
    "deterministic-extraction",
  );
  const invalid: ExtractorPlugin = {
    descriptor: invalidDescriptor,
    extract() {
      return {
        nodes: [
          {
            identity: {
              namespace: ingested.repository,
              kind: "undeclared-kind",
              key: "bad",
            },
            provenance: [
              provenance(
                ingested,
                invalidDescriptor,
                "deterministic-extraction",
              ),
            ],
          },
        ],
        diagnostics: [
          {
            code: "bad-diagnostic",
            message: "missing provenance on purpose",
            state: "partial",
          },
        ],
      };
    },
  };
  const failed: ExtractorPlugin = {
    descriptor: descriptor(
      "z-throws",
      "1",
      "in-process",
      "deterministic-extraction",
    ),
    extract() {
      throw new Error("fixture failure");
    },
  };

  const graph = runExtractors(ingested, [failed, invalid, native]);

  assert.equal(
    graph.nodes.some((node) => node.identity.key === "src/a.ts#fixture:a"),
    true,
  );
  assert.equal(
    graph.diagnostics.some((item) => item.code === "extractor-invalid-node"),
    true,
  );
  assert.equal(
    graph.diagnostics.some(
      (item) => item.code === "extractor-invalid-diagnostic",
    ),
    true,
  );
  assert.equal(
    graph.diagnostics.some((item) => item.code === "extractor-failed"),
    true,
  );
});

test("extractor version participates only in that extractor's artifact identity", () => {
  const a1 = descriptor(
    "extractor-a",
    "1",
    "in-process",
    "deterministic-extraction",
  );
  const a2 = descriptor(
    "extractor-a",
    "2",
    "in-process",
    "deterministic-extraction",
  );
  const b1 = descriptor(
    "extractor-b",
    "1",
    "in-process",
    "deterministic-extraction",
  );

  const artifact = {
    contentIdentity: "git-blob:abc",
    artifactKind: "fixture-index",
    schemaVersion: "fixture/v1",
  };

  const a1Key = artifactKey(extractorArtifactIdentity(a1, artifact));
  const a2Key = artifactKey(extractorArtifactIdentity(a2, artifact));
  const b1Key = artifactKey(extractorArtifactIdentity(b1, artifact));
  const b1Again = artifactKey(extractorArtifactIdentity(b1, artifact));

  assert.notEqual(a1Key, a2Key);
  assert.notEqual(a1Key, b1Key);
  assert.equal(b1Key, b1Again);
});
