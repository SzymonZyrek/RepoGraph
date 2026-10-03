import { canonicalJsonUnknown } from "./canonical.js";
import { GraphValidationError } from "./graph.js";
import type {
  EvidenceMethod,
  EvidenceState,
  FactAuthority,
  FactOrigin,
  GraphDocument,
  GraphEdge,
  GraphNode,
  Provenance,
} from "./model.js";
import type { TraversalDirection } from "./traversal.js";

export const TRAVERSAL_POLICY_SCHEMA_VERSION = "repograph.traversal-policy/v1" as const;

export interface TraversalPolicy {
  schemaVersion: typeof TRAVERSAL_POLICY_SCHEMA_VERSION;
  direction: TraversalDirection;
  edgeKinds?: string[];
  nodeKinds?: string[];
  evidenceMethods?: EvidenceMethod[];
  evidenceOrigins?: FactOrigin[];
  authorities?: FactAuthority[];
  evidenceStates?: EvidenceState[];
  stopNodeKinds?: string[];
  maxDepth: number;
  maxNodes: number;
}

export interface TraversalReason {
  nodeId: string;
  fromNodeId: string;
  edgeId: string;
  depth: number;
  matchedProvenance: Provenance[];
}

export interface PolicyTraversalSlice {
  start: string;
  policy: TraversalPolicy;
  nodes: GraphNode[];
  edges: GraphEdge[];
  reasons: TraversalReason[];
  truncated: boolean;
  partial: boolean;
}

export interface PolicyCausalHop {
  fromNodeId: string;
  toNodeId: string;
  edge: GraphEdge;
  matchedProvenance: Provenance[];
}

export interface PolicyCausalPath {
  from: string;
  to: string;
  policy: TraversalPolicy;
  nodes: GraphNode[];
  hops: PolicyCausalHop[];
  partial: boolean;
}

export interface TraversalPolicyInput {
  direction?: TraversalDirection;
  edgeKinds?: readonly string[];
  nodeKinds?: readonly string[];
  evidenceMethods?: readonly EvidenceMethod[];
  evidenceOrigins?: readonly FactOrigin[];
  authorities?: readonly FactAuthority[];
  evidenceStates?: readonly EvidenceState[];
  stopNodeKinds?: readonly string[];
  maxDepth?: number;
  maxNodes?: number;
}

function sortedUnique<T extends string>(values?: readonly T[]): T[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return [...new Set(values)].sort();
}

export function createTraversalPolicy(input: TraversalPolicyInput = {}): TraversalPolicy {
  const maxDepth = input.maxDepth ?? 64;
  const maxNodes = input.maxNodes ?? 10_000;

  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new GraphValidationError("policy maxDepth must be a non-negative integer");
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new GraphValidationError("policy maxNodes must be a positive integer");
  }

  const edgeKinds = sortedUnique(input.edgeKinds);
  const nodeKinds = sortedUnique(input.nodeKinds);
  const evidenceMethods = sortedUnique(input.evidenceMethods);
  const evidenceOrigins = sortedUnique(input.evidenceOrigins);
  const authorities = sortedUnique(input.authorities);
  const evidenceStates = sortedUnique(input.evidenceStates);
  const stopNodeKinds = sortedUnique(input.stopNodeKinds);

  return {
    schemaVersion: TRAVERSAL_POLICY_SCHEMA_VERSION,
    direction: input.direction ?? "out",
    ...(edgeKinds === undefined ? {} : { edgeKinds }),
    ...(nodeKinds === undefined ? {} : { nodeKinds }),
    ...(evidenceMethods === undefined ? {} : { evidenceMethods }),
    ...(evidenceOrigins === undefined ? {} : { evidenceOrigins }),
    ...(authorities === undefined ? {} : { authorities }),
    ...(evidenceStates === undefined ? {} : { evidenceStates }),
    ...(stopNodeKinds === undefined ? {} : { stopNodeKinds }),
    maxDepth,
    maxNodes,
  };
}

function includesOrAny<T extends string>(allowed: readonly T[] | undefined, value: T | undefined): boolean {
  return allowed === undefined || (value !== undefined && allowed.includes(value));
}

