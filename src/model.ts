export const GRAPH_SCHEMA_VERSION = "repograph.graph/v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type FactOrigin = "source" | "derived" | "overlay";

export type EvidenceMethod =
  | "source-observation"
  | "deterministic-extraction"
  | "external-index"
  | "explicit-overlay";

export type EvidenceState = "complete" | "partial" | "unresolved";
export type FactAuthority = "authoritative" | "advisory";

export interface OverlayRef {
  name: string;
  version: string;
}

export interface ExtractorRef {
  name: string;
  version: string;
}

export interface Provenance {
  repository: string;
  ref: string;
  commit?: string;
  path?: string;
  extractor?: ExtractorRef;
  origin: FactOrigin;
  method: EvidenceMethod;
  state: EvidenceState;
  authority?: FactAuthority;
  overlay?: OverlayRef;
  diagnostic?: string;
}

export interface NodeIdentity {
  namespace: string;
  kind: string;
  key: string;
}

export interface EdgeIdentity {
  kind: string;
  from: string;
  to: string;
  key?: string;
}

export interface GraphNode {
  id: string;
  identity: NodeIdentity;
  metadata?: JsonObject;
  provenance: Provenance[];
}

export interface GraphEdge {
  id: string;
  identity: EdgeIdentity;
  metadata?: JsonObject;
  provenance: Provenance[];
}

export interface GraphDiagnostic {
  code: string;
  message: string;
  state: Exclude<EvidenceState, "complete">;
  provenance?: Provenance;
}

export interface GraphDocument {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: GraphDiagnostic[];
}

export interface GraphNodeInput {
  identity: NodeIdentity;
  metadata?: JsonObject;
  provenance: Provenance[];
}

export interface GraphEdgeInput {
  identity: EdgeIdentity;
  metadata?: JsonObject;
  provenance: Provenance[];
}

export interface GraphInput {
  nodes?: GraphNodeInput[];
  edges?: GraphEdgeInput[];
  diagnostics?: GraphDiagnostic[];
}
