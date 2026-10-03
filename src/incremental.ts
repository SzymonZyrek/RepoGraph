import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { affectedClosure } from "./traversal.js";
import type { GraphDocument, GraphEdge, GraphNode } from "./model.js";
import {
  ensureRepositorySnapshot,
  type RepositorySnapshotOptions,
  type SnapshotAnalysisConfiguration,
} from "./snapshot.js";
import type { LocalArtifactStore, StoreStats } from "./store.js";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed";
export type DiffBaseMode = "direct" | "merge-base";

export interface GitChange {
  kind: GitChangeKind;
  path: string;
  oldPath?: string;
  similarity?: number;
  beforeObject?: string;
  afterObject?: string;
  contentChanged: boolean;
}

export interface GitDiffResult {
  repositoryRoot: string;
  requestedBaseRef: string;
  requestedTargetRef: string;
  baseCommit: string;
  targetCommit: string;
  baseMode: DiffBaseMode;
  changes: GitChange[];
}

export interface IncrementalPlanMetrics {
  changes: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  renameOnly: number;
  touchedNodes: number;
  reusedNodes: number;
  touchedEdges: number;
  reusedEdges: number;
  invalidatedNodes: number;
  artifactWrites: number;
  artifactReuses: number;
}

export interface IncrementalUpdatePlan {
  baseCommit: string;
  targetCommit: string;
  globalInvalidation: boolean;
  globalInvalidationReasons: string[];
  changes: GitChange[];
  changedNodeIds: string[];
  invalidatedNodeIds: string[];
  touchedEdgeIds: string[];
  metrics: IncrementalPlanMetrics;
}

export interface IncrementalRepositoryUpdateOptions
  extends Omit<RepositorySnapshotOptions, "ref" | "analysis"> {
  baseRef: string;
  targetRef: string;
  baseMode?: DiffBaseMode;
  analysis?: SnapshotAnalysisConfiguration;
  previousAnalysis?: SnapshotAnalysisConfiguration;
  invalidationEdgeKinds?: string[];
}

