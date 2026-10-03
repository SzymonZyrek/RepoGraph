import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { canonicalJsonUnknown } from "./canonical.js";
import {
  SNAPSHOT_SCHEMA_VERSION,
  STORE_SCHEMA_VERSION,
  StoreCorruptionError,
  parseSnapshotManifest,
  parseStoredArtifact,
  type SnapshotManifest,
} from "./store.js";

export interface StoreInventorySection {
  files: number;
  valid: number;
  corrupt: number;
  bytes: number;
}

export interface StoreInventory {
  artifacts: StoreInventorySection & {
    unreferenced: number;
    reclaimableBytes: number;
  };
  manifests: StoreInventorySection & {
    missingArtifactReferences: number;
  };
  totalBytes: number;
}

export interface StoreFileInfo {
  key: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface StoreGarbageCollectionOptions {
  dryRun?: boolean;
  deleteCorrupt?: boolean;
  retainManifest?: (
    manifest: SnapshotManifest,
    file: StoreFileInfo,
  ) => boolean;
}

export interface StoreGarbageCollectionResult {
  deletedArtifacts: string[];
  deletedManifests: string[];
  bytesReclaimed: number;
  dryRun: boolean;
}

export type StoreSchemaMigrationKind = "artifact" | "snapshot";

export interface StoreSchemaMigration {
  kind: StoreSchemaMigrationKind;
  fromVersion: string;
  toVersion: string;
  migrate(record: Record<string, unknown>): Record<string, unknown>;
}

export interface StoreRecoveryOptions {
  corruption?: "error" | "rebuild";
  incompatibleSchema?: "error" | "rebuild";
  migrations?: StoreSchemaMigration[];
}

export interface StoreRecoveryResult {
  migratedArtifacts: string[];
  migratedManifests: string[];
  removedArtifacts: string[];
  removedManifests: string[];
  invalidatedManifests: string[];
  bytesRemoved: number;
}

interface ScannedFile extends StoreFileInfo {
  raw: string;
}

interface ParsedArtifactFile extends ScannedFile {
  valid: boolean;
}

interface ParsedManifestFile extends ScannedFile {
  valid: boolean;
  manifest?: SnapshotManifest;
}

function walkJson(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walkJson(path) : [path];
    })
    .filter((path) => path.endsWith(".json"))
    .sort();
}

function keyFromPath(path: string, prefix: string): string {
  const filename = basename(path).replace(/\.json$/, "");
  if (!/^[a-f0-9]{64}$/.test(filename)) {
    throw new StoreCorruptionError(`Invalid store filename: ${path}`);
  }
  return `${prefix}${filename}`;
}

function scanFiles(root: string, kind: "artifacts" | "manifests"): ScannedFile[] {
  const prefix =
    kind === "artifacts" ? "artifact-sha256-" : "snapshot-sha256-";
  return walkJson(join(root, kind)).map((path) => {
    const stats = statSync(path);
    return {
      key: keyFromPath(path, prefix),
      path,
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
      raw: readFileSync(path, "utf8"),
    };
  });
}

function parseArtifacts(files: readonly ScannedFile[]): ParsedArtifactFile[] {
  return files.map((file) => {
    try {
      parseStoredArtifact(file.raw, file.key);
      return { ...file, valid: true };
    } catch {
      return { ...file, valid: false };
    }
  });
}

function parseManifests(files: readonly ScannedFile[]): ParsedManifestFile[] {
  return files.map((file) => {
    try {
      return {
        ...file,
        valid: true,
        manifest: parseSnapshotManifest(file.raw, file.key),
      };
    } catch {
      return { ...file, valid: false };
    }
  });
}

