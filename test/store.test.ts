import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GRAPH_SCHEMA_VERSION,
  LocalContentStore,
  buildGraph,
  STORE_SCHEMA_VERSION,
  StoreConflictError,
  StoreValidationError,
  artifactKey,
  canonicalJsonUnknown,
  createSnapshotManifest,
  graphEquals,
  snapshotGitRepository,
  parseGraph,
  serializeGraph,
  toJsonValue,
  snapshotManifestKey,
  type ArtifactDescriptor,
  type Provenance,
} from "../src/index.js";

function cacheRoot(): string {
  return mkdtempSync(join(tmpdir(), "repograph-store-"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "repograph-store-repo-"));
  git(root, "init");
  git(root, "config", "user.email", "repograph@example.test");
  git(root, "config", "user.name", "RepoGraph Test");
  return root;
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
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
  const sharedV1 = manifest1.artifacts.find(
    (item) => item.contentIdentity === "blob:shared",
  );
  const sharedV2 = manifest2.artifacts.find(
    (item) => item.contentIdentity === "blob:shared",
  );
  assert.equal(
    sharedV1?.artifactKeys[0],
    sharedV2?.artifactKeys[0],
  );
  assert.deepEqual(
    thirdProcess.readArtifactByKey(reused.key)?.payload,
    reused.payload,
  );
});

