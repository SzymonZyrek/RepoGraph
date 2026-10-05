import { createHash } from "node:crypto";

export const CAUSAL_SCHEMA = "repograph.causal/v1";
export const ARTIFACT_ROLES = ["validation", "documentation", "contract", "configuration", "build", "generated"] as const;
export type ArtifactRole = typeof ARTIFACT_ROLES[number];
export type CausalNode =
  | { id: string; type: "artifact"; path: string; roles: ArtifactRole[] }
  | { id: string; type: "boundary"; kind: string; key: string };
export type CausalEdgeKind = "DEPENDS_ON" | "CONTAINS";
export type EvidenceClass = "precise-index" | "native-build" | "protocol-contract" | "deterministic-repo" | "explicit-overlay";
export interface CausalEvidence {
  id: string;
  provider: string;
  version: string;
  fingerprint: string;
  class: EvidenceClass;
  state: "complete" | "partial";
  source?: string;
  authority?: "authoritative" | "advisory";
}
export interface CausalEdge { from: string; to: string; kind: CausalEdgeKind; evidence: string[] }
export interface ProviderFacts {
  provider: string;
  fingerprint: string;
  nodes: CausalNode[];
  edges: CausalEdge[];
  evidence: CausalEvidence[];
  partial: boolean;
  diagnostics: string[];
}
export interface QueryPolicy {
  direction?: "in" | "out" | "both";
  relations?: CausalEdgeKind[];
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
}
export interface CausalAnswer {
  schemaVersion: typeof CAUSAL_SCHEMA;
  repository: string;
  commit: string;
  nodes: CausalNode[];
  edges: CausalEdge[];
  evidence: CausalEvidence[];
  partial: boolean;
  truncated: boolean;
  diagnostics: string[];
}
export function fingerprint(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function artifact(path: string, roles: ArtifactRole[] = []): CausalNode {
  if (!path || path.length > 2048 || /[\x00-\x1f]/.test(path) || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Invalid repository artifact path: ${path}`);
  }
  if (roles.some(role => !ARTIFACT_ROLES.includes(role))) throw new Error("Unknown artifact role");
  return { id: `artifact:${path}`, type: "artifact", path, roles: [...new Set(roles)].sort() };
}
export function boundary(kind: string, key: string): CausalNode {
  if (!/^[a-z][a-z0-9-]*$/.test(kind) || !key || key.length > 2048 || /[\x00-\x1f]/.test(key)) throw new Error("Invalid boundary identity");
  return { id: `boundary:${kind}:${key}`, type: "boundary", kind, key };
}
export function validateFacts(facts: ProviderFacts): void {
  if (!facts.provider || !facts.fingerprint) throw new Error("Provider identity is required");
  const ids = new Set<string>();
  for (const node of facts.nodes) {
    const fields = node.type === "artifact" ? ["id", "type", "path", "roles"] : ["id", "type", "kind", "key"];
    if (Object.keys(node).some(key => !fields.includes(key))) throw new Error("Provider cannot extend node schema");
    const normalized = node.type === "artifact" ? artifact(node.path, node.roles) : node.type === "boundary" ? boundary(node.kind, node.key) : undefined;
    if (!normalized || normalized.id !== node.id || ids.has(node.id)) throw new Error(`Invalid/duplicate node: ${node.id}`);
    ids.add(node.id);
  }
  const evidence = new Set<string>();
  for (const item of facts.evidence) {
    if (Object.keys(item).some(key => !["id", "provider", "version", "fingerprint", "class", "state", "source", "authority"].includes(key)) ||
      (item.source !== undefined && (typeof item.source !== "string" || item.source.length > 2048)) ||
      (item.authority !== undefined && !["authoritative", "advisory"].includes(item.authority))) throw new Error("Provider cannot extend compact evidence schema");
    if (item.provider !== facts.provider || item.fingerprint !== facts.fingerprint || !item.version || evidence.has(item.id) || !item.id ||
      !["precise-index", "native-build", "protocol-contract", "deterministic-repo", "explicit-overlay"].includes(item.class) ||
      !["complete", "partial"].includes(item.state)) throw new Error("Invalid provider evidence");
    evidence.add(item.id);
  }
  for (const edge of facts.edges) {
    if (Object.keys(edge).some(key => !["from", "to", "kind", "evidence"].includes(key))) throw new Error("Provider cannot extend edge schema");
    if (!ids.has(edge.from) || !ids.has(edge.to) || !["DEPENDS_ON", "CONTAINS"].includes(edge.kind) ||
      (edge.kind === "CONTAINS" && !edge.from.startsWith("boundary:")) || !edge.evidence.length || edge.evidence.some(id => !evidence.has(id))) {
      throw new Error(`Invalid causal relation: ${edge.from} -> ${edge.to}`);
    }
  }
}
export function queryPolicy(policy: QueryPolicy = {}): Required<QueryPolicy> {
  const result = { direction: policy.direction ?? "in", relations: policy.relations ?? ["DEPENDS_ON"],
    maxDepth: policy.maxDepth ?? 16, maxNodes: policy.maxNodes ?? 200, maxEdges: policy.maxEdges ?? 1000 };
  if (!["in", "out", "both"].includes(result.direction) || result.relations.some(kind => !["DEPENDS_ON", "CONTAINS"].includes(kind))) throw new Error("Invalid traversal policy");
  for (const [name, limit] of [["maxDepth", 64], ["maxNodes", 1000], ["maxEdges", 5000]] as const) {
    if (!Number.isInteger(result[name]) || result[name] < (name === "maxDepth" ? 0 : 1) || result[name] > limit) throw new Error(`Invalid ${name}; maximum ${limit}`);
  }
  return result as Required<QueryPolicy>;
}