export function inspectArtifactStore(root: string): StoreInventory {
  const artifactFiles = parseArtifacts(scanFiles(root, "artifacts"));
  const manifestFiles = parseManifests(scanFiles(root, "manifests"));
  const validArtifacts = new Map(
    artifactFiles
      .filter((file) => file.valid)
      .map((file) => [file.key, file]),
  );

  const referenced = new Set<string>();
  let missingArtifactReferences = 0;
  for (const file of manifestFiles) {
    if (!file.valid || file.manifest === undefined) continue;
    for (const reference of file.manifest.artifacts) {
      referenced.add(reference.artifactKey);
      if (!validArtifacts.has(reference.artifactKey)) {
        missingArtifactReferences += 1;
      }
    }
  }

  const unreferenced = artifactFiles.filter(
    (file) => file.valid && !referenced.has(file.key),
  );

  const artifactBytes = artifactFiles.reduce(
    (total, file) => total + file.bytes,
    0,
  );
  const manifestBytes = manifestFiles.reduce(
    (total, file) => total + file.bytes,
    0,
  );

  return {
    artifacts: {
      files: artifactFiles.length,
      valid: artifactFiles.filter((file) => file.valid).length,
      corrupt: artifactFiles.filter((file) => !file.valid).length,
      bytes: artifactBytes,
      unreferenced: unreferenced.length,
      reclaimableBytes: unreferenced.reduce(
        (total, file) => total + file.bytes,
        0,
      ),
    },
    manifests: {
      files: manifestFiles.length,
      valid: manifestFiles.filter((file) => file.valid).length,
      corrupt: manifestFiles.filter((file) => !file.valid).length,
      bytes: manifestBytes,
      missingArtifactReferences,
    },
    totalBytes: artifactBytes + manifestBytes,
  };
}

function maybeRemove(path: string, dryRun: boolean): void {
  if (!dryRun) rmSync(path, { force: true });
}

export function collectArtifactStoreGarbage(
  root: string,
  options: StoreGarbageCollectionOptions = {},
): StoreGarbageCollectionResult {
  const dryRun = options.dryRun ?? false;
  const deleteCorrupt = options.deleteCorrupt ?? false;
  const artifacts = parseArtifacts(scanFiles(root, "artifacts"));
  const manifests = parseManifests(scanFiles(root, "manifests"));
  const retainedArtifactKeys = new Set<string>();
  const deletedArtifacts: string[] = [];
  const deletedManifests: string[] = [];
  let bytesReclaimed = 0;

  for (const file of manifests) {
    if (!file.valid || file.manifest === undefined) {
      if (deleteCorrupt) {
        deletedManifests.push(file.key);
        bytesReclaimed += file.bytes;
        maybeRemove(file.path, dryRun);
      }
      continue;
    }

    const retain = options.retainManifest?.(file.manifest, file) ?? true;
    if (!retain) {
      deletedManifests.push(file.key);
      bytesReclaimed += file.bytes;
      maybeRemove(file.path, dryRun);
      continue;
    }

    for (const reference of file.manifest.artifacts) {
      retainedArtifactKeys.add(reference.artifactKey);
    }
  }

  for (const file of artifacts) {
    if (!file.valid) {
      if (deleteCorrupt) {
        deletedArtifacts.push(file.key);
        bytesReclaimed += file.bytes;
        maybeRemove(file.path, dryRun);
      }
      continue;
    }
    if (retainedArtifactKeys.has(file.key)) continue;

    deletedArtifacts.push(file.key);
    bytesReclaimed += file.bytes;
    maybeRemove(file.path, dryRun);
  }

  return {
    deletedArtifacts: deletedArtifacts.sort(),
    deletedManifests: deletedManifests.sort(),
    bytesReclaimed,
    dryRun,
  };
}

function parseRawRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function schemaVersion(
  record: Record<string, unknown> | undefined,
  kind: StoreSchemaMigrationKind,
): string | undefined {
  const field =
    kind === "artifact" ? "storeSchemaVersion" : "snapshotSchemaVersion";
  return typeof record?.[field] === "string"
    ? (record[field] as string)
    : undefined;
}

function findMigration(
  migrations: readonly StoreSchemaMigration[],
  kind: StoreSchemaMigrationKind,
  version: string | undefined,
): StoreSchemaMigration | undefined {
  if (version === undefined) return undefined;
  return migrations.find(
    (migration) =>
      migration.kind === kind &&
      migration.fromVersion === version &&
      migration.toVersion ===
        (kind === "artifact"
          ? STORE_SCHEMA_VERSION
          : SNAPSHOT_SCHEMA_VERSION),
  );
}

