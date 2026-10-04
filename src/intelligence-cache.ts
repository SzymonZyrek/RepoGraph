import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as ts from "typescript";

import { canonicalJsonUnknown, toJsonValue } from "./canonical.js";
import { assembleGraphFragments, makeNode, makeEdge, nodeId } from "./graph.js";
import { posix } from "node:path";
import { ingestGitRepository, parseTree, type GitTreeEntry, type GitIngestionResult } from "./git.js";
import { GRAPH_SCHEMA_VERSION, type GraphDocument, type GraphInput, type GraphNode, type Provenance } from "./model.js";
import { extractRepositoryRelationshipInputs, REPOSITORY_RELATIONSHIP_EXTRACTOR, testSourceCandidates, getPackageFacts, packageResolutionCandidates, type PackageFacts, type RepositoryRelationshipMetrics } from "./repository-relations.js";
import { StoreCorruptionError } from "./store.js";
import { extractTypeScriptJavaScriptFragments, isSourcePath, readTsConfig, TSJS_EXTRACTOR, type TsConfigResolution, type TsJsExtractionMetrics } from "./tsjs.js";
import type { RepositoryIntelligenceOptions, RepositoryIntelligenceResult } from "./intelligence.js";
import type { PathRuleInput } from "./path-rules.js";

const FACT_REF = "$intelligence-facts/v6";
const CACHE_VERSION = "repograph.intelligence/v6";
const PACK_SIZE = 64;
type Fragments = Record<string, GraphDocument>;
type ReverseIndex = Record<string, string[]>;
interface FragmentPack { key: string; keys: string[] }

interface IntelligenceState {
  schema: typeof CACHE_VERSION;
  entries: Record<string, GitTreeEntry>;
  git: Fragments;
  sources: Fragments;
  relationships: Fragments;
  candidates: Record<string, string[]>;
  importers: ReverseIndex;
  tests: ReverseIndex;
  packages: PackageFacts[];
  packageCandidates: Record<string, string[]>;
  packageDependents: ReverseIndex;
  config: TsConfigResolution;
  configSources: string[];
  configDiagnostics: GraphDocument;
  tsjs: TsJsExtractionMetrics;
  relationshipMetrics: RepositoryRelationshipMetrics;
}

function flatten(state: IntelligenceState): Fragments {
  const facts: Fragments = Object.create(null) as Fragments;
  for (const group of ["git", "sources", "relationships"] as const) {
    for (const [path, fragment] of Object.entries(state[group])) facts[JSON.stringify([group, path])] = fragment;
  }
  return facts;
}

function restoreFragments(state: IntelligenceState, facts: Fragments): void {
  state.git = Object.create(null) as Fragments;
  state.sources = Object.create(null) as Fragments;
  state.relationships = Object.create(null) as Fragments;
  for (const [key, fragment] of Object.entries(facts)) {
    const [group, path] = JSON.parse(key) as ["git" | "sources" | "relationships", string];
    if (!["git", "sources", "relationships"].includes(group) || typeof path !== "string") throw new StoreCorruptionError("Invalid intelligence fragment address");
    state[group][path] = fragment;
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function resolveRevision(root: string, ref: string): { commit: string; parent?: string; tree: string } {
  const fields = git(root, "show", "-s", "--format=%H%x00%P%x00%T", `${ref}^{commit}`).trimEnd().split("\0");
  if (fields.length !== 3 || fields[0] === "" || fields[2] === "") {
    throw new Error(`Invalid Git revision metadata for ${ref}`);
  }
  const parent = fields[1]!.split(" ").find((value) => value.length > 0);
  return { commit: fields[0]!, ...(parent === undefined ? {} : { parent }), tree: fields[2]! };
}

function emptyGraph(): GraphDocument {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: [], edges: [], diagnostics: [] };
}

/** Lazy batch reads amortize process startup; a fully cached rename never invokes Git. */
function sourceReader(root: string, files: ReadonlyMap<string, GraphNode>, selected?: ReadonlySet<string>): (path: string) => string {
  const sources = (selected === undefined ? [...files.keys()] : [...selected]).filter((path) => files.has(path) && isSourcePath(path));
  const positions = new Map(sources.map((path, index) => [path, index]));
  const objects = sources.map((path) => String(files.get(path)!.metadata!.blobSha));
  let sizes: number[] | undefined;
  let contents = new Map<string, string>();
  return (path) => {
    if (!contents.has(path)) {
      const position = positions.get(path);
      if (position === undefined) throw new Error(`Missing batched source ${path}`);
      if (sizes === undefined && sources.length === 1) sizes = [64 * 1024 * 1024];
      if (sizes === undefined) {
        const checked = execFileSync("git", ["cat-file", "--batch-check"], { cwd: root, input: objects.join("\n") + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trimEnd().split("\n");
        sizes = checked.map((header, index) => {
          const [object, type, text] = header.trim().split(" ");
          const size = Number(text);
          if (object !== objects[index] || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024) throw new Error(`Invalid or oversized Git source ${sources[index]}`);
          return size;
        });
        if (sizes.length !== sources.length) throw new Error("Incomplete Git batch size response");
      }
      const batch: string[] = [];
      const batchObjects: string[] = [];
      let bytes = 0;
      for (let index = position; index < sources.length; index++) {
        const size = sizes[index]! + 128;
        if (batch.length > 0 && bytes + size > 8 * 1024 * 1024) break;
        batch.push(sources[index]!); batchObjects.push(objects[index]!); bytes += size;
      }
      const raw = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: batchObjects.join("\n") + "\n", maxBuffer: Math.max(64 * 1024 * 1024, bytes + 1024), stdio: ["pipe", "pipe", "pipe"] });
      contents = new Map();
      let offset = 0;
      for (const source of batch) {
        const end = raw.indexOf(10, offset);
        const header = raw.subarray(offset, end).toString("utf8").split(" ");
        const size = Number(header[2]);
        if (end < 0 || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024 || end + 1 + size >= raw.length) throw new Error(`Invalid Git batch response for ${source}`);
        contents.set(source, raw.subarray(end + 1, end + 1 + size).toString("utf8"));
        offset = end + 1 + size + 1;
      }
    }
    const content = contents.get(path);
    if (content === undefined) throw new Error(`Missing batched source ${path}`);
    contents.delete(path);
    return content;
  };
}

function normalized(input: GraphInput): GraphDocument {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: (input.nodes ?? []).map(makeNode), edges: (input.edges ?? []).map(makeEdge), diagnostics: input.diagnostics ?? [] };
}

