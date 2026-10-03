import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJsonUnknown, toJsonValue } from "./canonical.js";
import { GRAPH_SCHEMA_VERSION, type JsonValue } from "./model.js";

export const STORE_SCHEMA_VERSION = "repograph.store/v1" as const;

export interface ArtifactDescriptor {
  kind: string;
  contentIdentity: string;
  extractor: {
    name: string;
    version: string;
  };
  parserVersion?: string;
  schemaVersion: string;
}

export interface ArtifactEnvelope {
  storeSchemaVersion: typeof STORE_SCHEMA_VERSION;
  key: string;
  descriptor: ArtifactDescriptor;
  payload: JsonValue;
}

export interface SnapshotManifestIdentity {
  repository: string;
  commit: string;
  configurationIdentity: string;
}

export interface SnapshotArtifactRef {
  contentIdentity: string;
  artifactKeys: string[];
  path?: string;
  nodeId?: string;
}

export interface CommitSnapshotManifest {
  storeSchemaVersion: typeof STORE_SCHEMA_VERSION;
  graphSchemaVersion: typeof GRAPH_SCHEMA_VERSION;
  identity: SnapshotManifestIdentity;
  requestedRef?: string;
  tree: string;
  artifacts: SnapshotArtifactRef[];
}

export interface StoreStats {
  hits: number;
  misses: number;
  writes: number;
}

export interface ArtifactLookup {
  key: string;
  payload: JsonValue;
  reused: boolean;
}

export class StoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreValidationError";
  }
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonUnknown(value)).digest("hex");
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new StoreValidationError(`${label} must be an array`);
  }
  return value;
}

function parseDescriptor(value: unknown, label: string): ArtifactDescriptor {
  const raw = record(value, label);
  const extractor = record(raw.extractor, `${label}.extractor`);
  return {
    kind: nonEmpty(raw.kind, `${label}.kind`),
    contentIdentity: nonEmpty(
      raw.contentIdentity,
      `${label}.contentIdentity`,
    ),
    extractor: {
      name: nonEmpty(extractor.name, `${label}.extractor.name`),
      version: nonEmpty(extractor.version, `${label}.extractor.version`),
    },
    ...(raw.parserVersion === undefined
      ? {}
      : {
          parserVersion: nonEmpty(
            raw.parserVersion,
            `${label}.parserVersion`,
          ),
        }),
    schemaVersion: nonEmpty(raw.schemaVersion, `${label}.schemaVersion`),
  };
}

function normalizeArtifactRefs(
  values: readonly SnapshotArtifactRef[],
): SnapshotArtifactRef[] {
  return values
    .map((value) => ({
      contentIdentity: nonEmpty(
        value.contentIdentity,
        "snapshot artifact contentIdentity",
      ),
      artifactKeys: [...new Set(value.artifactKeys)]
        .map((key) => nonEmpty(key, "snapshot artifact key"))
        .sort(),
      ...(value.path === undefined
        ? {}
        : { path: nonEmpty(value.path, "snapshot artifact path") }),
      ...(value.nodeId === undefined
        ? {}
        : { nodeId: nonEmpty(value.nodeId, "snapshot artifact nodeId") }),
    }))
    .sort((left, right) =>
      canonicalJsonUnknown(left).localeCompare(canonicalJsonUnknown(right)),
    );
}

export function artifactKey(descriptor: ArtifactDescriptor): string {
  parseDescriptor(descriptor, "artifact descriptor");
  return `artifact:${sha256({
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    descriptor,
  })}`;
}

export function snapshotManifestKey(
  identity: SnapshotManifestIdentity,
): string {
  const normalized = {
    repository: nonEmpty(identity.repository, "manifest repository"),
    commit: nonEmpty(identity.commit, "manifest commit"),
    configurationIdentity: nonEmpty(
      identity.configurationIdentity,
      "manifest configurationIdentity",
    ),
  };
  return `manifest:${sha256({
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    identity: normalized,
  })}`;
}

