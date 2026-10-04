import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { performance } from "node:perf_hooks";

import { buildGraph, nodeId } from "./graph.js";
import type { GitIngestionResult } from "./git.js";
import type {
  GraphDiagnostic,
  GraphDocument,
  GraphEdgeInput,
  GraphNode,
  GraphNodeInput,
  GraphInput,
  JsonObject,
  JsonValue,
  Provenance,
} from "./model.js";
import {
  artifactKey,
  type ArtifactIdentity,
  type LocalArtifactStore,
} from "./store.js";

export const REPOSITORY_RELATIONSHIP_EXTRACTOR = {
  name: "repograph-repository-relations",
  version: "0.0.3",
} as const;

export const REPOSITORY_PACKAGE_SCHEMA_VERSION =
  "repograph.repository-package/v1" as const;

const PACKAGE_JSON = "package.json";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type DependencyField = (typeof DEPENDENCY_FIELDS)[number];
type EntrypointRelation = "build" | "contract";

interface DeclaredDependency {
  field: DependencyField;
  name: string;
  specifier: string;
}

interface DeclaredEntrypoint {
  field: string;
  target: string;
  relation: EntrypointRelation;
}

interface PackageManifestFacts {
  name?: string;
  version?: string;
  dependencies: DeclaredDependency[];
  entrypoints: DeclaredEntrypoint[];
}

export interface PackageFacts extends PackageManifestFacts {
  path: string;
  directory: string;
}

export interface RepositoryRelationshipMetrics {
  indexedFiles: number;
  packageManifestCandidates: number;
  testFileCandidates: number;
  membershipFilesVisited: number;
  packageManifests: number;
  parsedPackageManifests: number;
  reusedPackageArtifacts: number;
  packageCacheIoMs?: number;
  packageNodes: number;
  packageDependencies: number;
  packageMemberships: number;
  buildEntrypoints: number;
  contractEntrypoints: number;
  testRelations: number;
  diagnostics: number;
}

export interface RepositoryRelationshipExtractionOptions {
  store?: LocalArtifactStore;
  packages?: PackageFacts[];
  membershipPaths?: ReadonlySet<string>;
  testPaths?: ReadonlySet<string>;
  packagePaths?: ReadonlySet<string>;
  files?: ReadonlyMap<string, GraphNode>;
}

export interface RepositoryRelationshipExtractionResult {
  graph: GraphDocument;
  metrics: RepositoryRelationshipMetrics;
}

