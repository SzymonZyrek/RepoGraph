import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJsonUnknown, toJsonValue } from "./canonical.js";
import type { ExtractorRef, JsonValue } from "./model.js";

export const STORE_SCHEMA_VERSION = "repograph.store/v1" as const;
export const SNAPSHOT_SCHEMA_VERSION = "repograph.snapshot/v1" as const;

export interface ArtifactIdentity {
  contentIdentity: string;
  artifactKind: string;
  extractor: ExtractorRef;
  parser?: ExtractorRef;
  schemaVersion: string;
}

export interface StoredArtifact {
  storeSchemaVersion: typeof STORE_SCHEMA_VERSION;
  key: string;
  identity: ArtifactIdentity;
  payload: JsonValue;
}

export interface SnapshotArtifactRef {
  logicalKey: string;
  artifactKey: string;
}

export interface SnapshotManifestInput {
  repository: string;
  ref: string;
  commit: string;
  graphSchemaVersion: string;
  artifacts: SnapshotArtifactRef[];
}

export interface SnapshotManifest extends SnapshotManifestInput {
  snapshotSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  key: string;
}

export interface PutResult {
  key: string;
  reused: boolean;
}

export interface StoreStats {
  artifactHits: number;
  artifactMisses: number;
  artifactWrites: number;
  artifactReuses: number;
  manifestHits: number;
  manifestMisses: number;
  manifestWrites: number;
  manifestReuses: number;
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export class StoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreCorruptionError";
  }
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeExtractor(value: ExtractorRef, label: string): ExtractorRef {
  return {
    name: nonEmpty(value.name, `${label}.name`),
    version: nonEmpty(value.version, `${label}.version`),
  };
}

function normalizeArtifactIdentity(identity: ArtifactIdentity): ArtifactIdentity {
  return {
    contentIdentity: nonEmpty(identity.contentIdentity, "contentIdentity"),
    artifactKind: nonEmpty(identity.artifactKind, "artifactKind"),
    extractor: normalizeExtractor(identity.extractor, "extractor"),
    ...(identity.parser === undefined
      ? {}
      : { parser: normalizeExtractor(identity.parser, "parser") }),
    schemaVersion: nonEmpty(identity.schemaVersion, "schemaVersion"),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonUnknown(value)).digest("hex");
}

export function artifactKey(identity: ArtifactIdentity): string {
  return `artifact-sha256-${hash(normalizeArtifactIdentity(identity))}`;
}

export function snapshotManifestKey(
  input: Pick<SnapshotManifestInput, "repository" | "ref" | "commit">,
): string {
  return `snapshot-sha256-${hash({
    repository: nonEmpty(input.repository, "repository"),
    ref: nonEmpty(input.ref, "ref"),
    commit: nonEmpty(input.commit, "commit"),
  })}`;
}

function keyDigest(key: string, prefix: string): string {
  if (!key.startsWith(prefix)) {
    throw new TypeError(`Invalid store key: ${key}`);
  }
  const digest = key.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError(`Invalid store key: ${key}`);
  }
  return digest;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

let tempCounter = 0;

