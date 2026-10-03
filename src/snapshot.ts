import { createHash } from "node:crypto";

import { canonicalJsonUnknown } from "./canonical.js";
import {
  ingestGitRepository,
  type GitIngestionOptions,
  type GitIngestionResult,
} from "./git.js";
import type { GraphNode, JsonObject, JsonValue } from "./model.js";
import {
  createSnapshotManifest,
  type CommitSnapshotManifest,
  type LocalContentStore,
  type StoreStats,
} from "./store.js";

export interface GitSnapshotResult extends GitIngestionResult {
  manifest: CommitSnapshotManifest;
  manifestKey: string;
  cache: StoreStats;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonUnknown(value)).digest("hex");
}

function ingestionConfiguration(options: GitIngestionOptions): JsonValue {
  return {
    discoverCodeowners: options.discoverCodeowners ?? true,
    policy: (options.policy ?? {}) as JsonObject,
    pathRules: (options.pathRules ?? []) as unknown as JsonValue,
  };
}

export function gitSnapshotConfigurationIdentity(
  options: GitIngestionOptions,
): string {
  return `git-ingestion:${sha256(ingestionConfiguration(options))}`;
}

function reusableGitObjectPayload(node: GraphNode): JsonValue {
  const target = node.metadata?.target;
  return {
    kind: node.identity.kind,
    ...(typeof target === "string" ? { target } : {}),
  };
}

export function snapshotGitRepository(
  store: LocalContentStore,
  options: GitIngestionOptions,
): GitSnapshotResult {
  const ingested = ingestGitRepository(options);
  const artifactRefs = [];

  for (const node of ingested.graph.nodes) {
    const gitObject = node.metadata?.gitObject;
    if (typeof gitObject !== "string") continue;

    const artifact = store.getOrCreateArtifact(
      {
        kind: `git-object/${node.identity.kind}`,
        contentIdentity: gitObject,
        extractor: {
          name: "git-tree",
          version: "0.0.1",
        },
        schemaVersion: "repograph.git-object/v1",
      },
      () => reusableGitObjectPayload(node),
    );

    artifactRefs.push({
      path: node.identity.key,
      nodeId: node.id,
      contentIdentity: gitObject,
      artifactKeys: [artifact.key],
    });
  }

  const manifest = createSnapshotManifest({
    repository: ingested.repository,
    requestedRef: ingested.requestedRef,
    commit: ingested.commit,
    tree: ingested.tree,
    configurationIdentity: gitSnapshotConfigurationIdentity(options),
    artifacts: artifactRefs,
  });
  const manifestKey = store.writeManifest(manifest);

  return {
    ...ingested,
    manifest,
    manifestKey,
    cache: { ...store.stats },
  };
}
