import { canonicalJsonUnknown } from "./canonical.js";
import { VERSION } from "./generated-version.js";
import { parseGraph } from "./graph.js";
import {
  GRAPH_SCHEMA_VERSION,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type JsonObject,
  type Provenance,
} from "./model.js";
import {
  createTraversalPolicy,
  explainWithPolicy,
  traverseWithPolicy,
  validateTraversalPolicy,
  type PolicyCausalPath,
  type PolicyTraversalSlice,
  type TraversalPolicy,
} from "./policy.js";

export const REPOGRAPH_PROTOCOL_VERSION = "repograph.protocol/v1" as const;
export const REPOGRAPH_PROTOCOL_DEFAULT_MAX_DEPTH = 6;
export const REPOGRAPH_PROTOCOL_DEFAULT_MAX_NODES = 200;
export const REPOGRAPH_PROTOCOL_MAX_DEPTH = 64;
export const REPOGRAPH_PROTOCOL_MAX_NODES = 1_000;

export type ProtocolFeatureStatus = "stable" | "experimental" | "deprecated";

export interface ProtocolFeature {
  name: string;
  version: string;
  status: ProtocolFeatureStatus;
}

export interface ProtocolInfo {
  protocolVersion: typeof REPOGRAPH_PROTOCOL_VERSION;
  releaseVersion: string;
  graphSchemaVersion: typeof GRAPH_SCHEMA_VERSION;
  features: ProtocolFeature[];
  limits: {
    defaultMaxDepth: number;
    defaultMaxNodes: number;
    maxDepth: number;
    maxNodes: number;
  };
}

export interface ProtocolInfoRequest {
  operation: "info";
  requestId?: string;
  acceptedProtocolVersions?: string[];
}

export interface ProtocolSliceRequest {
  protocolVersion: typeof REPOGRAPH_PROTOCOL_VERSION;
  operation: "slice";
  requestId?: string;
  graph: GraphDocument;
  start: string;
  policy?: TraversalPolicy;
}

export interface ProtocolExplainRequest {
  protocolVersion: typeof REPOGRAPH_PROTOCOL_VERSION;
  operation: "explain";
  requestId?: string;
  graph: GraphDocument;
  from: string;
  to: string;
  policy?: TraversalPolicy;
}

export type ProtocolRequest =
  | ProtocolInfoRequest
  | ProtocolSliceRequest
  | ProtocolExplainRequest;

export interface ProtocolProvenanceDto {
  repository: string;
  ref: string;
  commit?: string;
  path?: string;
  extractor?: {
    name: string;
    version: string;
  };
  origin: Provenance["origin"];
  method: Provenance["method"];
  state: Provenance["state"];
  authority?: Provenance["authority"];
  overlay?: {
    name: string;
    version: string;
  };
  diagnostic?: string;
}

export interface ProtocolNodeDto {
  id: string;
  namespace: string;
  kind: string;
  key: string;
  metadata?: JsonObject;
  provenance: ProtocolProvenanceDto[];
}

export interface ProtocolEdgeDto {
  id: string;
  kind: string;
  from: string;
  to: string;
  key?: string;
  metadata?: JsonObject;
  provenance: ProtocolProvenanceDto[];
}

export interface ProtocolUnavailable {
  code: string;
  message: string;
}

export interface ProtocolSliceDto {
  type: "graph-slice";
  availability: "available" | "unavailable";
  start: string;
  policy: TraversalPolicy;
  nodes: ProtocolNodeDto[];
  edges: ProtocolEdgeDto[];
  partial: boolean;
  truncated: boolean;
  unavailable?: ProtocolUnavailable;
}

export interface ProtocolExplanationHopDto {
  fromNodeId: string;
  toNodeId: string;
  edge: ProtocolEdgeDto;
  matchedProvenance: ProtocolProvenanceDto[];
}

export interface ProtocolExplanationDto {
  type: "causal-explanation";
  availability: "available" | "unavailable";
  from: string;
  to: string;
  policy: TraversalPolicy;
  nodes: ProtocolNodeDto[];
  hops: ProtocolExplanationHopDto[];
  partial: boolean;
  truncated: boolean;
  unavailable?: ProtocolUnavailable;
}