function atomicCreate(path: string, content: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return false;

  const temp = `${path}.${process.pid}.${tempCounter++}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreCorruptionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreCorruptionError(`${label} must be a non-empty string`);
  }
  return value;
}

function parseArtifact(raw: string, expectedKey: string): StoredArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StoreCorruptionError(
      `Artifact ${expectedKey} contains malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const record = requireRecord(parsed, "artifact");
  if (record.storeSchemaVersion !== STORE_SCHEMA_VERSION) {
    throw new StoreCorruptionError(
      `Artifact ${expectedKey} uses unsupported store schema`,
    );
  }
  if (requireString(record.key, "artifact.key") !== expectedKey) {
    throw new StoreCorruptionError(`Artifact key mismatch for ${expectedKey}`);
  }

  const identityRecord = requireRecord(record.identity, "artifact.identity");
  const extractorRecord = requireRecord(
    identityRecord.extractor,
    "artifact.identity.extractor",
  );
  const parserRecord =
    identityRecord.parser === undefined
      ? undefined
      : requireRecord(identityRecord.parser, "artifact.identity.parser");

  const identity = normalizeArtifactIdentity({
    contentIdentity: requireString(
      identityRecord.contentIdentity,
      "artifact.identity.contentIdentity",
    ),
    artifactKind: requireString(
      identityRecord.artifactKind,
      "artifact.identity.artifactKind",
    ),
    extractor: {
      name: requireString(extractorRecord.name, "artifact.identity.extractor.name"),
      version: requireString(
        extractorRecord.version,
        "artifact.identity.extractor.version",
      ),
    },
    ...(parserRecord === undefined
      ? {}
      : {
          parser: {
            name: requireString(parserRecord.name, "artifact.identity.parser.name"),
            version: requireString(
              parserRecord.version,
              "artifact.identity.parser.version",
            ),
          },
        }),
    schemaVersion: requireString(
      identityRecord.schemaVersion,
      "artifact.identity.schemaVersion",
    ),
  });

  if (artifactKey(identity) !== expectedKey) {
    throw new StoreCorruptionError(
      `Artifact identity does not match key ${expectedKey}`,
    );
  }

  return {
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    key: expectedKey,
    identity,
    payload: toJsonValue(record.payload),
  };
}

function normalizeRefs(values: readonly SnapshotArtifactRef[]): SnapshotArtifactRef[] {
  const byLogicalKey = new Map<string, string>();
  for (const value of values) {
    const logicalKey = nonEmpty(value.logicalKey, "artifact logicalKey");
    keyDigest(value.artifactKey, "artifact-sha256-");
    const existing = byLogicalKey.get(logicalKey);
    if (existing !== undefined && existing !== value.artifactKey) {
      throw new StoreConflictError(
        `Snapshot logical key ${logicalKey} points at multiple artifacts`,
      );
    }
    byLogicalKey.set(logicalKey, value.artifactKey);
  }

  return [...byLogicalKey.entries()]
    .sort(
      ([leftKey, leftArtifact], [rightKey, rightArtifact]) =>
        leftKey.localeCompare(rightKey) ||
        leftArtifact.localeCompare(rightArtifact),
    )
    .map(([logicalKey, artifactKey]) => ({ logicalKey, artifactKey }));
}

function normalizeManifestInput(
  input: SnapshotManifestInput,
): SnapshotManifestInput {
  return {
    repository: nonEmpty(input.repository, "repository"),
    ref: nonEmpty(input.ref, "ref"),
    commit: nonEmpty(input.commit, "commit"),
    graphSchemaVersion: nonEmpty(input.graphSchemaVersion, "graphSchemaVersion"),
    artifacts: normalizeRefs(input.artifacts),
  };
}

