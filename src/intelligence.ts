import { canonicalJsonUnknown } from "./canonical.js";
import { buildGraph } from "./graph.js";
import {
  ingestGitRepository,
  type GitIngestionOptions,
} from "./git.js";
import type {
  GraphDiagnostic,
  GraphDocument,
  GraphEdgeInput,
  GraphNodeInput,
} from "./model.js";
import {
  extractRepositoryRelationships,
  type RepositoryRelationshipMetrics,
} from "./repository-relations.js";
import type { LocalArtifactStore, StoreStats } from "./store.js";
import {
  extractTypeScriptJavaScriptDependencies,
  type TsJsExtractionMetrics,
} from "./tsjs.js";

export interface RepositoryIntelligenceOptions extends GitIngestionOptions {
  store?: LocalArtifactStore;
  tsconfigPath?: string;
}

export interface RepositoryIntelligenceMetrics {
  files: number;
  nodes: number;
  edges: number;
  diagnostics: number;
  tsjs: TsJsExtractionMetrics;
  relationships: RepositoryRelationshipMetrics;
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

function nodeInput(graph: GraphDocument): GraphNodeInput[] {
  return graph.nodes.map((node) => ({
    identity: node.identity,
    ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
    provenance: node.provenance,
  }));
}

function edgeInput(graph: GraphDocument): GraphEdgeInput[] {
  return graph.edges.map((edge) => ({
    identity: edge.identity,
    ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
    provenance: edge.provenance,
  }));
}

function uniqueDiagnostics(graphs: readonly GraphDocument[]): GraphDiagnostic[] {
  const unique = new Map<string, GraphDiagnostic>();
  for (const graph of graphs) {
    for (const diagnostic of graph.diagnostics) {
      unique.set(canonicalJsonUnknown(diagnostic), diagnostic);
    }
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, diagnostic]) => diagnostic);
}

function composeGraphs(graphs: readonly GraphDocument[]): GraphDocument {
  return buildGraph({
    nodes: graphs.flatMap(nodeInput),
    edges: graphs.flatMap(edgeInput),
    diagnostics: uniqueDiagnostics(graphs),
  });
}

/**
 * Build the generic built-in repository-intelligence graph for one exact Git ref.
 *
 * This is intentionally composition, not policy:
 * - Git supplies pinned repository/file facts;
 * - the TS/JS extractor adds deterministic module/symbol dependency evidence;
 * - repository relations add deterministic package/test/contract/build evidence.
 *
 * Consumer overlays and traversal policy remain separate operations.
 */
export function buildRepositoryIntelligence(
  options: RepositoryIntelligenceOptions,
): RepositoryIntelligenceResult {
  const ingestion = ingestGitRepository(options);
  const tsjs = extractTypeScriptJavaScriptDependencies(ingestion, {
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.tsconfigPath === undefined
      ? {}
      : { tsconfigPath: options.tsconfigPath }),
  });
  const relationships = extractRepositoryRelationships(ingestion);
  const graph = composeGraphs([tsjs.graph, relationships.graph]);

  return {
    repositoryRoot: ingestion.repositoryRoot,
    repository: ingestion.repository,
    requestedRef: ingestion.requestedRef,
    commit: ingestion.commit,
    graph,
    metrics: {
      files: ingestion.graph.nodes.filter(
        (node) => node.identity.kind === "file",
      ).length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      diagnostics: graph.diagnostics.length,
      tsjs: tsjs.metrics,
      relationships: relationships.metrics,
    },
    ...(tsjs.cache === undefined ? {} : { cache: tsjs.cache }),
  };
}
