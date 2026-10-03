import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GRAPH_SCHEMA_VERSION,
  LocalArtifactStore,
  STORE_SCHEMA_VERSION,
  StoreCorruptionError,
  collectArtifactStoreGarbage,
  inspectArtifactStore,
  recoverArtifactStore,
  type ArtifactIdentity,
  type JsonValue,
} from "../src/index.js";

const payload: JsonValue = { value: 1 };

function root(): string {
  return mkdtempSync(join(tmpdir(), "repograph-store-lifecycle-"));
}

function identity(contentIdentity: string): ArtifactIdentity {
  return {
    contentIdentity,
    artifactKind: "fixture",
    extractor: { name: "fixture", version: "1" },
    schemaVersion: "fixture/v1",
  };
}

function artifactPath(storeRoot: string, key: string): string {
  const digest = key.slice("artifact-sha256-".length);
  return join(storeRoot, "artifacts", digest.slice(0, 2), `${digest}.json`);
}

function manifestPath(storeRoot: string, key: string): string {
  const digest = key.slice("snapshot-sha256-".length);
  return join(storeRoot, "manifests", digest.slice(0, 2), `${digest}.json`);
}

test("inventory reports reclaimable bytes and GC preserves artifacts reachable from retained manifests", () => {
  const storeRoot = root();
  const store = new LocalArtifactStore(storeRoot);

  const shared = store.putArtifact(identity("shared"), payload);
  const oldOnly = store.putArtifact(identity("old"), { value: "old" });
  const newOnly = store.putArtifact(identity("new"), { value: "new" });
  const orphan = store.putArtifact(identity("orphan"), { value: "orphan" });

  const oldManifest = store.writeManifest({
    repository: "fixture/repo",
    ref: "main",
    commit: "old",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [
      { logicalKey: "shared", artifactKey: shared.key },
      { logicalKey: "old", artifactKey: oldOnly.key },
    ],
  });
  const newManifest = store.writeManifest({
    repository: "fixture/repo",
    ref: "main",
    commit: "new",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [
      { logicalKey: "shared", artifactKey: shared.key },
      { logicalKey: "new", artifactKey: newOnly.key },
    ],
  });

  const before = inspectArtifactStore(storeRoot);
  assert.equal(before.artifacts.files, 4);
  assert.equal(before.artifacts.unreferenced, 1);
  assert.equal(before.artifacts.reclaimableBytes > 0, true);
  assert.equal(before.manifests.files, 2);
  assert.equal(before.manifests.missingArtifactReferences, 0);
  assert.equal(before.totalBytes > 0, true);

  const dryRun = collectArtifactStoreGarbage(storeRoot, {
    dryRun: true,
    retainManifest: (manifest) => manifest.commit === "new",
  });
  assert.deepEqual(dryRun.deletedManifests, [oldManifest.key]);
  assert.deepEqual(
    new Set(dryRun.deletedArtifacts),
    new Set([oldOnly.key, orphan.key]),
  );
  assert.equal(existsSync(manifestPath(storeRoot, oldManifest.key)), true);

  const collected = collectArtifactStoreGarbage(storeRoot, {
    retainManifest: (manifest) => manifest.commit === "new",
  });
  assert.deepEqual(collected.deletedManifests, [oldManifest.key]);
  assert.equal(collected.bytesReclaimed > 0, true);

  const after = inspectArtifactStore(storeRoot);
  assert.equal(after.manifests.files, 1);
  assert.equal(after.artifacts.files, 2);
  assert.equal(after.artifacts.unreferenced, 0);
  assert.equal(
    existsSync(manifestPath(storeRoot, newManifest.key)),
    true,
  );
  assert.equal(existsSync(artifactPath(storeRoot, shared.key)), true);
  assert.equal(existsSync(artifactPath(storeRoot, newOnly.key)), true);
});