function gitText(root: string, commit: string, path: string): string {
  try {
    return execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `git cat-file failed for ${commit}:${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphInputs(graph: GraphDocument): {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  diagnostics: GraphDiagnostic[];
} {
  return {
    nodes: graph.nodes.map((node) => ({
      identity: node.identity,
      ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
      provenance: node.provenance,
    })),
    edges: graph.edges.map((edge) => ({
      identity: edge.identity,
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
      provenance: edge.provenance,
    })),
    diagnostics: [...graph.diagnostics],
  };
}

function factProvenance(
  ingestion: GitIngestionResult,
  path: string,
  state: "complete" | "partial" | "unresolved" = "complete",
  diagnostic?: string,
): Provenance {
  return {
    repository: ingestion.repository,
    ref: ingestion.requestedRef,
    commit: ingestion.commit,
    path,
    extractor: REPOSITORY_RELATIONSHIP_EXTRACTOR,
    origin: "derived",
    method: "deterministic-extraction",
    state,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function diagnostic(
  ingestion: GitIngestionResult,
  path: string,
  code: string,
  message: string,
  state: "partial" | "unresolved" = "partial",
): GraphDiagnostic {
  return {
    code,
    message,
    state,
    provenance: factProvenance(ingestion, path, state, message),
  };
}

function packageDirectory(path: string): string {
  const directory = posix.dirname(path);
  return directory === "." ? "." : directory;
}

function packageIdentity(
  repository: string,
  manifestPath: string,
): { namespace: string; kind: string; key: string } {
  return {
    namespace: repository,
    kind: "package",
    key: manifestPath,
  };
}

function stringsFromRecord(value: unknown): Array<[string, string]> {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
}

function collectExportTargets(
  value: unknown,
  segments: string[],
  targets: DeclaredEntrypoint[],
): void {
  if (typeof value === "string") {
    targets.push({
      field: segments.length === 0 ? "exports" : `exports.${segments.join(".")}`,
      target: value,
      relation: segments.includes("types") ? "contract" : "build",
    });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectExportTargets(item, [...segments, String(index)], targets),
    );
    return;
  }

  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    collectExportTargets(nested, [...segments, key], targets);
  }
}

export function parsePackageFacts(
  ingestion: GitIngestionResult,
  path: string,
  diagnostics: GraphDiagnostic[],
): PackageFacts | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      gitText(ingestion.repositoryRoot, ingestion.commit, path),
    ) as unknown;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        ingestion,
        path,
        "repository-relations-invalid-package-json",
        `Could not parse ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "unresolved",
      ),
    );
    return undefined;
  }

  if (!isRecord(parsed)) {
    diagnostics.push(
      diagnostic(
        ingestion,
        path,
        "repository-relations-invalid-package-json",
        `${path} must contain a JSON object`,
        "unresolved",
      ),
    );
    return undefined;
  }

  const dependencies: DeclaredDependency[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, specifier] of stringsFromRecord(parsed[field])) {
      dependencies.push({ field, name, specifier });
    }
  }

  const entrypoints: DeclaredEntrypoint[] = [];
  for (const [field, relation] of [
    ["main", "build"],
    ["module", "build"],
    ["types", "contract"],
    ["typings", "contract"],
  ] as const) {
    const target = parsed[field];
    if (typeof target === "string") {
      entrypoints.push({ field, target, relation });
    }
  }

  const bin = parsed.bin;
  if (typeof bin === "string") {
    entrypoints.push({ field: "bin", target: bin, relation: "build" });
  } else {
    for (const [name, target] of stringsFromRecord(bin)) {
      entrypoints.push({
        field: `bin.${name}`,
        target,
        relation: "build",
      });
    }
  }

  collectExportTargets(parsed.exports, [], entrypoints);

  const name = typeof parsed.name === "string" ? parsed.name : undefined;
  const version = typeof parsed.version === "string" ? parsed.version : undefined;

  return {
    path,
    directory: packageDirectory(path),
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    dependencies,
    entrypoints: entrypoints
      .filter(
        (entry, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.field === entry.field &&
              candidate.target === entry.target &&
              candidate.relation === entry.relation,
          ) === index,
      )
      .sort((left, right) =>
        `${left.field}\0${left.target}`.localeCompare(
          `${right.field}\0${right.target}`,
        ),
      ),
  };
}


function packageManifestPayload(facts: PackageFacts): JsonValue {
  return {
    ...(facts.name === undefined ? {} : { name: facts.name }),
    ...(facts.version === undefined ? {} : { version: facts.version }),
    dependencies: facts.dependencies.map((dependency) => ({
      field: dependency.field,
      name: dependency.name,
      specifier: dependency.specifier,
    })),
    entrypoints: facts.entrypoints.map((entrypoint) => ({
      field: entrypoint.field,
      target: entrypoint.target,
      relation: entrypoint.relation,
    })),
  };
}

