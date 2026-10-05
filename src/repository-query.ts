import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { artifact, fingerprint, queryPolicy, validateFacts, type CausalAnswer, type ProviderFacts, type QueryPolicy } from "./causal-model.js";
import { EmbeddedCausalStore } from "./embedded-store.js";
import { cargoFacts, FactCollector, interfaceFacts, markdownFacts, object, overlayFacts, scipFacts, type InterfaceBinding } from "./causal-providers.js";

export interface RepositoryQueryOptions {
  repositoryPath: string;
  ref: string;
  repository?: string;
  cacheDirectory?: string;
  overlays?: unknown[];
  providers?: GraphProvider[];
}
export interface ProviderContext {
  repository: string;
  commit: string;
  paths: ReadonlySet<string>;
  read(path: string): Buffer;
}
export interface GraphProvider {
  id: string;
  version: string;
  fingerprint(context: ProviderContext): string;
  available(context: ProviderContext): boolean;
  collect(context: ProviderContext): ProviderFacts | Promise<ProviderFacts>;
}
export interface IndexDiagnostics { refreshedProviders: number; reusedProviders: number; parsedDocumentationBlobs: number }
export interface IndexResult { repository: string; commit: string; partial: boolean; diagnostics: string[] }

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
const activeIndexes = new Map<string, Promise<void>>();
async function withIndex<T>(options: RepositoryQueryOptions, action: (store: EmbeddedCausalStore, revision: IndexResult) => Promise<T>, metrics?: IndexDiagnostics): Promise<T> {
  const root = git(resolve(options.repositoryPath), "rev-parse", "--show-toplevel").toString().trim();
  const repository = options.repository ?? root.replaceAll("\\", "/");
  const cache = resolve(options.cacheDirectory ?? join(root, ".cache", "repograph"));
  const key = join(cache, fingerprint(repository));
  const previous = activeIndexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const current = previous.then(() => gate);
  activeIndexes.set(key, current);
  await previous;
  try { return await indexed(options, root, repository, cache, action, metrics); }
  finally { release(); if (activeIndexes.get(key) === current) activeIndexes.delete(key); }
}
async function indexed<T>(options: RepositoryQueryOptions, root: string, repository: string, cache: string,
  action: (store: EmbeddedCausalStore, revision: IndexResult) => Promise<T>, metrics?: IndexDiagnostics): Promise<T> {
  const commit = git(root, "rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`).toString().trim();
  mkdirSync(cache, { recursive: true });
  const store = new EmbeddedCausalStore(join(cache, `${fingerprint(repository).slice(0, 24)}.lbdb`));
  try {
    await store.open();
    let configBytes = "{}";
    const configExists = git(root, "ls-tree", commit, "--", ".repograph.json").toString().length > 0;
    if (configExists) configBytes = git(root, "show", `${commit}:.repograph.json`).toString();
    const config = object(JSON.parse(configBytes) as unknown);
    const configuration = fingerprint(JSON.stringify(["causal-index-1", configBytes, options.overlays ?? [], options.providers?.map(provider => [provider.id, provider.version]) ?? []]));
    const prior = await store.metadata();
    if (prior?.repository === repository && prior.commit === commit && prior.configuration === configuration && !options.providers?.length) {
      return await action(store, { repository, commit, partial: prior.partial === true, diagnostics: prior.diagnostics as string[] });
    }
    const tree = new Map<string, string>();
    for (const entry of git(root, "ls-tree", "-rz", commit).toString().split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t"); const [mode, type, blob] = entry.slice(0, tab).split(" ");
      if (type === "blob" && (mode === "100644" || mode === "100755")) tree.set(entry.slice(tab + 1), blob!);
    }
    const paths = new Set(tree.keys());
    const read = (path: string): Buffer => { const blob = tree.get(path); if (!blob) throw new Error(`Unavailable committed artifact ${path}`); return git(root, "cat-file", "blob", blob); };
    const existing = new Map((await store.providers()).map(row => [String(row.owner), String(row.fingerprint)]));
    const replacements: ProviderFacts[] = [];
    const owners = new Set<string>();
    const add = async (owner: string, identity: string, collect: () => ProviderFacts | Promise<ProviderFacts>) => {
      if (owners.has(owner)) throw new Error(`Duplicate provider identity ${owner}`);
      owners.add(owner);
      if (existing.get(owner) === identity && prior?.configuration === configuration) { if (metrics) metrics.reusedProviders++; return; }
      let facts: ProviderFacts;
      try {
        facts = await collect(); validateFacts(facts);
        if (facts.nodes.some(node => node.type === "artifact" && !paths.has(node.path))) throw new Error("Provider emitted an artifact outside the indexed Git revision");
      }
      catch (error) {
        const unavailable = new FactCollector(owner, identity, "deterministic-repo");
        unavailable.partial(`provider unavailable: ${error instanceof Error ? error.message : "collection failed"}`);
        facts = unavailable.finish();
      }
      if (facts.provider !== owner) throw new Error(`Provider ${owner} emitted facts for ${facts.provider}`);
      facts.fingerprint = identity; facts.evidence.forEach(evidence => { evidence.fingerprint = identity; });
      replacements.push(facts); if (metrics) metrics.refreshedProviders++;
    };
    for (const [path, blob] of tree) {
      await add(`git:${path}`, blob, () => {
        const facts = new FactCollector(`git:${path}`, blob, "deterministic-repo", path);
        facts.add(artifact(path, /(^|\/)(test|tests)\/|\.(test|spec)\.[^/]+$/.test(path) ? ["validation"] : /\.md$/i.test(path) ? ["documentation"] : [])); return facts.finish();
      });
      if (/\.md$/i.test(path)) {
        const identity = fingerprint(`${path}:${blob}:${[...paths].sort().join("\n")}`);
        await add(`markdown:${path}`, identity, () => {
          const syntaxPath = join(cache, `markdown-${blob}.json`);
          let links: string[];
          try {
            const cached: unknown = JSON.parse(readFileSync(syntaxPath, "utf8"));
            if (!Array.isArray(cached) || cached.some(link => typeof link !== "string")) throw new Error("Invalid syntax cache");
            links = cached as string[];
          } catch {
            links = [...read(path).toString().matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map(match => match[1]!);
            writeFileSync(syntaxPath, JSON.stringify(links)); if (metrics) metrics.parsedDocumentationBlobs++;
          }
          return markdownFacts(path, links, paths, identity);
        });
      }
    }
    const configured = config.providers === undefined ? [] : config.providers;
    if (!Array.isArray(configured)) throw new Error("providers must be an array");
    const descriptors: unknown[] = [...configured];
    for (const [type, path] of [["scip", "index.scip"], ["cargo", "cargo.metadata.json"],
      ["openapi", "openapi.yaml"], ["openapi", "openapi.json"], ["wsdl", "service.wsdl"], ["asyncapi", "asyncapi.yaml"], ["asyncapi", "asyncapi.json"]]) {
      if (paths.has(path!) && !configured.some(raw => object(raw).type === type && object(raw).path === path)) {
        const companion = `${path}.sources.json`;
        descriptors.push({ type, path, ...(paths.has(companion) ? { sources: JSON.parse(read(companion).toString()) as unknown } : {}) });
      }
    }
    let sourceProvider = false;
    for (const descriptor of descriptors) {
      const input = object(descriptor);
      const type = String(input.type); const path = String(input.path);
      const owner = `${type}:${path}`;
      if (!["scip", "cargo", "openapi", "wsdl", "asyncapi"].includes(type)) throw new Error(`Unsupported configured provider ${type}`);
      sourceProvider ||= type === "scip";
      const snapshot = input.sources === undefined ? {} : object(input.sources);
      const sourceKeys = Object.keys(snapshot).sort();
      const sourceIdentity = sourceKeys.map(path => [path, tree.get(path) ?? "missing"]);
      const identity = fingerprint(`${JSON.stringify(input)}:${tree.get(path) ?? "missing"}:${[...paths].sort().join("\n")}:${JSON.stringify(sourceIdentity)}`);
      await add(owner, identity, () => {
        if (type === "scip" || type === "cargo") {
          const facts = type === "scip" ? scipFacts(read(path), paths, owner) : cargoFacts(JSON.parse(read(path).toString()) as unknown, paths, owner);
          const validSnapshot = sourceKeys.length > 0 && sourceKeys.every(path => tree.has(path) && snapshot[path] === fingerprint(read(path)));
          const covered = type === "scip" ? facts.nodes.every(node => node.type !== "artifact" || Object.hasOwn(snapshot, node.path)) :
            facts.nodes.filter(node => node.type === "boundary" && node.kind === "workspace").every(node => node.type === "boundary" && Object.hasOwn(snapshot, node.key)) &&
            ["Cargo.toml", "Cargo.lock"].filter(path => paths.has(path)).every(path => Object.hasOwn(snapshot, path));
          if (!validSnapshot || !covered) {
            facts.partial = true; facts.edges = [];
            facts.evidence.forEach(evidence => { evidence.state = "partial"; });
            facts.diagnostics.push(`${owner}: source snapshot is missing or stale; regenerate the external index and its source hashes`);
          }
          return facts;
        }
        const bindings = input.bindings ?? [];
        if (!Array.isArray(bindings) || bindings.some(raw => { const binding = object(raw); return typeof binding.interface !== "string" || !Array.isArray(binding.artifacts) || binding.artifacts.some(path => typeof path !== "string"); })) throw new Error("Invalid interface bindings");
        return interfaceFacts(type as "openapi" | "wsdl" | "asyncapi", path, read(path).toString(), paths, bindings as InterfaceBinding[], typeof input.scope === "string" ? input.scope : path);
      });
    }
    const context: ProviderContext = { repository, commit, paths, read };
    for (const provider of options.providers ?? []) {
      let available = false;
      let identity: string;
      try { available = provider.available(context); identity = fingerprint(`${provider.version}:${available}:${available ? provider.fingerprint(context) : "unavailable"}`); }
      catch { identity = fingerprint(`${provider.version}:unavailable`); }
      await add(provider.id, identity, async () => {
        if (!available) throw new Error("configured tool/index is unavailable");
        return provider.collect(context);
      });
      sourceProvider = true;
    }
    await add("source-coverage", String(sourceProvider), () => {
      const facts = new FactCollector("source-coverage", String(sourceProvider), "deterministic-repo");
      if (!sourceProvider) facts.partial("No precise source provider configured; source dependencies are not inferred");
      return facts.finish();
    });
    const configuredOverlays = config.overlays ?? [];
    if (!Array.isArray(configuredOverlays)) throw new Error("overlays must be an array");
    for (const overlay of [...configuredOverlays, ...options.overlays ?? []]) {
      const owner = `overlay:${String(object(overlay).name)}`;
      const identity = fingerprint(`${JSON.stringify(overlay)}:${[...paths].sort().join("\n")}`);
      await add(owner, identity, () => overlayFacts(overlay, paths));
    }
    await store.replace(repository, commit, configuration, replacements, [...existing.keys()].filter(owner => !owners.has(owner)));
    const current = (await store.metadata())!;
    const revision = { repository, commit, partial: current.partial === true, diagnostics: current.diagnostics as string[] };
    return await action(store, revision);
  } finally { await store.close(); }
}

export async function indexRepository(options: RepositoryQueryOptions, diagnostics?: IndexDiagnostics): Promise<IndexResult> {
  return withIndex(options, async (_store, revision) => revision, diagnostics);
}
export async function affected(options: RepositoryQueryOptions, changedArtifacts: string[], policy: QueryPolicy = {}): Promise<CausalAnswer> {
  queryPolicy(policy);
  return withIndex(options, (store, revision) => store.query(revision.repository, revision.commit, changedArtifacts.map(path => path.startsWith("artifact:") || path.startsWith("boundary:") ? path : artifact(path).id), { ...policy, direction: "in" }));
}
export async function slice(options: RepositoryQueryOptions, starts: string[], policy: QueryPolicy = {}): Promise<CausalAnswer> {
  queryPolicy(policy);
  return withIndex(options, (store, revision) => store.query(revision.repository, revision.commit, starts, policy));
}
export async function explain(options: RepositoryQueryOptions, from: string, to: string, policy: QueryPolicy = {}): Promise<CausalAnswer> {
  queryPolicy(policy);
  return withIndex(options, (store, revision) => store.query(revision.repository, revision.commit, [from], policy, to));
}
