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
  type FactAuthority,
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
  type OverlayRef,
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

export {
  TSJS_EXTRACTOR,
  TSJS_SYNTAX_SCHEMA_VERSION,
  extractTypeScriptJavaScriptDependencies,
  type TsJsExtractionMetrics,
  type TsJsExtractionOptions,
  type TsJsExtractionResult,
} from "./tsjs.js";

export {
  applyOverlay,
  matchGraphNodesByPath,
  overlayProvenance,
  type OverlayApplyResult,
  type OverlayDefinition,
  type OverlayEdgeInput,
  type OverlayNodeInput,
  type OverlayPathEdgeInput,
} from "./overlay.js";

export {
  TRAVERSAL_POLICY_SCHEMA_VERSION,
  createTraversalPolicy,
  explainWithPolicy,
  parseTraversalPolicy,
  serializeTraversalPolicy,
  traverseWithPolicy,
  validateTraversalPolicy,
  type PolicyCausalHop,
  type PolicyCausalPath,
  type PolicyTraversalSlice,
  type TraversalPolicy,
  type TraversalPolicyInput,
  type TraversalReason,
} from "./policy.js";

export {
  REPOSITORY_PACKAGE_SCHEMA_VERSION,
  REPOSITORY_RELATIONSHIP_EXTRACTOR,
  extractRepositoryRelationships,
  type RepositoryRelationshipExtractionOptions,
  type RepositoryRelationshipExtractionResult,
  type RepositoryRelationshipMetrics,
} from "./repository-relations.js";

export {
  EXTRACTOR_PROTOCOL_VERSION,
  applyExtractorOutput,
  createExternalProcessExtractor,
  extractorArtifactIdentity,
  normalizeExtractorDescriptor,
  runExtractors,
  type ExternalProcessExtractorOptions,
  type ExtractorCapabilities,
  type ExtractorDescriptor,
  type ExtractorExecutionBoundary,
  type ExtractorOutput,
  type ExtractorPlugin,
  type ExtractorRequest,
} from "./extractor.js";

export {
  CROSS_REPOSITORY_COORDINATE_NAMESPACE,
  CROSS_REPOSITORY_MAPPING_VERSION,
  composeCrossRepositoryGraph,
  coordinateIdentity,
  crossRepositoryAffected,
  type CrossRepositoryCompositionMetrics,
  type CrossRepositoryCompositionOptions,
  type CrossRepositoryCompositionResult,
  type CrossRepositoryCoordinate,
  type CrossRepositoryDependencyMapping,
  type CrossRepositoryNodeLocator,
  type CrossRepositorySlice,
  type CrossRepositoryTraversalOptions,
  type RepositoryGraphSnapshot,
} from "./cross-repo.js";

export {
  collectArtifactStoreGarbage,
  inspectArtifactStore,
  recoverArtifactStore,
  type StoreFileInfo,
  type StoreGarbageCollectionOptions,
  type StoreGarbageCollectionResult,
  type StoreInventory,
  type StoreInventorySection,
  type StoreRecoveryOptions,
  type StoreRecoveryResult,
  type StoreSchemaMigration,
  type StoreSchemaMigrationKind,
} from "./store-lifecycle.js";

export {
  REPOGRAPH_PROTOCOL_DEFAULT_MAX_DEPTH,
  REPOGRAPH_PROTOCOL_DEFAULT_MAX_NODES,
  REPOGRAPH_PROTOCOL_MAX_DEPTH,
  REPOGRAPH_PROTOCOL_MAX_NODES,
  REPOGRAPH_PROTOCOL_VERSION,
  executeProtocolRequest,
  negotiateProtocol,
  parseProtocolRequest,
  protocolInfo,
  serializeProtocolResponse,
  type ProtocolData,
  type ProtocolEdgeDto,
  type ProtocolExplainRequest,
  type ProtocolExplanationDto,
  type ProtocolExplanationHopDto,
  type ProtocolFailure,
  type ProtocolFeature,
  type ProtocolFeatureStatus,
  type ProtocolInfo,
  type ProtocolInfoDto,
  type ProtocolInfoRequest,
  type ProtocolNodeDto,
  type ProtocolProvenanceDto,
  type ProtocolRequest,
  type ProtocolResponse,
  type ProtocolSliceDto,
  type ProtocolSliceRequest,
  type ProtocolSuccess,
  type ProtocolUnavailable,
} from "./protocol.js";

export {
  GRAPH_VIEW_SCHEMA_VERSION,
  GraphViewController,
  createGraphViewModel,
  renderGraphViewSvg,
  type GraphViewBounds,
  type GraphViewEdge,
  type GraphViewEvidence,
  type GraphViewInput,
  type GraphViewModel,
  type GraphViewNode,
  type GraphViewOptions,
  type GraphViewSnapshot,
  type GraphViewViewport,
  type RenderGraphViewOptions,
} from "./view.js";

export {
  buildRepositoryIntelligence,
  type RepositoryIntelligenceMetrics,
  type RepositoryIntelligenceOptions,
  type RepositoryIntelligenceResult,
} from "./intelligence.js";