function matchingProvenance(edge: GraphEdge, policy: TraversalPolicy): Provenance[] {
  return edge.provenance.filter((provenance) =>
    includesOrAny(policy.evidenceMethods, provenance.method) &&
    includesOrAny(policy.evidenceOrigins, provenance.origin) &&
    includesOrAny(policy.evidenceStates, provenance.state) &&
    includesOrAny(policy.authorities, provenance.authority)
  );
}

function edgeAllowed(edge: GraphEdge, policy: TraversalPolicy): Provenance[] {
  if (policy.edgeKinds !== undefined && !policy.edgeKinds.includes(edge.identity.kind)) return [];
  return matchingProvenance(edge, policy);
}

function nodeAllowed(node: GraphNode, policy: TraversalPolicy): boolean {
  return policy.nodeKinds === undefined || policy.nodeKinds.includes(node.identity.kind);
}

function nodeById(graph: GraphDocument): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function requireNode(graph: GraphDocument, id: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new GraphValidationError("Unknown graph node: " + id);
  return node;
}

interface PolicyStep {
  fromNodeId: string;
  node: GraphNode;
  edge: GraphEdge;
  matchedProvenance: Provenance[];
}

function adjacent(graph: GraphDocument, id: string, policy: TraversalPolicy): PolicyStep[] {
  const nodes = nodeById(graph);
  const steps: PolicyStep[] = [];

  for (const edge of graph.edges) {
    const evidence = edgeAllowed(edge, policy);
    if (evidence.length === 0) continue;

    if ((policy.direction === "out" || policy.direction === "both") && edge.identity.from === id) {
      const node = nodes.get(edge.identity.to);
      if (node !== undefined && nodeAllowed(node, policy)) {
        steps.push({ fromNodeId: id, node, edge, matchedProvenance: evidence });
      }
    }
    if ((policy.direction === "in" || policy.direction === "both") && edge.identity.to === id) {
      const node = nodes.get(edge.identity.from);
      if (node !== undefined && nodeAllowed(node, policy)) {
        steps.push({ fromNodeId: id, node, edge, matchedProvenance: evidence });
      }
    }
  }

  return steps.sort((left, right) => {
    const byNode = left.node.id.localeCompare(right.node.id);
    return byNode !== 0 ? byNode : left.edge.id.localeCompare(right.edge.id);
  });
}

function graphHasPartialEvidence(graph: GraphDocument): boolean {
  return graph.diagnostics.length > 0 ||
    graph.nodes.some((node) => node.provenance.some((p) => p.state !== "complete")) ||
    graph.edges.some((edge) => edge.provenance.some((p) => p.state !== "complete"));
}

export function traverseWithPolicy(
  graph: GraphDocument,
  start: string,
  policyInput: TraversalPolicy | TraversalPolicyInput,
): PolicyTraversalSlice {
  requireNode(graph, start);
  const policy =
    "schemaVersion" in policyInput ? validateTraversalPolicy(policyInput) : createTraversalPolicy(policyInput);

  const selectedNodes = new Map<string, GraphNode>();
  const selectedEdges = new Map<string, GraphEdge>();
  const reasons = new Map<string, TraversalReason>();
  const visited = new Set<string>([start]);
  const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth >= policy.maxDepth) {
      if (adjacent(graph, current.id, policy).some((step) => !visited.has(step.node.id))) truncated = true;
      continue;
    }

    for (const step of adjacent(graph, current.id, policy)) {
      if (visited.has(step.node.id)) continue;
      if (selectedNodes.size >= policy.maxNodes) {
        truncated = true;
        queue.length = 0;
        break;
      }

      visited.add(step.node.id);
      selectedNodes.set(step.node.id, step.node);
      selectedEdges.set(step.edge.id, step.edge);
      reasons.set(step.node.id, {
        nodeId: step.node.id,
        fromNodeId: step.fromNodeId,
        edgeId: step.edge.id,
        depth: current.depth + 1,
        matchedProvenance: step.matchedProvenance,
      });

      if (policy.stopNodeKinds?.includes(step.node.identity.kind)) continue;
      queue.push({ id: step.node.id, depth: current.depth + 1 });
    }
  }

  return {
    start,
    policy,
    nodes: [...selectedNodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...selectedEdges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    reasons: [...reasons.values()].sort((a, b) => {
      const byDepth = a.depth - b.depth;
      return byDepth !== 0 ? byDepth : a.nodeId.localeCompare(b.nodeId);
    }),
    truncated,
    partial: truncated || graphHasPartialEvidence(graph),
  };
}

