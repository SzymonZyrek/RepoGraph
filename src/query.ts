import type { GraphDocument, GraphEdge, GraphNode } from "./model.js";

export interface QueryOptions {
  edgeKinds?: readonly string[];
  maxDepth?: number;
}

export interface Neighbor {
  node: GraphNode;
  edge: GraphEdge;
}

export interface TraversalResult {
  seeds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface PathExplanation {
  found: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function sortById<T extends { id: string }>(values: T[]): T[] {
  return values.sort((left, right) => left.id.localeCompare(right.id));
}

function indexes(graph: GraphDocument) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const forward = new Map<string, GraphEdge[]>();
  const reverse = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    const outgoing = forward.get(edge.identity.from) ?? [];
    outgoing.push(edge);
    forward.set(edge.identity.from, outgoing);

    const incoming = reverse.get(edge.identity.to) ?? [];
    incoming.push(edge);
    reverse.set(edge.identity.to, incoming);
  }

  for (const edges of forward.values()) sortById(edges);
  for (const edges of reverse.values()) sortById(edges);

  return { nodes, forward, reverse };
}

export function resolveNode(graph: GraphDocument, idOrKey: string): GraphNode {
  const exact = graph.nodes.find((node) => node.id === idOrKey);
  if (exact !== undefined) return exact;

  const matches = graph.nodes.filter((node) => node.identity.key === idOrKey);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(`Unknown graph node: ${idOrKey}`);
  }
  throw new Error(
    `Ambiguous graph node key: ${idOrKey}; use the stable node id instead`,
  );
}

function edgeAllowed(edge: GraphEdge, options: QueryOptions): boolean {
  return (
    options.edgeKinds === undefined ||
    options.edgeKinds.length === 0 ||
    options.edgeKinds.includes(edge.identity.kind)
  );
}

function adjacent(
  graph: GraphDocument,
  nodeId: string,
  direction: "forward" | "reverse",
  options: QueryOptions,
): Neighbor[] {
  const { nodes, forward, reverse } = indexes(graph);
  const edges =
    direction === "forward"
      ? (forward.get(nodeId) ?? [])
      : (reverse.get(nodeId) ?? []);

  const result: Neighbor[] = [];
  for (const edge of edges) {
    if (!edgeAllowed(edge, options)) continue;
    const adjacentId =
      direction === "forward" ? edge.identity.to : edge.identity.from;
    const node = nodes.get(adjacentId);
    if (node !== undefined) result.push({ node, edge });
  }

  return result.sort(
    (left, right) =>
      left.node.id.localeCompare(right.node.id) ||
      left.edge.id.localeCompare(right.edge.id),
  );
}

export function neighbors(
  graph: GraphDocument,
  node: string,
  options: QueryOptions = {},
): Neighbor[] {
  return adjacent(graph, resolveNode(graph, node).id, "forward", options);
}

export function reverseNeighbors(
  graph: GraphDocument,
  node: string,
  options: QueryOptions = {},
): Neighbor[] {
  return adjacent(graph, resolveNode(graph, node).id, "reverse", options);
}

export function affected(
  graph: GraphDocument,
  seeds: readonly string[],
  options: QueryOptions = {},
): TraversalResult {
  if (seeds.length === 0) throw new Error("At least one seed is required");

  const resolvedSeeds = [...new Set(seeds.map((seed) => resolveNode(graph, seed).id))]
    .sort((left, right) => left.localeCompare(right));
  const visited = new Set(resolvedSeeds);
  const queue = resolvedSeeds.map((id) => ({ id, depth: 0 }));
  const traversedEdges = new Map<string, GraphEdge>();
  let truncated = false;

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (
      options.maxDepth !== undefined &&
      current.depth >= options.maxDepth
    ) {
      if (adjacent(graph, current.id, "reverse", options).length > 0) {
        truncated = true;
      }
      continue;
    }

    for (const next of adjacent(graph, current.id, "reverse", options)) {
      traversedEdges.set(next.edge.id, next.edge);
      if (!visited.has(next.node.id)) {
        visited.add(next.node.id);
        queue.push({ id: next.node.id, depth: current.depth + 1 });
      }
    }
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    seeds: resolvedSeeds,
    nodes: [...visited]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => byId.get(id)!),
    edges: sortById([...traversedEdges.values()]),
    truncated,
  };
}

export function explainPath(
  graph: GraphDocument,
  from: string,
  to: string,
  direction: "forward" | "reverse" = "forward",
  options: QueryOptions = {},
): PathExplanation {
  const start = resolveNode(graph, from);
  const target = resolveNode(graph, to);

  if (start.id === target.id) {
    return { found: true, nodes: [start], edges: [] };
  }

  const visited = new Set([start.id]);
  const queue: Array<{ id: string; depth: number }> = [{ id: start.id, depth: 0 }];
  const parent = new Map<string, { previous: string; edge: GraphEdge }>();

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (
      options.maxDepth !== undefined &&
      current.depth >= options.maxDepth
    ) {
      continue;
    }

    for (const next of adjacent(graph, current.id, direction, options)) {
      if (visited.has(next.node.id)) continue;
      visited.add(next.node.id);
      parent.set(next.node.id, { previous: current.id, edge: next.edge });

      if (next.node.id === target.id) {
        const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
        const nodes: GraphNode[] = [target];
        const edges: GraphEdge[] = [];
        let cursor = target.id;

        while (cursor !== start.id) {
          const step = parent.get(cursor)!;
          edges.push(step.edge);
          nodes.push(nodeById.get(step.previous)!);
          cursor = step.previous;
        }

        return {
          found: true,
          nodes: nodes.reverse(),
          edges: edges.reverse(),
        };
      }

      queue.push({ id: next.node.id, depth: current.depth + 1 });
    }
  }

  return { found: false, nodes: [], edges: [] };
}
