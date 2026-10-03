import { canonicalJsonUnknown } from "./canonical.js";
import { buildGraph, nodeId } from "./graph.js";
import type {
  FactAuthority,
  GraphDiagnostic,
  GraphDocument,
  GraphEdge,
  GraphInput,
  GraphNode,
  JsonObject,
  NodeIdentity,
  Provenance,
} from "./model.js";

export const CROSS_REPOSITORY_MAPPING_VERSION = "repograph.cross-repo/v1" as const;
export const CROSS_REPOSITORY_COORDINATE_NAMESPACE = "repograph:coordinates" as const;

export interface RepositoryGraphSnapshot {
  repository: string;
  ref: string;
  commit: string;
  graph: GraphDocument;
}

export interface CrossRepositoryCoordinate {
  kind: "package" | "artifact";
  ecosystem: string;
  name: string;
  version: string;
}

export interface CrossRepositoryNodeLocator {
  repository: string;
  kind: string;
  key: string;
}

export interface CrossRepositoryDependencyMapping {
  id: string;
  consumer: CrossRepositoryNodeLocator;
  coordinate: CrossRepositoryCoordinate;
  producer?: CrossRepositoryNodeLocator;
}

export interface CrossRepositoryCompositionOptions {
  identity: {
    name: string;
    version: string;
  };
  authority?: FactAuthority;
  mappings: CrossRepositoryDependencyMapping[];
}

export interface CrossRepositoryCompositionMetrics {
  mappings: number;
  connected: number;
  unresolved: number;
  ambiguous: number;
}

export interface CrossRepositoryCompositionResult {
  graph: GraphDocument;
  metrics: CrossRepositoryCompositionMetrics;
}

export interface CrossRepositoryTraversalOptions {
  maxRepositoryHops?: number;
  maxNodes?: number;
}

export interface CrossRepositorySlice {
  start: string;
  maxRepositoryHops: number;
  maxNodes: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function graphInput(graph: GraphDocument): Required<GraphInput> {
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
    diagnostics: [...graph.diagnostics],
  };
}

function locatorIdentity(locator: CrossRepositoryNodeLocator): NodeIdentity {
  return {
    namespace: nonEmpty(locator.repository, "locator.repository"),
    kind: nonEmpty(locator.kind, "locator.kind"),
    key: nonEmpty(locator.key, "locator.key"),
  };
}

export function coordinateIdentity(
  coordinate: CrossRepositoryCoordinate,
): NodeIdentity {
  const normalized = normalizeCoordinate(coordinate);
  return {
    namespace: CROSS_REPOSITORY_COORDINATE_NAMESPACE,
    kind: "coordinate",
    key: canonicalJsonUnknown(normalized),
  };
}

function normalizeCoordinate(
  coordinate: CrossRepositoryCoordinate,
): CrossRepositoryCoordinate {
  if (coordinate.kind !== "package" && coordinate.kind !== "artifact") {
    throw new TypeError(`Unsupported coordinate kind: ${String(coordinate.kind)}`);
  }
  return {
    kind: coordinate.kind,
    ecosystem: nonEmpty(coordinate.ecosystem, "coordinate.ecosystem"),
    name: nonEmpty(coordinate.name, "coordinate.name"),
    version: nonEmpty(coordinate.version, "coordinate.version"),
  };
}

function coordinateMetadata(
  coordinate: CrossRepositoryCoordinate,
): JsonObject {
  const normalized = normalizeCoordinate(coordinate);
  return {
    kind: normalized.kind,
    ecosystem: normalized.ecosystem,
    name: normalized.name,
    version: normalized.version,
  };
}

function mappingProvenance(
  snapshot: RepositoryGraphSnapshot,
  options: CrossRepositoryCompositionOptions,
  path?: string,
  state: "complete" | "partial" | "unresolved" = "complete",
  message?: string,
): Provenance {
  return {
    repository: snapshot.repository,
    ref: snapshot.ref,
    commit: snapshot.commit,
    ...(path === undefined ? {} : { path }),
    origin: "overlay",
    method: "explicit-overlay",
    state,
    authority: options.authority ?? "authoritative",
    overlay: {
      name: nonEmpty(options.identity.name, "mapping identity name"),
      version: nonEmpty(options.identity.version, "mapping identity version"),
    },
    ...(message === undefined ? {} : { diagnostic: message }),
  };
}

