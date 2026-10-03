import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GRAPH_SCHEMA_VERSION,
  LocalContentStore,
  STORE_SCHEMA_VERSION,
  StoreConflictError,
  StoreValidationError,
  artifactKey,
  canonicalJsonUnknown,
  createSnapshotManifest,
  snapshotManifestKey,
  type ArtifactDescriptor,
} from "../src/index.js";

function cacheRoot(): string {
  return mkdtempSync(join(tmpdir(), "repograph-store-"));
}

function descriptor(
  contentIdentity: string,
  version = "1.0.0",
): ArtifactDescriptor {
  return {
    kind: "fixture-analysis",
    contentIdentity,
    extractor: { name: "fixture", version },
    parserVersion: "parser-v1",
    schemaVersion: "fixture/v1",
  };
}

test("artifact keys depend on content and extractor/schema identity, not commit", () => {
  const first = descriptor("blob:abc");
  const second = descriptor("blob:abc");
  const changedExtractor = descriptor("blob:abc", "2.0.0");

  assert.equal(artifactKey(first), artifactKey(second));
  assert.notEqual(artifactKey(first), artifactKey(changedExtractor));
  assert.notEqual(
    artifactKey(first),
    artifactKey({ ...first, contentIdentity: "blob:def" }),
  );
});

test("unchanged content reuses artifacts across commits and process restarts", () => {
  const root = cacheRoot();
  let producerCalls = 0;

  const firstProcess = new LocalContentStore(root);
  const shared = firstProcess.getOrCreateArtifact(
    descriptor("blob:shared"),
    () => {
      producerCalls += 1;
      return { imports: ["./shared.js"] };
    },
  );
  const changedV1 = firstProcess.getOrCreateArtifact(
    descriptor("blob:old"),
    () => {
      producerCalls += 1;
      return { imports: ["./old.js"] };
    },
  );

  const manifest1 = createSnapshotManifest({
    repository: "fixture/repo",
    requestedRef: "main",
    commit: "commit-1",
    tree: "tree-1",
    artifacts: [
      {
        path: "src/shared.ts",
        nodeId: "node:shared",
        contentIdentity: "blob:shared",
        artifactKeys: [shared.key],
      },
      {
        path: "src/changed.ts",
        nodeId: "node:changed",
        contentIdentity: "blob:old",
        artifactKeys: [changedV1.key],
      },
    ],
  });
  firstProcess.writeManifest(manifest1);
  assert.equal(producerCalls, 2);
  assert.deepEqual(firstProcess.stats, { hits: 0, misses: 2, writes: 3 });

  const secondProcess = new LocalContentStore(root);
  const reused = secondProcess.getOrCreateArtifact(
    descriptor("blob:shared"),
    () => {
      producerCalls += 100;
      return { impossible: true };
    },
  );
  const changedV2 = secondProcess.getOrCreateArtifact(
    descriptor("blob:new"),
    () => {
      producerCalls += 1;
      return { imports: ["./new.js"] };
    },
  );

  assert.equal(reused.reused, true);
  assert.equal(changedV2.reused, false);
  assert.equal(producerCalls, 3);
  assert.deepEqual(secondProcess.stats, { hits: 1, misses: 1, writes: 1 });

  const manifest2 = createSnapshotManifest({
    repository: "fixture/repo",
    requestedRef: "main",
    commit: "commit-2",
    tree: "tree-2",
    artifacts: [
      {
        path: "src/shared.ts",
        nodeId: "node:shared",
        contentIdentity: "blob:shared",
        artifactKeys: [reused.key],
      },
      {
        path: "src/changed.ts",
        nodeId: "node:changed",
        contentIdentity: "blob:new",
        artifactKeys: [changedV2.key],
      },
    ],
  });
  secondProcess.writeManifest(manifest2);

  const thirdProcess = new LocalContentStore(root);
  assert.deepEqual(
    thirdProcess.readManifest(manifest1.identity),
    manifest1,
  );
  assert.deepEqual(
    thirdProcess.readManifest(manifest2.identity),
    manifest2,
  );
  assert.equal(
    manifest1.artifacts[0]?.artifactKeys[0],
    manifest2.artifacts[0]?.artifactKeys[0],
  );
});

test("deleting the disposable cache and rebuilding yields equivalent artifacts", () => {
  const root = cacheRoot();
  const store = new LocalContentStore(root);
  const spec = descriptor("blob:stable");

  const first = store.getOrCreateArtifact(spec, () => ({
    exports: ["A", "B"],
    nested: { value: 1 },
  }));
  const firstSerialized = canonicalJsonUnknown(first.payload);

  store.clear();

  const rebuilt = new LocalContentStore(root).getOrCreateArtifact(spec, () => ({
    nested: { value: 1 },
    exports: ["A", "B"],
  }));

  assert.equal(rebuilt.key, first.key);
  assert.equal(canonicalJsonUnknown(rebuilt.payload), firstSerialized);
  assert.equal(rebuilt.reused, false);
});

test("immutable artifact writes reject nondeterministic output for one key", () => {
  const root = cacheRoot();
  const store = new LocalContentStore(root);
  const spec = descriptor("blob:collision");

  store.writeArtifact(spec, { value: 1 });
  assert.throws(
    () => store.writeArtifact(spec, { value: 2 }),
    StoreConflictError,
  );
  assert.deepEqual(store.stats, { hits: 0, misses: 0, writes: 1 });
});

test("snapshot manifests normalize reference ordering and include schema versions", () => {
  const keyA = artifactKey(descriptor("blob:key-a"));
  const keyB = artifactKey(descriptor("blob:key-b"));
  const keyC = artifactKey(descriptor("blob:key-c"));
  const manifest = createSnapshotManifest({
    repository: "fixture/repo",
    commit: "commit-1",
    tree: "tree-1",
    configurationIdentity: "policy:abc",
    artifacts: [
      {
        contentIdentity: "blob:b",
        artifactKeys: [keyB, keyA, keyA],
        path: "b.ts",
      },
      {
        contentIdentity: "blob:a",
        artifactKeys: [keyC],
        path: "a.ts",
      },
    ],
  });

  assert.equal(manifest.storeSchemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(manifest.graphSchemaVersion, GRAPH_SCHEMA_VERSION);
  const aRef = manifest.artifacts.find((item) => item.path === "a.ts");
  const bRef = manifest.artifacts.find((item) => item.path === "b.ts");
  assert.deepEqual(aRef?.artifactKeys, [keyC]);
  assert.deepEqual(bRef?.artifactKeys, [keyA, keyB].sort());
  assert.match(snapshotManifestKey(manifest.identity), /^manifest:[0-9a-f]{64}$/);
});

test("corrupted persisted schema fails explicitly", () => {
  const root = cacheRoot();
  const store = new LocalContentStore(root);
  const spec = descriptor("blob:corrupt");
  const written = store.writeArtifact(spec, { value: 1 });

  const digest = written.key.slice("artifact:".length);
  const path = join(root, "artifacts", digest.slice(0, 2), `${digest}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  parsed.storeSchemaVersion = "repograph.store/v999";
  writeFileSync(path, JSON.stringify(parsed));

  assert.throws(() => store.readArtifact(spec), StoreValidationError);
});

test("atomic writes leave no temporary files behind", () => {
  const root = cacheRoot();
  const store = new LocalContentStore(root);
  const written = store.writeArtifact(descriptor("blob:atomic"), { ok: true });
  const digest = written.key.slice("artifact:".length);
  const directory = join(root, "artifacts", digest.slice(0, 2));

  assert.deepEqual(
    readdirSync(directory).filter((name) => name.endsWith(".tmp")),
    [],
  );
});
