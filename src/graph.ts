import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical.js";
import {
  GRAPH_SCHEMA_VERSION,
  type EdgeIdentity,
  type EvidenceMethod,
  type EvidenceState,
  type FactAuthority,
  type FactOrigin,
  type GraphDiagnostic,
  type GraphDocument,
  type GraphEdge,
  type GraphEdgeInput,
  type GraphInput,
  type GraphNode,
  type GraphNodeInput,
  type JsonObject,
  type JsonValue,
  type NodeIdentity,
  type Provenance,
} from "./model.js";

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export class GraphConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphConflictError";
  }
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[key] = asJsonValue(item);
      }
    }
    return result;
  }
  throw new GraphValidationError("Value is not valid JSON");
}

function stableHash(prefix: "node" | "edge", identity: JsonValue): string {
  const digest = createHash("sha256").update(canonicalJson(identity)).digest("hex");
  return `${prefix}:${digest}`;
}

function nodeIdentityJson(identity: NodeIdentity): JsonValue {
  return {
    key: identity.key,
    kind: identity.kind,
    namespace: identity.namespace,
  };
}

function edgeIdentityJson(identity: EdgeIdentity): JsonValue {
  const value: Record<string, JsonValue> = {
    from: identity.from,
    kind: identity.kind,
    to: identity.to,
  };
  if (identity.key !== undefined) {
    value.key = identity.key;
  }
  return value;
}

export function nodeId(identity: NodeIdentity): string {
  assertNonEmpty(identity.namespace, "node identity namespace");
  assertNonEmpty(identity.kind, "node identity kind");
  assertNonEmpty(identity.key, "node identity key");
  return stableHash("node", nodeIdentityJson(identity));
}

export function edgeId(identity: EdgeIdentity): string {
  assertNonEmpty(identity.kind, "edge identity kind");
  assertNonEmpty(identity.from, "edge identity from");
  assertNonEmpty(identity.to, "edge identity to");
  if (identity.key !== undefined) {
    assertNonEmpty(identity.key, "edge identity key");
  }
  return stableHash("edge", edgeIdentityJson(identity));
}

function provenanceJson(value: Provenance): JsonValue {
  const json: Record<string, JsonValue> = {
    method: value.method,
    origin: value.origin,
    ref: value.ref,
    repository: value.repository,
    state: value.state,
  };
  if (value.authority !== undefined) json.authority = value.authority;
  if (value.overlay !== undefined) {
    json.overlay = {
      name: value.overlay.name,
      version: value.overlay.version,
    };
  }
  if (value.commit !== undefined) json.commit = value.commit;
  if (value.path !== undefined) json.path = value.path;
  if (value.extractor !== undefined) {
    json.extractor = {
      name: value.extractor.name,
      version: value.extractor.version,
    };
  }
  if (value.diagnostic !== undefined) json.diagnostic = value.diagnostic;
  return json;
}

