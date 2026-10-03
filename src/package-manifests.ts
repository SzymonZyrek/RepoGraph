import { execFileSync } from "node:child_process";
import { posix } from "node:path";

import { buildGraph, nodeId } from "./graph.js";
import type { GitIngestionResult } from "./git.js";
import type {
  GraphDiagnostic,
  GraphDocument,
  GraphEdgeInput,
  GraphNode,
  GraphNodeInput,
  JsonObject,
  Provenance,
} from "./model.js";

export const PACKAGE_MANIFEST_EXTRACTOR = {
  name: "repograph-package-manifests",
  version: "0.0.3",
} as const;

const DEPENDENCY_SCOPES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type PackageDependencyScope = (typeof DEPENDENCY_SCOPES)[number];

interface ManifestDependency {
  name: string;
  scope: PackageDependencyScope;
  specifier: string;
}

interface PackageManifest {
  path: string;
  directory: string;
  name?: string;
  version?: string;
  dependencies: ManifestDependency[];
}

export interface PackageManifestExtractionMetrics {
  manifests: number;
  parsedManifests: number;
  packageNodes: number;
  internalDependencies: number;
  externalDependencies: number;
  ambiguousDependencies: number;
}

export interface PackageManifestExtractionResult {
  graph: GraphDocument;
  metrics: PackageManifestExtractionMetrics;
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
    extractor: PACKAGE_MANIFEST_EXTRACTOR,
    origin: "derived",
    method: "deterministic-extraction",
    state,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function dependencyEntries(
  record: Record<string, unknown>,
): ManifestDependency[] {
  const result: ManifestDependency[] = [];

  for (const scope of DEPENDENCY_SCOPES) {
    const raw = record[scope];
    if (!isRecord(raw)) continue;

    for (const [name, specifier] of Object.entries(raw)) {
      if (typeof specifier !== "string") continue;
      result.push({ name, scope, specifier });
    }
  }

  return result.sort((left, right) => {
    const leftKey = `${left.scope}\0${left.name}\0${left.specifier}`;
    const rightKey = `${right.scope}\0${right.name}\0${right.specifier}`;
    return leftKey.localeCompare(rightKey);
  });
}

function parseManifest(
  ingestion: GitIngestionResult,
  node: GraphNode,
  diagnostics: GraphDiagnostic[],
): PackageManifest | undefined {
  const provenance = factProvenance(ingestion, node.identity.key, "partial");

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      gitText(ingestion.repositoryRoot, ingestion.commit, node.identity.key),
    ) as unknown;
  } catch (error) {
    diagnostics.push({
      code: "package-manifest-invalid-json",
      message: `Could not parse ${node.identity.key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      state: "partial",
      provenance,
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    diagnostics.push({
      code: "package-manifest-invalid-shape",
      message: `${node.identity.key} must contain a JSON object`,
      state: "partial",
      provenance,
    });
    return undefined;
  }

  const name = typeof parsed.name === "string" && parsed.name.length > 0
    ? parsed.name
    : undefined;
  const version = typeof parsed.version === "string" && parsed.version.length > 0
    ? parsed.version
    : undefined;

  return {
    path: node.identity.key,
    directory: posix.dirname(node.identity.key),
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    dependencies: dependencyEntries(parsed),
  };
}

function packageIdentity(
  ingestion: GitIngestionResult,
  manifest: PackageManifest,
) {
  return {
    namespace: ingestion.repository,
    kind: "package",
    key: manifest.path,
  };
}

function packageMetadata(manifest: PackageManifest): JsonObject {
  return {
    manifestPath: manifest.path,
    ...(manifest.name === undefined ? {} : { name: manifest.name }),
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
  };
}

function containsPath(directory: string, path: string): boolean {
  return directory === "." || path.startsWith(`${directory}/`);
}

function owningManifest(
  manifests: readonly PackageManifest[],
  path: string,
): PackageManifest | undefined {
  const candidates = manifests
    .filter((manifest) => containsPath(manifest.directory, path))
    .sort(
      (left, right) =>
        right.directory.length - left.directory.length ||
        left.path.localeCompare(right.path),
    );
  return candidates[0];
}

export function extractPackageManifestRelationships(
  ingestion: GitIngestionResult,
): PackageManifestExtractionResult {
  const inputs = graphInputs(ingestion.graph);
  const fileNodes = ingestion.graph.nodes.filter(
    (node) => node.identity.kind === "file",
  );
  const manifestNodes = fileNodes.filter(
    (node) => posix.basename(node.identity.key) === "package.json",
  );

  const manifests = manifestNodes
    .map((node) => parseManifest(ingestion, node, inputs.diagnostics))
    .filter((manifest): manifest is PackageManifest => manifest !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));

  const packageIds = new Map<string, string>();
  const manifestNodeByPath = new Map(
    manifestNodes.map((node) => [node.identity.key, node]),
  );

  for (const manifest of manifests) {
    const identity = packageIdentity(ingestion, manifest);
    const id = nodeId(identity);
    packageIds.set(manifest.path, id);

    inputs.nodes.push({
      identity,
      metadata: packageMetadata(manifest),
      provenance: [factProvenance(ingestion, manifest.path)],
    });

    const manifestNode = manifestNodeByPath.get(manifest.path);
    if (manifestNode !== undefined) {
      inputs.edges.push({
        identity: {
          kind: "declares-package",
          from: manifestNode.id,
          to: id,
        },
        provenance: [factProvenance(ingestion, manifest.path)],
      });
    }
  }

  for (const fileNode of fileNodes) {
    const owner = owningManifest(manifests, fileNode.identity.key);
    if (owner === undefined) continue;
    const ownerId = packageIds.get(owner.path);
    if (ownerId === undefined) continue;

    inputs.edges.push({
      identity: {
        kind: "belongs-to-package",
        from: fileNode.id,
        to: ownerId,
      },
      provenance: [factProvenance(ingestion, owner.path)],
    });
  }

  const byName = new Map<string, PackageManifest[]>();
  for (const manifest of manifests) {
    if (manifest.name === undefined) continue;
    byName.set(manifest.name, [...(byName.get(manifest.name) ?? []), manifest]);
  }

  for (const [name, matches] of [...byName.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (matches.length <= 1) continue;
    inputs.diagnostics.push({
      code: "package-manifest-duplicate-name",
      message: `Package name ${name} is declared by multiple manifests: ${matches
        .map((manifest) => manifest.path)
        .sort()
        .join(", ")}`,
      state: "partial",
      provenance: factProvenance(
        ingestion,
        matches[0]!.path,
        "partial",
        `Duplicate package name: ${name}`,
      ),
    });
  }

  let internalDependencies = 0;
  let externalDependencies = 0;
  let ambiguousDependencies = 0;

  for (const manifest of manifests) {
    const from = packageIds.get(manifest.path);
    if (from === undefined) continue;

    for (const dependency of manifest.dependencies) {
      const targets = byName.get(dependency.name) ?? [];
      if (targets.length === 0) {
        externalDependencies += 1;
        continue;
      }

      if (targets.length > 1) {
        ambiguousDependencies += 1;
        inputs.diagnostics.push({
          code: "package-dependency-ambiguous",
          message: `Dependency ${dependency.name} from ${manifest.path} matches multiple internal packages`,
          state: "unresolved",
          provenance: factProvenance(
            ingestion,
            manifest.path,
            "unresolved",
            `Ambiguous internal package: ${dependency.name}`,
          ),
        });
        continue;
      }

      const target = targets[0]!;
      const to = packageIds.get(target.path);
      if (to === undefined) continue;

      inputs.edges.push({
        identity: {
          kind: "package-depends-on",
          from,
          to,
          key: `${dependency.scope}:${dependency.name}`,
        },
        metadata: {
          dependency: dependency.name,
          scope: dependency.scope,
          specifier: dependency.specifier,
        },
        provenance: [factProvenance(ingestion, manifest.path)],
      });
      internalDependencies += 1;
    }
  }

  return {
    graph: buildGraph(inputs),
    metrics: {
      manifests: manifestNodes.length,
      parsedManifests: manifests.length,
      packageNodes: manifests.length,
      internalDependencies,
      externalDependencies,
      ambiguousDependencies,
    },
  };
}