function parseManifest(raw: string, expectedKey: string): SnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StoreCorruptionError(
      `Snapshot ${expectedKey} contains malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const record = requireRecord(parsed, "snapshot");
  if (record.snapshotSchemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new StoreCorruptionError(
      `Snapshot ${expectedKey} uses unsupported snapshot schema`,
    );
  }
  if (requireString(record.key, "snapshot.key") !== expectedKey) {
    throw new StoreCorruptionError(`Snapshot key mismatch for ${expectedKey}`);
  }
  if (!Array.isArray(record.artifacts)) {
    throw new StoreCorruptionError("snapshot.artifacts must be an array");
  }

  const input = normalizeManifestInput({
    repository: requireString(record.repository, "snapshot.repository"),
    ref: requireString(record.ref, "snapshot.ref"),
    commit: requireString(record.commit, "snapshot.commit"),
    graphSchemaVersion: requireString(
      record.graphSchemaVersion,
      "snapshot.graphSchemaVersion",
    ),
    artifacts: record.artifacts.map((item, index) => {
      const artifact = requireRecord(item, `snapshot.artifacts[${index}]`);
      return {
        logicalKey: requireString(
          artifact.logicalKey,
          `snapshot.artifacts[${index}].logicalKey`,
        ),
        artifactKey: requireString(
          artifact.artifactKey,
          `snapshot.artifacts[${index}].artifactKey`,
        ),
      };
    }),
  });

  if (snapshotManifestKey(input) !== expectedKey) {
    throw new StoreCorruptionError(
      `Snapshot identity does not match key ${expectedKey}`,
    );
  }

  return {
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    key: expectedKey,
    ...input,
  };
}

export class LocalArtifactStore {
  readonly root: string;

  private readonly stats: StoreStats = {
    artifactHits: 0,
    artifactMisses: 0,
    artifactWrites: 0,
    artifactReuses: 0,
    manifestHits: 0,
    manifestMisses: 0,
    manifestWrites: 0,
    manifestReuses: 0,
  };

  constructor(root: string) {
    this.root = nonEmpty(root, "store root");
  }

  private artifactPath(key: string): string {
    const digest = keyDigest(key, "artifact-sha256-");
    return join(this.root, "artifacts", digest.slice(0, 2), `${digest}.json`);
  }

  private manifestPath(key: string): string {
    const digest = keyDigest(key, "snapshot-sha256-");
    return join(this.root, "manifests", digest.slice(0, 2), `${digest}.json`);
  }

  getStats(): StoreStats {
    return { ...this.stats };
  }

  resetStats(): void {
    for (const key of Object.keys(this.stats) as Array<keyof StoreStats>) {
      this.stats[key] = 0;
    }
  }

  putArtifact(identity: ArtifactIdentity, payload: JsonValue): PutResult {
    const normalizedIdentity = normalizeArtifactIdentity(identity);
    const key = artifactKey(normalizedIdentity);
    const artifact: StoredArtifact = {
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      key,
      identity: normalizedIdentity,
      payload: toJsonValue(payload),
    };
    const encoded = canonicalJsonUnknown(artifact);
    const path = this.artifactPath(key);

    const created = atomicCreate(path, encoded);
    if (created) {
      this.stats.artifactWrites += 1;
      return { key, reused: false };
    }

    const existing = readFileSync(path, "utf8");
    if (existing !== encoded) {
      throw new StoreConflictError(
        `Artifact ${key} already exists with different derived content`,
      );
    }
    this.stats.artifactReuses += 1;
    return { key, reused: true };
  }

  getArtifact(key: string): StoredArtifact | undefined {
    const path = this.artifactPath(key);
    if (!existsSync(path)) {
      this.stats.artifactMisses += 1;
      return undefined;
    }

    const artifact = parseArtifact(readFileSync(path, "utf8"), key);
    this.stats.artifactHits += 1;
    return artifact;
  }

  writeManifest(input: SnapshotManifestInput): PutResult {
    const normalized = normalizeManifestInput(input);
    for (const artifact of normalized.artifacts) {
      if (!existsSync(this.artifactPath(artifact.artifactKey))) {
        throw new StoreConflictError(
          `Snapshot references missing artifact ${artifact.artifactKey}`,
        );
      }
    }

    const key = snapshotManifestKey(normalized);
    const manifest: SnapshotManifest = {
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      key,
      ...normalized,
    };
    const encoded = canonicalJsonUnknown(manifest);
    const path = this.manifestPath(key);

    const created = atomicCreate(path, encoded);
    if (created) {
      this.stats.manifestWrites += 1;
      return { key, reused: false };
    }

    const existing = readFileSync(path, "utf8");
    if (existing !== encoded) {
      throw new StoreConflictError(
        `Snapshot ${key} already exists with different content`,
      );
    }
    this.stats.manifestReuses += 1;
    return { key, reused: true };
  }

  getManifest(
    identity: Pick<SnapshotManifestInput, "repository" | "ref" | "commit">,
  ): SnapshotManifest | undefined {
    const key = snapshotManifestKey(identity);
    const path = this.manifestPath(key);
    if (!existsSync(path)) {
      this.stats.manifestMisses += 1;
      return undefined;
    }

    const manifest = parseManifest(readFileSync(path, "utf8"), key);
    this.stats.manifestHits += 1;
    return manifest;
  }
}