test("deleting the disposable cache and rebuilding yields equivalent graph output", () => {
  const root = cacheRoot();
  const store = new LocalContentStore(root);
  const evidence: Provenance = {
    repository: "fixture/repo",
    ref: "main",
    commit: "commit-1",
    origin: "derived",
    method: "deterministic-extraction",
    state: "complete",
  };
  const identityA = {
    namespace: "fixture/repo",
    kind: "module",
    key: "a",
  };
  const identityB = {
    namespace: "fixture/repo",
    kind: "module",
    key: "b",
  };
  const spec: ArtifactDescriptor = {
    kind: "graph-snapshot",
    contentIdentity: "commit:commit-1",
    extractor: { name: "fixture-graph", version: "1" },
    schemaVersion: GRAPH_SCHEMA_VERSION,
  };

  const graphA = buildGraph({
    nodes: [
      { identity: identityB, provenance: [evidence] },
      { identity: identityA, provenance: [evidence] },
    ],
  });
  const first = store.getOrCreateArtifact(spec, () => toJsonValue(graphA));
  const firstGraph = parseGraph(canonicalJsonUnknown(first.payload));

  store.clear();

  const graphB = buildGraph({
    nodes: [
      { identity: identityA, provenance: [evidence] },
      { identity: identityB, provenance: [evidence] },
    ],
  });
  const rebuilt = new LocalContentStore(root).getOrCreateArtifact(
    spec,
    () => toJsonValue(graphB),
  );
  const rebuiltGraph = parseGraph(canonicalJsonUnknown(rebuilt.payload));

  assert.equal(rebuilt.key, first.key);
  assert.equal(serializeGraph(rebuiltGraph), serializeGraph(firstGraph));
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

test("manifests reject references to missing local artifacts", () => {
  const root = cacheRoot();
  const store = new LocalContentStore(root);
  const missing = artifactKey(descriptor("blob:missing"));
  const manifest = createSnapshotManifest({
    repository: "fixture/repo",
    commit: "commit-missing",
    tree: "tree-missing",
    artifacts: [
      {
        contentIdentity: "blob:missing",
        artifactKeys: [missing],
      },
    ],
  });

  assert.throws(() => store.writeManifest(manifest), StoreValidationError);
});

test("different requested refs get distinct manifest identities for the same commit", () => {
  const main = createSnapshotManifest({
    repository: "fixture/repo",
    requestedRef: "main",
    commit: "same-commit",
    tree: "same-tree",
  });
  const tag = createSnapshotManifest({
    repository: "fixture/repo",
    requestedRef: "refs/tags/v1",
    commit: "same-commit",
    tree: "same-tree",
  });

  assert.notEqual(
    snapshotManifestKey(main.identity),
    snapshotManifestKey(tag.identity),
  );
});

test("missing reads are observable and identical immutable writes are idempotent", () => {
  const root = cacheRoot();
  const store = new LocalContentStore(root);
  const spec = descriptor("blob:idempotent");

  assert.equal(store.readArtifact(spec), undefined);
  assert.deepEqual(store.stats, { hits: 0, misses: 1, writes: 0 });

  const first = store.writeArtifact(spec, { value: 1 });
  const second = store.writeArtifact(spec, { value: 1 });
  assert.equal(first.key, second.key);
  assert.deepEqual(store.stats, { hits: 0, misses: 1, writes: 1 });

  store.resetStats();
  assert.deepEqual(store.stats, { hits: 0, misses: 0, writes: 0 });
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


test("real Git snapshots reuse unchanged blobs across commits and restarts", () => {
  const root = gitRepository();
  const cache = cacheRoot();

  writeFileSync(join(root, "stable.txt"), "stable\n");
  writeFileSync(join(root, "changing.txt"), "one\n");
  const firstCommit = commitAll(root, "first");

  const firstStore = new LocalContentStore(cache);
  const first = snapshotGitRepository(firstStore, {
    repositoryPath: root,
    repository: "fixture/real-git",
    ref: firstCommit,
    discoverCodeowners: false,
  });

  writeFileSync(join(root, "changing.txt"), "two\n");
  const secondCommit = commitAll(root, "second");

  const secondStore = new LocalContentStore(cache);
  const second = snapshotGitRepository(secondStore, {
    repositoryPath: root,
    repository: "fixture/real-git",
    ref: secondCommit,
    discoverCodeowners: false,
  });

  const stableFirst = first.manifest.artifacts.find(
    (artifact) => artifact.path === "stable.txt",
  );
  const stableSecond = second.manifest.artifacts.find(
    (artifact) => artifact.path === "stable.txt",
  );
  const changingFirst = first.manifest.artifacts.find(
    (artifact) => artifact.path === "changing.txt",
  );
  const changingSecond = second.manifest.artifacts.find(
    (artifact) => artifact.path === "changing.txt",
  );

  assert.notEqual(stableFirst, undefined);
  assert.notEqual(stableSecond, undefined);
  assert.notEqual(changingFirst, undefined);
  assert.notEqual(changingSecond, undefined);
  assert.deepEqual(stableSecond?.artifactKeys, stableFirst?.artifactKeys);
  assert.notDeepEqual(changingSecond?.artifactKeys, changingFirst?.artifactKeys);
  assert.equal(second.cache.hits >= 1, true);

  const restarted = new LocalContentStore(cache);
  const replay = snapshotGitRepository(restarted, {
    repositoryPath: root,
    repository: "fixture/real-git",
    ref: secondCommit,
    discoverCodeowners: false,
  });

  assert.equal(replay.manifestKey, second.manifestKey);
  assert.equal(replay.cache.writes, 0);
  assert.equal(replay.cache.hits >= second.manifest.artifacts.length, true);
  assert.equal(graphEquals(replay.graph, second.graph), true);
});

test("Git mode-only changes reuse blob artifacts without CAS conflicts", () => {
  const root = gitRepository();
  const cache = cacheRoot();

  writeFileSync(join(root, "script.sh"), "#!/bin/sh\necho ok\n");
  const firstCommit = commitAll(root, "non-executable");
  const first = snapshotGitRepository(new LocalContentStore(cache), {
    repositoryPath: root,
    repository: "fixture/mode",
    ref: firstCommit,
    discoverCodeowners: false,
  });

  git(root, "update-index", "--chmod=+x", "script.sh");
  git(root, "commit", "-m", "executable");
  const secondCommit = git(root, "rev-parse", "HEAD");
  const second = snapshotGitRepository(new LocalContentStore(cache), {
    repositoryPath: root,
    repository: "fixture/mode",
    ref: secondCommit,
    discoverCodeowners: false,
  });

  const firstRef = first.manifest.artifacts.find(
    (artifact) => artifact.path === "script.sh",
  );
  const secondRef = second.manifest.artifacts.find(
    (artifact) => artifact.path === "script.sh",
  );
  assert.deepEqual(firstRef?.artifactKeys, secondRef?.artifactKeys);
});

test("cache deletion remains legal for real Git snapshots", () => {
  const root = gitRepository();
  const cache = cacheRoot();
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  const commit = commitAll(root, "fixture");

  const first = snapshotGitRepository(new LocalContentStore(cache), {
    repositoryPath: root,
    repository: "fixture/disposable-git",
    ref: commit,
    discoverCodeowners: false,
  });

  rmSync(cache, { recursive: true, force: true });

  const rebuilt = snapshotGitRepository(new LocalContentStore(cache), {
    repositoryPath: root,
    repository: "fixture/disposable-git",
    ref: commit,
    discoverCodeowners: false,
  });

  assert.equal(first.manifestKey, rebuilt.manifestKey);
  assert.deepEqual(first.manifest, rebuilt.manifest);
  assert.equal(graphEquals(first.graph, rebuilt.graph), true);
});
