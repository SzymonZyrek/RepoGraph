import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GRAPH_SCHEMA_VERSION,
  LocalArtifactStore,
  StoreConflictError,
  artifactKey,
  canonicalJsonUnknown,
  snapshotManifestKey,
  type ArtifactIdentity,
  type JsonValue,
} from "../src/index.js";

const identity: ArtifactIdentity = {
  contentIdentity: "git-blob:1111111111111111111111111111111111111111",
  artifactKind: "parsed-module",
  extractor: { name: "fixture-extractor", version: "1.0.0" },
  parser: { name: "typescript", version: "5.7.2" },
  schemaVersion: "fixture.module/v1",
};

const payload: JsonValue = {
  imports: ["./shared.js"],
  exports: ["run"],
};

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "repograph-store-"));
}

test("artifact keys include content, extractor, parser and schema identity", () => {
  const base = artifactKey(identity);
  assert.notEqual(
    base,
    artifactKey({
      ...identity,
      extractor: { ...identity.extractor, version: "1.0.1" },
    }),
  );
  assert.notEqual(
    base,
    artifactKey({
      ...identity,
      parser: { name: "typescript", version: "5.8.0" },
    }),
  );
  assert.notEqual(
    base,
    artifactKey({ ...identity, schemaVersion: "fixture.module/v2" }),
  );
  assert.notEqual(
    base,
    artifactKey({ ...identity, contentIdentity: "git-blob:different" }),
  );
});

test("two commit manifests reuse unchanged content-addressed artifacts", () => {
  const root = newRoot();
  const store = new LocalArtifactStore(root);

  const firstPut = store.putArtifact(identity, payload);
  const secondPut = store.putArtifact(identity, payload);
  assert.equal(firstPut.reused, false);
  assert.equal(secondPut.reused, true);
  assert.equal(firstPut.key, secondPut.key);

  const firstManifest = store.writeManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-a",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [
      { logicalKey: "src/shared.ts", artifactKey: firstPut.key },
    ],
  });
  const secondManifest = store.writeManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-b",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [
      { logicalKey: "src/shared.ts", artifactKey: firstPut.key },
    ],
  });

  assert.notEqual(firstManifest.key, secondManifest.key);
  assert.equal(store.getStats().artifactWrites, 1);
  assert.equal(store.getStats().artifactReuses, 1);

  const first = store.getManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-a",
  });
  const second = store.getManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-b",
  });

  assert.equal(first?.artifacts[0]?.artifactKey, firstPut.key);
  assert.equal(second?.artifacts[0]?.artifactKey, firstPut.key);
});

test("snapshot identity distinguishes build configuration without breaking default keys", () => {
  const base = {
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "same-commit",
  };

  assert.equal(
    snapshotManifestKey(base),
    snapshotManifestKey({ ...base, configurationIdentity: "default" }),
  );
  assert.notEqual(
    snapshotManifestKey(base),
    snapshotManifestKey({ ...base, configurationIdentity: "policy:strict" }),
  );

  const root = newRoot();
  const store = new LocalArtifactStore(root);
  const put = store.putArtifact(identity, payload);

  const defaultManifest = store.writeManifest({
    ...base,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [{ logicalKey: "src/shared.ts", artifactKey: put.key }],
  });
  const strictManifest = store.writeManifest({
    ...base,
    configurationIdentity: "policy:strict",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [{ logicalKey: "src/shared.ts", artifactKey: put.key }],
  });

  assert.notEqual(defaultManifest.key, strictManifest.key);
  assert.equal(
    store.getManifest(base)?.configurationIdentity,
    undefined,
  );
  assert.equal(
    store.getManifest({
      ...base,
      configurationIdentity: "policy:strict",
    })?.configurationIdentity,
    "policy:strict",
  );
});

test("store survives process-style restart and exposes hit/miss counters", () => {
  const root = newRoot();
  const first = new LocalArtifactStore(root);
  const put = first.putArtifact(identity, payload);
  first.writeManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-a",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [{ logicalKey: "src/shared.ts", artifactKey: put.key }],
  });

  const restarted = new LocalArtifactStore(root);
  assert.deepEqual(restarted.getArtifact(put.key)?.payload, payload);
  assert.notEqual(
    restarted.getManifest({
      repository: "fixture/repo",
      ref: "refs/heads/main",
      commit: "commit-a",
    }),
    undefined,
  );
  assert.equal(restarted.getArtifact("artifact-sha256-" + "0".repeat(64)), undefined);
  assert.deepEqual(restarted.getStats(), {
    artifactHits: 1,
    artifactMisses: 1,
    artifactWrites: 0,
    artifactReuses: 0,
    manifestHits: 1,
    manifestMisses: 0,
    manifestWrites: 0,
    manifestReuses: 0,
  });
});

test("deleting the cache and rebuilding produces equivalent immutable state", () => {
  const root = newRoot();
  const first = new LocalArtifactStore(root);
  const firstArtifact = first.putArtifact(identity, payload);
  const firstManifest = first.writeManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-a",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [
      { logicalKey: "src/shared.ts", artifactKey: firstArtifact.key },
    ],
  });
  const artifactBefore = first.getArtifact(firstArtifact.key);
  const manifestBefore = first.getManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-a",
  });

  rmSync(root, { recursive: true, force: true });

  const rebuilt = new LocalArtifactStore(root);
  const rebuiltArtifact = rebuilt.putArtifact(identity, payload);
  const rebuiltManifest = rebuilt.writeManifest({
    repository: "fixture/repo",
    ref: "refs/heads/main",
    commit: "commit-a",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [
      { logicalKey: "src/shared.ts", artifactKey: rebuiltArtifact.key },
    ],
  });

  assert.equal(rebuiltArtifact.key, firstArtifact.key);
  assert.equal(rebuiltManifest.key, firstManifest.key);
  assert.equal(
    canonicalJsonUnknown(rebuilt.getArtifact(rebuiltArtifact.key)),
    canonicalJsonUnknown(artifactBefore),
  );
  assert.equal(
    canonicalJsonUnknown(
      rebuilt.getManifest({
        repository: "fixture/repo",
        ref: "refs/heads/main",
        commit: "commit-a",
      }),
    ),
    canonicalJsonUnknown(manifestBefore),
  );
});

test("same artifact identity cannot silently overwrite different output", () => {
  const root = newRoot();
  const store = new LocalArtifactStore(root);
  store.putArtifact(identity, payload);

  assert.throws(
    () => store.putArtifact(identity, { imports: ["./other.js"] }),
    StoreConflictError,
  );
});

test("snapshot manifests reject dangling artifacts and leave no temp files", () => {
  const root = newRoot();
  const store = new LocalArtifactStore(root);

  assert.throws(
    () =>
      store.writeManifest({
        repository: "fixture/repo",
        ref: "main",
        commit: "missing",
        graphSchemaVersion: GRAPH_SCHEMA_VERSION,
        artifacts: [
          {
            logicalKey: "missing",
            artifactKey: "artifact-sha256-" + "1".repeat(64),
          },
        ],
      }),
    StoreConflictError,
  );

  const put = store.putArtifact(identity, payload);
  store.writeManifest({
    repository: "fixture/repo",
    ref: "main",
    commit: "ok",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [{ logicalKey: "ok", artifactKey: put.key }],
  });

  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });

  assert.equal(walk(root).some((path) => path.endsWith(".tmp")), false);
});
