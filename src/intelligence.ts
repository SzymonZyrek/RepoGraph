import { buildIncrementalIntelligence } from "./intelligence-cache.js";
import type { GitIngestionOptions } from "./git.js";
import type { GraphDocument } from "./model.js";
import type { RepositoryRelationshipMetrics } from "./repository-relations.js";
import type { LocalArtifactStore, StoreStats } from "./store.js";
import type { TsJsExtractionMetrics } from "./tsjs.js";

export interface RepositoryIntelligenceOptions extends GitIngestionOptions {
  store?: LocalArtifactStore;
  tsconfigPath?: string;
}

export interface RepositoryIntelligenceCompositionMetrics {
  baseNodes: number;
  baseEdges: number;
  relationshipOnlyNodes: number;
  relationshipOnlyEdges: number;
  skippedDuplicateRelationshipNodes: number;
  skippedDuplicateRelationshipEdges: number;
}

export interface RepositoryIntelligenceMetrics {
  files: number;
  nodes: number;
  edges: number;
  diagnostics: number;
  tsjs: TsJsExtractionMetrics;
  relationships: RepositoryRelationshipMetrics;
  composition: RepositoryIntelligenceCompositionMetrics & {
    mode: "cold" | "incremental" | "exact";
    baseCommit?: string;
    invalidationReasons: string[];
    changedPaths: string[];
    inspectedPaths: number;
    inspectedBlobs: number;
    resolvedSourceFragments: number;
    recomposedRelationshipFragments: number;
    reusedFragments: number;
    encodedFragments: number;
    writtenFragmentPacks: number;
    reusedFragmentPacks: number;
    materializedNodes: number;
    materializedEdges: number;
  };
  timings: {
    gitChangeDiscoveryMs: number;
    extractionResolutionMs: number;
    relationshipMaintenanceMs: number;
    cacheIoMs: number;
    graphMaterializationMs: number;
    totalMs: number;
  };
}

export interface RepositoryIntelligenceResult {
  repositoryRoot: string;
  repository: string;
  requestedRef: string;
  commit: string;
  graph: GraphDocument;
  metrics: RepositoryIntelligenceMetrics;
  cache?: StoreStats;
}

/** Build a deterministic full graph while reusing first-parent composed facts. */
export function buildRepositoryIntelligence(
  options: RepositoryIntelligenceOptions,
): RepositoryIntelligenceResult {
  return buildIncrementalIntelligence(options);
}