function mappingDiagnostic(
  snapshot: RepositoryGraphSnapshot,
  options: CrossRepositoryCompositionOptions,
  code: string,
  message: string,
  state: "partial" | "unresolved",
  path?: string,
): GraphDiagnostic {
  return {
    code,
    message,
    state,
    provenance: mappingProvenance(snapshot, options, path, state, message),
  };
}

function snapshotsByRepository(
  snapshots: readonly RepositoryGraphSnapshot[],
): Map<string, RepositoryGraphSnapshot> {
  const result = new Map<string, RepositoryGraphSnapshot>();
  for (const snapshot of snapshots) {
    nonEmpty(snapshot.repository, "snapshot.repository");
    nonEmpty(snapshot.ref, "snapshot.ref");
    nonEmpty(snapshot.commit, "snapshot.commit");
    if (result.has(snapshot.repository)) {
      throw new TypeError(
        `Duplicate repository snapshot: ${snapshot.repository}`,
      );
    }
    result.set(snapshot.repository, snapshot);
  }
  return result;
}

function nodeForLocator(
  snapshots: ReadonlyMap<string, RepositoryGraphSnapshot>,
  locator: CrossRepositoryNodeLocator,
): GraphNode | undefined {
  const snapshot = snapshots.get(locator.repository);
  if (snapshot === undefined) return undefined;
  const id = nodeId(locatorIdentity(locator));
  return snapshot.graph.nodes.find((node) => node.id === id);
}

function packageMatchesCoordinate(
  node: GraphNode,
  coordinate: CrossRepositoryCoordinate,
): boolean {
  return (
    node.identity.kind === "package" &&
    node.metadata?.ecosystem === coordinate.ecosystem &&
    node.metadata?.name === coordinate.name &&
    node.metadata?.version === coordinate.version
  );
}

function inferPackageProducer(
  snapshots: readonly RepositoryGraphSnapshot[],
  coordinate: CrossRepositoryCoordinate,
): Array<{ snapshot: RepositoryGraphSnapshot; node: GraphNode }> {
  if (coordinate.kind !== "package") return [];
  const matches: Array<{
    snapshot: RepositoryGraphSnapshot;
    node: GraphNode;
  }> = [];
  for (const snapshot of snapshots) {
    for (const node of snapshot.graph.nodes) {
      if (packageMatchesCoordinate(node, coordinate)) {
        matches.push({ snapshot, node });
      }
    }
  }
  return matches.sort((left, right) =>
    `${left.snapshot.repository}\0${left.node.id}`.localeCompare(
      `${right.snapshot.repository}\0${right.node.id}`,
    ),
  );
}

function mergeGraphs(
  snapshots: readonly RepositoryGraphSnapshot[],
): GraphDocument {
  const inputs = snapshots.map((snapshot) => graphInput(snapshot.graph));
  return buildGraph({
    nodes: inputs.flatMap((input) => input.nodes),
    edges: inputs.flatMap((input) => input.edges),
    diagnostics: inputs.flatMap((input) => input.diagnostics),
  });
}