/** Facts have no target ref/commit. Only final materialization adds that provenance. */
function pin(graph: GraphDocument, ref: string, commit?: string): GraphDocument {
  const provenance = (p: Provenance): Provenance => {
    const result = { ...p, ref };
    delete result.commit;
    return { ...result, ...(p.commit === undefined ? {} : { commit: commit ?? "$target" }) };
  };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      let metadata = node.metadata;
      if (node.identity.kind === "repository" && metadata !== undefined) {
        metadata = { ...metadata };
        delete metadata.commit;
        if (commit !== undefined) metadata.commit = commit;
      }
      return { ...node, ...(metadata === undefined ? {} : { metadata }), provenance: node.provenance.map(provenance) };
    }),
    edges: graph.edges.map((edge) => ({ ...edge, provenance: edge.provenance.map(provenance) })),
    diagnostics: graph.diagnostics.map((d) => ({ ...d, ...(d.provenance === undefined ? {} : { provenance: provenance(d.provenance) }) })),
  };
}

function split(graph: GraphDocument, key: (kind: string, path?: string) => string): Fragments {
  const result: Fragments = Object.create(null) as Fragments;
  const fragment = (name: string) => result[name] ??= emptyGraph();
  for (const node of graph.nodes) fragment(key(node.identity.kind, node.provenance[0]?.path)).nodes.push(node);
  for (const edge of graph.edges) fragment(key(edge.identity.kind, edge.provenance[0]?.path)).edges.push(edge);
  for (const diagnostic of graph.diagnostics) fragment(key("diagnostic", diagnostic.provenance?.path)).diagnostics.push(diagnostic);
  return result;
}

function addIndex(index: ReverseIndex, path: string, owner: string): void {
  const values = index[path] ??= [];
  if (!values.includes(owner)) values.push(owner);
  values.sort();
}

function splitGit(graph: GraphDocument): Fragments {
  const result = split({ ...graph, edges: graph.edges.filter((edge) => edge.identity.kind !== "path-rule-match") }, (kind, path) => kind === "path-rule" ? "$rules" : path === undefined ? "$root" : `path:${path}`);
  const paths = new Map(graph.nodes.map((node) => [node.id, node.identity.key]));
  for (const edge of graph.edges.filter((edge) => edge.identity.kind === "path-rule-match")) {
    (result[`path:${paths.get(edge.identity.to)!}`] ??= emptyGraph()).edges.push(edge);
  }
  return result;
}

function removeIndex(index: ReverseIndex, path: string, owner: string): void {
  const values = index[path]?.filter((value) => value !== owner);
  if (values?.length) index[path] = values;
  else delete index[path];
}

function relationshipKey(kind: string, path?: string): string {
  return kind === "tests" || (kind === "diagnostic" && path !== undefined && testSourceCandidates(path).length > 0)
    ? `test:${path}` : `package:${path}`;
}