function recoverFile(
  file: ScannedFile,
  kind: StoreSchemaMigrationKind,
  options: Required<
    Pick<StoreRecoveryOptions, "corruption" | "incompatibleSchema">
  > & {
    migrations: readonly StoreSchemaMigration[];
  },
): { action: "valid" | "migrated" | "removed"; bytesRemoved: number } {
  const validate = (raw: string): void => {
    if (kind === "artifact") parseStoredArtifact(raw, file.key);
    else parseSnapshotManifest(raw, file.key);
  };

  try {
    validate(file.raw);
    return { action: "valid", bytesRemoved: 0 };
  } catch (error) {
    const record = parseRawRecord(file.raw);
    const version = schemaVersion(record, kind);
    const currentVersion =
      kind === "artifact" ? STORE_SCHEMA_VERSION : SNAPSHOT_SCHEMA_VERSION;
    const incompatible =
      version !== undefined && version !== currentVersion;
    const migration = findMigration(options.migrations, kind, version);

    if (migration !== undefined && record !== undefined) {
      const migrated = migration.migrate(record);
      const encoded = canonicalJsonUnknown(migrated);
      validate(encoded);
      writeFileSync(file.path, encoded, "utf8");
      return { action: "migrated", bytesRemoved: 0 };
    }

    const policy = incompatible
      ? options.incompatibleSchema
      : options.corruption;
    if (policy === "error") throw error;

    rmSync(file.path, { force: true });
    return { action: "removed", bytesRemoved: file.bytes };
  }
}

export function recoverArtifactStore(
  root: string,
  options: StoreRecoveryOptions = {},
): StoreRecoveryResult {
  const normalized = {
    corruption: options.corruption ?? "rebuild",
    incompatibleSchema: options.incompatibleSchema ?? "rebuild",
    migrations: options.migrations ?? [],
  } as const;

  const migratedArtifacts: string[] = [];
  const migratedManifests: string[] = [];
  const removedArtifacts: string[] = [];
  const removedManifests: string[] = [];
  const invalidatedManifests: string[] = [];
  let bytesRemoved = 0;

  for (const file of scanFiles(root, "artifacts")) {
    const result = recoverFile(file, "artifact", normalized);
    if (result.action === "migrated") migratedArtifacts.push(file.key);
    if (result.action === "removed") removedArtifacts.push(file.key);
    bytesRemoved += result.bytesRemoved;
  }

  for (const file of scanFiles(root, "manifests")) {
    const result = recoverFile(file, "snapshot", normalized);
    if (result.action === "migrated") migratedManifests.push(file.key);
    if (result.action === "removed") removedManifests.push(file.key);
    bytesRemoved += result.bytesRemoved;
  }

  const validArtifacts = new Set(
    parseArtifacts(scanFiles(root, "artifacts"))
      .filter((file) => file.valid)
      .map((file) => file.key),
  );

  for (const file of parseManifests(scanFiles(root, "manifests"))) {
    if (!file.valid || file.manifest === undefined) continue;
    if (
      file.manifest.artifacts.every((reference) =>
        validArtifacts.has(reference.artifactKey),
      )
    ) {
      continue;
    }

    if (normalized.corruption === "error") {
      throw new StoreCorruptionError(
        `Snapshot ${file.key} references a missing or corrupt artifact`,
      );
    }

    invalidatedManifests.push(file.key);
    bytesRemoved += file.bytes;
    rmSync(file.path, { force: true });
  }

  return {
    migratedArtifacts: migratedArtifacts.sort(),
    migratedManifests: migratedManifests.sort(),
    removedArtifacts: removedArtifacts.sort(),
    removedManifests: removedManifests.sort(),
    invalidatedManifests: invalidatedManifests.sort(),
    bytesRemoved,
  };
}
