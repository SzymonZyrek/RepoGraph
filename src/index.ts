export { canonicalJson, canonicalize } from "./canonical.js";
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
