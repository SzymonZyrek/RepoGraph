import { Connection, Database, type LbugValue } from "@ladybugdb/core";
import { CAUSAL_SCHEMA, queryPolicy, validateFacts, type CausalAnswer, type CausalEdge, type CausalEvidence, type CausalNode, type ProviderFacts, type QueryPolicy } from "./causal-model.js";

type Row = Record<string, LbugValue>;
const order = (a: CausalEdge, b: CausalEdge) => `${a.from}\0${a.kind}\0${a.to}`.localeCompare(`${b.from}\0${b.kind}\0${b.to}`, "en");

/** Internal storage adapter. No native DB values escape the repo/ref API. */
export class EmbeddedCausalStore {
  private readonly db: Database;
  private readonly connection: Connection;
  constructor(path: string) {
    this.db = new Database(path, 64 * 1024 * 1024);
    this.connection = new Connection(this.db, 2);
  }
  async rows(cypher: string, params: Record<string, LbugValue> = {}): Promise<Row[]> {
    const prepared = await this.connection.prepare(cypher);
    const result = await this.connection.execute(prepared, params);
    if (Array.isArray(result)) throw new Error("Multiple statements are not supported");
    try { return await result.getAll(); } finally { result.close(); }
  }
  async open(): Promise<void> {
    for (const statement of [
      "CREATE NODE TABLE IF NOT EXISTS Entity(id STRING PRIMARY KEY, type STRING, path STRING, kind STRING, key STRING, roles STRING[])",
      "CREATE NODE TABLE IF NOT EXISTS Evidence(id STRING PRIMARY KEY, owner STRING, value STRING)",
      "CREATE NODE TABLE IF NOT EXISTS Provider(owner STRING PRIMARY KEY, fingerprint STRING, partial BOOL, diagnostics STRING[])",
      "CREATE NODE TABLE IF NOT EXISTS Claim(id STRING PRIMARY KEY, owner STRING, node STRING, roles STRING[])",
      "CREATE NODE TABLE IF NOT EXISTS Metadata(id STRING PRIMARY KEY, repository STRING, commit STRING, configuration STRING, schema STRING, partial BOOL, diagnostics STRING[])",
      "CREATE REL TABLE IF NOT EXISTS Causal(FROM Entity TO Entity, kind STRING, owner STRING, evidence STRING[])",
    ]) await this.rows(statement);
    const current = await this.metadata();
    if (current && current.schema !== CAUSAL_SCHEMA) throw new Error("Unsupported causal index schema; rebuild the disposable index");
  }
  async close(): Promise<void> { await this.connection.close(); await this.db.close(); }
  async metadata(): Promise<Row | undefined> { return (await this.rows("MATCH (m:Metadata) WHERE m.id = 'revision' RETURN m.repository AS repository, m.commit AS commit, m.configuration AS configuration, m.schema AS schema, m.partial AS partial, m.diagnostics AS diagnostics"))[0]; }
  async providers(): Promise<Row[]> { return this.rows("MATCH (p:Provider) RETURN p.owner AS owner, p.fingerprint AS fingerprint, p.partial AS partial, p.diagnostics AS diagnostics ORDER BY p.owner"); }
  async replace(repository: string, commit: string, configuration: string, replacements: ProviderFacts[], remove: string[] = []): Promise<void> {
    replacements.forEach(validateFacts);
    await this.rows("BEGIN TRANSACTION");
    try {
      const touched = new Set(replacements.flatMap(facts => facts.nodes.map(node => node.id)));
      for (const owner of [...remove, ...replacements.map(facts => facts.provider)]) {
        for (const row of await this.rows("MATCH (c:Claim) WHERE c.owner=$owner RETURN c.node AS node", { owner })) touched.add(String(row.node));
        await this.rows("MATCH ()-[r:Causal]->() WHERE r.owner = $owner DELETE r", { owner });
        await this.rows("MATCH (c:Claim) WHERE c.owner = $owner DELETE c", { owner });
        await this.rows("MATCH (e:Evidence) WHERE e.owner = $owner DELETE e", { owner });
        await this.rows("MATCH (p:Provider) WHERE p.owner = $owner DELETE p", { owner });
      }
      for (const facts of replacements) {
        for (const node of facts.nodes) {
          const prior = await this.rows("MATCH (n:Entity) WHERE n.id = $id RETURN n.type AS type, n.kind AS kind, n.key AS key, n.path AS path", { id: node.id });
          if (prior[0] && (prior[0].type !== node.type || (node.type === "boundary" && (prior[0].kind !== node.kind || prior[0].key !== node.key)))) throw new Error("Conflicting normalized node identity");
          await this.rows("MERGE (n:Entity {id: $id}) SET n.type=$type, n.path=$path, n.kind=$kind, n.key=$key", {
            id: node.id, type: node.type, path: node.type === "artifact" ? node.path : "", kind: node.type === "boundary" ? node.kind : "", key: node.type === "boundary" ? node.key : "",
          });
          await this.rows("CREATE (:Claim {id:$id, owner:$owner, node:$node, roles:$roles})", { id: JSON.stringify([facts.provider, node.id]), owner: facts.provider, node: node.id, roles: node.type === "artifact" ? node.roles : [] });
        }
        for (const item of facts.evidence) await this.rows("CREATE (:Evidence {id:$id, owner:$owner, value:$value})", { id: item.id, owner: facts.provider, value: JSON.stringify(item) });
        for (const edge of facts.edges) await this.rows("MATCH (a:Entity), (b:Entity) WHERE a.id=$from AND b.id=$to CREATE (a)-[:Causal {kind:$kind, owner:$owner, evidence:$evidence}]->(b)", { from: edge.from, to: edge.to, kind: edge.kind, owner: facts.provider, evidence: edge.evidence });
        await this.rows("CREATE (:Provider {owner:$owner, fingerprint:$fingerprint, partial:$partial, diagnostics:$diagnostics})", { owner: facts.provider, fingerprint: facts.fingerprint, partial: facts.partial, diagnostics: facts.diagnostics });
      }
      // Orphan removal and role consolidation are index maintenance, never query materialization.
      await this.rows("MATCH (n:Entity) WHERE NOT EXISTS { MATCH (c:Claim) WHERE c.node=n.id } DETACH DELETE n");
      for (const id of touched) {
        const claims = await this.rows("MATCH (c:Claim) WHERE c.node=$id RETURN c.roles AS roles", { id });
        const roles = [...new Set(claims.flatMap(row => row.roles as string[]))].sort();
        await this.rows("MATCH (n:Entity) WHERE n.id=$id SET n.roles=$roles", { id, roles });
      }
      const states = await this.rows("MATCH (p:Provider) WHERE p.partial=true RETURN p.diagnostics AS diagnostics ORDER BY p.owner LIMIT 20");
      const diagnostics = [...new Set(states.flatMap(row => row.diagnostics as string[]))].sort().slice(0, 20);
      await this.rows("MERGE (m:Metadata {id:'revision'}) SET m.repository=$repository, m.commit=$commit, m.configuration=$configuration, m.schema=$schema, m.partial=$partial, m.diagnostics=$diagnostics", { repository, commit, configuration, schema: CAUSAL_SCHEMA, partial: states.length > 0, diagnostics });
      await this.rows("COMMIT");
    } catch (error) { await this.rows("ROLLBACK"); throw error; }
  }
  private async nodes(ids: string[]): Promise<CausalNode[]> {
    if (!ids.length) return [];
    const rows = await this.rows("MATCH (n:Entity) WHERE n.id IN $ids RETURN n.id AS id, n.type AS type, n.path AS path, n.roles AS roles, n.kind AS kind, n.key AS key ORDER BY n.id", { ids });
    return rows.map(row => row.type === "artifact" ? { id: String(row.id), type: "artifact", path: String(row.path), roles: row.roles as Extract<CausalNode, { type: "artifact" }>["roles"] } : { id: String(row.id), type: "boundary", kind: String(row.kind), key: String(row.key) });
  }
  private async neighbors(ids: string[], policy: Required<QueryPolicy>, limit: number): Promise<{ edges: CausalEdge[]; overflow: boolean }> {
    const condition = policy.direction === "in" ? "b.id IN $ids" : policy.direction === "out" ? "a.id IN $ids" : "(a.id IN $ids OR b.id IN $ids)";
    const rows = await this.rows(`MATCH (a:Entity)-[r:Causal]->(b:Entity) WHERE ${condition} AND r.kind IN $relations RETURN a.id AS from, b.id AS to, r.kind AS kind, r.evidence AS evidence ORDER BY a.id, r.kind, b.id, r.owner LIMIT ${limit}`, { ids, relations: policy.relations });
    const merged = new Map<string, CausalEdge>();
    for (const row of rows) {
      const edge = { from: String(row.from), to: String(row.to), kind: row.kind as CausalEdge["kind"], evidence: row.evidence as string[] };
      const key = JSON.stringify([edge.from, edge.kind, edge.to]);
      const prior = merged.get(key);
      if (prior) prior.evidence = [...new Set([...prior.evidence, ...edge.evidence])].sort();
      else merged.set(key, edge);
    }
    return { edges: [...merged.values()].sort(order), overflow: rows.length >= limit };
  }
  async query(repository: string, commit: string, starts: string[], input: QueryPolicy = {}, target?: string): Promise<CausalAnswer> {
    const policy = queryPolicy(input);
    const metadata = await this.metadata();
    if (!metadata || metadata.repository !== repository || metadata.commit !== commit) throw new Error("Requested revision is not indexed");
    const available = await this.nodes([...new Set(starts)].sort().slice(0, policy.maxNodes));
    const visited = new Set(available.map(node => node.id));
    const missing = [...new Set(starts)].filter(id => !visited.has(id));
    let frontier = [...visited];
    const edges: CausalEdge[] = [];
    const parents = new Map<string, { id: string; edge: CausalEdge }>();
    let truncated = starts.length > policy.maxNodes;
    for (let depth = 0; frontier.length && depth <= policy.maxDepth && !visited.has(target ?? ""); depth++) {
      const next: string[] = [];
      const found = await this.neighbors(frontier, policy, policy.maxEdges - edges.length + 1);
      truncated ||= found.overflow;
      for (const edge of found.edges) {
        const candidates = policy.direction === "in" ? [edge.from] : policy.direction === "out" ? [edge.to] : [edge.from, edge.to];
        for (const id of candidates) {
          if (visited.has(id)) continue;
          if (depth === policy.maxDepth || visited.size >= policy.maxNodes || edges.length >= policy.maxEdges) { truncated = true; continue; }
          visited.add(id); next.push(id);
          parents.set(id, { id: frontier.includes(edge.from) ? edge.from : edge.to, edge });
        }
        if (visited.has(edge.from) && visited.has(edge.to) && !edges.some(item => item.from === edge.from && item.to === edge.to && item.kind === edge.kind)) {
          if (edges.length >= policy.maxEdges) truncated = true;
          else edges.push(edge);
        }
      }
      frontier = next.sort();
    }
    let selected = [...visited];
    let selectedEdges = edges;
    if (target !== undefined) {
      selected = visited.has(target) ? [target] : [];
      selectedEdges = [];
      let id = target;
      while (parents.has(id)) { const parent = parents.get(id)!; selected.push(parent.id); selectedEdges.push(parent.edge); id = parent.id; }
    }
    const evidenceIds = [...new Set(selectedEdges.flatMap(edge => edge.evidence))].sort();
    const evidenceRows = evidenceIds.length ? await this.rows("MATCH (e:Evidence) WHERE e.id IN $ids RETURN e.value AS value ORDER BY e.id", { ids: evidenceIds }) : [];
    return { schemaVersion: CAUSAL_SCHEMA, repository, commit, nodes: await this.nodes(selected), edges: selectedEdges.sort(order),
      evidence: evidenceRows.map(row => JSON.parse(String(row.value)) as CausalEvidence), partial: missing.length > 0 || metadata.partial === true, truncated,
      diagnostics: [...new Set([...missing.map(id => `Unknown query start: ${id}`), ...metadata.diagnostics as string[]])].sort().slice(0, 20) };
  }
}
