import { compare, type LoadedGraph, type GraphNode, type GraphEdge } from './model.js';
import { RepoGraphError } from './error.js';

export interface QueryOptions { edgeTypes?: string[]; direction?: 'forward' | 'reverse' }
export interface Neighbor { node: GraphNode; edge: GraphEdge }
export function resolveNode(graph: LoadedGraph, idOrPath: string): GraphNode {
  const exact = graph.nodes.get(idOrPath); if (exact) return exact;
  const byPath = graph.document.nodes.find(n => ['file', 'directory', 'gitlink'].includes(n.type) && n.key === idOrPath);
  if (!byPath) throw new RepoGraphError('UNKNOWN_NODE', 'Node ID or path is not present in this snapshot', { node: idOrPath });
  return byPath;
}
function adjacent(graph: LoadedGraph, id: string, options: QueryOptions): Neighbor[] {
  const reverse = options.direction === 'reverse';
  const edges = (reverse ? graph.reverse : graph.forward).get(id)!;
  return edges.filter(e => options.edgeTypes === undefined || options.edgeTypes.includes(e.type))
    .map(edge => ({ node: graph.nodes.get(reverse ? edge.from : edge.to)!, edge }))
    .sort((a,b) => compare(a.node.id,b.node.id) || compare(a.edge.id,b.edge.id));
}
export function neighbors(graph: LoadedGraph, node: string, options: Pick<QueryOptions, 'edgeTypes'> = {}): Neighbor[] {
  return adjacent(graph, resolveNode(graph, node).id, { ...options, direction: 'forward' });
}
export function reverseNeighbors(graph: LoadedGraph, node: string, options: Pick<QueryOptions, 'edgeTypes'> = {}): Neighbor[] {
  return adjacent(graph, resolveNode(graph, node).id, { ...options, direction: 'reverse' });
}
export function affected(graph: LoadedGraph, seeds: string[], options: Pick<QueryOptions, 'edgeTypes'> = {}) {
  if (seeds.length === 0) throw new RepoGraphError('INVALID_INPUT', 'At least one affected seed is required');
  const seedIds = [...new Set(seeds.map(seed => resolveNode(graph, seed).id))].sort(compare);
  const queue = [...seedIds]; const visited = new Set(queue); const edges = new Map<string, GraphEdge>();
  for (let index = 0; index < queue.length; index++) {
    for (const next of adjacent(graph, queue[index]!, { direction: 'reverse', edgeTypes: options.edgeTypes ?? ['applies_to'] })) {
      edges.set(next.edge.id, next.edge);
      if (!visited.has(next.node.id)) { visited.add(next.node.id); queue.push(next.node.id); }
    }
  }
  return { seeds: seedIds, nodes: [...visited].sort(compare).map(id => graph.nodes.get(id)!), edges: [...edges.values()].sort((a,b) => compare(a.id,b.id)) };
}
export function explainPath(graph: LoadedGraph, from: string, to: string, options: QueryOptions = {}) {
  if (options.direction !== undefined && !['forward', 'reverse'].includes(options.direction)) throw new RepoGraphError('INVALID_INPUT', 'Invalid traversal direction');
  const start = resolveNode(graph, from); const target = resolveNode(graph, to);
  const queue = [start.id]; const visited = new Set(queue); const parent = new Map<string, { id: string; edge: GraphEdge }>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (id === target.id) {
      const nodes = [target]; const edges: GraphEdge[] = []; let cursor = target.id;
      while (cursor !== start.id) { const p = parent.get(cursor)!; edges.push(p.edge); nodes.push(graph.nodes.get(p.id)!); cursor = p.id; }
      return { found: true, nodes: nodes.reverse(), edges: edges.reverse() };
    }
    for (const next of adjacent(graph, id, options)) {
      if (!visited.has(next.node.id)) { visited.add(next.node.id); parent.set(next.node.id, { id, edge: next.edge }); queue.push(next.node.id); }
    }
  }
  return { found: false, nodes: [], edges: [] };
}
