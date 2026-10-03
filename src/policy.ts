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

export const TRAVERSAL_POLICY_SCHEMA_VERSION =
  "repograph.traversal-policy/v1" as const;

export interface EvidenceFilter {
  origins?: readonly FactOrigin[];
  methods?: readonly EvidenceMethod[];
  states?: readonly EvidenceState[];
  authorities?: readonly FactAuthority[];
  overlayNames?: readonly string[];
}

export interface TraversalPolicy {
  direction?: TraversalDirection;
  nodeKinds?: readonly string[];
  edgeKinds?: readonly string[];
  edgeEvidence?: EvidenceFilter;
  nodeEvidence?: EvidenceFilter;
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  stopNodeKinds?: readonly string[];
}

export interface NormalizedTraversalPolicy {
  schemaVersion: typeof TRAVERSAL_POLICY_SCHEMA_VERSION;
  direction: TraversalDirection;
  nodeKinds: string[];
  edgeKinds: string[];
  edgeEvidence: NormalizedEvidenceFilter;
  nodeEvidence: NormalizedEvidenceFilter;
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  stopNodeKinds: string[];
}

export interface NormalizedEvidenceFilter {
  origins: FactOrigin[];
  methods: EvidenceMethod[];
  states: EvidenceState[];
  authorities: FactAuthority[];
  overlayNames: string[];
}

export interface PolicyReason {
  nodeId: string;
  fromNodeId: string;
  edgeId: string;
  depth: number;
  matchedEdgeProvenance: Provenance[];
  matchedNodeProvenance: Provenance[];
}

export interface PolicyTraversalResult {
  start: string;
  policy: NormalizedTraversalPolicy;
  nodes: GraphNode[];
  edges: GraphEdge[];
  reasons: PolicyReason[];
  truncated: boolean;
  truncationReasons: Array<"max-depth" | "max-nodes" | "max-edges">;
}

export interface PolicyPathStep {
  fromNodeId: string;
  toNodeId: string;
  edge: GraphEdge;
  matchedEdgeProvenance: Provenance[];
  matchedNodeProvenance: Provenance[];
}

export interface PolicyPathResult {
  from: string;
  to: string;
  found: boolean;
  policy: NormalizedTraversalPolicy;
  nodes: GraphNode[];
  steps: PolicyPathStep[];
  truncated: boolean;
  truncationReasons: Array<"max-depth" | "max-nodes" | "max-edges">;
}

interface AllowedStep {
  node: GraphNode;
  edge: GraphEdge;
  matchedEdgeProvenance: Provenance[];
  matchedNodeProvenance: Provenance[];
}