test("corrupt artifacts invalidate only affected manifests and can be rebuilt at the same identities", () => {
  const storeRoot = root();
  const store = new LocalArtifactStore(storeRoot);
  const artifact = store.putArtifact(identity("corrupt-me"), payload);
  const manifest = store.writeManifest({
    repository: "fixture/repo",
    ref: "main",
    commit: "commit-a",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [{ logicalKey: "a", artifactKey: artifact.key }],
  });

  writeFileSync(artifactPath(storeRoot, artifact.key), "{broken", "utf8");

  const broken = inspectArtifactStore(storeRoot);
  assert.equal(broken.artifacts.corrupt, 1);
  assert.equal(broken.manifests.missingArtifactReferences, 1);

  const recovery = recoverArtifactStore(storeRoot);
  assert.deepEqual(recovery.removedArtifacts, [artifact.key]);
  assert.deepEqual(recovery.invalidatedManifests, [manifest.key]);
  assert.equal(recovery.bytesRemoved > 0, true);
  assert.equal(store.getArtifact(artifact.key), undefined);
  assert.equal(
    store.getManifest({
      repository: "fixture/repo",
      ref: "main",
      commit: "commit-a",
    }),
    undefined,
  );

  const rebuiltArtifact = store.putArtifact(identity("corrupt-me"), payload);
  const rebuiltManifest = store.writeManifest({
    repository: "fixture/repo",
    ref: "main",
    commit: "commit-a",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [{ logicalKey: "a", artifactKey: rebuiltArtifact.key }],
  });

  assert.equal(rebuiltArtifact.key, artifact.key);
  assert.equal(rebuiltManifest.key, manifest.key);
  assert.deepEqual(store.getArtifact(artifact.key)?.payload, payload);
});

test("explicit schema migration hooks repair compatible old wrappers in place", () => {
  const storeRoot = root();
  const store = new LocalArtifactStore(storeRoot);
  const artifact = store.putArtifact(identity("migrate-me"), payload);
  const path = artifactPath(storeRoot, artifact.key);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.storeSchemaVersion = "repograph.store/v0";
  writeFileSync(path, JSON.stringify(raw), "utf8");

  const recovery = recoverArtifactStore(storeRoot, {
    migrations: [
      {
        kind: "artifact",
        fromVersion: "repograph.store/v0",
        toVersion: STORE_SCHEMA_VERSION,
        migrate(record) {
          return {
            ...record,
            storeSchemaVersion: STORE_SCHEMA_VERSION,
          };
        },
      },
    ],
  });

  assert.deepEqual(recovery.migratedArtifacts, [artifact.key]);
  assert.deepEqual(recovery.removedArtifacts, []);
  assert.deepEqual(store.getArtifact(artifact.key)?.payload, payload);
});

test("unknown incompatible snapshot schemas follow the explicit rebuild rule", () => {
  const storeRoot = root();
  const store = new LocalArtifactStore(storeRoot);
  const artifact = store.putArtifact(identity("snapshot-rebuild"), payload);
  const manifest = store.writeManifest({
    repository: "fixture/repo",
    ref: "main",
    commit: "legacy",
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    artifacts: [{ logicalKey: "a", artifactKey: artifact.key }],
  });
  const path = manifestPath(storeRoot, manifest.key);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.snapshotSchemaVersion = "repograph.snapshot/v0";
  writeFileSync(path, JSON.stringify(raw), "utf8");

  const recovery = recoverArtifactStore(storeRoot, {
    incompatibleSchema: "rebuild",
  });

  assert.deepEqual(recovery.removedManifests, [manifest.key]);
  assert.equal(existsSync(path), false);
  assert.notEqual(store.getArtifact(artifact.key), undefined);
});

test("error recovery policy surfaces corruption instead of deleting it", () => {
  const storeRoot = root();
  const store = new LocalArtifactStore(storeRoot);
  const artifact = store.putArtifact(identity("strict"), payload);
  writeFileSync(artifactPath(storeRoot, artifact.key), "{broken", "utf8");

  assert.throws(
    () =>
      recoverArtifactStore(storeRoot, {
        corruption: "error",
      }),
    StoreCorruptionError,
  );
  assert.equal(existsSync(artifactPath(storeRoot, artifact.key)), true);
});