export function explainWithPolicy(
  graph: GraphDocument,
  from: string,
  to: string,
  policyInput: TraversalPolicy | TraversalPolicyInput,
): PolicyCausalPath | null {
  const fromNode = requireNode(graph, from);
  requireNode(graph, to);
  const policy =
    "schemaVersion" in policyInput ? validateTraversalPolicy(policyInput) : createTraversalPolicy(policyInput);

  if (from === to) {
    return { from, to, policy, nodes: [fromNode], hops: [], partial: graphHasPartialEvidence(graph) };
  }

  const queue: Array<{ id: string; depth: number }> = [{ id: from, depth: 0 }];
  const visited = new Set<string>([from]);
  const previous = new Map<string, PolicyStep>();
  const nodes = nodeById(graph);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= policy.maxDepth) continue;

    for (const step of adjacent(graph, current.id, policy)) {
      if (visited.has(step.node.id)) continue;
      visited.add(step.node.id);
      previous.set(step.node.id, step);

      if (step.node.id === to) {
        const nodeIds = [to];
        const hops: PolicyCausalHop[] = [];
        let cursor = to;

        while (cursor !== from) {
          const link = previous.get(cursor);
          if (link === undefined) throw new GraphValidationError("Broken policy path reconstruction");
          hops.push({
            fromNodeId: link.fromNodeId,
            toNodeId: cursor,
            edge: link.edge,
            matchedProvenance: link.matchedProvenance,
          });
          cursor = link.fromNodeId;
          nodeIds.push(cursor);
        }

        nodeIds.reverse();
        hops.reverse();
        return {
          from,
          to,
          policy,
          nodes: nodeIds.map((id) => nodes.get(id)!).filter(Boolean),
          hops,
          partial: graphHasPartialEvidence(graph),
        };
      }

      if (!policy.stopNodeKinds?.includes(step.node.identity.kind)) {
        queue.push({ id: step.node.id, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

export function serializeTraversalPolicy(policy: TraversalPolicy): string {
  return canonicalJsonUnknown(validateTraversalPolicy(policy));
}

export function parseTraversalPolicy(serialized: string): TraversalPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new GraphValidationError(
      "Traversal policy JSON is malformed: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  return validateTraversalPolicy(parsed);
}

function stringArray(raw: Record<string, unknown>, name: string): string[] | undefined {
  const item = raw[name];
  if (item === undefined) return undefined;
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new GraphValidationError("Traversal policy " + name + " must be a string array");
  }
  return item;
}

export function validateTraversalPolicy(value: unknown): TraversalPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GraphValidationError("Traversal policy must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== TRAVERSAL_POLICY_SCHEMA_VERSION) {
    throw new GraphValidationError("Unsupported traversal policy schema: " + String(raw.schemaVersion));
  }

  const direction = raw.direction;
  if (direction !== "out" && direction !== "in" && direction !== "both") {
    throw new GraphValidationError("Traversal policy direction must be out, in, or both");
  }

  const edgeKinds = stringArray(raw, "edgeKinds");
  const nodeKinds = stringArray(raw, "nodeKinds");
  const evidenceMethods = stringArray(raw, "evidenceMethods");
  const evidenceOrigins = stringArray(raw, "evidenceOrigins");
  const authorities = stringArray(raw, "authorities");
  const evidenceStates = stringArray(raw, "evidenceStates");
  const stopNodeKinds = stringArray(raw, "stopNodeKinds");

  return createTraversalPolicy({
    direction,
    ...(edgeKinds === undefined ? {} : { edgeKinds }),
    ...(nodeKinds === undefined ? {} : { nodeKinds }),
    ...(evidenceMethods === undefined ? {} : { evidenceMethods: evidenceMethods as EvidenceMethod[] }),
    ...(evidenceOrigins === undefined ? {} : { evidenceOrigins: evidenceOrigins as FactOrigin[] }),
    ...(authorities === undefined ? {} : { authorities: authorities as FactAuthority[] }),
    ...(evidenceStates === undefined ? {} : { evidenceStates: evidenceStates as EvidenceState[] }),
    ...(stopNodeKinds === undefined ? {} : { stopNodeKinds }),
    maxDepth: raw.maxDepth as number,
    maxNodes: raw.maxNodes as number,
  });
}
