import type { CausalAnswer, CausalEvidence, CausalNode } from "./causal-model.js";

export interface GraphViewEvidence { origins: string[]; methods: string[]; states: string[]; authorities: string[] }
export interface GraphViewModel {
  schemaVersion: "repograph.view/v1";
  partial: boolean; truncated: boolean;
  nodes: Array<{ id: string; kind: string; key: string; label: string; x: number; y: number; evidence: GraphViewEvidence }>;
  edges: Array<{ id: string; kind: string; from: string; to: string; evidence: GraphViewEvidence }>;
  bounds: { x: number; y: number; width: number; height: number };
}
export function createGraphViewModel(answer: CausalAnswer, label?: (node: CausalNode) => string): GraphViewModel {
  const summarize = (items: CausalEvidence[]): GraphViewEvidence => ({
    origins: [...new Set(items.map(item => item.provider))].sort(), methods: [...new Set(items.map(item => item.class))].sort(),
    states: [...new Set(items.map(item => item.state))].sort(), authorities: [...new Set(items.flatMap(item => item.authority ? [item.authority] : []))].sort(),
  });
  const byId = new Map(answer.evidence.map(item => [item.id, item]));
  const edges = answer.edges.map(edge => ({ ...edge, id: JSON.stringify([edge.from, edge.kind, edge.to]), evidence: summarize(edge.evidence.map(id => byId.get(id)!)) }));
  return { schemaVersion: "repograph.view/v1", partial: answer.partial, truncated: answer.truncated,
    nodes: answer.nodes.map((node, i) => ({ id: node.id, kind: node.type === "artifact" ? "artifact" : node.kind, key: node.type === "artifact" ? node.path : node.key,
      label: label?.(node) ?? (node.type === "artifact" ? node.path : node.key), x: 0, y: i * 80,
      evidence: summarize(answer.edges.filter(edge => edge.from === node.id || edge.to === node.id).flatMap(edge => edge.evidence.map(id => byId.get(id)!))) })),
    edges, bounds: { x: 0, y: 0, width: 400, height: Math.max(80, answer.nodes.length * 80) } };
}