function decodePackageManifest(value: JsonValue): PackageManifestFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Cached package manifest artifact must be an object");
  }

  const name = value.name;
  const version = value.version;
  const rawDependencies = value.dependencies;
  const rawEntrypoints = value.entrypoints;
  if (
    (name !== undefined && typeof name !== "string") ||
    (version !== undefined && typeof version !== "string") ||
    !Array.isArray(rawDependencies) ||
    !Array.isArray(rawEntrypoints)
  ) {
    throw new Error("Cached package manifest artifact has invalid shape");
  }

  const dependencies = rawDependencies.map((item): DeclaredDependency => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Cached package dependency must be an object");
    }
    const field = item.field;
    const dependencyName = item.name;
    const specifier = item.specifier;
    if (
      !DEPENDENCY_FIELDS.includes(field as DependencyField) ||
      typeof dependencyName !== "string" ||
      typeof specifier !== "string"
    ) {
      throw new Error("Cached package dependency has invalid fields");
    }
    return {
      field: field as DependencyField,
      name: dependencyName,
      specifier,
    };
  });

  const entrypoints = rawEntrypoints.map((item): DeclaredEntrypoint => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Cached package entrypoint must be an object");
    }
    const field = item.field;
    const target = item.target;
    const relation = item.relation;
    if (
      typeof field !== "string" ||
      typeof target !== "string" ||
      (relation !== "build" && relation !== "contract")
    ) {
      throw new Error("Cached package entrypoint has invalid fields");
    }
    return { field, target, relation };
  });

  return {
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    dependencies,
    entrypoints,
  };
}

function packageManifestArtifactIdentity(node: GraphNode): ArtifactIdentity {
  const blob = node.metadata?.blobSha ?? node.metadata?.gitObject;
  if (typeof blob !== "string") {
    throw new Error(`Package manifest ${node.identity.key} has no Git blob identity`);
  }
  return {
    contentIdentity: `git-blob:${blob}`,
    artifactKind: "repository-package-manifest",
    extractor: REPOSITORY_RELATIONSHIP_EXTRACTOR,
    schemaVersion: REPOSITORY_PACKAGE_SCHEMA_VERSION,
  };
}

export function getPackageFacts(
  ingestion: GitIngestionResult,
  node: GraphNode,
  diagnostics: GraphDiagnostic[],
  store: LocalArtifactStore | undefined,
): { facts?: PackageFacts; reused: boolean; cacheIoMs: number } {
  const path = node.identity.key;
  const identity = packageManifestArtifactIdentity(node);
  let cacheIoMs = 0;
  if (store !== undefined) {
    const before = performance.now();
    const cached = store.getArtifact(artifactKey(identity));
    cacheIoMs += performance.now() - before;
    if (cached !== undefined) {
      const manifest = decodePackageManifest(cached.payload);
      return {
        facts: {
          path,
          directory: packageDirectory(path),
          ...manifest,
        },
        reused: true,
        cacheIoMs,
      };
    }
  }

  const facts = parsePackageFacts(ingestion, path, diagnostics);
  if (facts !== undefined && store !== undefined) {
    const before = performance.now();
    store.putArtifact(identity, packageManifestPayload(facts));
    cacheIoMs += performance.now() - before;
  }
  return facts === undefined
    ? { reused: false, cacheIoMs }
    : { facts, reused: false, cacheIoMs };
}

function resolveManifestRelativePath(
  manifest: PackageFacts,
  target: string,
): string | undefined {
  if (
    target.length === 0 ||
    target.startsWith("http:") ||
    target.startsWith("https:")
  ) {
    return undefined;
  }
  const withoutPrefix = target.startsWith("./") ? target.slice(2) : target;
  const resolved =
    manifest.directory === "."
      ? posix.normalize(withoutPrefix)
      : posix.normalize(posix.join(manifest.directory, withoutPrefix));
  if (
    resolved === "." ||
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  ) {
    return undefined;
  }
  return resolved.startsWith("./") ? resolved.slice(2) : resolved;
}

function resolveLocalDependency(
  source: PackageFacts,
  dependency: DeclaredDependency,
  byDirectory: ReadonlyMap<string, PackageFacts>,
  byName: ReadonlyMap<string, readonly PackageFacts[]>,
): PackageFacts | undefined {
  if (dependency.specifier.startsWith("workspace:")) {
    const matches = byName.get(dependency.name) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }

  const prefix = dependency.specifier.startsWith("file:")
    ? "file:"
    : dependency.specifier.startsWith("link:")
      ? "link:"
      : undefined;
  if (prefix === undefined) return undefined;

  const relative = dependency.specifier.slice(prefix.length);
  const resolved =
    source.directory === "."
      ? posix.normalize(relative)
      : posix.normalize(posix.join(source.directory, relative));
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  ) {
    return undefined;
  }
  const directory = resolved === "." ? "." : resolved.replace(/^\.\//, "");
  return byDirectory.get(directory);
}

