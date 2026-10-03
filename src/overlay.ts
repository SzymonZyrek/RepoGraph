import { canonicalJsonUnknown } from "./canonical.js";
import { buildGraph, edgeId, nodeId } from "./graph.js";
import { matchesRepoGlob } from "./glob.js";
import type {
  FactAuthority,
  GraphDiagnostic,
  GraphDocument,
  GraphEdge,
  GraphEdgeInput,
  GraphNode,
  GraphNodeInput,
  JsonObject,
  NodeIdentity,
  OverlayRef,
  Provenance,
} from "./model.js";

export interface OverlayNodeInput {
  identity: NodeIdentity;
  metadata?: JsonObject;
}

export interface OverlayEdgeInput {
  identity: {
    kind: string;
    from: string;
    to: string;
    key?: string;
  };
  metadata?: JsonObject;
}

export interface OverlayPathEdgeInput {
  anchor: NodeIdentity;
  pattern: string;
  edgeKind: string;
  direction?: "out" | "in";
  nodeKinds?: readonly string[];
  keyPrefix?: string;
  metadata?: JsonObject;
}

export interface OverlayDefinition {
  identity: OverlayRef;
  authority: FactAuthority;
  repository: string;
  ref: string;
  commit?: string;
  nodes?: readonly OverlayNodeInput[];
  edges?: readonly OverlayEdgeInput[];
  pathEdges?: readonly OverlayPathEdgeInput[];
}

export interface OverlayApplyResult {
  graph: GraphDocument;
  addedNodes: number;
  addedEdges: number;
  diagnosticsAdded: number;
}

function metadataKey(metadata: JsonObject | undefined): string {
  return canonicalJsonUnknown(metadata ?? null);
}

function nodeInput(node: GraphNode): GraphNodeInput {
  return {
    identity: node.identity,
    ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
    provenance: node.provenance,
  };
}