function uniqueSorted<T extends string>(values: readonly T[] | undefined): T[] {
  return [...new Set(values ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new GraphValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new GraphValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeEvidence(
  filter: EvidenceFilter | undefined,
): NormalizedEvidenceFilter {
  return {
    origins: uniqueSorted(filter?.origins),
    methods: uniqueSorted(filter?.methods),
    states: uniqueSorted(filter?.states),
    authorities: uniqueSorted(filter?.authorities),
    overlayNames: uniqueSorted(filter?.overlayNames),
  };
}

export function normalizeTraversalPolicy(
  policy: TraversalPolicy = {},
): NormalizedTraversalPolicy {
  const direction = policy.direction ?? "out";
  if (direction !== "out" && direction !== "in" && direction !== "both") {
    throw new GraphValidationError("policy direction must be out, in, or both");
  }

  return {
    schemaVersion: TRAVERSAL_POLICY_SCHEMA_VERSION,
    direction,
    nodeKinds: uniqueSorted(policy.nodeKinds),
    edgeKinds: uniqueSorted(policy.edgeKinds),
    edgeEvidence: normalizeEvidence(policy.edgeEvidence),
    nodeEvidence: normalizeEvidence(policy.nodeEvidence),
    maxDepth: nonNegativeInteger(
      policy.maxDepth,
      Number.MAX_SAFE_INTEGER,
      "policy maxDepth",
    ),
    maxNodes: positiveInteger(policy.maxNodes, 10_000, "policy maxNodes"),
    maxEdges: positiveInteger(policy.maxEdges, 20_000, "policy maxEdges"),
    stopNodeKinds: uniqueSorted(policy.stopNodeKinds),
  };
}

function includesOrAny<T extends string>(
  values: readonly T[],
  value: T | undefined,
): boolean {
  return values.length === 0 || (value !== undefined && values.includes(value));
}

export function matchingProvenance(
  provenance: readonly Provenance[],
  filter: EvidenceFilter | NormalizedEvidenceFilter = {},
): Provenance[] {
  const normalized = normalizeEvidence(filter);
  return provenance
    .filter(
      (item) =>
        includesOrAny(normalized.origins, item.origin) &&
        includesOrAny(normalized.methods, item.method) &&
        includesOrAny(normalized.states, item.state) &&
        includesOrAny(normalized.authorities, item.authority) &&
        (normalized.overlayNames.length === 0 ||
          (item.overlay !== undefined &&
            normalized.overlayNames.includes(item.overlay.name))),
    )
    .sort((left, right) =>
      canonicalJsonUnknown(left).localeCompare(canonicalJsonUnknown(right)),
    );
}

function nodeAllowed(
  node: GraphNode,
  policy: NormalizedTraversalPolicy,
): Provenance[] | undefined {
  if (
    policy.nodeKinds.length > 0 &&
    !policy.nodeKinds.includes(node.identity.kind)
  ) {
    return undefined;
  }
  const matched = matchingProvenance(node.provenance, policy.nodeEvidence);
  return matched.length === 0 ? undefined : matched;
}

function edgeAllowed(
  edge: GraphEdge,
  policy: NormalizedTraversalPolicy,
): Provenance[] | undefined {
  if (
    policy.edgeKinds.length > 0 &&
    !policy.edgeKinds.includes(edge.identity.kind)
  ) {
    return undefined;
  }
  const matched = matchingProvenance(edge.provenance, policy.edgeEvidence);
  return matched.length === 0 ? undefined : matched;
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

function adjacent(
  graph: GraphDocument,
  id: string,
  policy: NormalizedTraversalPolicy,
): AllowedStep[] {
  const nodes = nodeMap(graph);
  const steps: AllowedStep[] = [];

  for (const edge of graph.edges) {
    const matchedEdgeProvenance = edgeAllowed(edge, policy);
    if (matchedEdgeProvenance === undefined) continue;

    const candidates: string[] = [];
    if (
      (policy.direction === "out" || policy.direction === "both") &&
      edge.identity.from === id
    ) {
      candidates.push(edge.identity.to);
    }
    if (
      (policy.direction === "in" || policy.direction === "both") &&
      edge.identity.to === id
    ) {
      candidates.push(edge.identity.from);
    }

    for (const candidate of candidates) {
      const node = nodes.get(candidate);
      if (node === undefined) continue;
      const matchedNodeProvenance = nodeAllowed(node, policy);
      if (matchedNodeProvenance === undefined) continue;
      steps.push({
        node,
        edge,
        matchedEdgeProvenance,
        matchedNodeProvenance,
      });
    }
  }

  return steps.sort((left, right) => {
    const byNode = left.node.id.localeCompare(right.node.id);
    return byNode !== 0 ? byNode : left.edge.id.localeCompare(right.edge.id);
  });
}

function addTruncation(
  reasons: Set<"max-depth" | "max-nodes" | "max-edges">,
  reason: "max-depth" | "max-nodes" | "max-edges",
): void {
  reasons.add(reason);
}

export function traverseWithPolicy(
  graph: GraphDocument,
  start: string,
  input: TraversalPolicy | NormalizedTraversalPolicy = {},
): PolicyTraversalResult {
  requireNode(graph, start);
  const policy =
    "schemaVersion" in input
      ? normalizeTraversalPolicy(input)
      : normalizeTraversalPolicy(input);

  const visited = new Set<string>([start]);
  const selectedNodes = new Map<string, GraphNode>();
  const selectedEdges = new Map<string, GraphEdge>();
  const reasons = new Map<string, PolicyReason>();
  const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
  const truncationReasons = new Set<
    "max-depth" | "max-nodes" | "max-edges"
  >();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const candidates = adjacent(graph, current.id, policy);

    if (current.depth >= policy.maxDepth) {
      if (candidates.some((step) => !visited.has(step.node.id))) {
        addTruncation(truncationReasons, "max-depth");
      }
      continue;
    }

    for (const step of candidates) {
      if (visited.has(step.node.id)) continue;

      if (selectedNodes.size >= policy.maxNodes) {
        addTruncation(truncationReasons, "max-nodes");
        queue.length = 0;
        break;
      }
      if (
        !selectedEdges.has(step.edge.id) &&
        selectedEdges.size >= policy.maxEdges
      ) {
        addTruncation(truncationReasons, "max-edges");
        queue.length = 0;
        break;
      }

      visited.add(step.node.id);
      selectedNodes.set(step.node.id, step.node);
      selectedEdges.set(step.edge.id, step.edge);
      reasons.set(step.node.id, {
        nodeId: step.node.id,
        fromNodeId: current.id,
        edgeId: step.edge.id,
        depth: current.depth + 1,
        matchedEdgeProvenance: step.matchedEdgeProvenance,
        matchedNodeProvenance: step.matchedNodeProvenance,
      });

      if (!policy.stopNodeKinds.includes(step.node.identity.kind)) {
        queue.push({ id: step.node.id, depth: current.depth + 1 });
      }
    }
  }

  return {
    start,
    policy,
    nodes: [...selectedNodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: [...selectedEdges.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    reasons: [...reasons.values()].sort(
      (left, right) =>
        left.depth - right.depth || left.nodeId.localeCompare(right.nodeId),
    ),
    truncated: truncationReasons.size > 0,
    truncationReasons: [...truncationReasons].sort(),
  };
}

export function affectedWithPolicy(
  graph: GraphDocument,
  changed: string,
  input: Omit<TraversalPolicy, "direction"> = {},
): PolicyTraversalResult {
  return traverseWithPolicy(graph, changed, { ...input, direction: "in" });
}

export function explainWithPolicy(
  graph: GraphDocument,
  from: string,
  to: string,
  input: TraversalPolicy | NormalizedTraversalPolicy = {},
): PolicyPathResult {
  const fromNode = requireNode(graph, from);
  requireNode(graph, to);
  const policy =
    "schemaVersion" in input
      ? normalizeTraversalPolicy(input)
      : normalizeTraversalPolicy(input);
  const truncationReasons = new Set<
    "max-depth" | "max-nodes" | "max-edges"
  >();

  if (from === to) {
    return {
      from,
      to,
      found: true,
      policy,
      nodes: [fromNode],
      steps: [],
      truncated: false,
      truncationReasons: [],
    };
  }

  const nodes = nodeMap(graph);
  const visited = new Set<string>([from]);
  const queue: Array<{ id: string; depth: number }> = [{ id: from, depth: 0 }];
  const previous = new Map<
    string,
    {
      prior: string;
      edge: GraphEdge;
      matchedEdgeProvenance: Provenance[];
      matchedNodeProvenance: Provenance[];
    }
  >();
  let traversedEdges = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const candidates = adjacent(graph, current.id, policy);

    if (current.depth >= policy.maxDepth) {
      if (candidates.some((step) => !visited.has(step.node.id))) {
        addTruncation(truncationReasons, "max-depth");
      }
      continue;
    }

    for (const step of candidates) {
      if (visited.has(step.node.id)) continue;
      if (visited.size - 1 >= policy.maxNodes) {
        addTruncation(truncationReasons, "max-nodes");
        queue.length = 0;
        break;
      }
      if (traversedEdges >= policy.maxEdges) {
        addTruncation(truncationReasons, "max-edges");
        queue.length = 0;
        break;
      }

      traversedEdges += 1;
      visited.add(step.node.id);
      previous.set(step.node.id, {
        prior: current.id,
        edge: step.edge,
        matchedEdgeProvenance: step.matchedEdgeProvenance,
        matchedNodeProvenance: step.matchedNodeProvenance,
      });

      if (step.node.id === to) {
        const pathNodeIds = [to];
        const steps: PolicyPathStep[] = [];
        let cursor = to;

        while (cursor !== from) {
          const link = previous.get(cursor);
          if (link === undefined) {
            throw new GraphValidationError(
              "Broken policy causal path reconstruction",
            );
          }
          steps.push({
            fromNodeId: link.prior,
            toNodeId: cursor,
            edge: link.edge,
            matchedEdgeProvenance: link.matchedEdgeProvenance,
            matchedNodeProvenance: link.matchedNodeProvenance,
          });
          cursor = link.prior;
          pathNodeIds.push(cursor);
        }

        pathNodeIds.reverse();
        steps.reverse();
        return {
          from,
          to,
          found: true,
          policy,
          nodes: pathNodeIds.map((id) => nodes.get(id)!).filter(Boolean),
          steps,
          truncated: truncationReasons.size > 0,
          truncationReasons: [...truncationReasons].sort(),
        };
      }

      if (!policy.stopNodeKinds.includes(step.node.identity.kind)) {
        queue.push({ id: step.node.id, depth: current.depth + 1 });
      }
    }
  }

  return {
    from,
    to,
    found: false,
    policy,
    nodes: [],
    steps: [],
    truncated: truncationReasons.size > 0,
    truncationReasons: [...truncationReasons].sort(),
  };
}

export function serializeTraversalPolicy(policy: TraversalPolicy): string {
  return canonicalJsonUnknown(normalizeTraversalPolicy(policy));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GraphValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GraphValidationError(`${label} must be an array of strings`);
  }
  return value as string[];
}

function enumArray<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T[] | undefined {
  const values = stringArray(value, label);
  if (values === undefined) return undefined;
  for (const item of values) {
    if (!allowed.includes(item as T)) {
      throw new GraphValidationError(
        `${label} contains unsupported value: ${item}`,
      );
    }
  }
  return values as T[];
}

function numberValue(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new GraphValidationError(`${label} must be a number`);
  }
  return value;
}

function parseEvidence(
  value: unknown,
  label: string,
): EvidenceFilter | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, label);
  const origins = enumArray(
    raw.origins,
    `${label}.origins`,
    ["source", "derived", "overlay"] as const,
  );
  const methods = enumArray(
    raw.methods,
    `${label}.methods`,
    [
      "source-observation",
      "deterministic-extraction",
      "external-index",
      "explicit-overlay",
    ] as const,
  );
  const states = enumArray(
    raw.states,
    `${label}.states`,
    ["complete", "partial", "unresolved"] as const,
  );
  const authorities = enumArray(
    raw.authorities,
    `${label}.authorities`,
    ["authoritative", "advisory"] as const,
  );
  const overlayNames = stringArray(raw.overlayNames, `${label}.overlayNames`);

  return {
    ...(origins === undefined ? {} : { origins }),
    ...(methods === undefined ? {} : { methods }),
    ...(states === undefined ? {} : { states }),
    ...(authorities === undefined ? {} : { authorities }),
    ...(overlayNames === undefined ? {} : { overlayNames }),
  };
}