export interface ProtocolInfoDto extends ProtocolInfo {
  type: "protocol-info";
  negotiatedProtocolVersion: typeof REPOGRAPH_PROTOCOL_VERSION | null;
}

export type ProtocolData =
  | ProtocolInfoDto
  | ProtocolSliceDto
  | ProtocolExplanationDto;

export interface ProtocolSuccess {
  protocolVersion: typeof REPOGRAPH_PROTOCOL_VERSION;
  releaseVersion: string;
  ok: true;
  requestId?: string;
  data: ProtocolData;
}

export interface ProtocolFailure {
  protocolVersion: typeof REPOGRAPH_PROTOCOL_VERSION;
  releaseVersion: string;
  ok: false;
  requestId?: string;
  error: {
    code: string;
    message: string;
  };
}

export type ProtocolResponse = ProtocolSuccess | ProtocolFailure;

const FEATURES: readonly ProtocolFeature[] = [
  { name: "causal-explanation", version: "v1", status: "stable" },
  { name: "cross-repository", version: "v1", status: "experimental" },
  { name: "extractor-plugins", version: "v1", status: "experimental" },
  { name: "graph-slice", version: "v1", status: "stable" },
  { name: "store-lifecycle", version: "v1", status: "experimental" },
  { name: "traversal-policy", version: "v1", status: "stable" },
] as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  name: string,
): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string when supplied`);
  }
  return value;
}

function stringArray(
  record: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return [...new Set(value)].sort();
}

function parseGraphValue(value: unknown): GraphDocument {
  return parseGraph(canonicalJsonUnknown(value));
}

function boundedPolicy(value: unknown): TraversalPolicy {
  const policy =
    value === undefined
      ? createTraversalPolicy({
          maxDepth: REPOGRAPH_PROTOCOL_DEFAULT_MAX_DEPTH,
          maxNodes: REPOGRAPH_PROTOCOL_DEFAULT_MAX_NODES,
        })
      : validateTraversalPolicy(value);

  if (policy.maxDepth > REPOGRAPH_PROTOCOL_MAX_DEPTH) {
    throw new TypeError(
      `policy.maxDepth exceeds protocol maximum ${REPOGRAPH_PROTOCOL_MAX_DEPTH}`,
    );
  }
  if (policy.maxNodes > REPOGRAPH_PROTOCOL_MAX_NODES) {
    throw new TypeError(
      `policy.maxNodes exceeds protocol maximum ${REPOGRAPH_PROTOCOL_MAX_NODES}`,
    );
  }
  return policy;
}

function parseInfoRequest(raw: Record<string, unknown>): ProtocolInfoRequest {
  const requestId = optionalString(raw, "requestId");
  const acceptedProtocolVersions = stringArray(
    raw,
    "acceptedProtocolVersions",
  );
  return {
    operation: "info",
    ...(requestId === undefined ? {} : { requestId }),
    ...(acceptedProtocolVersions === undefined
      ? {}
      : { acceptedProtocolVersions }),
  };
}

function requireProtocolVersion(
  raw: Record<string, unknown>,
): typeof REPOGRAPH_PROTOCOL_VERSION {
  const version = requiredString(raw, "protocolVersion");
  if (version !== REPOGRAPH_PROTOCOL_VERSION) {
    throw new UnsupportedProtocolError(version);
  }
  return REPOGRAPH_PROTOCOL_VERSION;
}

function parseSliceRequest(raw: Record<string, unknown>): ProtocolSliceRequest {
  requireProtocolVersion(raw);
  const requestId = optionalString(raw, "requestId");
  const start = requiredString(raw, "start");
  return {
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "slice",
    ...(requestId === undefined ? {} : { requestId }),
    graph: parseGraphValue(raw.graph),
    start,
    policy: boundedPolicy(raw.policy),
  };
}

function parseExplainRequest(
  raw: Record<string, unknown>,
): ProtocolExplainRequest {
  requireProtocolVersion(raw);
  const requestId = optionalString(raw, "requestId");
  return {
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    operation: "explain",
    ...(requestId === undefined ? {} : { requestId }),
    graph: parseGraphValue(raw.graph),
    from: requiredString(raw, "from"),
    to: requiredString(raw, "to"),
    policy: boundedPolicy(raw.policy),
  };
}

class UnsupportedProtocolError extends Error {
  constructor(readonly requestedVersion: string) {
    super(
      `Unsupported protocol version ${requestedVersion}; supported: ${REPOGRAPH_PROTOCOL_VERSION}`,
    );
    this.name = "UnsupportedProtocolError";
  }
}

export function parseProtocolRequest(value: unknown): ProtocolRequest {
  const raw = asRecord(value, "protocol request");
  const operation = requiredString(raw, "operation");
  if (operation === "info") return parseInfoRequest(raw);
  if (operation === "slice") return parseSliceRequest(raw);
  if (operation === "explain") return parseExplainRequest(raw);
  throw new TypeError(`Unsupported protocol operation: ${operation}`);
}

export function protocolInfo(): ProtocolInfo {
  return {
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    releaseVersion: VERSION,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    features: FEATURES.map((feature) => ({ ...feature })),
    limits: {
      defaultMaxDepth: REPOGRAPH_PROTOCOL_DEFAULT_MAX_DEPTH,
      defaultMaxNodes: REPOGRAPH_PROTOCOL_DEFAULT_MAX_NODES,
      maxDepth: REPOGRAPH_PROTOCOL_MAX_DEPTH,
      maxNodes: REPOGRAPH_PROTOCOL_MAX_NODES,
    },
  };
}

export function negotiateProtocol(
  acceptedProtocolVersions: readonly string[],
): typeof REPOGRAPH_PROTOCOL_VERSION | null {
  return acceptedProtocolVersions.includes(REPOGRAPH_PROTOCOL_VERSION)
    ? REPOGRAPH_PROTOCOL_VERSION
    : null;
}

function provenanceDto(value: Provenance): ProtocolProvenanceDto {
  return {
    repository: value.repository,
    ref: value.ref,
    ...(value.commit === undefined ? {} : { commit: value.commit }),
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.extractor === undefined
      ? {}
      : { extractor: { ...value.extractor } }),
    origin: value.origin,
    method: value.method,
    state: value.state,
    ...(value.authority === undefined ? {} : { authority: value.authority }),
    ...(value.overlay === undefined ? {} : { overlay: { ...value.overlay } }),
    ...(value.diagnostic === undefined
      ? {}
      : { diagnostic: value.diagnostic }),
  };
}

function nodeDto(node: GraphNode): ProtocolNodeDto {
  return {
    id: node.id,
    namespace: node.identity.namespace,
    kind: node.identity.kind,
    key: node.identity.key,
    ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
    provenance: node.provenance.map(provenanceDto),
  };
}

function edgeDto(edge: GraphEdge): ProtocolEdgeDto {
  return {
    id: edge.id,
    kind: edge.identity.kind,
    from: edge.identity.from,
    to: edge.identity.to,
    ...(edge.identity.key === undefined ? {} : { key: edge.identity.key }),
    ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
    provenance: edge.provenance.map(provenanceDto),
  };
}

function unavailableSlice(
  start: string,
  policy: TraversalPolicy,
  code: string,
  message: string,
): ProtocolSliceDto {
  return {
    type: "graph-slice",
    availability: "unavailable",
    start,
    policy,
    nodes: [],
    edges: [],
    partial: true,
    truncated: false,
    unavailable: { code, message },
  };
}

function sliceDto(
  graph: GraphDocument,
  start: string,
  policy: TraversalPolicy,
): ProtocolSliceDto {
  if (!graph.nodes.some((node) => node.id === start)) {
    return unavailableSlice(
      start,
      policy,
      "unknown-node",
      `Graph does not contain start node ${start}`,
    );
  }

  const slice: PolicyTraversalSlice = traverseWithPolicy(
    graph,
    start,
    policy,
  );
  return {
    type: "graph-slice",
    availability: "available",
    start: slice.start,
    policy: slice.policy,
    nodes: slice.nodes.map(nodeDto),
    edges: slice.edges.map(edgeDto),
    partial: slice.partial,
    truncated: slice.truncated,
  };
}

function unavailableExplanation(
  from: string,
  to: string,
  policy: TraversalPolicy,
  code: string,
  message: string,
): ProtocolExplanationDto {
  return {
    type: "causal-explanation",
    availability: "unavailable",
    from,
    to,
    policy,
    nodes: [],
    hops: [],
    partial: true,
    truncated: false,
    unavailable: { code, message },
  };
}

function explanationDto(
  graph: GraphDocument,
  from: string,
  to: string,
  policy: TraversalPolicy,
): ProtocolExplanationDto {
  const missing = [from, to].filter(
    (id) => !graph.nodes.some((node) => node.id === id),
  );
  if (missing.length > 0) {
    return unavailableExplanation(
      from,
      to,
      policy,
      "unknown-node",
      `Graph does not contain node(s): ${missing.join(", ")}`,
    );
  }

  const path: PolicyCausalPath | null = explainWithPolicy(
    graph,
    from,
    to,
    policy,
  );
  if (path === null) {
    return unavailableExplanation(
      from,
      to,
      policy,
      "no-path",
      "No causal path matches the supplied traversal policy and bounds",
    );
  }

  return {
    type: "causal-explanation",
    availability: "available",
    from: path.from,
    to: path.to,
    policy: path.policy,
    nodes: path.nodes.map(nodeDto),
    hops: path.hops.map((hop) => ({
      fromNodeId: hop.fromNodeId,
      toNodeId: hop.toNodeId,
      edge: edgeDto(hop.edge),
      matchedProvenance: hop.matchedProvenance.map(provenanceDto),
    })),
    partial: path.partial,
    truncated: false,
  };
}

function requestIdFromUnknown(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : undefined;
}

function success(
  data: ProtocolData,
  requestId?: string,
): ProtocolSuccess {
  return {
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    releaseVersion: VERSION,
    ok: true,
    ...(requestId === undefined ? {} : { requestId }),
    data,
  };
}

function failure(
  code: string,
  message: string,
  requestId?: string,
): ProtocolFailure {
  return {
    protocolVersion: REPOGRAPH_PROTOCOL_VERSION,
    releaseVersion: VERSION,
    ok: false,
    ...(requestId === undefined ? {} : { requestId }),
    error: { code, message },
  };
}

export function executeProtocolRequest(value: unknown): ProtocolResponse {
  const requestId = requestIdFromUnknown(value);
  try {
    const request = parseProtocolRequest(value);
    if (request.operation === "info") {
      const info = protocolInfo();
      const accepted = request.acceptedProtocolVersions;
      return success(
        {
          type: "protocol-info",
          ...info,
          negotiatedProtocolVersion:
            accepted === undefined
              ? REPOGRAPH_PROTOCOL_VERSION
              : negotiateProtocol(accepted),
        },
        request.requestId,
      );
    }

    if (request.operation === "slice") {
      return success(
        sliceDto(
          request.graph,
          request.start,
          request.policy ??
            createTraversalPolicy({
              maxDepth: REPOGRAPH_PROTOCOL_DEFAULT_MAX_DEPTH,
              maxNodes: REPOGRAPH_PROTOCOL_DEFAULT_MAX_NODES,
            }),
        ),
        request.requestId,
      );
    }

    return success(
      explanationDto(
        request.graph,
        request.from,
        request.to,
        request.policy ??
          createTraversalPolicy({
            maxDepth: REPOGRAPH_PROTOCOL_DEFAULT_MAX_DEPTH,
            maxNodes: REPOGRAPH_PROTOCOL_DEFAULT_MAX_NODES,
          }),
      ),
      request.requestId,
    );
  } catch (error) {
    if (error instanceof UnsupportedProtocolError) {
      return failure("unsupported-protocol", error.message, requestId);
    }
    return failure(
      "invalid-request",
      error instanceof Error ? error.message : String(error),
      requestId,
    );
  }
}

export function serializeProtocolResponse(response: ProtocolResponse): string {
  return canonicalJsonUnknown(response);
}
