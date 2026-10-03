import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RepoGraphError } from './error.js';
import { VERSION } from './version.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const json = z.json();
const metadata = z.record(z.string(), json);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const nonempty = z.string().min(1);
const provenanceSchema = z.object({
  repoId: nonempty, commit: oid, extractor: nonempty, extractorVersion: nonempty,
  path: z.string().optional(), blobOid: oid.optional(), source: nonempty.optional(),
  line: z.number().int().positive().optional(), index: z.number().int().nonnegative().optional()
}).strict();
const nodeSchema = z.object({
  id: nonempty, type: nonempty, key: z.string(), classification: z.enum(['source', 'derived']),
  metadata: metadata, provenance: z.array(provenanceSchema).min(1)
}).strict();
const edgeSchema = z.object({
  id: nonempty, type: nonempty, from: nonempty, to: nonempty, qualifier: z.string(),
  classification: z.enum(['source', 'derived']), metadata: metadata,
  provenance: z.array(provenanceSchema).min(1)
}).strict();
export const rulesSchema = z.object({ schemaVersion: z.literal(1), rules: z.array(z.object({
  id: nonempty, pattern: nonempty, metadata: metadata.optional()
}).strict()) }).strict();
const documentSchema = z.object({
  schemaVersion: z.literal(1), producerVersion: nonempty,
  repository: z.object({ id: nonempty, commit: oid }).strict(),
  policy: z.object({ include: z.array(z.string()), exclude: z.array(z.string()), codeowners: z.boolean(),
    rules: rulesSchema.nullable(), omittedEntries: z.number().int().nonnegative() }).strict(),
  nodes: z.array(nodeSchema), edges: z.array(edgeSchema),
  diagnostics: z.array(z.object({ code: nonempty, message: nonempty, source: z.string().optional(),
    line: z.number().int().positive().optional() }).strict())
}).strict();
export type Provenance = z.infer<typeof provenanceSchema>;
export type GraphNode = z.infer<typeof nodeSchema>;
export type GraphEdge = z.infer<typeof edgeSchema>;
export type GraphDocument = z.infer<typeof documentSchema>;
export type RulesDocument = z.infer<typeof rulesSchema>;

/** Ordinal comparison: independent of operating system locale. */
export function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compare).map(key => [key, canonical(value[key]!)]));
  }
  return value;
}
export function canonicalJSON(value: unknown): string {
  const parsed = json.safeParse(value);
  if (!parsed.success) throw new RepoGraphError('INVALID_JSON', 'Values must be finite, JSON-compatible data');
  return JSON.stringify(canonical(parsed.data));
}
function hash(parts: string[]) { return createHash('sha256').update(canonicalJSON(parts)).digest('hex'); }
export function nodeId(repoId: string, type: string, key: string): string { return `n:${hash([repoId, type, key])}`; }
export function edgeId(type: string, from: string, to: string, qualifier = ''): string { return `e:${hash([type, from, to, qualifier])}`; }