/** Successful and unsuccessful relationship-resolution dependencies. */
export function packageResolutionCandidates(facts: PackageFacts): string[] {
  const candidates = new Set<string>();
  for (const dependency of facts.dependencies) {
    if (dependency.specifier.startsWith("workspace:")) candidates.add(`name:${dependency.name}`);
    else if (dependency.specifier.startsWith("file:") || dependency.specifier.startsWith("link:")) candidates.add(`directory:${posix.normalize(posix.join(facts.directory, dependency.specifier.slice(5)))}`);
  }
  for (const entrypoint of facts.entrypoints) {
    const path = resolveManifestRelativePath(facts, entrypoint.target);
    if (path !== undefined) candidates.add(`file:${path}`);
  }
  return [...candidates].sort();
}

export function testSourceCandidates(path: string): string[] {
  const base = posix.basename(path);
  const match = /^(.+)\.(test|spec)(\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))$/.exec(base);
  if (match === null) return [];

  const stem = match[1]!;
  const extension = match[3]!;
  const directory = posix.dirname(path);
  const candidates = new Set<string>([
    posix.join(directory, `${stem}${extension}`),
  ]);

  if (posix.basename(directory) === "__tests__") {
    candidates.add(posix.join(posix.dirname(directory), `${stem}${extension}`));
  }

  return [...candidates].sort();
}