function relationshipFragments(input: GraphInput, files: ReadonlyMap<string, GraphNode>): Fragments {
  const graph = normalized(input);
  const paths = new Map([...files.values()].map((node) => [node.id, node.identity.key]));
  const memberships = graph.edges.filter((edge) => edge.identity.kind === "belongs-to-package");
  graph.edges = graph.edges.filter((edge) => edge.identity.kind !== "belongs-to-package");
  const result = split(graph, relationshipKey);
  for (const edge of memberships) {
    result[`member:${paths.get(edge.identity.from)}`] = { ...emptyGraph(), edges: [edge] };
  }
  return result;
}

function totals(state: IntelligenceState): void {
  const sources = Object.values(state.sources);
  state.tsjs = {
    sourceFiles: Object.keys(state.candidates).length,
    parsedFiles: 0, reusedSyntaxArtifacts: 0,
    resolvedDependencies: sources.reduce((n, graph) => n + graph.edges.filter((edge) => edge.identity.kind === "imports" || edge.identity.kind === "reexports").length, 0),
    unresolvedDependencies: sources.reduce((n, graph) => n + graph.diagnostics.filter((d) => d.code === "tsjs-unresolved-import").length, 0),
    externalDependencies: sources.reduce((n, graph) => n + graph.diagnostics.filter((d) => d.code === "tsjs-external-module").length, 0),
  };
  const edges = Object.values(state.relationships).flatMap((fragment) => fragment.edges);
  const count = (kind: string) => edges.filter((edge) => edge.identity.kind === kind).length;
  state.relationshipMetrics = {
    indexedFiles: Object.values(state.git).reduce((n, fragment) => n + fragment.nodes.filter((node) => node.identity.kind === "file").length, 0),
    packageManifestCandidates: Object.values(state.git).reduce((n, fragment) => n + fragment.nodes.filter((node) => node.identity.kind === "file" && /(^|\/)package\.json$/.test(node.identity.key)).length, 0),
    testFileCandidates: new Set(Object.values(state.tests).flat()).size,
    membershipFilesVisited: 0, parsedPackageManifests: 0, reusedPackageArtifacts: 0,
    packageManifests: state.packages.length, packageNodes: state.packages.length,
    packageDependencies: count("package-dependency"), packageMemberships: count("belongs-to-package"),
    buildEntrypoints: count("package-build-entrypoint"), contractEntrypoints: count("package-contract"), testRelations: count("tests"),
    diagnostics: Object.values(state.relationships).reduce((n, f) => n + f.diagnostics.length, 0),
  };
}

