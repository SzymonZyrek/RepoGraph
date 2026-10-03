import { GraphValidationError } from "./graph.js";
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
} from "./model.js";

export type TraversalDirection = "out" | "in" | "both";

export interface TraversalOptions {
  direction?: TraversalDirection;
  edgeKinds?: readonly string[];
  maxDepth?: number;
  maxNodes?: number;
}

export interface NeighborSlice {
  start: string;
  direction: TraversalDirection;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TraversalSlice extends NeighborSlice {
  maxDepth: number;
  maxNodes: number;
  truncated: boolean;
}

export interface CausalPath {
  from: string;
  to: string;
  direction: TraversalDirection;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Step {
  node: GraphNode;
  edge: GraphEdge;
}

function nodeMap(graph: GraphDocument): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function requireNode(graph: GraphDocument, id: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new GraphValidationError(`Unknown graph node: ${id}`);
  }
  return node;
}

function allowsEdge(edge: GraphEdge, edgeKinds?: readonly string[]): boolean {
  return edgeKinds === undefined || edgeKinds.length === 0 || edgeKinds.includes(edge.identity.kind);
}

function adjacent(
  graph: GraphDocument,
  id: string,
  direction: TraversalDirection,
  edgeKinds?: readonly string[],
): Step[] {
  const nodes = nodeMap(graph);
  const steps: Step[] = [];

  for (const edge of graph.edges) {
    if (!allowsEdge(edge, edgeKinds)) continue;

    if ((direction === "out" || direction === "both") && edge.identity.from === id) {
      const node = nodes.get(edge.identity.to);
      if (node !== undefined) steps.push({ node, edge });
    }

    if ((direction === "in" || direction === "both") && edge.identity.to === id) {
      const node = nodes.get(edge.identity.from);
      if (node !== undefined) steps.push({ node, edge });
    }
  }

  return steps.sort((left, right) => {
    const byNode = left.node.id.localeCompare(right.node.id);
    return byNode !== 0 ? byNode : left.edge.id.localeCompare(right.edge.id);
  });
}

export function neighbors(
  graph: GraphDocument,
  start: string,
  options: Pick<TraversalOptions, "direction" | "edgeKinds"> = {},
): NeighborSlice {
  requireNode(graph, start);
  const direction = options.direction ?? "out";
  const steps = adjacent(graph, start, direction, options.edgeKinds);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const step of steps) {
    nodes.set(step.node.id, step.node);
    edges.set(step.edge.id, step.edge);
  }

  return {
    start,
    direction,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function reverseNeighbors(
  graph: GraphDocument,
  start: string,
  edgeKinds?: readonly string[],
): NeighborSlice {
  return neighbors(graph, start, { direction: "in", edgeKinds });
}

export function transitiveClosure(
  graph: GraphDocument,
  start: string,
  options: TraversalOptions = {},
): TraversalSlice {
  requireNode(graph, start);
  const direction = options.direction ?? "out";
  const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER;
  const maxNodes = options.maxNodes ?? 10_000;

  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new GraphValidationError("maxDepth must be a non-negative integer");
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new GraphValidationError("maxNodes must be a positive integer");
  }

  const visited = new Set<string>([start]);
  const selectedNodes = new Map<string, GraphNode>();
  const selectedEdges = new Map<string, GraphEdge>();
  const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) {
      if (adjacent(graph, current.id, direction, options.edgeKinds).some((step) => !visited.has(step.node.id))) {
        truncated = true;
      }
      continue;
    }

    for (const step of adjacent(graph, current.id, direction, options.edgeKinds)) {
      if (visited.has(step.node.id)) continue;

      if (selectedNodes.size >= maxNodes) {
        truncated = true;
        queue.length = 0;
        break;
      }

      visited.add(step.node.id);
      selectedNodes.set(step.node.id, step.node);
      selectedEdges.set(step.edge.id, step.edge);
      queue.push({ id: step.node.id, depth: current.depth + 1 });
    }
  }

  return {
    start,
    direction,
    maxDepth,
    maxNodes,
    truncated,
    nodes: [...selectedNodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...selectedEdges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function affectedClosure(
  graph: GraphDocument,
  changed: string,
  options: Omit<TraversalOptions, "direction"> = {},
): TraversalSlice {
  return transitiveClosure(graph, changed, { ...options, direction: "in" });
}

export function shortestPath(
  graph: GraphDocument,
  from: string,
  to: string,
  options: Pick<TraversalOptions, "direction" | "edgeKinds" | "maxDepth"> = {},
): CausalPath | null {
  const fromNode = requireNode(graph, from);
  requireNode(graph, to);
  const direction = options.direction ?? "out";
  const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new GraphValidationError("maxDepth must be a non-negative integer");
  }

  if (from === to) {
    return { from, to, direction, nodes: [fromNode], edges: [] };
  }

  const queue: Array<{ id: string; depth: number }> = [{ id: from, depth: 0 }];
  const visited = new Set<string>([from]);
  const previous = new Map<string, { prior: string; edge: GraphEdge }>();
  const nodes = nodeMap(graph);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    for (const step of adjacent(graph, current.id, direction, options.edgeKinds)) {
      if (visited.has(step.node.id)) continue;
      visited.add(step.node.id);
      previous.set(step.node.id, { prior: current.id, edge: step.edge });

      if (step.node.id === to) {
        const pathNodeIds = [to];
        const pathEdges: GraphEdge[] = [];
        let cursor = to;

        while (cursor !== from) {
          const link = previous.get(cursor);
          if (link === undefined) {
            throw new GraphValidationError("Broken causal path reconstruction");
          }
          pathEdges.push(link.edge);
          cursor = link.prior;
          pathNodeIds.push(cursor);
        }

        pathNodeIds.reverse();
        pathEdges.reverse();
        return {
          from,
          to,
          direction,
          nodes: pathNodeIds.map((id) => nodes.get(id)!).filter(Boolean),
          edges: pathEdges,
        };
      }

      queue.push({ id: step.node.id, depth: current.depth + 1 });
    }
  }

  return null;
}