export interface IncrementalRepositoryUpdateResult {
  plan: IncrementalUpdatePlan;
  baseSnapshotKey: string;
  targetSnapshotKey: string;
  targetGraph: GraphDocument;
  cache: StoreStats;
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

function gitRaw(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function resolveCommit(cwd: string, ref: string): string {
  return gitText(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function objectAt(cwd: string, commit: string, path: string): string {
  return gitText(cwd, ["rev-parse", "--verify", `${commit}:${path}`]);
}

function parseDiff(
  cwd: string,
  raw: string,
  baseCommit: string,
  targetCommit: string,
): GitChange[] {
  if (raw.length === 0) return [];
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();

  const changes: GitChange[] = [];
  let index = 0;

  while (index < fields.length) {
    const status = fields[index++];
    if (status === undefined || status.length === 0) {
      throw new Error("Malformed git diff status");
    }

    if (status.startsWith("R")) {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (oldPath === undefined || path === undefined) {
        throw new Error(`Malformed rename record: ${status}`);
      }
      const similarityText = status.slice(1);
      const similarity =
        similarityText.length === 0 ? undefined : Number(similarityText);
      const beforeObject = objectAt(cwd, baseCommit, oldPath);
      const afterObject = objectAt(cwd, targetCommit, path);
      changes.push({
        kind: "renamed",
        oldPath,
        path,
        ...(similarity === undefined || !Number.isFinite(similarity)
          ? {}
          : { similarity }),
        beforeObject,
        afterObject,
        contentChanged: beforeObject !== afterObject,
      });
      continue;
    }

    const path = fields[index++];
    if (path === undefined) {
      throw new Error(`Malformed diff record: ${status}`);
    }

    const code = status[0];
    if (code === "A") {
      const afterObject = objectAt(cwd, targetCommit, path);
      changes.push({
        kind: "added",
        path,
        afterObject,
        contentChanged: true,
      });
    } else if (code === "D") {
      const beforeObject = objectAt(cwd, baseCommit, path);
      changes.push({
        kind: "deleted",
        path,
        beforeObject,
        contentChanged: true,
      });
    } else if (code === "M" || code === "T") {
      const beforeObject = objectAt(cwd, baseCommit, path);
      const afterObject = objectAt(cwd, targetCommit, path);
      changes.push({
        kind: "modified",
        path,
        beforeObject,
        afterObject,
        contentChanged: beforeObject !== afterObject,
      });
    } else {
      throw new Error(`Unsupported git diff status: ${status}`);
    }
  }

  return changes.sort((left, right) => {
    const leftKey = `${left.oldPath ?? ""}\0${left.path}`;
    const rightKey = `${right.oldPath ?? ""}\0${right.path}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function diffGitRepository(input: {
  repositoryPath: string;
  baseRef: string;
  targetRef: string;
  baseMode?: DiffBaseMode;
}): GitDiffResult {
  const repositoryRoot = realpathSync(
    gitText(input.repositoryPath, ["rev-parse", "--show-toplevel"]),
  );
  const requestedBaseRef = input.baseRef;
  const requestedTargetRef = input.targetRef;
  const requestedBaseCommit = resolveCommit(repositoryRoot, requestedBaseRef);
  const targetCommit = resolveCommit(repositoryRoot, requestedTargetRef);
  const baseMode = input.baseMode ?? "direct";
  const baseCommit =
    baseMode === "merge-base"
      ? gitText(repositoryRoot, [
          "merge-base",
          requestedBaseCommit,
          targetCommit,
        ])
      : requestedBaseCommit;

  const raw = gitRaw(repositoryRoot, [
    "diff",
    "--name-status",
    "-z",
    "-M",
    baseCommit,
    targetCommit,
    "--",
  ]);

  return {
    repositoryRoot,
    requestedBaseRef,
    requestedTargetRef,
    baseCommit,
    targetCommit,
    baseMode,
    changes: parseDiff(repositoryRoot, raw, baseCommit, targetCommit),
  };
}

function pathNode(graph: GraphDocument, path: string): GraphNode | undefined {
  return graph.nodes.find(
    (node) =>
      node.identity.key === path &&
      (node.identity.kind === "file" ||
        node.identity.kind === "symlink" ||
        node.identity.kind === "submodule"),
  );
}

function edgeIds(graph: GraphDocument): Set<string> {
  return new Set(graph.edges.map((edge) => edge.id));
}

function outgoingEdges(
  graph: GraphDocument,
  nodeIds: ReadonlySet<string>,
): GraphEdge[] {
  return graph.edges.filter((edge) => nodeIds.has(edge.identity.from));
}

function configurationReasons(
  baseGraph: GraphDocument,
  targetGraph: GraphDocument,
  previous: SnapshotAnalysisConfiguration | undefined,
  current: SnapshotAnalysisConfiguration | undefined,
): string[] {
  const reasons: string[] = [];
  if (baseGraph.schemaVersion !== targetGraph.schemaVersion) {
    reasons.push("graph-schema");
  }
  if (previous?.schemaVersion !== current?.schemaVersion) {
    reasons.push("analysis-schema");
  }
  if (
    previous?.extractor?.name !== current?.extractor?.name ||
    previous?.extractor?.version !== current?.extractor?.version
  ) {
    reasons.push("extractor");
  }
  if (
    previous?.parser?.name !== current?.parser?.name ||
    previous?.parser?.version !== current?.parser?.version
  ) {
    reasons.push("parser");
  }
  if (previous?.chunkVersion !== current?.chunkVersion) {
    reasons.push("chunk");
  }
  return reasons;
}

const NON_DEPENDENCY_EDGE_KINDS = new Set([
  "contains",
  "path-rule-match",
]);

function defaultInvalidationEdgeKinds(graph: GraphDocument): string[] {
  return [
    ...new Set(
      graph.edges
        .map((edge) => edge.identity.kind)
        .filter((kind) => !NON_DEPENDENCY_EDGE_KINDS.has(kind)),
    ),
  ].sort();
}

function reverseInvalidation(
  graph: GraphDocument,
  seeds: ReadonlySet<string>,
  edgeKinds?: readonly string[],
): Set<string> {
  const result = new Set<string>();
  const traversalEdgeKinds =
    edgeKinds ?? defaultInvalidationEdgeKinds(graph);

  for (const seed of seeds) {
    if (!graph.nodes.some((node) => node.id === seed)) continue;
    result.add(seed);

    // Traversal treats an empty edge-kind list as "all kinds", which is useful
    // for generic graph queries but wrong for dependency invalidation. If this
    // graph has no dependency-like edges, the changed seed is the whole slice.
    if (traversalEdgeKinds.length === 0) continue;

    const closure = affectedClosure(graph, seed, {
      edgeKinds: traversalEdgeKinds,
    });
    for (const node of closure.nodes) result.add(node.id);
  }
  return result;
}

export function planIncrementalUpdate(input: {
  baseGraph: GraphDocument;
  targetGraph: GraphDocument;
  diff: GitDiffResult;
  cache?: StoreStats;
  previousAnalysis?: SnapshotAnalysisConfiguration;
  analysis?: SnapshotAnalysisConfiguration;
  invalidationEdgeKinds?: readonly string[];
}): IncrementalUpdatePlan {
  const baseChanged = new Set<string>();
  const targetChanged = new Set<string>();

  for (const change of input.diff.changes) {
    if (change.oldPath !== undefined) {
      const oldNode = pathNode(input.baseGraph, change.oldPath);
      if (oldNode !== undefined) baseChanged.add(oldNode.id);
    } else if (change.kind === "deleted" || change.kind === "modified") {
      const oldNode = pathNode(input.baseGraph, change.path);
      if (oldNode !== undefined) baseChanged.add(oldNode.id);
    }

    if (change.kind !== "deleted") {
      const newNode = pathNode(input.targetGraph, change.path);
      if (newNode !== undefined) targetChanged.add(newNode.id);
    }
  }

  const globalInvalidationReasons = configurationReasons(
    input.baseGraph,
    input.targetGraph,
    input.previousAnalysis,
    input.analysis,
  );
  const globalInvalidation = globalInvalidationReasons.length > 0;

  const baseEdges = edgeIds(input.baseGraph);
  const targetEdges = edgeIds(input.targetGraph);
  const touchedEdgeIds = new Set<string>();

  if (globalInvalidation) {
    for (const edge of input.baseGraph.edges) touchedEdgeIds.add(edge.id);
    for (const edge of input.targetGraph.edges) touchedEdgeIds.add(edge.id);
  } else {
    for (const edge of outgoingEdges(input.baseGraph, baseChanged)) {
      touchedEdgeIds.add(edge.id);
    }
    for (const edge of outgoingEdges(input.targetGraph, targetChanged)) {
      touchedEdgeIds.add(edge.id);
    }
    for (const id of baseEdges) {
      if (!targetEdges.has(id)) touchedEdgeIds.add(id);
    }
    for (const id of targetEdges) {
      if (!baseEdges.has(id)) touchedEdgeIds.add(id);
    }
  }

  const invalidated = globalInvalidation
    ? new Set(input.targetGraph.nodes.map((node) => node.id))
    : new Set([
        ...reverseInvalidation(
          input.baseGraph,
          baseChanged,
          input.invalidationEdgeKinds,
        ),
        ...reverseInvalidation(
          input.targetGraph,
          targetChanged,
          input.invalidationEdgeKinds,
        ),
      ]);

  const changedNodeIds = new Set([...baseChanged, ...targetChanged]);
  const baseNodeIds = new Set(input.baseGraph.nodes.map((node) => node.id));
  const reusedNodes = input.targetGraph.nodes.filter((node) =>
    baseNodeIds.has(node.id),
  ).length;
  const reusedEdges = input.targetGraph.edges.filter((edge) =>
    baseEdges.has(edge.id),
  ).length;

  const count = (kind: GitChangeKind): number =>
    input.diff.changes.filter((change) => change.kind === kind).length;

  return {
    baseCommit: input.diff.baseCommit,
    targetCommit: input.diff.targetCommit,
    globalInvalidation,
    globalInvalidationReasons,
    changes: input.diff.changes,
    changedNodeIds: [...changedNodeIds].sort(),
    invalidatedNodeIds: [...invalidated].sort(),
    touchedEdgeIds: [...touchedEdgeIds].sort(),
    metrics: {
      changes: input.diff.changes.length,
      added: count("added"),
      modified: count("modified"),
      deleted: count("deleted"),
      renamed: count("renamed"),
      renameOnly: input.diff.changes.filter(
        (change) => change.kind === "renamed" && !change.contentChanged,
      ).length,
      touchedNodes: changedNodeIds.size,
      reusedNodes,
      touchedEdges: touchedEdgeIds.size,
      reusedEdges,
      invalidatedNodes: invalidated.size,
      artifactWrites: input.cache?.artifactWrites ?? 0,
      artifactReuses: input.cache?.artifactReuses ?? 0,
    },
  };
}

export function incrementalRepositoryUpdate(
  store: LocalArtifactStore,
  options: IncrementalRepositoryUpdateOptions,
): IncrementalRepositoryUpdateResult {
  const diff = diffGitRepository({
    repositoryPath: options.repositoryPath,
    baseRef: options.baseRef,
    targetRef: options.targetRef,
    ...(options.baseMode === undefined ? {} : { baseMode: options.baseMode }),
  });

  const common = {
    repositoryPath: options.repositoryPath,
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.pathRules === undefined ? {} : { pathRules: options.pathRules }),
    ...(options.discoverCodeowners === undefined
      ? {}
      : { discoverCodeowners: options.discoverCodeowners }),
  };

  const baseSnapshot = ensureRepositorySnapshot(store, {
    ...common,
    ref: diff.baseCommit,
    ...(options.previousAnalysis === undefined
      ? options.analysis === undefined
        ? {}
        : { analysis: options.analysis }
      : { analysis: options.previousAnalysis }),
  });

  store.resetStats();

  const targetSnapshot = ensureRepositorySnapshot(store, {
    ...common,
    ref: diff.targetCommit,
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
  });
  const cache = store.getStats();

  const plan = planIncrementalUpdate({
    baseGraph: baseSnapshot.graph,
    targetGraph: targetSnapshot.graph,
    diff,
    cache,
    ...(options.previousAnalysis === undefined
      ? {}
      : { previousAnalysis: options.previousAnalysis }),
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
    ...(options.invalidationEdgeKinds === undefined
      ? {}
      : { invalidationEdgeKinds: options.invalidationEdgeKinds }),
  });

  return {
    plan,
    baseSnapshotKey: baseSnapshot.manifestKey,
    targetSnapshotKey: targetSnapshot.manifestKey,
    targetGraph: targetSnapshot.graph,
    cache,
  };
}