export function buildIncrementalIntelligence(options: RepositoryIntelligenceOptions): RepositoryIntelligenceResult {
  const started = performance.now();
  const timings = { gitChangeDiscoveryMs: 0, extractionResolutionMs: 0, relationshipMaintenanceMs: 0, cacheIoMs: 0, graphMaterializationMs: 0 };
  const timed = <T>(phase: keyof typeof timings, operation: () => T): T => {
    const before = performance.now();
    try { return operation(); } finally { timings[phase] += performance.now() - before; }
  };
  const resolved = timed("gitChangeDiscoveryMs", () => {
    const root = realpathSync(git(options.repositoryPath, "rev-parse", "--show-toplevel").trim());
    const revision = resolveRevision(root, options.ref);
    return { root, ...revision, repository: options.repository ?? `file://${root}` };
  });
  const configurationIdentity = `intelligence-config-${createHash("sha256").update(canonicalJsonUnknown({
    schema: CACHE_VERSION, graph: GRAPH_SCHEMA_VERSION, git: "0.0.1", tsjs: TSJS_EXTRACTOR, relationships: REPOSITORY_RELATIONSHIP_EXTRACTOR,
    parser: ts.version, jsonParser: process.versions.v8, policy: options.policy ?? {}, pathRules: options.pathRules ?? [], discoverCodeowners: options.discoverCodeowners ?? true, tsconfigPath: options.tsconfigPath ?? "tsconfig.json",
  })).digest("hex")}`;
  const reasons: string[] = [];
  const layouts = new Map<string, FragmentPack[]>();
  const loadedFacts = new Map<string, Fragments>();
  const load = (commit: string): IntelligenceState | undefined => timed("cacheIoMs", () => {
    const manifest = options.store?.getManifest({ repository: resolved.repository, ref: FACT_REF, commit, configurationIdentity });
    if (manifest === undefined) return undefined;
    const reference = manifest.artifacts.find((item) => item.logicalKey === "$intelligence");
    const packs: FragmentPack[] = manifest.artifacts.filter((item) => item.logicalKey.startsWith("pack:")).map((item) => {
      let keys: unknown;
      try { keys = JSON.parse(item.logicalKey.slice(5)) as unknown; } catch { throw new StoreCorruptionError("Invalid intelligence pack address"); }
      if (!Array.isArray(keys) || keys.length > PACK_SIZE || keys.some((key) => typeof key !== "string")) throw new StoreCorruptionError("Invalid intelligence pack keys");
      return { key: item.artifactKey, keys: keys as string[] };
    });
    layouts.set(commit, packs);
    const artifact = reference === undefined ? undefined : options.store!.getArtifact(reference.artifactKey, { verifyContentIdentity: true });
    if (artifact === undefined) { reasons.push(`missing-artifact:${commit}`); return undefined; }
    const state = artifact.payload as unknown as IntelligenceState;
    if (state.schema !== CACHE_VERSION || state.importers === undefined || state.entries === undefined) {
      throw new StoreCorruptionError(`Invalid intelligence state in ${reference!.artifactKey}`);
    }
    const facts: Fragments = Object.create(null) as Fragments;
    for (const pack of packs) {
      const artifact = options.store!.getArtifact(pack.key, { verifyContentIdentity: true });
      if (artifact === undefined) { reasons.push(`missing-artifact:${commit}:${pack.key}`); return undefined; }
      const payload = artifact.payload as unknown as Fragments;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload) || Object.keys(payload).length !== pack.keys.length) throw new StoreCorruptionError(`Invalid intelligence pack ${pack.key}`);
      for (const key of pack.keys) {
        if (!Object.hasOwn(payload, key) || Object.hasOwn(facts, key)) throw new StoreCorruptionError(`Missing or duplicate intelligence fragment ${key}`);
        facts[key] = payload[key]!;
      }
    }
    restoreFragments(state, facts);
    if (!Array.isArray(state.configSources) || state.configSources.some((path) => typeof path !== "string")) throw new StoreCorruptionError(`Invalid configuration-source index in ${reference!.artifactKey}`);
    for (const index of [state.entries, state.candidates, state.importers, state.tests, state.packageCandidates, state.packageDependents]) {
      if (typeof index !== "object" || index === null || Array.isArray(index)) throw new StoreCorruptionError(`Invalid intelligence index in ${reference!.artifactKey}`);
      Object.setPrototypeOf(index, null);
    }
    loadedFacts.set(commit, facts);
    for (const fragment of [...Object.values(state.git), ...Object.values(state.sources), ...Object.values(state.relationships), state.configDiagnostics]) {
      if (fragment?.schemaVersion !== GRAPH_SCHEMA_VERSION || !Array.isArray(fragment.nodes) || !Array.isArray(fragment.edges) || !Array.isArray(fragment.diagnostics)) throw new StoreCorruptionError(`Invalid intelligence fragment in ${reference!.artifactKey}`);
    }
    return state;
  });

  let state = load(resolved.commit);
  let mode: "cold" | "incremental" | "exact" = state === undefined ? "cold" : "exact";
  let baseCommit: string | undefined;
  let inspectedPaths = 0;
  let inspectedBlobs = 0;
  let resolvedSourceFragments = 0;
  let recomposedRelationshipFragments = 0;
  let parsedFiles = 0;
  let reusedSyntaxArtifacts = 0;
  let syntaxCacheIoMs = 0;
  let parsedPackageManifests = 0;
  let packageCacheIoMs = 0;
  let membershipFilesVisited = 0;
  let changedPaths: string[] = [];
  let encodedFragments = 0;
  let writtenFragmentPacks = 0;
  let reusedFragmentPacks = mode === "exact" ? layouts.get(resolved.commit)?.length ?? 0 : 0;

  if (state === undefined && !layouts.has(resolved.commit) && options.store !== undefined && resolved.parent !== undefined) {
    state = load(resolved.parent);
    if (state !== undefined) { mode = "incremental"; baseCommit = resolved.parent; }
  }
  if (state === undefined) reasons.push(options.store === undefined ? "cache-disabled" : resolved.parent === undefined ? "no-first-parent" : "no-compatible-first-parent");

  if (mode === "incremental" && state !== undefined) {
    const previous = state;
    const updates = timed("gitChangeDiscoveryMs", () => {
      const fields = git(resolved.root, "diff-tree", "--no-commit-id", "-r", "-t", "--raw", "--no-abbrev", "-z", baseCommit!, resolved.commit).split("\0");
      const updates: Array<{ path: string; entry?: GitTreeEntry }> = [];
      for (let i = 0; i < fields.length - 1; i += 2) {
        const header = fields[i]!.split(" ");
        const path = fields[i + 1]!;
        const mode = header[1]!;
        updates.push({ path, ...(mode === "000000" ? {} : { entry: { mode, sha: header[3]!, type: mode === "040000" ? "tree" as const : mode === "160000" ? "commit" as const : "blob" as const, path } }) });
      }
      return updates;
    });
    changedPaths = updates.filter((u) => u.entry?.type !== "tree" && previous.entries[u.path]?.type !== "tree").map((u) => u.path);
    const global = changedPaths.filter((path) => [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].includes(path));
    if (global.length > 0) {
      reasons.push(...global.map((path) => `path-rules-changed:${path}`));
      state = undefined; mode = "cold";
    } else {
      const touched = new Set(updates.map((u) => u.path));
      const previousFiles = new Set(changedPaths.filter((path) => previous.git[`path:${path}`]?.nodes.some((node) => node.identity.kind === "file")));
      for (const update of updates) {
        if (update.entry === undefined) delete previous.entries[update.path];
        else previous.entries[update.path] = update.entry;
      }
      // Only touched leaves and their ancestors pass through ingestion policy/rules/blob inspection.
      const selected = new Set(touched);
      for (const path of touched) {
        let parent = path.lastIndexOf("/");
        while (parent >= 0) { selected.add(path.slice(0, parent)); parent = path.lastIndexOf("/", parent - 1); }
      }
      const sparseEntries = [...selected].map((path) => previous.entries[path]).filter((entry): entry is GitTreeEntry => entry !== undefined);
      inspectedPaths = sparseEntries.length;
      inspectedBlobs = sparseEntries.filter((entry) => entry.type === "blob" && touched.has(entry.path)).length;
      const rules: PathRuleInput[] = (previous.git["$rules"]?.nodes ?? []).sort((a, b) => Number(a.metadata?.order) - Number(b.metadata?.order)).map((node) => ({
        pattern: String(node.metadata!.pattern), targets: node.metadata!.targets as string[],
        source: node.metadata!.source as "repository" | "overlay", ...(typeof node.metadata!.sourcePath === "string" ? { sourcePath: node.metadata!.sourcePath } : {}),
      }));
      const partial = timed("gitChangeDiscoveryMs", () => ingestGitRepository({ ...options, ref: resolved.commit, repository: resolved.repository, discoverCodeowners: false, pathRules: rules }, sparseEntries));
      // Rule declarations are global; matches belong to the matched leaf, not the CODEOWNERS provenance path.
      const fragments = splitGit(pin(partial.graph, FACT_REF));
      {
        for (const path of selected) {
          const old = previous.git[`path:${path}`];
          const entry = previous.entries[path];
          if (old?.nodes[0]?.identity.kind === "directory" && entry?.type === "tree" && fragments[`path:${path}`] === undefined) {
            const node = old.nodes[0]!;
            previous.git[`path:${path}`] = { ...old, nodes: [{ ...node, metadata: { ...node.metadata, gitObject: entry.sha, treeSha: entry.sha } }] };
          } else delete previous.git[`path:${path}`];
        }
        Object.assign(previous.git, fragments);
        const files = timed("graphMaterializationMs", () => {
          const files = new Map<string, GraphNode>();
          const requiredDirectories = new Set<string>();
          for (const fragment of Object.values(previous.git)) for (const node of fragment.nodes) {
            if (["file", "symlink", "submodule"].includes(node.identity.kind)) {
              if (node.identity.kind === "file") files.set(node.identity.key, node);
              let parent = node.identity.key.lastIndexOf("/");
              while (parent >= 0) { requiredDirectories.add(node.identity.key.slice(0, parent)); parent = node.identity.key.lastIndexOf("/", parent - 1); }
            }
          }
          for (const path of selected) if (previous.git[`path:${path}`]?.nodes[0]?.identity.kind === "directory" && !requiredDirectories.has(path)) delete previous.git[`path:${path}`];
          return files;
        });
        const ingestion: GitIngestionResult = { ...partial, graph: { ...emptyGraph(), nodes: [...files.values()] } };
        const affected = new Set(changedPaths.filter(isSourcePath));
        if (changedPaths.includes(options.tsconfigPath ?? "tsconfig.json")) {
          const configDiagnostics = emptyGraph();
          previous.config = timed("extractionResolutionMs", () => readTsConfig(ingestion, { has: (path: string) => files.has(path) } as ReadonlySet<string>, options.tsconfigPath ?? "tsconfig.json", configDiagnostics.diagnostics));
          previous.configDiagnostics = pin(configDiagnostics, FACT_REF);
          for (const path of previous.configSources) affected.add(path);
          reasons.push(`tsconfig-resolution-changed:${options.tsconfigPath ?? "tsconfig.json"}`);
        }
        const pathChanges = changedPaths.filter((path) => previousFiles.has(path) !== files.has(path));
        const changedPackages = new Set(changedPaths.filter((path) => /(^|\/)package\.json$/.test(path)));
        const packagePaths = new Set(changedPackages);
        for (const path of pathChanges) for (const owner of previous.packageDependents[`file:${path}`] ?? []) packagePaths.add(owner);
        const packageDiagnostics = emptyGraph();
        const membershipPaths = new Set(pathChanges);
        if (changedPackages.size > 0) timed("relationshipMaintenanceMs", () => {
          const byPath = new Map(previous.packages.map((facts) => [facts.path, facts]));
          const regions = new Set<string>();
          const dependents = (facts: PackageFacts) => {
            for (const candidate of [`directory:${facts.directory}`, ...(facts.name === undefined ? [] : [`name:${facts.name}`])]) {
              for (const path of previous.packageDependents[candidate] ?? []) packagePaths.add(path);
            }
          };
          for (const path of changedPackages) {
            const before = byPath.get(path);
            if (before !== undefined) dependents(before);
            const loaded = files.has(path) ? getPackageFacts(ingestion, files.get(path)!, packageDiagnostics.diagnostics, options.store) : undefined;
            if (loaded !== undefined && !loaded.reused) parsedPackageManifests++;
            packageCacheIoMs += loaded?.cacheIoMs ?? 0;
            const after = loaded?.facts;
            for (const candidate of previous.packageCandidates[path] ?? []) removeIndex(previous.packageDependents, candidate, path);
            delete previous.packageCandidates[path];
            byPath.delete(path);
            if (after !== undefined) {
              byPath.set(path, after);
              dependents(after);
              const candidates = packageResolutionCandidates(after);
              previous.packageCandidates[path] = candidates;
              for (const candidate of candidates) addIndex(previous.packageDependents, candidate, path);
            }
            if ((before === undefined) !== (after === undefined)) regions.add(posix.dirname(path));
          }
          previous.packages = [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
          for (const path of files.keys()) {
            if (![...regions].some((directory) => directory === "." || path.startsWith(`${directory}/`))) continue;
            const owner = previous.packages.filter((facts) => facts.directory === "." || path.startsWith(`${facts.directory}/`)).sort((a, b) => b.directory.length - a.directory.length || a.path.localeCompare(b.path))[0];
            const newOwner = owner === undefined ? undefined : nodeId({ namespace: ingestion.repository, kind: "package", key: owner.path });
            const oldOwner = previous.relationships[`member:${path}`]?.edges[0]?.identity.to;
            if (newOwner !== oldOwner) membershipPaths.add(path);
          }
        });
        for (const path of pathChanges) for (const importer of previous.importers[path] ?? []) affected.add(importer);
        resolvedSourceFragments = [...affected].filter((path) => files.has(path) && isSourcePath(path)).length;
        const extracted = timed("extractionResolutionMs", () => extractTypeScriptJavaScriptFragments(ingestion, options, affected, previous.config, files, sourceReader(resolved.root, files, affected)));
        parsedFiles = extracted.metrics.parsedFiles;
        reusedSyntaxArtifacts = extracted.metrics.reusedSyntaxArtifacts;
        syntaxCacheIoMs += extracted.metrics.syntaxCacheIoMs ?? 0;
        const replacement = split(pin(normalized(extracted.inputs), FACT_REF), (_kind, path) => path ?? "$config");
        for (const path of affected) {
          for (const candidate of previous.candidates[path] ?? []) removeIndex(previous.importers, candidate, path);
          delete previous.sources[path]; delete previous.candidates[path];
        }
        Object.assign(previous.sources, replacement);
        Object.assign(previous.candidates, extracted.candidates);
        previous.configSources = [...new Set([...previous.configSources.filter((path) => !affected.has(path)), ...extracted.configSources])].sort();
        for (const [path, candidates] of Object.entries(extracted.candidates)) for (const candidate of candidates) addIndex(previous.importers, candidate, path);
        if (pathChanges.length > 0 || changedPackages.size > 0) {
          const testPaths = new Set<string>();
          for (const path of pathChanges) {
            testPaths.add(path);
            for (const test of previous.tests[path] ?? []) testPaths.add(test);
            for (const candidate of testSourceCandidates(path)) removeIndex(previous.tests, candidate, path);
            if (files.has(path)) for (const candidate of testSourceCandidates(path)) addIndex(previous.tests, candidate, path);
          }
          for (const path of membershipPaths) delete previous.relationships[`member:${path}`];
          for (const path of packagePaths) delete previous.relationships[`package:${path}`];
          for (const path of testPaths) delete previous.relationships[`test:${path}`];
          const relation = timed("relationshipMaintenanceMs", () => extractRepositoryRelationshipInputs(ingestion, { packages: previous.packages, membershipPaths, testPaths, packagePaths, files }));
          membershipFilesVisited += relation.metrics.membershipFilesVisited;
          relation.inputs.diagnostics = [...(relation.inputs.diagnostics ?? []), ...packageDiagnostics.diagnostics];
          const replacements = relationshipFragments(relation.inputs, new Map([...membershipPaths].filter((path) => files.has(path)).map((path) => [path, files.get(path)!])));
          Object.assign(previous.relationships, Object.fromEntries(Object.entries(replacements).map(([key, value]) => [key, pin(value, FACT_REF)])));
          recomposedRelationshipFragments = membershipPaths.size + testPaths.size + packagePaths.size;
        }
        timed("graphMaterializationMs", () => totals(previous));
      }
    }
  }

  if (state === undefined) {
    const entries = timed("gitChangeDiscoveryMs", () => parseTree(git(resolved.root, "ls-tree", "-r", "-t", "-z", "--full-tree", resolved.commit)));
    const ingestion = timed("gitChangeDiscoveryMs", () => ingestGitRepository({ ...options, ref: resolved.commit, repository: resolved.repository }, entries));
    const files = new Map(ingestion.graph.nodes.filter((node) => node.identity.kind === "file").map((node) => [node.identity.key, node]));
    const configDiagnostics = emptyGraph();
    const config = timed("extractionResolutionMs", () => readTsConfig(ingestion, new Set(files.keys()), options.tsconfigPath ?? "tsconfig.json", configDiagnostics.diagnostics));
    const extracted = timed("extractionResolutionMs", () => extractTypeScriptJavaScriptFragments(ingestion, options, undefined, config, files, sourceReader(resolved.root, files)));
    const relation = timed("relationshipMaintenanceMs", () => extractRepositoryRelationshipInputs(ingestion, { ...(options.store === undefined ? {} : { store: options.store }) }));
    parsedPackageManifests += relation.metrics.parsedPackageManifests;
    packageCacheIoMs += relation.metrics.packageCacheIoMs ?? 0;
    membershipFilesVisited += relation.metrics.membershipFilesVisited;
    const gitFragments = splitGit(pin(ingestion.graph, FACT_REF));
    state = {
      schema: CACHE_VERSION, entries: Object.fromEntries(entries.map((entry) => [entry.path, entry])), git: gitFragments,
      sources: split(pin(normalized(extracted.inputs), FACT_REF), (_kind, path) => path ?? "$config"),
      relationships: Object.fromEntries(Object.entries(relationshipFragments(relation.inputs, files)).map(([key, value]) => [key, pin(value, FACT_REF)])),
      config, configSources: extracted.configSources, configDiagnostics: pin(configDiagnostics, FACT_REF), packages: relation.packages, packageCandidates: Object.create(null) as ReverseIndex, packageDependents: Object.create(null) as ReverseIndex, candidates: extracted.candidates, importers: Object.create(null) as ReverseIndex, tests: Object.create(null) as ReverseIndex,
      tsjs: extracted.metrics, relationshipMetrics: relation.metrics,
    };
    for (const [path, candidates] of Object.entries(state.candidates)) for (const candidate of candidates) addIndex(state.importers, candidate, path);
    for (const path of files.keys()) for (const candidate of testSourceCandidates(path)) addIndex(state.tests, candidate, path);
    for (const facts of state.packages) {
      state.packageCandidates[facts.path] = packageResolutionCandidates(facts);
      for (const candidate of state.packageCandidates[facts.path]!) addIndex(state.packageDependents, candidate, facts.path);
    }
    inspectedPaths = entries.length; inspectedBlobs = entries.filter((entry) => entry.type === "blob").length;
    resolvedSourceFragments = extracted.metrics.sourceFiles;
    recomposedRelationshipFragments = Object.keys(state.relationships).length;
    parsedFiles = extracted.metrics.parsedFiles; reusedSyntaxArtifacts = extracted.metrics.reusedSyntaxArtifacts;
    syntaxCacheIoMs += extracted.metrics.syntaxCacheIoMs ?? 0;
  }

  if (mode !== "exact" && options.store !== undefined) {
    timed("cacheIoMs", () => {
      const facts = flatten(state);
      const oldFacts = loadedFacts.get(baseCommit ?? resolved.commit);
      const oldPacks = layouts.get(resolved.commit) ?? (baseCommit === undefined ? [] : layouts.get(baseCommit) ?? []);
      const remaining = new Set(Object.keys(facts));
      const refs: Array<{ logicalKey: string; artifactKey: string }> = [];
      const save = (kind: string, payload: unknown) => {
        const content = toJsonValue(payload);
        return options.store!.putArtifact({ contentIdentity: `sha256:${createHash("sha256").update(canonicalJsonUnknown(content)).digest("hex")}`, artifactKind: kind, extractor: { name: "repograph-intelligence", version: "2" }, schemaVersion: CACHE_VERSION }, content);
      };
      const savePack = (keys: string[], old?: FragmentPack) => {
        if (keys.length === 0) return;
        const unchanged = old !== undefined && old.keys.length === keys.length && keys.every((key) => oldFacts?.[key] === facts[key]);
        const saved = unchanged ? { key: old.key, reused: true } : save("intelligence-fragments", Object.fromEntries(keys.map((key) => [key, facts[key]])));
        const key = saved.key;
        if (saved.reused) reusedFragmentPacks++;
        else writtenFragmentPacks++;
        if (!unchanged) encodedFragments += keys.length;
        refs.push({ logicalKey: `pack:${JSON.stringify(keys)}`, artifactKey: key });
        for (const name of keys) remaining.delete(name);
      };
      for (const pack of oldPacks) savePack(pack.keys.filter((key) => remaining.has(key)), pack);
      const additions = [...remaining].sort();
      for (let i = 0; i < additions.length; i += PACK_SIZE) savePack(additions.slice(i, i + PACK_SIZE));
      const index = { ...state, tsjs: { ...state.tsjs, parsedFiles: 0, reusedSyntaxArtifacts: 0, syntaxCacheIoMs: 0 } } as Partial<IntelligenceState>;
      index.relationshipMetrics = { ...state.relationshipMetrics, parsedPackageManifests: 0, reusedPackageArtifacts: 0, membershipFilesVisited: 0, packageCacheIoMs: 0 };
      delete index.git; delete index.sources; delete index.relationships;
      const saved = save("intelligence-index", index);
      refs.push({ logicalKey: "$intelligence", artifactKey: saved.key });
      options.store!.writeManifest({ repository: resolved.repository, ref: FACT_REF, commit: resolved.commit, configurationIdentity, graphSchemaVersion: GRAPH_SCHEMA_VERSION, artifacts: refs });
    });
  }
  const graph = timed("graphMaterializationMs", () => pin(assembleGraphFragments([...Object.values(state.git), ...Object.values(state.sources), ...Object.values(state.relationships), state.configDiagnostics]), options.ref, resolved.commit));
  timings.cacheIoMs += syntaxCacheIoMs + packageCacheIoMs;
  timings.extractionResolutionMs -= syntaxCacheIoMs;
  timings.relationshipMaintenanceMs -= packageCacheIoMs;
  const totalFragments = Object.keys(state.sources).length + Object.keys(state.relationships).length;
  const baseNodes = Object.values(state.git).reduce((n, fragment) => n + fragment.nodes.length, 0);
  const baseEdges = Object.values(state.git).reduce((n, fragment) => n + fragment.edges.length, 0);
  const relationshipOnlyNodes = Object.values(state.relationships).reduce((n, fragment) => n + fragment.nodes.length, 0);
  const relationshipOnlyEdges = Object.values(state.relationships).reduce((n, fragment) => n + fragment.edges.length, 0);
  return {
    repositoryRoot: resolved.root, repository: resolved.repository, requestedRef: options.ref, commit: resolved.commit, graph,
    metrics: {
      files: graph.nodes.filter((node) => node.identity.kind === "file").length, nodes: graph.nodes.length, edges: graph.edges.length, diagnostics: graph.diagnostics.length,
      tsjs: { ...state.tsjs, parsedFiles, reusedSyntaxArtifacts, syntaxCacheIoMs }, relationships: { ...state.relationshipMetrics, parsedPackageManifests, reusedPackageArtifacts: Math.max(0, state.relationshipMetrics.packageManifestCandidates - parsedPackageManifests), membershipFilesVisited, packageCacheIoMs },
      composition: { baseNodes, baseEdges, relationshipOnlyNodes, relationshipOnlyEdges, skippedDuplicateRelationshipNodes: baseNodes, skippedDuplicateRelationshipEdges: baseEdges, mode, ...(baseCommit === undefined ? {} : { baseCommit }), invalidationReasons: reasons, changedPaths, inspectedPaths, inspectedBlobs, resolvedSourceFragments, recomposedRelationshipFragments, reusedFragments: Math.max(0, totalFragments - resolvedSourceFragments - recomposedRelationshipFragments), encodedFragments, writtenFragmentPacks, reusedFragmentPacks, materializedNodes: graph.nodes.length, materializedEdges: graph.edges.length },
      timings: { ...timings, totalMs: performance.now() - started },
    },
    ...(options.store === undefined ? {} : { cache: options.store.getStats() }),
  };
}
