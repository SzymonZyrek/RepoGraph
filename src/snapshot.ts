import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { canonicalJsonUnknown, toJsonValue } from "./canonical.js";
import {
  ingestGitRepository,
  type GitIngestionOptions,
  type GitIngestionResult,
} from "./git.js";
import { parseGraph, serializeGraph } from "./graph.js";
import type {
  ExtractorRef,
  GraphDocument,
  GraphNode,
  JsonValue,
} from "./model.js";
import type {
  LocalArtifactStore,
  SnapshotManifest,
  StoreStats,
} from "./store.js";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface SnapshotAnalysisConfiguration {
  extractor?: ExtractorRef;
  parser?: ExtractorRef;
  chunkVersion?: string;
  schemaVersion?: string;
  extra?: JsonValue;
}

export interface RepositorySnapshotOptions extends GitIngestionOptions {
  analysis?: SnapshotAnalysisConfiguration;
}

export interface RepositorySnapshotResult extends GitIngestionResult {
  manifest: SnapshotManifest;
  manifestKey: string;
  cache: StoreStats;
  reusedSnapshot: boolean;
}

interface ResolvedSnapshotIdentity {
  repositoryRoot: string;
  repository: string;
  requestedRef: string;
  commit: string;
  tree: string;
  configurationIdentity: string;
}

function gitText(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonUnknown(value)).digest("hex");
}

function snapshotConfigurationPayload(
  options: RepositorySnapshotOptions,
): JsonValue {
  return toJsonValue({
    ingestion: {
      discoverCodeowners: options.discoverCodeowners ?? true,
      policy: options.policy ?? {},
      pathRules: options.pathRules ?? [],
    },
    analysis: options.analysis ?? {},
  });
}

export function repositorySnapshotConfigurationIdentity(
  options: RepositorySnapshotOptions,
): string {
  return `snapshot-config-sha256-${sha256(
    snapshotConfigurationPayload(options),
  )}`;
}

function resolveSnapshotIdentity(
  options: RepositorySnapshotOptions,
): ResolvedSnapshotIdentity {
  const repositoryRoot = realpathSync(
    gitText(options.repositoryPath, ["rev-parse", "--show-toplevel"]),
  );
  const requestedRef = options.ref;
  const commit = gitText(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${requestedRef}^{commit}`,
  ]);
  const tree = gitText(repositoryRoot, ["rev-parse", `${commit}^{tree}`]);
  const repository = options.repository ?? `file://${repositoryRoot}`;

  return {
    repositoryRoot,
    repository,
    requestedRef,
    commit,
    tree,
    configurationIdentity: repositorySnapshotConfigurationIdentity(options),
  };
}

function reusableGitObjectPayload(node: GraphNode): JsonValue {
  const target = node.metadata?.target;
  return {
    kind: node.identity.kind,
    ...(typeof target === "string" ? { target } : {}),
  };
}

function graphArtifactIdentity(graph: GraphDocument) {
  return {
    contentIdentity: `graph-sha256-${sha256(serializeGraph(graph))}`,
    artifactKind: "graph-document",
    extractor: { name: "repository-snapshot", version: "1" },
    schemaVersion: graph.schemaVersion,
  };
}

export function loadSnapshotGraph(
  store: LocalArtifactStore,
  manifest: SnapshotManifest,
): GraphDocument {
  const graphRef = manifest.artifacts.find(
    (artifact) => artifact.logicalKey === "$graph",
  );
  if (graphRef === undefined) {
    throw new Error(`Snapshot ${manifest.key} does not reference $graph`);
  }
  const artifact = store.getArtifact(graphRef.artifactKey);
  if (artifact === undefined) {
    throw new Error(
      `Snapshot ${manifest.key} references missing graph artifact ${graphRef.artifactKey}`,
    );
  }
  return parseGraph(canonicalJsonUnknown(artifact.payload));
}

function writeSnapshot(
  store: LocalArtifactStore,
  ingested: GitIngestionResult,
  configurationIdentity: string,
): RepositorySnapshotResult {
  const refs = [];

  for (const node of ingested.graph.nodes) {
    const gitObject = node.metadata?.gitObject;
    if (typeof gitObject !== "string") continue;

    const put = store.putArtifact(
      {
        contentIdentity: `git-object:${gitObject}`,
        artifactKind: `git-object/${node.identity.kind}`,
        extractor: { name: "git-tree", version: "0.0.1" },
        schemaVersion: "repograph.git-object/v1",
      },
      reusableGitObjectPayload(node),
    );

    refs.push({
      logicalKey: `git:${node.identity.kind}:${node.identity.key}`,
      artifactKey: put.key,
    });
  }

  const graphPut = store.putArtifact(
    graphArtifactIdentity(ingested.graph),
    toJsonValue(ingested.graph),
  );
  refs.push({ logicalKey: "$graph", artifactKey: graphPut.key });

  const manifestPut = store.writeManifest({
    repository: ingested.repository,
    ref: ingested.requestedRef,
    commit: ingested.commit,
    configurationIdentity,
    graphSchemaVersion: ingested.graph.schemaVersion,
    artifacts: refs,
  });

  const manifest = store.getManifest({
    repository: ingested.repository,
    ref: ingested.requestedRef,
    commit: ingested.commit,
    configurationIdentity,
  });
  if (manifest === undefined) {
    throw new Error(
      `Snapshot manifest disappeared after write: ${manifestPut.key}`,
    );
  }

  return {
    ...ingested,
    manifest,
    manifestKey: manifestPut.key,
    cache: store.getStats(),
    reusedSnapshot: manifestPut.reused,
  };
}

export function createRepositorySnapshot(
  store: LocalArtifactStore,
  options: RepositorySnapshotOptions,
): RepositorySnapshotResult {
  const configurationIdentity =
    repositorySnapshotConfigurationIdentity(options);
  return writeSnapshot(
    store,
    ingestGitRepository(options),
    configurationIdentity,
  );
}

export function ensureRepositorySnapshot(
  store: LocalArtifactStore,
  options: RepositorySnapshotOptions,
): RepositorySnapshotResult {
  const resolved = resolveSnapshotIdentity(options);
  const existing = store.getManifest({
    repository: resolved.repository,
    ref: resolved.requestedRef,
    commit: resolved.commit,
    configurationIdentity: resolved.configurationIdentity,
  });

  if (existing !== undefined) {
    const graph = loadSnapshotGraph(store, existing);
    return {
      graph,
      repositoryRoot: resolved.repositoryRoot,
      repository: resolved.repository,
      requestedRef: resolved.requestedRef,
      commit: resolved.commit,
      tree: resolved.tree,
      manifest: existing,
      manifestKey: existing.key,
      cache: store.getStats(),
      reusedSnapshot: true,
    };
  }

  return createRepositorySnapshot(store, options);
}
