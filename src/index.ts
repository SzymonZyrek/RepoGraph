export { VERSION } from './version.js';
export { RepoGraphError } from './error.js';
export { buildGraph, type BuildOptions } from './build.js';
export { GraphBuilder, LoadedGraph, loadGraph, serializeGraph, canonicalJSON, nodeId, edgeId,
  type GraphDocument, type GraphNode, type GraphEdge, type Provenance, type JsonValue, type RulesDocument } from './model.js';
export { parseRules } from './rules.js';
export { neighbors, reverseNeighbors, affected, explainPath, resolveNode, type QueryOptions, type Neighbor } from './query.js';