function owningPackage(
  byDirectory: ReadonlyMap<string, PackageFacts>,
  path: string,
): PackageFacts | undefined {
  let directory = posix.dirname(path);

  while (true) {
    const owner = byDirectory.get(directory);
    if (owner !== undefined) return owner;
    if (directory === ".") return undefined;

    const parent = posix.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isPackageManifestPath(path: string): boolean {
  return path === PACKAGE_JSON || path.endsWith(`/${PACKAGE_JSON}`);
}

function isTestFilePath(path: string): boolean {
  return /^(.+)\.(test|spec)(\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))$/.test(
    posix.basename(path),
  );
}

function indexRepositoryFiles(nodes: readonly GraphNode[]): {
  filesByPath: Map<string, GraphNode>;
  packagePaths: string[];
  testFiles: Array<[string, GraphNode]>;
} {
  const filesByPath = new Map<string, GraphNode>();
  const packagePaths: string[] = [];
  const testFiles: Array<[string, GraphNode]> = [];

  for (const node of nodes) {
    if (node.identity.kind !== "file") continue;
    const path = node.identity.key;
    filesByPath.set(path, node);
    if (isPackageManifestPath(path)) packagePaths.push(path);
    if (isTestFilePath(path)) testFiles.push([path, node]);
  }

  packagePaths.sort();
  testFiles.sort(([left], [right]) => left.localeCompare(right));
  return { filesByPath, packagePaths, testFiles };
}

function packageMetadata(facts: PackageFacts): JsonObject {
  return {
    ecosystem: "npm",
    manifestPath: facts.path,
    ...(facts.name === undefined ? {} : { name: facts.name }),
    ...(facts.version === undefined ? {} : { version: facts.version }),
  };
}

export function extractRepositoryRelationshipInputs(
  ingestion: GitIngestionResult,
  options: RepositoryRelationshipExtractionOptions = {},
): { inputs: GraphInput; metrics: RepositoryRelationshipMetrics; packages: PackageFacts[] } {
  const inputs = { nodes: [] as GraphNodeInput[], edges: [] as GraphEdgeInput[], diagnostics: [] as GraphDiagnostic[] };
  const indexed = options.files === undefined ? indexRepositoryFiles(ingestion.graph.nodes) : undefined;
  const filesByPath = options.files ?? indexed!.filesByPath;
  const packagePaths = options.packages?.map((facts) => facts.path) ?? indexed?.packagePaths ?? [...filesByPath.keys()].filter(isPackageManifestPath).sort();
  const testFiles = options.testPaths === undefined
    ? indexed?.testFiles ?? [...filesByPath.entries()].filter(([path]) => isTestFilePath(path))
    : [...options.testPaths].filter((path) => filesByPath.has(path) && isTestFilePath(path)).map((path) => [path, filesByPath.get(path)!] as const);

  const packages: PackageFacts[] = options.packages ?? [];
  let parsedPackageManifests = 0;
  let reusedPackageArtifacts = 0;
  let packageCacheIoMs = 0;
  for (const path of options.packages === undefined ? packagePaths : []) {
    const node = filesByPath.get(path);
    if (node === undefined) continue;
    const loaded = getPackageFacts(
      ingestion,
      node,
      inputs.diagnostics,
      options.store,
    );
    if (loaded.reused) reusedPackageArtifacts += 1;
    else parsedPackageManifests += 1;
    packageCacheIoMs += loaded.cacheIoMs;
    if (loaded.facts !== undefined) packages.push(loaded.facts);
  }

  const packageNodeIds = new Map<string, string>();
  const packagesByDirectory = new Map<string, PackageFacts>();
  const packagesByName = new Map<string, PackageFacts[]>();

  for (const facts of packages) {
    const identity = packageIdentity(ingestion.repository, facts.path);
    packageNodeIds.set(facts.path, nodeId(identity));
    packagesByDirectory.set(facts.directory, facts);
    if (options.packagePaths === undefined || options.packagePaths.has(facts.path)) inputs.nodes.push({
      identity,
      metadata: packageMetadata(facts),
      provenance: [factProvenance(ingestion, facts.path)],
    });

    const manifestNode = filesByPath.get(facts.path);
    if (manifestNode !== undefined && (options.packagePaths === undefined || options.packagePaths.has(facts.path))) {
      inputs.edges.push({
        identity: {
          kind: "declares-package",
          from: manifestNode.id,
          to: nodeId(identity),
        },
        provenance: [factProvenance(ingestion, facts.path)],
      });
    }

    if (facts.name !== undefined) {
      packagesByName.set(facts.name, [
        ...(packagesByName.get(facts.name) ?? []),
        facts,
      ]);
    }
  }

  let packageDependencies = 0;
  let packageMemberships = 0;
  let membershipFilesVisited = 0;
  let buildEntrypoints = 0;

  const membershipFiles = options.membershipPaths === undefined ? filesByPath : [...options.membershipPaths].filter((path) => filesByPath.has(path)).map((path) => [path, filesByPath.get(path)!] as const);
  for (const [path, fileNode] of membershipFiles) {
    membershipFilesVisited += 1;
    const owner = owningPackage(packagesByDirectory, path);
    if (owner === undefined) continue;
    const ownerId = packageNodeIds.get(owner.path);
    if (ownerId === undefined) continue;

    inputs.edges.push({
      identity: {
        kind: "belongs-to-package",
        from: fileNode.id,
        to: ownerId,
      },
      provenance: [factProvenance(ingestion, owner.path)],
    });
    packageMemberships += 1;
  }
  let contractEntrypoints = 0;
  let testRelations = 0;

  for (const source of packages) {
    if (options.packagePaths !== undefined && !options.packagePaths.has(source.path)) continue;
    const sourceId = packageNodeIds.get(source.path);
    if (sourceId === undefined) continue;

    for (const dependency of source.dependencies) {
      const target = resolveLocalDependency(
        source,
        dependency,
        packagesByDirectory,
        packagesByName,
      );
      if (target === undefined) {
        if (dependency.specifier.startsWith("workspace:")) {
          const matches = packagesByName.get(dependency.name) ?? [];
          inputs.diagnostics.push(
            diagnostic(
              ingestion,
              source.path,
              matches.length > 1
                ? "repository-relations-ambiguous-workspace-dependency"
                : "repository-relations-unresolved-workspace-dependency",
              matches.length > 1
                ? `Workspace dependency ${dependency.name} from ${source.path} matches multiple package manifests`
                : `Workspace dependency ${dependency.name} from ${source.path} has no unique package manifest`,
              matches.length > 1 ? "partial" : "unresolved",
            ),
          );
        }
        continue;
      }

      const targetId = packageNodeIds.get(target.path);
      if (targetId === undefined) continue;
      inputs.edges.push({
        identity: {
          kind: "package-dependency",
          from: sourceId,
          to: targetId,
          key: `${dependency.field}:${dependency.name}`,
        },
        metadata: {
          field: dependency.field,
          dependencyName: dependency.name,
          specifier: dependency.specifier,
        },
        provenance: [factProvenance(ingestion, source.path)],
      });
      packageDependencies += 1;
    }

    for (const entrypoint of source.entrypoints) {
      const targetPath = resolveManifestRelativePath(source, entrypoint.target);
      const targetNode =
        targetPath === undefined ? undefined : filesByPath.get(targetPath);
      if (targetNode === undefined) {
        inputs.diagnostics.push(
          diagnostic(
            ingestion,
            source.path,
            "repository-relations-unresolved-entrypoint",
            `Declared ${entrypoint.field} target ${entrypoint.target} from ${source.path} is not a file at this revision`,
            "partial",
          ),
        );
        continue;
      }

      const kind =
        entrypoint.relation === "contract"
          ? "package-contract"
          : "package-build-entrypoint";
      inputs.edges.push({
        identity: {
          kind,
          from: sourceId,
          to: targetNode.id,
          key: `${entrypoint.field}:${entrypoint.target}`,
        },
        metadata: {
          field: entrypoint.field,
          target: entrypoint.target,
        },
        provenance: [factProvenance(ingestion, source.path)],
      });
      if (entrypoint.relation === "contract") contractEntrypoints += 1;
      else buildEntrypoints += 1;
    }
  }

  for (const [path, testNode] of testFiles) {
    const existing = testSourceCandidates(path)
      .map((candidate) => filesByPath.get(candidate))
      .filter((node): node is GraphNode => node !== undefined);
    const unique = [...new Map(existing.map((node) => [node.id, node])).values()];
    if (unique.length !== 1) {
      if (unique.length > 1) {
        inputs.diagnostics.push(
          diagnostic(
            ingestion,
            path,
            "repository-relations-ambiguous-test-source",
            `Test convention for ${path} matches multiple source files; no tests edge emitted`,
          ),
        );
      }
      continue;
    }

    const sourceNode = unique[0]!;
    inputs.edges.push({
      identity: {
        kind: "tests",
        from: testNode.id,
        to: sourceNode.id,
        key: "filename-convention",
      },
      metadata: {
        convention:
          posix.basename(posix.dirname(path)) === "__tests__"
            ? "__tests__-basename"
            : "same-directory-basename",
      },
      provenance: [factProvenance(ingestion, path)],
    });
    testRelations += 1;
  }

  return {
    inputs,
    packages,
    metrics: {
      indexedFiles: filesByPath.size,
      packageManifestCandidates: packagePaths.length,
      testFileCandidates: testFiles.length,
      membershipFilesVisited,
      packageManifests: packages.length,
      parsedPackageManifests,
      reusedPackageArtifacts,
      packageCacheIoMs,
      packageNodes: packages.length,
      packageDependencies,
      packageMemberships,
      buildEntrypoints,
      contractEntrypoints,
      testRelations,
      diagnostics: inputs.diagnostics.length,
    },
  };
}

/** Standalone graph and blob-manifest cache preserve their original public surface. */
export function extractRepositoryRelationships(
  ingestion: GitIngestionResult,
  options: RepositoryRelationshipExtractionOptions = {},
): RepositoryRelationshipExtractionResult {
  const result = extractRepositoryRelationshipInputs(ingestion, options);
  const base = graphInputs(ingestion.graph);
  return {
    graph: buildGraph({
      nodes: [...base.nodes, ...(result.inputs.nodes ?? [])],
      edges: [...base.edges, ...(result.inputs.edges ?? [])],
      diagnostics: [...base.diagnostics, ...(result.inputs.diagnostics ?? [])],
    }),
    metrics: result.metrics,
  };
}