export function createSnapshotManifest(input: {
  repository: string;
  commit: string;
  tree: string;
  configurationIdentity?: string;
  requestedRef?: string;
  artifacts?: SnapshotArtifactRef[];
}): CommitSnapshotManifest {
  const identity: SnapshotManifestIdentity = {
    repository: nonEmpty(input.repository, "manifest repository"),
    commit: nonEmpty(input.commit, "manifest commit"),
    configurationIdentity:
      input.configurationIdentity === undefined
        ? "default"
        : nonEmpty(
            input.configurationIdentity,
            "manifest configurationIdentity",
          ),
  };

  return {
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    identity,
    ...(input.requestedRef === undefined
      ? {}
      : {
          requestedRef: nonEmpty(
            input.requestedRef,
            "manifest requestedRef",
          ),
        }),
    tree: nonEmpty(input.tree, "manifest tree"),
    artifacts: normalizeArtifactRefs(input.artifacts ?? []),
  };
}

function parseArtifactEnvelope(
  serialized: string,
  expectedKey: string,
): ArtifactEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new StoreValidationError(
      `Artifact JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = record(parsed, "artifact envelope");
  if (raw.storeSchemaVersion !== STORE_SCHEMA_VERSION) {
    throw new StoreValidationError(
      `Unsupported store schema version: ${String(raw.storeSchemaVersion)}`,
    );
  }

  const key = nonEmpty(raw.key, "artifact key");
  if (key !== expectedKey) {
    throw new StoreValidationError(
      `Artifact key mismatch: expected ${expectedKey}, got ${key}`,
    );
  }

  const descriptor = parseDescriptor(raw.descriptor, "artifact descriptor");
  if (artifactKey(descriptor) !== key) {
    throw new StoreValidationError(
      `Artifact descriptor does not match key ${key}`,
    );
  }

  return {
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    key,
    descriptor,
    payload: toJsonValue(raw.payload),
  };
}

function parseManifest(
  serialized: string,
  expectedIdentity: SnapshotManifestIdentity,
): CommitSnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new StoreValidationError(
      `Manifest JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = record(parsed, "snapshot manifest");
  if (raw.storeSchemaVersion !== STORE_SCHEMA_VERSION) {
    throw new StoreValidationError(
      `Unsupported store schema version: ${String(raw.storeSchemaVersion)}`,
    );
  }
  if (raw.graphSchemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new StoreValidationError(
      `Unsupported graph schema version: ${String(raw.graphSchemaVersion)}`,
    );
  }

  const rawIdentity = record(raw.identity, "manifest identity");
  const identity: SnapshotManifestIdentity = {
    repository: nonEmpty(rawIdentity.repository, "manifest repository"),
    commit: nonEmpty(rawIdentity.commit, "manifest commit"),
    configurationIdentity: nonEmpty(
      rawIdentity.configurationIdentity,
      "manifest configurationIdentity",
    ),
  };

  if (
    snapshotManifestKey(identity) !== snapshotManifestKey(expectedIdentity)
  ) {
    throw new StoreValidationError("Manifest identity does not match its path");
  }

  const artifacts = array(raw.artifacts, "manifest artifacts").map(
    (item, index) => {
      const ref = record(item, `manifest artifacts[${index}]`);
      return {
        contentIdentity: nonEmpty(
          ref.contentIdentity,
          `manifest artifacts[${index}].contentIdentity`,
        ),
        artifactKeys: array(
          ref.artifactKeys,
          `manifest artifacts[${index}].artifactKeys`,
        ).map((key, keyIndex) =>
          nonEmpty(
            key,
            `manifest artifacts[${index}].artifactKeys[${keyIndex}]`,
          ),
        ),
        ...(ref.path === undefined
          ? {}
          : {
              path: nonEmpty(
                ref.path,
                `manifest artifacts[${index}].path`,
              ),
            }),
        ...(ref.nodeId === undefined
          ? {}
          : {
              nodeId: nonEmpty(
                ref.nodeId,
                `manifest artifacts[${index}].nodeId`,
              ),
            }),
      };
    },
  );

  return createSnapshotManifest({
    repository: identity.repository,
    commit: identity.commit,
    configurationIdentity: identity.configurationIdentity,
    ...(raw.requestedRef === undefined
      ? {}
      : {
          requestedRef: nonEmpty(
            raw.requestedRef,
            "manifest requestedRef",
          ),
        }),
    tree: nonEmpty(raw.tree, "manifest tree"),
    artifacts,
  });
}

function keyDigest(key: string, prefix: string): string {
  const expected = `${prefix}:`;
  if (!key.startsWith(expected)) {
    throw new StoreValidationError(
      `Expected ${prefix} key, got ${key}`,
    );
  }
  const digest = key.slice(expected.length);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new StoreValidationError(`Malformed ${prefix} key: ${key}`);
  }
  return digest;
}

