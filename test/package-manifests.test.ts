import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  extractPackageManifestRelationships,
  ingestGitRepository,
  nodeId,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-package-manifests-"));
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

function extract(root: string, ref: string) {
  return extractPackageManifestRelationships(
    ingestGitRepository({
      repositoryPath: root,
      repository: "fixture/packages",
      ref,
      discoverCodeowners: false,
    }),
  );
}

function id(kind: string, key: string): string {
  return nodeId({
    namespace: "fixture/packages",
    kind,
    key,
  });
}

test("extracts explicit internal package dependencies without inventing external edges", () => {
  const root = repository();

  file(
    root,
    "package.json",
    JSON.stringify({
      name: "@fixture/root",
      private: true,
      workspaces: ["packages/*"],
    }),
  );
  file(
    root,
    "packages/lib/package.json",
    JSON.stringify({
      name: "@fixture/lib",
      version: "1.0.0",
    }),
  );
  file(root, "packages/lib/src/index.ts", "export const lib = 1;\n");
  file(
    root,
    "packages/test-utils/package.json",
    JSON.stringify({
      name: "@fixture/test-utils",
      version: "1.0.0",
    }),
  );
  file(root, "packages/test-utils/src/index.ts", "export const testUtil = 1;\n");
  file(
    root,
    "packages/app/package.json",
    JSON.stringify({
      name: "@fixture/app",
      version: "1.0.0",
      dependencies: {
        "@fixture/lib": "workspace:*",
        react: "^19.0.0",
      },
      devDependencies: {
        "@fixture/test-utils": "workspace:*",
      },
    }),
  );
  file(root, "packages/app/src/app.ts", "export const app = 1;\n");

  const ref = commit(root, "fixture");
  const result = extract(root, ref);

  const appId = id("package", "packages/app/package.json");
  const libId = id("package", "packages/lib/package.json");
  const testUtilsId = id("package", "packages/test-utils/package.json");

  const internalEdges = result.graph.edges.filter(
    (edge) => edge.identity.kind === "package-depends-on",
  );

  assert.equal(result.metrics.manifests, 4);
  assert.equal(result.metrics.parsedManifests, 4);
  assert.equal(result.metrics.packageNodes, 4);
  assert.equal(result.metrics.internalDependencies, 2);
  assert.equal(result.metrics.externalDependencies, 1);
  assert.equal(result.metrics.ambiguousDependencies, 0);

  assert.equal(
    internalEdges.some(
      (edge) =>
        edge.identity.from === appId &&
        edge.identity.to === libId &&
        edge.metadata?.scope === "dependencies" &&
        edge.metadata?.specifier === "workspace:*",
    ),
    true,
  );
  assert.equal(
    internalEdges.some(
      (edge) =>
        edge.identity.from === appId &&
        edge.identity.to === testUtilsId &&
        edge.metadata?.scope === "devDependencies",
    ),
    true,
  );

  assert.equal(
    result.graph.nodes.some(
      (node) =>
        node.identity.kind === "package" &&
        node.metadata?.name === "react",
    ),
    false,
  );

  const appSourceId = id("file", "packages/app/src/app.ts");
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "belongs-to-package" &&
        edge.identity.from === appSourceId &&
        edge.identity.to === appId,
    ),
    true,
  );

  const appDependency = internalEdges.find(
    (edge) => edge.identity.from === appId && edge.identity.to === libId,
  );
  assert.equal(
    appDependency?.provenance.some(
      (provenance) =>
        provenance.commit === ref &&
        provenance.path === "packages/app/package.json" &&
        provenance.extractor?.name === "repograph-package-manifests",
    ),
    true,
  );
});

test("nearest manifest owns nested files deterministically", () => {
  const root = repository();

  file(
    root,
    "package.json",
    JSON.stringify({
      name: "@fixture/root",
    }),
  );
  file(root, "src/root.ts", "export const root = 1;\n");
  file(
    root,
    "packages/app/package.json",
    JSON.stringify({
      name: "@fixture/app",
    }),
  );
  file(root, "packages/app/src/app.ts", "export const app = 1;\n");

  const ref = commit(root, "nested");
  const result = extract(root, ref);

  const appSourceId = id("file", "packages/app/src/app.ts");
  const appId = id("package", "packages/app/package.json");
  const rootId = id("package", "package.json");

  const ownership = result.graph.edges.filter(
    (edge) =>
      edge.identity.kind === "belongs-to-package" &&
      edge.identity.from === appSourceId,
  );

  assert.equal(ownership.length, 1);
  assert.equal(ownership[0]?.identity.to, appId);
  assert.notEqual(ownership[0]?.identity.to, rootId);
});

test("duplicate internal package names produce diagnostics and no speculative dependency edge", () => {
  const root = repository();

  file(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "@fixture/shared" }),
  );
  file(
    root,
    "packages/b/package.json",
    JSON.stringify({ name: "@fixture/shared" }),
  );
  file(
    root,
    "packages/app/package.json",
    JSON.stringify({
      name: "@fixture/app",
      dependencies: { "@fixture/shared": "workspace:*" },
    }),
  );

  const ref = commit(root, "ambiguous");
  const result = extract(root, ref);
  const appId = id("package", "packages/app/package.json");

  assert.equal(result.metrics.ambiguousDependencies, 1);
  assert.equal(
    result.graph.edges.some(
      (edge) =>
        edge.identity.kind === "package-depends-on" &&
        edge.identity.from === appId,
    ),
    false,
  );
  assert.equal(
    result.graph.diagnostics.some(
      (diagnostic) => diagnostic.code === "package-manifest-duplicate-name",
    ),
    true,
  );
  assert.equal(
    result.graph.diagnostics.some(
      (diagnostic) => diagnostic.code === "package-dependency-ambiguous",
    ),
    true,
  );
});

test("invalid package.json is partial evidence and does not invent a package node", () => {
  const root = repository();
  file(root, "package.json", "{ nope\n");
  file(root, "src/app.ts", "export const app = 1;\n");

  const ref = commit(root, "invalid");
  const result = extract(root, ref);

  assert.equal(result.metrics.manifests, 1);
  assert.equal(result.metrics.parsedManifests, 0);
  assert.equal(result.metrics.packageNodes, 0);
  assert.equal(
    result.graph.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "package-manifest-invalid-json" &&
        diagnostic.state === "partial",
    ),
    true,
  );
});
