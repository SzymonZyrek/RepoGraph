export {
  canonicalJson,
  canonicalJsonUnknown,
  canonicalize,
  toJsonValue,
} from "./canonical.js";
export {
  GraphConflictError,
  GraphValidationError,
  buildGraph,
  edgeId,
  graphEquals,
  makeEdge,
  makeNode,
  nodeId,
  parseGraph,
  serializeGraph,
} from "./graph.js";
export {
  GRAPH_SCHEMA_VERSION,
  type EdgeIdentity,
  type EvidenceMethod,
  type EvidenceState,
  type ExtractorRef,
  type FactOrigin,
  type GraphDiagnostic,
  type GraphDocument,
  type GraphEdge,
  type GraphEdgeInput,
  type GraphInput,
  type GraphNode,
  type GraphNodeInput,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type NodeIdentity,
  type Provenance,
} from "./model.js";
export {
  ingestGitRepository,
  type GitIngestionOptions,
  type GitIngestionPolicy,
  type GitIngestionResult,
} from "./git.js";
export {
  matchesAnyRepoGlob,
  matchesRepoGlob,
  normalizeRepoPath,
} from "./glob.js";
export {
  effectivePathRule,
  matchingPathRules,
  normalizePathRules,
  parseCodeownersLike,
  type PathRule,
  type PathRuleInput,
} from "./path-rules.js";
export {
  affectedClosure,
  neighbors,
  reverseNeighbors,
  shortestPath,
  transitiveClosure,
  type CausalPath,
  type NeighborSlice,
  type TraversalDirection,
  type TraversalOptions,
  type TraversalSlice,
} from "./traversal.js";
export { loadGraph, saveGraph } from "./io.js";
export { VERSION } from "./generated-version.js";

export {
  LocalArtifactStore,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_SCHEMA_VERSION,
  StoreConflictError,
  StoreCorruptionError,
  artifactKey,
  snapshotManifestKey,
  type ArtifactIdentity,
  type PutResult,
  type SnapshotArtifactRef,
  type SnapshotManifest,
  type SnapshotManifestInput,
  type StoredArtifact,
  type StoreStats,
} from "./store.js";

export {
  createRepositorySnapshot,
  ensureRepositorySnapshot,
  loadSnapshotGraph,
  repositorySnapshotConfigurationIdentity,
  type RepositorySnapshotOptions,
  type RepositorySnapshotResult,
  type SnapshotAnalysisConfiguration,
} from "./snapshot.js";
export {
  diffGitRepository,
  incrementalRepositoryUpdate,
  planIncrementalUpdate,
  type DiffBaseMode,
  type GitChange,
  type GitChangeKind,
  type GitDiffResult,
  type IncrementalPlanMetrics,
  type IncrementalRepositoryUpdateOptions,
  type IncrementalRepositoryUpdateResult,
  type IncrementalUpdatePlan,
} from "./incremental.js";