export function composeCrossRepositoryGraph(
  snapshotsInput: readonly RepositoryGraphSnapshot[],
  options: CrossRepositoryCompositionOptions,
): CrossRepositoryCompositionResult {
  const snapshots = [...snapshotsInput].sort((left, right) =>
    left.repository.localeCompare(right.repository),
  );
  const byRepository = snapshotsByRepository(snapshots);
  let graph = mergeGraphs(snapshots);
  const additionalNodes: NonNullable<GraphInput["nodes"]> = [];
  const additionalEdges: NonNullable<GraphInput["edges"]> = [];
  const diagnostics: GraphDiagnostic[] = [];
  let connected = 0;
  let unresolved = 0;
  let ambiguous = 0;

  const mappings = [...options.mappings].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  for (const mapping of mappings) {
    nonEmpty(mapping.id, "mapping.id");
    const coordinate = normalizeCoordinate(mapping.coordinate);
    const consumerSnapshot = byRepository.get(mapping.consumer.repository);
    const consumerNode = nodeForLocator(byRepository, mapping.consumer);

    if (consumerSnapshot === undefined || consumerNode === undefined) {
      unresolved += 1;
      const fallback =
        consumerSnapshot ?? snapshots[0];
      if (fallback !== undefined) {
        diagnostics.push(
          mappingDiagnostic(
            fallback,
            options,
            "cross-repo-consumer-unresolved",
            `Consumer ${mapping.consumer.repository}:${mapping.consumer.kind}:${mapping.consumer.key} does not exist in supplied snapshots`,
            "unresolved",
            mapping.consumer.key,
          ),
        );
      }
      continue;
    }

    let producer:
      | { snapshot: RepositoryGraphSnapshot; node: GraphNode }
      | undefined;

    if (mapping.producer !== undefined) {
      const producerSnapshot = byRepository.get(mapping.producer.repository);
      const producerNode = nodeForLocator(byRepository, mapping.producer);
      if (producerSnapshot === undefined || producerNode === undefined) {
        unresolved += 1;
        diagnostics.push(
          mappingDiagnostic(
            consumerSnapshot,
            options,
            "cross-repo-producer-unresolved",
            `Explicit producer ${mapping.producer.repository}:${mapping.producer.kind}:${mapping.producer.key} does not exist in supplied snapshots`,
            "unresolved",
            mapping.consumer.key,
          ),
        );
        continue;
      }
      if (
        coordinate.kind === "package" &&
        !packageMatchesCoordinate(producerNode, coordinate)
      ) {
        unresolved += 1;
        diagnostics.push(
          mappingDiagnostic(
            consumerSnapshot,
            options,
            "cross-repo-producer-coordinate-mismatch",
            `Explicit producer does not match ${coordinate.ecosystem}:${coordinate.name}@${coordinate.version}`,
            "unresolved",
            mapping.consumer.key,
          ),
        );
        continue;
      }
      producer = { snapshot: producerSnapshot, node: producerNode };
    } else {
      const matches = inferPackageProducer(snapshots, coordinate);
      if (matches.length === 0) {
        unresolved += 1;
        diagnostics.push(
          mappingDiagnostic(
            consumerSnapshot,
            options,
            "cross-repo-producer-unresolved",
            `No supplied repository provides ${coordinate.ecosystem}:${coordinate.name}@${coordinate.version}; remote resolution is not attempted`,
            "unresolved",
            mapping.consumer.key,
          ),
        );
        continue;
      }
      if (matches.length > 1) {
        ambiguous += 1;
        diagnostics.push(
          mappingDiagnostic(
            consumerSnapshot,
            options,
            "cross-repo-producer-ambiguous",
            `Multiple supplied repositories provide ${coordinate.ecosystem}:${coordinate.name}@${coordinate.version}; provide an explicit producer locator`,
            "partial",
            mapping.consumer.key,
          ),
        );
        continue;
      }
      producer = matches[0];
    }

    if (producer === undefined) continue;

    const coordinateNodeIdentity = coordinateIdentity(coordinate);
    const coordinateId = nodeId(coordinateNodeIdentity);
    additionalNodes.push({
      identity: coordinateNodeIdentity,
      metadata: coordinateMetadata(coordinate),
      provenance: [
        mappingProvenance(
          consumerSnapshot,
          options,
          mapping.consumer.key,
        ),
        mappingProvenance(
          producer.snapshot,
          options,
          producer.node.identity.key,
        ),
      ],
    });

    additionalEdges.push(
      {
        identity: {
          kind: "depends-on-coordinate",
          from: consumerNode.id,
          to: coordinateId,
          key: mapping.id,
        },
        metadata: {
          mappingId: mapping.id,
          coordinate: coordinateMetadata(coordinate),
        },
        provenance: [
          mappingProvenance(
            consumerSnapshot,
            options,
            mapping.consumer.key,
          ),
        ],
      },
      {
        identity: {
          kind: "coordinate-resolves-to",
          from: coordinateId,
          to: producer.node.id,
          key: canonicalJsonUnknown(coordinate),
        },
        metadata: {
          mappingId: mapping.id,
          producerRepository: producer.snapshot.repository,
          producerRef: producer.snapshot.ref,
          producerCommit: producer.snapshot.commit,
        },
        provenance: [
          mappingProvenance(
            producer.snapshot,
            options,
            producer.node.identity.key,
          ),
        ],
      },
    );
    connected += 1;
  }

  const input = graphInput(graph);
  graph = buildGraph({
    nodes: [...input.nodes, ...additionalNodes],
    edges: [...input.edges, ...additionalEdges],
    diagnostics: [...input.diagnostics, ...diagnostics],
  });

  return {
    graph,
    metrics: {
      mappings: mappings.length,
      connected,
      unresolved,
      ambiguous,
    },
  };
}