function sortUniqueProvenance(values: Provenance[]): Provenance[] {
  const byCanonical = new Map<string, Provenance>();
  for (const value of values) {
    validateProvenance(value);
    byCanonical.set(canonicalJson(provenanceJson(value)), value);
  }
  return [...byCanonical.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function metadataEqual(left?: JsonObject, right?: JsonObject): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalJson(left) === canonicalJson(right);
}

function mergeNode(existing: GraphNode, incoming: GraphNode): GraphNode {
  if (!metadataEqual(existing.metadata, incoming.metadata)) {
    throw new GraphConflictError(
      `Node ${existing.id} has conflicting metadata for one stable identity`,
    );
  }
  return {
    ...existing,
    provenance: sortUniqueProvenance([
      ...existing.provenance,
      ...incoming.provenance,
    ]),
  };
}

function mergeEdge(existing: GraphEdge, incoming: GraphEdge): GraphEdge {
  if (!metadataEqual(existing.metadata, incoming.metadata)) {
    throw new GraphConflictError(
      `Edge ${existing.id} has conflicting metadata for one stable identity`,
    );
  }
  return {
    ...existing,
    provenance: sortUniqueProvenance([
      ...existing.provenance,
      ...incoming.provenance,
    ]),
  };
}

export function makeNode(input: GraphNodeInput): GraphNode {
  requireFactProvenance(input.provenance, "node");
  return {
    id: nodeId(input.identity),
    identity: { ...input.identity },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    provenance: sortUniqueProvenance(input.provenance),
  };
}

export function makeEdge(input: GraphEdgeInput): GraphEdge {
  requireFactProvenance(input.provenance, "edge");
  return {
    id: edgeId(input.identity),
    identity: { ...input.identity },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    provenance: sortUniqueProvenance(input.provenance),
  };
}

export function buildGraph(input: GraphInput): GraphDocument {
  const nodes = new Map<string, GraphNode>();
  for (const nodeInput of input.nodes ?? []) {
    const node = makeNode(nodeInput);
    const existing = nodes.get(node.id);
    nodes.set(node.id, existing === undefined ? node : mergeNode(existing, node));
  }

  const edges = new Map<string, GraphEdge>();
  for (const edgeInput of input.edges ?? []) {
    const edge = makeEdge(edgeInput);
    if (!nodes.has(edge.identity.from) || !nodes.has(edge.identity.to)) {
      throw new GraphValidationError(
        `Edge ${edge.id} references a missing node endpoint`,
      );
    }
    const existing = edges.get(edge.id);
    edges.set(edge.id, existing === undefined ? edge : mergeEdge(existing, edge));
  }

  const diagnostics = [...(input.diagnostics ?? [])]
    .map(validateDiagnostic)
    .sort((left, right) =>
      canonicalJson(asJsonValue(left)).localeCompare(canonicalJson(asJsonValue(right))),
    );

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
  };
}

export function serializeGraph(graph: GraphDocument): string {
  validateGraphDocument(graph);
  return canonicalJson(asJsonValue(graph));
}

export function graphEquals(left: GraphDocument, right: GraphDocument): boolean {
  return serializeGraph(left) === serializeGraph(right);
}