export function parseTraversalPolicy(serialized: string): NormalizedTraversalPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new GraphValidationError(
      `Traversal policy JSON is malformed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const raw = record(parsed, "traversal policy");
  if (
    raw.schemaVersion !== undefined &&
    raw.schemaVersion !== TRAVERSAL_POLICY_SCHEMA_VERSION
  ) {
    throw new GraphValidationError(
      `Unsupported traversal policy schema: ${String(raw.schemaVersion)}`,
    );
  }

  const direction = raw.direction;
  if (
    direction !== undefined &&
    direction !== "out" &&
    direction !== "in" &&
    direction !== "both"
  ) {
    throw new GraphValidationError(
      "traversal policy direction must be out, in, or both",
    );
  }

  return normalizeTraversalPolicy({
    ...(direction === undefined ? {} : { direction }),
    ...(stringArray(raw.nodeKinds, "traversal policy nodeKinds") === undefined
      ? {}
      : { nodeKinds: stringArray(raw.nodeKinds, "traversal policy nodeKinds") }),
    ...(stringArray(raw.edgeKinds, "traversal policy edgeKinds") === undefined
      ? {}
      : { edgeKinds: stringArray(raw.edgeKinds, "traversal policy edgeKinds") }),
    ...(parseEvidence(raw.edgeEvidence, "traversal policy edgeEvidence") ===
    undefined
      ? {}
      : { edgeEvidence: parseEvidence(raw.edgeEvidence, "traversal policy edgeEvidence") }),
    ...(parseEvidence(raw.nodeEvidence, "traversal policy nodeEvidence") ===
    undefined
      ? {}
      : { nodeEvidence: parseEvidence(raw.nodeEvidence, "traversal policy nodeEvidence") }),
    ...(numberValue(raw.maxDepth, "traversal policy maxDepth") === undefined
      ? {}
      : { maxDepth: numberValue(raw.maxDepth, "traversal policy maxDepth") }),
    ...(numberValue(raw.maxNodes, "traversal policy maxNodes") === undefined
      ? {}
      : { maxNodes: numberValue(raw.maxNodes, "traversal policy maxNodes") }),
    ...(numberValue(raw.maxEdges, "traversal policy maxEdges") === undefined
      ? {}
      : { maxEdges: numberValue(raw.maxEdges, "traversal policy maxEdges") }),
    ...(stringArray(raw.stopNodeKinds, "traversal policy stopNodeKinds") ===
    undefined
      ? {}
      : {
          stopNodeKinds: stringArray(
            raw.stopNodeKinds,
            "traversal policy stopNodeKinds",
          ),
        }),
  });
}
