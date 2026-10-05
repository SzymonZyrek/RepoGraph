import { posix } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parseYaml } from "yaml";
import protobuf from "protobufjs";
import { artifact, boundary, fingerprint, validateFacts, type CausalEdgeKind, type CausalNode, type EvidenceClass, type ProviderFacts } from "./causal-model.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected mapping");
  return value as Record<string, unknown>;
}
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => { if (typeof value !== "string" || !value) throw new Error("Expected non-empty string"); return value; };

/** Providers can only emit the closed causal schema. */
export class FactCollector {
  readonly facts: ProviderFacts;
  private readonly nodes = new Map<string, CausalNode>();
  constructor(provider: string, input: string | Uint8Array, evidenceClass: EvidenceClass, source?: string, authority?: "authoritative" | "advisory") {
    const hash = fingerprint(input);
    this.facts = { provider, fingerprint: hash, nodes: [], edges: [], evidence: [{ id: `evidence:${fingerprint(`${provider}:${hash}`)}`, provider, version: "1", fingerprint: hash, class: evidenceClass, state: "complete", ...(source === undefined ? {} : { source }), ...(authority === undefined ? {} : { authority }) }], partial: false, diagnostics: [] };
  }
  add(node: CausalNode): string {
    const previous = this.nodes.get(node.id);
    if (previous?.type === "artifact" && node.type === "artifact") node = artifact(node.path, [...previous.roles, ...node.roles]);
    this.nodes.set(node.id, node); return node.id;
  }
  edge(from: string, to: string, kind: CausalEdgeKind = "DEPENDS_ON"): void {
    if (from === to) return;
    if (!this.facts.edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)) this.facts.edges.push({ from, to, kind, evidence: [this.facts.evidence[0]!.id] });
  }
  partial(message: string): void {
    this.facts.partial = true; this.facts.evidence[0]!.state = "partial";
    this.facts.diagnostics.push(`${this.facts.provider}: ${message}`);
  }
  finish(): ProviderFacts {
    this.facts.nodes = [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
    this.facts.edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
    this.facts.diagnostics = [...new Set(this.facts.diagnostics)].sort();
    validateFacts(this.facts); return this.facts;
  }
}

// Wire-compatible subset of the official SCIP schema: unknown fields are skipped,
// and symbol/position inventories never become persisted graph nodes.
export const scipIndexType = protobuf.parse(`syntax="proto3";
message Occurrence { string symbol=2; int32 symbol_roles=3; }
message Document { string relative_path=1; repeated Occurrence occurrences=2; }
message ToolInfo { string name=1; string version=2; }
message Metadata { ToolInfo tool_info=2; }
message Index { Metadata metadata=1; repeated Document documents=2; }`).root.lookupType("Index");

export function scipFacts(bytes: Uint8Array, knownPaths: Set<string>, owner = "scip"): ProviderFacts {
  const index = object(scipIndexType.toObject(scipIndexType.decode(bytes), { defaults: true }));
  const facts = new FactCollector(owner, bytes, "precise-index");
  const docs = list(index.documents).map(object);
  const definitions = new Map<string, Set<string>>();
  for (const doc of docs) {
    const path = text(doc.relativePath);
    if (!knownPaths.has(path)) { facts.partial(`index references missing artifact ${path}`); continue; }
    facts.add(artifact(path));
    for (const raw of list(doc.occurrences)) {
      const occurrence = object(raw);
      const symbol = String(occurrence.symbol ?? "");
      if (!symbol || symbol.startsWith("local ") || !(Number(occurrence.symbolRoles) & 1)) continue;
      const targets = definitions.get(symbol) ?? new Set<string>(); targets.add(path); definitions.set(symbol, targets);
    }
  }
  for (const doc of docs) {
    const path = text(doc.relativePath); if (!knownPaths.has(path)) continue;
    for (const raw of list(doc.occurrences)) {
      const occurrence = object(raw); const symbol = String(occurrence.symbol ?? "");
      if (!symbol || symbol.startsWith("local ") || (Number(occurrence.symbolRoles) & 1)) continue;
      for (const target of definitions.get(symbol) ?? []) facts.edge(`artifact:${path}`, `artifact:${target}`);
    }
  }
  const tool = object(object(index.metadata ?? {}).toolInfo ?? {});
  if (typeof tool.name === "string" && tool.name) facts.facts.evidence[0]!.source = `${tool.name}@${String(tool.version ?? "unknown")}`;
  return facts.finish();
}

/** Consumes cargo metadata output; does not resolve Cargo manifests itself. */
export function cargoFacts(value: unknown, knownPaths: Set<string>, owner = "cargo"): ProviderFacts {
  const input = object(value);
  const facts = new FactCollector(owner, JSON.stringify(value), "native-build");
  const root = text(input.workspace_root).replaceAll("\\", "/").replace(/\/$/, "");
  const members = new Set(list(input.workspace_members).map(String));
  const packages = list(input.packages).map(object).filter(pkg => members.has(text(pkg.id)));
  const ids = new Map<string, string>();
  for (const pkg of packages) {
    const manifest = text(pkg.manifest_path).replaceAll("\\", "/");
    if (!manifest.startsWith(`${root}/`)) { facts.partial("workspace member is outside indexed repository"); continue; }
    const relative = manifest.slice(root.length + 1); const directory = posix.dirname(relative);
    const id = facts.add(boundary("workspace", relative)); ids.set(text(pkg.id), id);
    for (const path of [...knownPaths].filter(path => directory === "." || path.startsWith(`${directory}/`))) facts.edge(id, facts.add(artifact(path)), "CONTAINS");
  }
  const resolve = input.resolve ? object(input.resolve) : {};
  for (const node of list(resolve.nodes).map(object)) {
    const from = ids.get(text(node.id)); if (!from) continue;
    for (const dependency of list(node.dependencies)) { const to = ids.get(String(dependency)); if (to) facts.edge(from, to); }
  }
  if (!input.resolve) facts.partial("cargo metadata has no resolved dependency graph");
  return facts.finish();
}