function edgeInput(edge: GraphEdge): GraphEdgeInput {
  return {
    identity: edge.identity,
    ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
    provenance: edge.provenance,
  };
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function overlayProvenance(
  overlay: OverlayDefinition,
  diagnostic?: string,
): Provenance {
  nonEmpty(overlay.identity.name, "overlay name");
  nonEmpty(overlay.identity.version, "overlay version");
  nonEmpty(overlay.repository, "overlay repository");
  nonEmpty(overlay.ref, "overlay ref");

  return {
    repository: overlay.repository,
    ref: overlay.ref,
    ...(overlay.commit === undefined ? {} : { commit: overlay.commit }),
    origin: "overlay",
    method: "explicit-overlay",
    state: diagnostic === undefined ? "complete" : "partial",
    authority: overlay.authority,
    overlay: { ...overlay.identity },
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function diagnostic(
  overlay: OverlayDefinition,
  code: string,
  message: string,
  state: "partial" | "unresolved" = "partial",
): GraphDiagnostic {
  const provenance = overlayProvenance(overlay, message);
  return {
    code,
    message,
    state,
    provenance: { ...provenance, state },
  };
}

export function matchGraphNodesByPath(
  graph: GraphDocument,
  pattern: string,
  nodeKinds: readonly string[] = ["file"],
): GraphNode[] {
  nonEmpty(pattern, "overlay path pattern");
  const allowed = new Set(nodeKinds);
  return graph.nodes
    .filter(
      (node) =>
        (allowed.size === 0 || allowed.has(node.identity.kind)) &&
        matchesRepoGlob(node.identity.key, pattern),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function collectNodes(
  graph: GraphDocument,
  overlay: OverlayDefinition,
  diagnostics: GraphDiagnostic[],
): GraphNodeInput[] {
  const accepted: GraphNodeInput[] = [];
  const base = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Map<string, OverlayNodeInput>();
  const conflicted = new Set<string>();

  for (const candidate of overlay.nodes ?? []) {
    const id = nodeId(candidate.identity);
    const prior = seen.get(id);
    if (prior !== undefined) {
      if (metadataKey(prior.metadata) === metadataKey(candidate.metadata)) {
        diagnostics.push(
          diagnostic(
            overlay,
            "overlay-duplicate-node",
            `Overlay ${overlay.identity.name}@${overlay.identity.version} repeats node ${id}`,
          ),
        );
      } else {
        conflicted.add(id);
        diagnostics.push(
          diagnostic(
            overlay,
            "overlay-conflicting-node",
            `Overlay ${overlay.identity.name}@${overlay.identity.version} declares conflicting metadata for node ${id}`,
          ),
        );
      }
      continue;
    }
    seen.set(id, candidate);
  }

  for (const [id, candidate] of seen) {
    if (conflicted.has(id)) continue;
    const existing = base.get(id);
    if (
      existing !== undefined &&
      metadataKey(existing.metadata) !== metadataKey(candidate.metadata)
    ) {
      diagnostics.push(
        diagnostic(
          overlay,
          "overlay-base-node-conflict",
          `Overlay node ${id} conflicts with metadata already present in the graph`,
        ),
      );
      continue;
    }

    accepted.push({
      identity: candidate.identity,
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
      provenance: [overlayProvenance(overlay)],
    });
  }

  return accepted;
}

function collectDirectEdges(
  graph: GraphDocument,
  overlay: OverlayDefinition,
  knownNodeIds: ReadonlySet<string>,
  diagnostics: GraphDiagnostic[],
): GraphEdgeInput[] {
  const accepted: GraphEdgeInput[] = [];
  const base = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const seen = new Map<string, OverlayEdgeInput>();
  const conflicted = new Set<string>();

  for (const candidate of overlay.edges ?? []) {
    const id = edgeId(candidate.identity);
    const prior = seen.get(id);
    if (prior !== undefined) {
      if (metadataKey(prior.metadata) === metadataKey(candidate.metadata)) {
        diagnostics.push(
          diagnostic(
            overlay,
            "overlay-duplicate-edge",
            `Overlay ${overlay.identity.name}@${overlay.identity.version} repeats edge ${id}`,
          ),
        );
      } else {
        conflicted.add(id);
        diagnostics.push(
          diagnostic(
            overlay,
            "overlay-conflicting-edge",
            `Overlay ${overlay.identity.name}@${overlay.identity.version} declares conflicting metadata for edge ${id}`,
          ),
        );
      }
      continue;
    }
    seen.set(id, candidate);
  }

  for (const [id, candidate] of seen) {
    if (conflicted.has(id)) continue;
    if (
      !knownNodeIds.has(candidate.identity.from) ||
      !knownNodeIds.has(candidate.identity.to)
    ) {
      diagnostics.push(
        diagnostic(
          overlay,
          "overlay-missing-edge-endpoint",
          `Overlay edge ${id} references a node that is not present in the graph`,
          "unresolved",
        ),
      );
      continue;
    }

    const existing = base.get(id);
    if (
      existing !== undefined &&
      metadataKey(existing.metadata) !== metadataKey(candidate.metadata)
    ) {
      diagnostics.push(
        diagnostic(
          overlay,
          "overlay-base-edge-conflict",
          `Overlay edge ${id} conflicts with metadata already present in the graph`,
        ),
      );
      continue;
    }

    accepted.push({
      identity: candidate.identity,
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
      provenance: [overlayProvenance(overlay)],
    });
  }

  return accepted;
}

function collectPathEdges(
  graphForMatching: GraphDocument,
  overlay: OverlayDefinition,
  knownNodeIds: ReadonlySet<string>,
  diagnostics: GraphDiagnostic[],
): GraphEdgeInput[] {
  const result: GraphEdgeInput[] = [];

  for (const mapping of overlay.pathEdges ?? []) {
    const anchorId = nodeId(mapping.anchor);
    if (!knownNodeIds.has(anchorId)) {
      diagnostics.push(
        diagnostic(
          overlay,
          "overlay-path-anchor-missing",
          `Overlay path mapping anchor ${anchorId} is not present in the graph`,
          "unresolved",
        ),
      );
      continue;
    }

    const matches = matchGraphNodesByPath(
      graphForMatching,
      mapping.pattern,
      mapping.nodeKinds ?? ["file"],
    );
    if (matches.length === 0) {
      diagnostics.push(
        diagnostic(
          overlay,
          "overlay-path-no-match",
          `Overlay path mapping ${mapping.pattern} matched no graph nodes`,
          "unresolved",
        ),
      );
      continue;
    }

    for (const match of matches) {
      const direction = mapping.direction ?? "out";
      const from = direction === "out" ? anchorId : match.id;
      const to = direction === "out" ? match.id : anchorId;
      result.push({
        identity: {
          kind: mapping.edgeKind,
          from,
          to,
          key: `${mapping.keyPrefix ?? "path"}:${mapping.pattern}:${match.id}`,
        },
        ...(mapping.metadata === undefined ? {} : { metadata: mapping.metadata }),
        provenance: [overlayProvenance(overlay)],
      });
    }
  }

  return result;
}

export function applyOverlay(
  graph: GraphDocument,
  overlay: OverlayDefinition,
): OverlayApplyResult {
  const diagnostics = [...graph.diagnostics];
  const overlayNodes = collectNodes(graph, overlay, diagnostics);

  const provisionalGraph = buildGraph({
    nodes: [
      ...graph.nodes.map(nodeInput),
      ...overlayNodes,
    ],
    edges: graph.edges.map(edgeInput),
    diagnostics,
  });
  const knownNodeIds = new Set(provisionalGraph.nodes.map((node) => node.id));

  const directEdges = collectDirectEdges(
    provisionalGraph,
    overlay,
    knownNodeIds,
    diagnostics,
  );
  const pathEdges = collectPathEdges(
    provisionalGraph,
    overlay,
    knownNodeIds,
    diagnostics,
  );

  const result = buildGraph({
    nodes: provisionalGraph.nodes.map(nodeInput),
    edges: [
      ...graph.edges.map(edgeInput),
      ...directEdges,
      ...pathEdges,
    ],
    diagnostics,
  });

  return {
    graph: result,
    addedNodes: result.nodes.length - graph.nodes.length,
    addedEdges: result.edges.length - graph.edges.length,
    diagnosticsAdded: result.diagnostics.length - graph.diagnostics.length,
  };
}