export class LocalContentStore {
  readonly root: string;
  readonly stats: StoreStats = { hits: 0, misses: 0, writes: 0 };

  constructor(root: string) {
    this.root = root;
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.writes = 0;
  }

  clear(): void {
    rmSync(this.root, { recursive: true, force: true });
    this.resetStats();
  }

  readArtifact(descriptor: ArtifactDescriptor): ArtifactEnvelope | undefined {
    const key = artifactKey(descriptor);
    const path = this.artifactPath(key);
    if (!existsSync(path)) {
      this.stats.misses += 1;
      return undefined;
    }

    const envelope = parseArtifactEnvelope(readFileSync(path, "utf8"), key);
    this.stats.hits += 1;
    return envelope;
  }

  getOrCreateArtifact(
    descriptor: ArtifactDescriptor,
    producer: () => JsonValue,
  ): ArtifactLookup {
    const existing = this.readArtifact(descriptor);
    if (existing !== undefined) {
      return {
        key: existing.key,
        payload: existing.payload,
        reused: true,
      };
    }

    const key = artifactKey(descriptor);
    const envelope: ArtifactEnvelope = {
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      key,
      descriptor: parseDescriptor(descriptor, "artifact descriptor"),
      payload: toJsonValue(producer()),
    };
    this.writeImmutable(this.artifactPath(key), envelope, "artifact");
    return { key, payload: envelope.payload, reused: false };
  }

  writeArtifact(
    descriptor: ArtifactDescriptor,
    payload: JsonValue,
  ): ArtifactEnvelope {
    const key = artifactKey(descriptor);
    const envelope: ArtifactEnvelope = {
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      key,
      descriptor: parseDescriptor(descriptor, "artifact descriptor"),
      payload: toJsonValue(payload),
    };
    this.writeImmutable(this.artifactPath(key), envelope, "artifact");
    return envelope;
  }

  writeManifest(manifest: CommitSnapshotManifest): string {
    const normalized = createSnapshotManifest({
      repository: manifest.identity.repository,
      commit: manifest.identity.commit,
      configurationIdentity: manifest.identity.configurationIdentity,
      ...(manifest.requestedRef === undefined
        ? {}
        : { requestedRef: manifest.requestedRef }),
      tree: manifest.tree,
      artifacts: manifest.artifacts,
    });
    const key = snapshotManifestKey(normalized.identity);
    this.writeImmutable(this.manifestPath(key), normalized, "manifest");
    return key;
  }

  readManifest(
    identity: SnapshotManifestIdentity,
  ): CommitSnapshotManifest | undefined {
    const key = snapshotManifestKey(identity);
    const path = this.manifestPath(key);
    if (!existsSync(path)) {
      this.stats.misses += 1;
      return undefined;
    }

    const manifest = parseManifest(readFileSync(path, "utf8"), identity);
    this.stats.hits += 1;
    return manifest;
  }

  private artifactPath(key: string): string {
    const digest = keyDigest(key, "artifact");
    return join(
      this.root,
      "artifacts",
      digest.slice(0, 2),
      `${digest}.json`,
    );
  }

  private manifestPath(key: string): string {
    const digest = keyDigest(key, "manifest");
    return join(
      this.root,
      "manifests",
      digest.slice(0, 2),
      `${digest}.json`,
    );
  }

  private writeImmutable(
    path: string,
    value: unknown,
    kind: "artifact" | "manifest",
  ): void {
    const serialized = `${canonicalJsonUnknown(value)}\n`;
    mkdirSync(dirname(path), { recursive: true });

    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8");
      if (existing !== serialized) {
        throw new StoreConflictError(
          `Immutable ${kind} path already contains different content: ${path}`,
        );
      }
      return;
    }

    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, serialized, { flag: "wx" });
      try {
        renameSync(temporary, path);
      } catch (error) {
        if (!existsSync(path)) throw error;
        const existing = readFileSync(path, "utf8");
        if (existing !== serialized) {
          throw new StoreConflictError(
            `Concurrent immutable ${kind} write disagreed at ${path}`,
          );
        }
        rmSync(temporary, { force: true });
        return;
      }
      this.stats.writes += 1;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