export function parseGraph(serialized: string): GraphDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new GraphValidationError(
      `Graph JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = requireRecord(parsed, "graph document");
  if (raw.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new GraphValidationError(
      `Unsupported schema version: ${String(raw.schemaVersion)}`,
    );
  }

  const rawNodes = requireArray(raw.nodes, "graph nodes");
  const rawEdges = requireArray(raw.edges, "graph edges");
  const rawDiagnostics = requireArray(raw.diagnostics, "graph diagnostics");

  const nodeInputs: GraphNodeInput[] = rawNodes.map((value, index) => {
    const node = requireRecord(value, `node[${index}]`);
    const identity = parseNodeIdentity(node.identity, `node[${index}].identity`);
    const expectedId = nodeId(identity);
    const actualId = requireString(node.id, `node[${index}].id`);
    if (actualId !== expectedId) {
      throw new GraphValidationError(
        `node[${index}] id does not match its stable identity`,
      );
    }
    return {
      identity,
      ...(node.metadata === undefined
        ? {}
        : { metadata: parseJsonObject(node.metadata, `node[${index}].metadata`) }),
      provenance: requireArray(node.provenance, `node[${index}].provenance`).map(
        (item, provenanceIndex) =>
          parseProvenance(
            item,
            `node[${index}].provenance[${provenanceIndex}]`,
          ),
      ),
    };
  });

  const edgeInputs: GraphEdgeInput[] = rawEdges.map((value, index) => {
    const edge = requireRecord(value, `edge[${index}]`);
    const identity = parseEdgeIdentity(edge.identity, `edge[${index}].identity`);
    const expectedId = edgeId(identity);
    const actualId = requireString(edge.id, `edge[${index}].id`);
    if (actualId !== expectedId) {
      throw new GraphValidationError(
        `edge[${index}] id does not match its stable identity`,
      );
    }
    return {
      identity,
      ...(edge.metadata === undefined
        ? {}
        : { metadata: parseJsonObject(edge.metadata, `edge[${index}].metadata`) }),
      provenance: requireArray(edge.provenance, `edge[${index}].provenance`).map(
        (item, provenanceIndex) =>
          parseProvenance(
            item,
            `edge[${index}].provenance[${provenanceIndex}]`,
          ),
      ),
    };
  });

  const diagnostics = rawDiagnostics.map((item, index) =>
    parseDiagnostic(item, `diagnostic[${index}]`),
  );

  return buildGraph({
    nodes: nodeInputs,
    edges: edgeInputs,
    diagnostics,
  });
}

function validateGraphDocument(graph: GraphDocument): void {
  if (graph.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new GraphValidationError(
      `Unsupported schema version: ${String(graph.schemaVersion)}`,
    );
  }
  const normalized = buildGraph({
    nodes: graph.nodes.map(({ identity, metadata, provenance }) => ({
      identity,
      ...(metadata === undefined ? {} : { metadata }),
      provenance,
    })),
    edges: graph.edges.map(({ identity, metadata, provenance }) => ({
      identity,
      ...(metadata === undefined ? {} : { metadata }),
      provenance,
    })),
    diagnostics: graph.diagnostics,
  });
  if (canonicalJson(asJsonValue(normalized)) !== canonicalJson(asJsonValue(graph))) {
    throw new GraphValidationError(
      "Graph document is not normalized or contains inconsistent stable identities",
    );
  }
}

function requireFactProvenance(values: Provenance[], label: string): void {
  if (values.length === 0) {
    throw new GraphValidationError(`${label} must carry at least one provenance record`);
  }
}

function validateProvenance(value: Provenance): void {
  assertNonEmpty(value.repository, "provenance repository");
  assertNonEmpty(value.ref, "provenance ref");
  if (value.commit !== undefined) assertNonEmpty(value.commit, "provenance commit");
  if (value.path !== undefined) assertNonEmpty(value.path, "provenance path");
  if (value.diagnostic !== undefined) {
    assertNonEmpty(value.diagnostic, "provenance diagnostic");
  }
  if (value.extractor !== undefined) {
    assertNonEmpty(value.extractor.name, "extractor name");
    assertNonEmpty(value.extractor.version, "extractor version");
  }
  if (value.overlay !== undefined) {
    assertNonEmpty(value.overlay.name, "overlay name");
    assertNonEmpty(value.overlay.version, "overlay version");
  }
  if (value.authority !== undefined) {
    assertAllowed<FactAuthority>(
      value.authority,
      ["authoritative", "advisory"],
      "provenance authority",
    );
  }
  assertAllowed<FactOrigin>(
    value.origin,
    ["source", "derived", "overlay"],
    "provenance origin",
  );
  assertAllowed<EvidenceMethod>(
    value.method,
    [
      "source-observation",
      "deterministic-extraction",
      "external-index",
      "explicit-overlay",
    ],
    "provenance method",
  );
  assertAllowed<EvidenceState>(
    value.state,
    ["complete", "partial", "unresolved"],
    "provenance state",
  );

  if (value.origin === "overlay") {
    if (value.method !== "explicit-overlay") {
      throw new GraphValidationError(
        "overlay provenance must use explicit-overlay evidence method",
      );
    }
    if (value.overlay === undefined) {
      throw new GraphValidationError(
        "overlay provenance must identify overlay name and version",
      );
    }
    if (value.authority === undefined) {
      throw new GraphValidationError(
        "overlay provenance must declare authoritative or advisory authority",
      );
    }
  } else if (value.overlay !== undefined || value.authority !== undefined) {
    throw new GraphValidationError(
      "overlay identity/authority are only valid for overlay provenance",
    );
  }
}

function validateDiagnostic(value: GraphDiagnostic): GraphDiagnostic {
  assertNonEmpty(value.code, "diagnostic code");
  assertNonEmpty(value.message, "diagnostic message");
  assertAllowed(value.state, ["partial", "unresolved"] as const, "diagnostic state");
  if (value.provenance !== undefined) validateProvenance(value.provenance);
  return value;
}

function parseNodeIdentity(value: unknown, label: string): NodeIdentity {
  const record = requireRecord(value, label);
  return {
    namespace: requireString(record.namespace, `${label}.namespace`),
    kind: requireString(record.kind, `${label}.kind`),
    key: requireString(record.key, `${label}.key`),
  };
}

function parseEdgeIdentity(value: unknown, label: string): EdgeIdentity {
  const record = requireRecord(value, label);
  return {
    kind: requireString(record.kind, `${label}.kind`),
    from: requireString(record.from, `${label}.from`),
    to: requireString(record.to, `${label}.to`),
    ...(record.key === undefined
      ? {}
      : { key: requireString(record.key, `${label}.key`) }),
  };
}

function parseProvenance(value: unknown, label: string): Provenance {
  const record = requireRecord(value, label);
  const extractor =
    record.extractor === undefined
      ? undefined
      : (() => {
          const rawExtractor = requireRecord(record.extractor, `${label}.extractor`);
          return {
            name: requireString(rawExtractor.name, `${label}.extractor.name`),
            version: requireString(rawExtractor.version, `${label}.extractor.version`),
          };
        })();

  const provenance: Provenance = {
    repository: requireString(record.repository, `${label}.repository`),
    ref: requireString(record.ref, `${label}.ref`),
    ...(record.commit === undefined
      ? {}
      : { commit: requireString(record.commit, `${label}.commit`) }),
    ...(record.path === undefined
      ? {}
      : { path: requireString(record.path, `${label}.path`) }),
    ...(extractor === undefined ? {} : { extractor }),
    origin: requireAllowed(
      record.origin,
      ["source", "derived", "overlay"] as const,
      `${label}.origin`,
    ),
    method: requireAllowed(
      record.method,
      [
        "source-observation",
        "deterministic-extraction",
        "external-index",
        "explicit-overlay",
      ] as const,
      `${label}.method`,
    ),
    state: requireAllowed(
      record.state,
      ["complete", "partial", "unresolved"] as const,
      `${label}.state`,
    ),
    ...(record.authority === undefined
      ? {}
      : {
          authority: requireAllowed(
            record.authority,
            ["authoritative", "advisory"] as const,
            `${label}.authority`,
          ),
        }),
    ...(record.overlay === undefined
      ? {}
      : {
          overlay: (() => {
            const rawOverlay = requireRecord(record.overlay, `${label}.overlay`);
            return {
              name: requireString(rawOverlay.name, `${label}.overlay.name`),
              version: requireString(rawOverlay.version, `${label}.overlay.version`),
            };
          })(),
        }),
    ...(record.diagnostic === undefined
      ? {}
      : { diagnostic: requireString(record.diagnostic, `${label}.diagnostic`) }),
  };
  validateProvenance(provenance);
  return provenance;
}

function parseDiagnostic(value: unknown, label: string): GraphDiagnostic {
  const record = requireRecord(value, label);
  return validateDiagnostic({
    code: requireString(record.code, `${label}.code`),
    message: requireString(record.message, `${label}.message`),
    state: requireAllowed(
      record.state,
      ["partial", "unresolved"] as const,
      `${label}.state`,
    ),
    ...(record.provenance === undefined
      ? {}
      : { provenance: parseProvenance(record.provenance, `${label}.provenance`) }),
  });
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new GraphValidationError(`${label} must be a JSON object`);
  }
  return asJsonValue(value) as JsonObject;
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphValidationError(`${label} must be a non-empty string`);
  }
}

function assertAllowed<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new GraphValidationError(
      `${label} must be one of: ${allowed.join(", ")}`,
    );
  }
}

function requireAllowed<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  const text = requireString(value, label);
  if (!allowed.includes(text as T[number])) {
    throw new GraphValidationError(
      `${label} must be one of: ${allowed.join(", ")}`,
    );
  }
  return text as T[number];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new GraphValidationError(`${label} must be an array`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new GraphValidationError(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