export function crossRepositoryAffected(
  graph: GraphDocument,
  start: string,
  options: CrossRepositoryTraversalOptions = {},
): CrossRepositorySlice {
  const startNode = graph.nodes.find((node) => node.id === start);
  if (startNode === undefined) {
    throw new TypeError(`Unknown graph node: ${start}`);
  }

  const maxRepositoryHops = options.maxRepositoryHops ?? 1;
  const maxNodes = options.maxNodes ?? 100;
  if (!Number.isInteger(maxRepositoryHops) || maxRepositoryHops < 0) {
    throw new TypeError("maxRepositoryHops must be a non-negative integer");
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new TypeError("maxNodes must be a positive integer");
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const visitedPackages = new Map<string, number>([[start, 0]]);
  const queue: Array<{ packageId: string; hops: number }> = [
    { packageId: start, hops: 0 },
  ];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentPackage = graph.nodes.find(
      (node) => node.id === current.packageId,
    );
    if (currentPackage === undefined) continue;

    const coordinateEdges = graph.edges.filter(
      (edge) =>
        edge.identity.kind === "coordinate-resolves-to" &&
        edge.identity.to === current.packageId,
    );

    for (const resolveEdge of coordinateEdges) {
      const coordinate = graph.nodes.find(
        (node) => node.id === resolveEdge.identity.from,
      );
      if (coordinate === undefined) continue;

      const consumerEdges = graph.edges.filter(
        (edge) =>
          edge.identity.kind === "depends-on-coordinate" &&
          edge.identity.to === coordinate.id,
      );

      for (const consumerEdge of consumerEdges) {
        const consumer = graph.nodes.find(
          (node) => node.id === consumerEdge.identity.from,
        );
        if (consumer === undefined) continue;

        const repositoryHop =
          consumer.identity.namespace === currentPackage.identity.namespace
            ? 0
            : 1;
        const nextHops = current.hops + repositoryHop;
        if (nextHops > maxRepositoryHops) {
          truncated = true;
          continue;
        }

        const additions = [
          [coordinate.id, coordinate] as const,
          [consumer.id, consumer] as const,
        ].filter(([id]) => !nodes.has(id));

        if (nodes.size + additions.length > maxNodes) {
          truncated = true;
          continue;
        }

        for (const [id, node] of additions) nodes.set(id, node);
        edges.set(resolveEdge.id, resolveEdge);
        edges.set(consumerEdge.id, consumerEdge);

        const previous = visitedPackages.get(consumer.id);
        if (previous === undefined || nextHops < previous) {
          visitedPackages.set(consumer.id, nextHops);
          queue.push({ packageId: consumer.id, hops: nextHops });
        }
      }
    }
  }

  return {
    start,
    maxRepositoryHops,
    maxNodes,
    truncated,
    nodes: [...nodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: [...edges.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}
