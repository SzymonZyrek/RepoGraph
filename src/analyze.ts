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
import {
  extractTypeScriptJavaScriptDependencies,
  type TsJsExtractionMetrics,
  type TsJsExtractionOptions,
} from "./tsjs.js";

export interface RepositoryAnalysisOptions extends GitIngestionOptions {
  tsjs?: TsJsExtractionOptions;
}

export interface RepositoryAnalysisMetrics {
  tsjs: TsJsExtractionMetrics;
  relationships: RepositoryRelationshipMetrics;
}

export interface RepositoryAnalysisResult {
  graph: GraphDocument;
  repositoryRoot: string;
  repository: string;
  requestedRef: string;
  commit: string;
  tree: string;
  metrics: RepositoryAnalysisMetrics;
}

function graphInputs(graph: GraphDocument): {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  diagnostics: GraphDiagnostic[];
} {
  return {
    nodes: graph.nodes.map((node) => ({
      identity: node.identity,
      ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
      provenance: node.provenance,
    })),
    edges: graph.edges.map((edge) => ({
      identity: edge.identity,
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
      provenance: edge.provenance,
    })),
    diagnostics: graph.diagnostics,
  };
}

function mergeGraphDocuments(...graphs: readonly GraphDocument[]): GraphDocument {
  const nodes: GraphNodeInput[] = [];
  const edges: GraphEdgeInput[] = [];
  const diagnostics = new Map<string, GraphDiagnostic>();

  for (const graph of graphs) {
    const inputs = graphInputs(graph);
    nodes.push(...inputs.nodes);
    edges.push(...inputs.edges);
    for (const item of inputs.diagnostics) {
      diagnostics.set(canonicalJsonUnknown(item), item);
    }
  }

  return buildGraph({
    nodes,
    edges,
    diagnostics: [...diagnostics.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => item),
  });
}

export function analyzeRepository(
  options: RepositoryAnalysisOptions,
): RepositoryAnalysisResult {
  const { tsjs, ...ingestionOptions } = options;
  const ingestion = ingestGitRepository(ingestionOptions);
  const dependencies = extractTypeScriptJavaScriptDependencies(
    ingestion,
    tsjs ?? {},
  );
  const relationships = extractRepositoryRelationships(ingestion);

  return {
    graph: mergeGraphDocuments(
      ingestion.graph,
      dependencies.graph,
      relationships.graph,
    ),
    repositoryRoot: ingestion.repositoryRoot,
    repository: ingestion.repository,
    requestedRef: ingestion.requestedRef,
    commit: ingestion.commit,
    tree: ingestion.tree,
    metrics: {
      tsjs: dependencies.metrics,
      relationships: relationships.metrics,
    },
  };
}