function validate(document: unknown): GraphDocument {
  const result = documentSchema.safeParse(document);
  if (!result.success) throw new RepoGraphError('INVALID_GRAPH', 'Malformed graph or unsupported schema', { issues: result.error.issues });
  const graph = result.data;
  const nodes = new Set<string>(); const edges = new Set<string>();
  for (const record of [...graph.nodes, ...graph.edges]) {
    for (const p of record.provenance) {
      if (p.repoId !== graph.repository.id || p.commit !== graph.repository.commit) {
        throw new RepoGraphError('INVALID_PROVENANCE', 'Fact belongs to a different snapshot', { id: record.id });
      }
    }
  }
  for (const n of graph.nodes) {
    if (n.id !== nodeId(graph.repository.id, n.type, n.key)) throw new RepoGraphError('INVALID_ID', 'Node identity mismatch', { id: n.id });
    if (nodes.has(n.id)) throw new RepoGraphError('DUPLICATE_ID', 'Duplicate node', { id: n.id });
    nodes.add(n.id);
  }
  for (const e of graph.edges) {
    if (e.id !== edgeId(e.type, e.from, e.to, e.qualifier)) throw new RepoGraphError('INVALID_ID', 'Edge identity mismatch', { id: e.id });
    if (edges.has(e.id)) throw new RepoGraphError('DUPLICATE_ID', 'Duplicate edge', { id: e.id });
    if (!nodes.has(e.from) || !nodes.has(e.to)) throw new RepoGraphError('DANGLING_EDGE', 'Edge endpoint missing', { id: e.id });
    edges.add(e.id);
  }
  return graph;
}
function provenanceOrder(items: Provenance[]) {
  const unique = new Map(items.map(p => [canonicalJSON(p), p]));
  return [...unique.entries()].sort(([a], [b]) => compare(a, b)).map(([, p]) => p);
}
function ordered(graph: GraphDocument): GraphDocument {
  return { ...graph,
    policy: { ...graph.policy, include: [...new Set(graph.policy.include)].sort(compare), exclude: [...new Set(graph.policy.exclude)].sort(compare) },
    nodes: graph.nodes.map(n => ({ ...n, provenance: provenanceOrder(n.provenance) })).sort((a,b) => compare(a.id,b.id)),
    edges: graph.edges.map(e => ({ ...e, provenance: provenanceOrder(e.provenance) })).sort((a,b) => compare(a.id,b.id)),
    diagnostics: [...graph.diagnostics].sort((a,b) => compare(canonicalJSON(a),canonicalJSON(b)))
  };
}
export function serializeGraph(graph: GraphDocument): string { return canonicalJSON(ordered(validate(graph))); }

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class LoadedGraph {
  readonly document: GraphDocument;
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly forward: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly reverse: ReadonlyMap<string, readonly GraphEdge[]>;
  constructor(document: GraphDocument) {
    this.document = freeze(ordered(validate(document)));
    const nodes = new Map(this.document.nodes.map(n => [n.id, n]));
    const forward = new Map<string, GraphEdge[]>(); const reverse = new Map<string, GraphEdge[]>();
    for (const n of nodes.values()) { forward.set(n.id, []); reverse.set(n.id, []); }
    for (const e of this.document.edges) { forward.get(e.from)!.push(e); reverse.get(e.to)!.push(e); }
    for (const entries of [...forward.values(), ...reverse.values()]) Object.freeze(entries);
    this.nodes = nodes; this.forward = forward; this.reverse = reverse;
  }
}
export function loadGraph(input: string | unknown): LoadedGraph {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { throw new RepoGraphError('INVALID_GRAPH', 'Graph is not valid JSON'); }
  }
  return new LoadedGraph(validate(value));
}

/** Builder converges duplicate facts while rejecting inconsistent payloads. */
export class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  constructor(public readonly repoId: string, public readonly commit: string) {}
  private add<T extends GraphNode | GraphEdge>(map: Map<string, T>, record: T): T {
    const previous = map.get(record.id);
    if (previous && canonicalJSON({ ...previous, provenance: [] }) !== canonicalJSON({ ...record, provenance: [] })) {
      throw new RepoGraphError('FACT_CONFLICT', 'Conflicting fact with the same identity', { id: record.id });
    }
    const merged = { ...record, provenance: provenanceOrder([...(previous?.provenance ?? []), ...record.provenance]) };
    map.set(record.id, merged); return merged;
  }
  addNode(node: GraphNode): GraphNode { return this.add(this.nodes, node); }
  addEdge(edge: GraphEdge): GraphEdge { return this.add(this.edges, edge); }
  document(policy: GraphDocument['policy'], diagnostics: GraphDocument['diagnostics'] = []): GraphDocument {
    return ordered(validate({ schemaVersion: 1, producerVersion: VERSION,
      repository: { id: this.repoId, commit: this.commit }, policy,
      nodes: [...this.nodes.values()], edges: [...this.edges.values()], diagnostics }));
  }
}