export function markdownFacts(path: string, links: string[], knownPaths: Set<string>, inputFingerprint: string): ProviderFacts {
  const facts = new FactCollector(`markdown:${path}`, inputFingerprint, "deterministic-repo", path);
  const from = facts.add(artifact(path, ["documentation"]));
  for (const link of links) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) continue;
    let destination: string;
    try { destination = decodeURIComponent(link.split(/[?#]/)[0]!); } catch { facts.partial("invalid encoded local link"); continue; }
    const target = posix.normalize(posix.join(posix.dirname(path), destination));
    if (knownPaths.has(target)) facts.edge(from, facts.add(artifact(target)));
    else facts.partial(`unresolved local link ${link}`);
  }
  return facts.finish();
}

export interface InterfaceBinding { interface: string; artifacts: string[] }
export function interfaceFacts(family: "openapi" | "wsdl" | "asyncapi", path: string, source: string, knownPaths: Set<string>, bindings: InterfaceBinding[] = [], scope = path): ProviderFacts {
  const facts = new FactCollector(`${family}:${path}`, `${source}\n${JSON.stringify(bindings)}\n${scope}`, "protocol-contract", path);
  const contract = facts.add(artifact(path, ["contract"]));
  const operations = new Set<string>();
  if (family === "wsdl") {
    if (/<!DOCTYPE|<!ENTITY/i.test(source) || XMLValidator.validate(source) !== true) throw new Error("Invalid/unsafe WSDL XML");
    const parsed = object(new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, isArray: (name: string) => ["portType", "interface", "operation"].includes(name) }).parse(source));
    const root = object(parsed.definitions ?? parsed.description);
    if (list(root.import).length) facts.partial("external WSDL imports require resolved provider output");
    const namespace = text(root["@_targetNamespace"]);
    for (const port of [...list(root.portType), ...list(root.interface)].map(object)) {
      for (const operation of list(port.operation).map(object)) operations.add(`soap:${namespace}:${text(port["@_name"])}:${text(operation["@_name"])}`);
    }
  } else {
    const document = object(parseYaml(source) as unknown);
    const seen = new Set<object>();
    const unresolvedReferences = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || seen.has(value)) return false;
      seen.add(value);
      if (!Array.isArray(value) && typeof (value as Record<string, unknown>).$ref === "string" && !(value as Record<string, string>).$ref!.startsWith("#")) return true;
      return Object.values(value).some(unresolvedReferences);
    };
    if (unresolvedReferences(document)) facts.partial("external contract references require resolved provider output");
    if (family === "openapi") {
      if (typeof document.openapi !== "string") throw new Error("Expected OpenAPI contract");
      for (const [route, raw] of Object.entries(object(document.paths ?? {}))) {
        for (const method of Object.keys(object(raw)).filter(method => ["get", "put", "post", "delete", "patch", "head", "options", "trace"].includes(method))) operations.add(`rest:${scope}:${method}:${route}`);
      }
    } else {
      if (typeof document.asyncapi !== "string") throw new Error("Expected AsyncAPI contract");
      for (const [name, raw] of Object.entries(object(document.channels ?? {}))) {
        const channel = object(raw);
        operations.add(`message:${scope}:${typeof channel.address === "string" ? channel.address : name}`);
      }
    }
  }
  if (!operations.size) facts.partial("no resolved interface operations");
  for (const key of [...operations].sort()) facts.edge(facts.add(boundary("interface", key)), contract);
  for (const binding of bindings) {
    if (!operations.has(binding.interface)) { facts.partial(`unknown interface binding ${binding.interface}`); continue; }
    for (const path of binding.artifacts) {
      if (!knownPaths.has(path)) { facts.partial(`missing bound artifact ${path}`); continue; }
      facts.edge(facts.add(artifact(path)), `boundary:interface:${binding.interface}`);
    }
  }
  return facts.finish();
}

export function overlayFacts(value: unknown, knownPaths: Set<string>): ProviderFacts {
  const input = object(value);
  const name = text(input.name);
  if (input.authority !== "authoritative" && input.authority !== "advisory") throw new Error("Overlay authority must be explicit");
  const facts = new FactCollector(`overlay:${name}`, JSON.stringify(value), "explicit-overlay", undefined, input.authority);
  for (const raw of list(input.boundaries)) {
    const item = object(raw); const id = facts.add(boundary("overlay", `${name}:${text(item.key)}`));
    for (const path of list(item.artifacts).map(text)) {
      if (!knownPaths.has(path)) { facts.partial(`missing overlay artifact ${path}`); continue; }
      facts.edge(id, facts.add(artifact(path)), "CONTAINS");
    }
  }
  for (const raw of list(input.dependencies)) {
    const item = object(raw); const from = text(item.from); const to = text(item.to);
    facts.edge(from, to);
  }
  return facts.finish();
}
