import { execFileSync } from "node:child_process";
import { posix } from "node:path";

import * as ts from "typescript";

import { canonicalJsonUnknown, toJsonValue } from "./canonical.js";
import { buildGraph, nodeId } from "./graph.js";
import {
  diffGitRepository,
  planIncrementalUpdate,
  type DiffBaseMode,
  type IncrementalUpdatePlan,
} from "./incremental.js";
import type {
  GraphDiagnostic,
  GraphDocument,
  GraphEdgeInput,
  GraphNode,
  GraphNodeInput,
  JsonValue,
  Provenance,
} from "./model.js";
import {
  ensureRepositorySnapshot,
  type RepositorySnapshotOptions,
  type RepositorySnapshotResult,
  type SnapshotAnalysisConfiguration,
} from "./snapshot.js";
import {
  artifactKey,
  type ArtifactIdentity,
  type LocalArtifactStore,
} from "./store.js";

export const TYPESCRIPT_DEPENDENCY_SCHEMA_VERSION =
  "repograph.typescript-dependencies/v1" as const;
export const TYPESCRIPT_SYNTAX_SCHEMA_VERSION =
  "repograph.typescript-syntax/v1" as const;
export const TYPESCRIPT_DEPENDENCY_EXTRACTOR = {
  name: "typescript-module-deps",
  version: "0.0.2",
} as const;

const TYPESCRIPT_PARSER = {
  name: "typescript",
  version: ts.version,
} as const;

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const RESOLUTION_EXTENSIONS = [
  ...SOURCE_EXTENSIONS,
  ".json",
] as const;

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

type SyntaxDependencyKind =
  | "import"
  | "re-export"
  | "dynamic-import"
  | "require";

interface SyntaxDependency {
  kind: SyntaxDependencyKind;
  specifier: string;
  typeOnly: boolean;
}

interface SyntaxParseDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

interface SyntaxArtifact {
  schemaVersion: typeof TYPESCRIPT_SYNTAX_SCHEMA_VERSION;
  dependencies: SyntaxDependency[];
  exports: string[];
  diagnostics: SyntaxParseDiagnostic[];
}

interface ProjectConfig {
  path: string;
  directory: string;
  baseUrl?: string;
  paths: Record<string, string[]>;
  references: string[];
}

export interface TypeScriptExtractionMetrics {
  candidateFiles: number;
  parsedFiles: number;
  reusedSyntaxArtifacts: number;
  resolvedInternalDependencies: number;
  externalDependencies: number;
  unresolvedDependencies: number;
  exportedSymbols: number;
  projects: number;
  projectReferences: number;
}

export interface TypeScriptExtractionResult {
  graph: GraphDocument;
  metrics: TypeScriptExtractionMetrics;
}

export interface TypeScriptRepositoryExtractionOptions
  extends Omit<RepositorySnapshotOptions, "analysis"> {}

export interface TypeScriptRepositoryExtractionResult
  extends Omit<RepositorySnapshotResult, "graph">,
    TypeScriptExtractionResult {}

export interface IncrementalTypeScriptRepositoryOptions
  extends Omit<TypeScriptRepositoryExtractionOptions, "ref"> {
  baseRef: string;
  targetRef: string;
  baseMode?: DiffBaseMode;
  invalidationEdgeKinds?: string[];
}

export interface IncrementalTypeScriptRepositoryResult {
  plan: IncrementalUpdatePlan;
  targetGraph: GraphDocument;
  baseSnapshotKey: string;
  targetSnapshotKey: string;
  baseExtraction: TypeScriptExtractionMetrics;
  targetExtraction: TypeScriptExtractionMetrics;
}

function gitBlob(repositoryRoot: string, sha: string): string {
  try {
    return execFileSync("git", ["cat-file", "blob", sha], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `git cat-file blob ${sha} failed in ${repositoryRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sourceExtension(path: string): string {
  return posix.extname(path).toLowerCase();
}

function isSourceFile(node: GraphNode): boolean {
  return (
    node.identity.kind === "file" &&
    SOURCE_EXTENSIONS.includes(
      sourceExtension(node.identity.key) as (typeof SOURCE_EXTENSIONS)[number],
    )
  );
}

function blobIdentity(node: GraphNode): string | undefined {
  const blob = node.metadata?.blobSha ?? node.metadata?.gitObject;
  return typeof blob === "string" ? blob : undefined;
}

function derivedProvenance(
  source: GraphNode,
  state: Provenance["state"] = "complete",
  diagnostic?: string,
): Provenance {
  const observed = source.provenance[0];
  if (observed === undefined) {
    throw new Error(`Source node ${source.id} has no provenance`);
  }
  return {
    repository: observed.repository,
    ref: observed.ref,
    ...(observed.commit === undefined ? {} : { commit: observed.commit }),
    path: source.identity.key,
    extractor: { ...TYPESCRIPT_DEPENDENCY_EXTRACTOR },
    origin: "derived",
    method: "deterministic-extraction",
    state,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function scriptKind(path: string): ts.ScriptKind {
  switch (sourceExtension(path)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".json":
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.TS;
  }
}

function hasModifier(
  node: ts.Node,
  kind: ts.SyntaxKind.ExportKeyword | ts.SyntaxKind.DefaultKeyword,
): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

function collectBindingNames(name: ts.BindingName, target: Set<string>): void {
  if (ts.isIdentifier(name)) {
    target.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, target);
    }
  }
}

function literalSpecifier(node: ts.Expression | undefined): string | undefined {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function analyzeSyntax(path: string, text: string): SyntaxArtifact {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const dependencies: SyntaxDependency[] = [];
  const exported = new Set<string>();

  const pushDependency = (
    kind: SyntaxDependencyKind,
    specifier: string | undefined,
    typeOnly = false,
  ): void => {
    if (specifier === undefined || specifier.length === 0) return;
    dependencies.push({ kind, specifier, typeOnly });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      pushDependency(
        "import",
        ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined,
        node.importClause?.isTypeOnly ?? false,
      );
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        pushDependency(
          "require",
          literalSpecifier(node.moduleReference.expression),
          node.isTypeOnly,
        );
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        pushDependency(
          "re-export",
          ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : undefined,
          node.isTypeOnly,
        );
      }
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exported.add(element.name.text);
        }
      }
    } else if (ts.isExportAssignment(node)) {
      exported.add("default");
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
          exported.add("default");
        } else if (node.name !== undefined) {
          exported.add(node.name.text);
        }
      }
    } else if (ts.isVariableStatement(node)) {
      if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          collectBindingNames(declaration.name, exported);
        }
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        pushDependency("dynamic-import", literalSpecifier(node.arguments[0]));
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        pushDependency("require", literalSpecifier(node.arguments[0]));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const diagnostics: SyntaxParseDiagnostic[] = sourceFile.parseDiagnostics.map(
    (diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
      );
      if (diagnostic.start === undefined) return { message };
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      return {
        message,
        line: position.line + 1,
        column: position.character + 1,
      };
    },
  );

  const uniqueDependencies = new Map<string, SyntaxDependency>();
  for (const dependency of dependencies) {
    uniqueDependencies.set(
      canonicalJsonUnknown(dependency),
      dependency,
    );
  }

  return {
    schemaVersion: TYPESCRIPT_SYNTAX_SCHEMA_VERSION,
    dependencies: [...uniqueDependencies.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value),
    exports: [...exported].sort(),
    diagnostics,
  };
}

function syntaxIdentity(blobSha: string): ArtifactIdentity {
  return {
    contentIdentity: `git-blob:${blobSha}`,
    artifactKind: "typescript-syntax-dependencies",
    extractor: { ...TYPESCRIPT_DEPENDENCY_EXTRACTOR },
    parser: { ...TYPESCRIPT_PARSER },
    schemaVersion: TYPESCRIPT_SYNTAX_SCHEMA_VERSION,
  };
}

function requireRecord(value: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseSyntaxArtifact(payload: JsonValue): SyntaxArtifact {
  const raw = requireRecord(payload, "syntax artifact");
  if (raw.schemaVersion !== TYPESCRIPT_SYNTAX_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported syntax artifact schema: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.dependencies) || !Array.isArray(raw.exports)) {
    throw new Error("Malformed syntax artifact arrays");
  }
  if (!Array.isArray(raw.diagnostics)) {
    throw new Error("Malformed syntax artifact diagnostics");
  }

  const dependencies = raw.dependencies.map((item, index) => {
    const dependency = requireRecord(item, `dependencies[${index}]`);
    const kind = requireString(dependency.kind, `dependencies[${index}].kind`);
    if (
      kind !== "import" &&
      kind !== "re-export" &&
      kind !== "dynamic-import" &&
      kind !== "require"
    ) {
      throw new Error(`Unsupported syntax dependency kind: ${kind}`);
    }
    if (typeof dependency.typeOnly !== "boolean") {
      throw new Error(`dependencies[${index}].typeOnly must be boolean`);
    }
    return {
      kind,
      specifier: requireString(
        dependency.specifier,
        `dependencies[${index}].specifier`,
      ),
      typeOnly: dependency.typeOnly,
    };
  });

  const exports = raw.exports.map((value, index) =>
    requireString(value, `exports[${index}]`),
  );

  const diagnostics = raw.diagnostics.map((item, index) => {
    const diagnostic = requireRecord(item, `diagnostics[${index}]`);
    const line =
      diagnostic.line === undefined
        ? undefined
        : typeof diagnostic.line === "number"
          ? diagnostic.line
          : (() => {
              throw new Error(`diagnostics[${index}].line must be a number`);
            })();
    const column =
      diagnostic.column === undefined
        ? undefined
        : typeof diagnostic.column === "number"
          ? diagnostic.column
          : (() => {
              throw new Error(`diagnostics[${index}].column must be a number`);
            })();
    return {
      message: requireString(
        diagnostic.message,
        `diagnostics[${index}].message`,
      ),
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    };
  });

  return {
    schemaVersion: TYPESCRIPT_SYNTAX_SCHEMA_VERSION,
    dependencies,
    exports,
    diagnostics,
  };
}

function loadSyntax(
  store: LocalArtifactStore,
  repositoryRoot: string,
  node: GraphNode,
): { artifact: SyntaxArtifact; reused: boolean } {
  const blobSha = blobIdentity(node);
  if (blobSha === undefined) {
    throw new Error(`Source file ${node.identity.key} has no Git blob identity`);
  }

  const identity = syntaxIdentity(blobSha);
  const key = artifactKey(identity);
  const existing = store.getArtifact(key);
  if (existing !== undefined) {
    return { artifact: parseSyntaxArtifact(existing.payload), reused: true };
  }

  const artifact = analyzeSyntax(
    node.identity.key,
    gitBlob(repositoryRoot, blobSha),
  );
  store.putArtifact(identity, toJsonValue(artifact));
  return { artifact, reused: false };
}

function configFileNodes(graph: GraphDocument): GraphNode[] {
  return graph.nodes
    .filter(
      (node) =>
        node.identity.kind === "file" &&
        posix.basename(node.identity.key) === "tsconfig.json",
    )
    .sort((left, right) =>
      left.identity.key.localeCompare(right.identity.key),
    );
}

function readProjectConfig(
  repositoryRoot: string,
  node: GraphNode,
): { config?: ProjectConfig; diagnostic?: GraphDiagnostic } {
  const blobSha = blobIdentity(node);
  if (blobSha === undefined) {
    return {
      diagnostic: {
        code: "tsconfig-missing-blob",
        message: `tsconfig has no Git blob identity: ${node.identity.key}`,
        state: "unresolved",
        provenance: derivedProvenance(
          node,
          "unresolved",
          "tsconfig missing Git blob identity",
        ),
      },
    };
  }

  const parsed = ts.parseConfigFileTextToJson(
    node.identity.key,
    gitBlob(repositoryRoot, blobSha),
  );
  if (parsed.error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(
      parsed.error.messageText,
      "\n",
    );
    return {
      diagnostic: {
        code: "tsconfig-parse-error",
        message: `${node.identity.key}: ${message}`,
        state: "partial",
        provenance: derivedProvenance(node, "partial", message),
      },
    };
  }

  const raw =
    typeof parsed.config === "object" && parsed.config !== null
      ? (parsed.config as Record<string, unknown>)
      : {};
  const compilerOptions =
    typeof raw.compilerOptions === "object" &&
    raw.compilerOptions !== null &&
    !Array.isArray(raw.compilerOptions)
      ? (raw.compilerOptions as Record<string, unknown>)
      : {};

  const rawPaths =
    typeof compilerOptions.paths === "object" &&
    compilerOptions.paths !== null &&
    !Array.isArray(compilerOptions.paths)
      ? (compilerOptions.paths as Record<string, unknown>)
      : {};
  const paths: Record<string, string[]> = {};
  for (const [pattern, rawTargets] of Object.entries(rawPaths)) {
    if (!Array.isArray(rawTargets)) continue;
    const targets = rawTargets.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (targets.length > 0) paths[pattern] = targets;
  }

  const rawReferences = Array.isArray(raw.references) ? raw.references : [];
  const references = rawReferences.flatMap((reference) => {
    if (
      typeof reference !== "object" ||
      reference === null ||
      Array.isArray(reference)
    ) {
      return [];
    }
    const path = (reference as Record<string, unknown>).path;
    return typeof path === "string" && path.length > 0 ? [path] : [];
  });

  const directory = posix.dirname(node.identity.key);
  const rawBaseUrl = compilerOptions.baseUrl;

  return {
    config: {
      path: node.identity.key,
      directory: directory === "." ? "" : directory,
      ...(typeof rawBaseUrl === "string" && rawBaseUrl.length > 0
        ? {
            baseUrl: normalizeInternalPath(
              posix.join(directory, rawBaseUrl),
            ),
          }
        : {}),
      paths,
      references,
    },
  };
}

function normalizeInternalPath(path: string): string {
  const normalized = posix.normalize(path).replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}

function isInside(path: string, directory: string): boolean {
  return directory.length === 0 || path === directory || path.startsWith(`${directory}/`);
}

function nearestProject(
  path: string,
  projects: readonly ProjectConfig[],
): ProjectConfig | undefined {
  return projects
    .filter((project) => isInside(path, project.directory))
    .sort(
      (left, right) =>
        right.directory.length - left.directory.length ||
        left.path.localeCompare(right.path),
    )[0];
}

function extensionSubstitutions(path: string): string[] {
  const extension = sourceExtension(path);
  if (extension === ".js") {
    return [
      path.slice(0, -3) + ".ts",
      path.slice(0, -3) + ".tsx",
      path,
    ];
  }
  if (extension === ".mjs") {
    return [path.slice(0, -4) + ".mts", path];
  }
  if (extension === ".cjs") {
    return [path.slice(0, -4) + ".cts", path];
  }
  return [path];
}

function resolveFilePath(
  rawPath: string,
  allFiles: ReadonlySet<string>,
): string | undefined {
  const normalized = normalizeInternalPath(rawPath);
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    return undefined;
  }

  for (const candidate of extensionSubstitutions(normalized)) {
    if (allFiles.has(candidate)) return candidate;
  }

  if (sourceExtension(normalized).length === 0) {
    for (const extension of RESOLUTION_EXTENSIONS) {
      const candidate = `${normalized}${extension}`;
      if (allFiles.has(candidate)) return candidate;
    }
    for (const extension of RESOLUTION_EXTENSIONS) {
      const candidate = posix.join(normalized, `index${extension}`);
      if (allFiles.has(candidate)) return candidate;
    }
  }

  return undefined;
}

function aliasCapture(
  specifier: string,
  pattern: string,
): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return specifier === pattern ? "" : undefined;
  if (pattern.indexOf("*", star + 1) >= 0) return undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return undefined;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyCapture(target: string, capture: string): string {
  const star = target.indexOf("*");
  return star < 0 ? target : `${target.slice(0, star)}${capture}${target.slice(star + 1)}`;
}

interface Resolution {
  kind: "internal" | "external" | "unresolved";
  path?: string;
  reason?: string;
}

function resolveSpecifier(
  sourcePath: string,
  specifier: string,
  project: ProjectConfig | undefined,
  allFiles: ReadonlySet<string>,
): Resolution {
  if (specifier.startsWith(".")) {
    const resolved = resolveFilePath(
      posix.join(posix.dirname(sourcePath), specifier),
      allFiles,
    );
    return resolved === undefined
      ? { kind: "unresolved", reason: "relative target not found" }
      : { kind: "internal", path: resolved };
  }

  if (specifier.startsWith("/")) {
    return { kind: "unresolved", reason: "absolute repository import unsupported" };
  }

  if (project !== undefined) {
    const patterns = Object.entries(project.paths).sort(
      ([left], [right]) =>
        right.replace("*", "").length - left.replace("*", "").length ||
        left.localeCompare(right),
    );
    for (const [pattern, targets] of patterns) {
      const capture = aliasCapture(specifier, pattern);
      if (capture === undefined) continue;
      const base = project.baseUrl ?? project.directory;
      for (const target of targets) {
        const resolved = resolveFilePath(
          posix.join(base, applyCapture(target, capture)),
          allFiles,
        );
        if (resolved !== undefined) {
          return { kind: "internal", path: resolved };
        }
      }
      return {
        kind: "unresolved",
        reason: `tsconfig path alias ${pattern} matched but no target exists`,
      };
    }

    if (project.baseUrl !== undefined) {
      const resolved = resolveFilePath(
        posix.join(project.baseUrl, specifier),
        allFiles,
      );
      if (resolved !== undefined) {
        return { kind: "internal", path: resolved };
      }
    }
  }

  return { kind: "external" };
}

function nodeInput(node: GraphNode): GraphNodeInput {
  return {
    identity: node.identity,
    ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
    provenance: node.provenance,
  };
}

function edgeInputs(graph: GraphDocument): GraphEdgeInput[] {
  return graph.edges.map((edge) => ({
    identity: edge.identity,
    ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
    provenance: edge.provenance,
  }));
}

function projectNodeIdentity(repository: string, path: string) {
  return { namespace: repository, kind: "ts-project", key: path };
}

function moduleNodeIdentity(repository: string, path: string) {
  return { namespace: repository, kind: "module", key: path };
}

function symbolNodeIdentity(repository: string, path: string, name: string) {
  return {
    namespace: repository,
    kind: "symbol",
    key: `${path}#export:${name}`,
  };
}

function externalNodeIdentity(repository: string, specifier: string) {
  return {
    namespace: repository,
    kind: "external-module",
    key: specifier,
  };
}

function diagnosticForImport(
  source: GraphNode,
  specifier: string,
  reason: string,
): GraphDiagnostic {
  const message = `Cannot resolve "${specifier}" from ${source.identity.key}: ${reason}`;
  return {
    code: "ts-import-unresolved",
    message,
    state: "unresolved",
    provenance: derivedProvenance(source, "unresolved", message),
  };
}

export function typeScriptAnalysisConfiguration(): SnapshotAnalysisConfiguration {
  return {
    extractor: { ...TYPESCRIPT_DEPENDENCY_EXTRACTOR },
    parser: { ...TYPESCRIPT_PARSER },
    schemaVersion: TYPESCRIPT_DEPENDENCY_SCHEMA_VERSION,
  };
}

export function extractTypeScriptDependencies(
  store: LocalArtifactStore,
  repositoryRoot: string,
  baseGraph: GraphDocument,
): TypeScriptExtractionResult {
  const repositoryNode = baseGraph.nodes.find(
    (node) => node.identity.kind === "repository",
  );
  if (repositoryNode === undefined) {
    throw new Error("Graph has no repository node");
  }
  const repository = repositoryNode.identity.namespace;

  const allFileNodes = baseGraph.nodes.filter(
    (node) => node.identity.kind === "file",
  );
  const allFiles = new Set(allFileNodes.map((node) => node.identity.key));
  const fileByPath = new Map(
    allFileNodes.map((node) => [node.identity.key, node]),
  );

  const diagnostics: GraphDiagnostic[] = [...baseGraph.diagnostics];
  const projects: ProjectConfig[] = [];
  const configNodeByPath = new Map<string, GraphNode>();

  for (const configNode of configFileNodes(baseGraph)) {
    configNodeByPath.set(configNode.identity.key, configNode);
    const loaded = readProjectConfig(repositoryRoot, configNode);
    if (loaded.diagnostic !== undefined) diagnostics.push(loaded.diagnostic);
    if (loaded.config !== undefined) projects.push(loaded.config);
  }

  const additions: GraphNodeInput[] = [];
  const edges: GraphEdgeInput[] = edgeInputs(baseGraph);
  let projectReferences = 0;

  for (const project of projects) {
    const configNode = configNodeByPath.get(project.path)!;
    const provenance = [derivedProvenance(configNode)];
    const projectIdentity = projectNodeIdentity(repository, project.path);
    const projectId = nodeId(projectIdentity);
    additions.push({
      identity: projectIdentity,
      metadata: {
        configPath: project.path,
        ...(project.baseUrl === undefined ? {} : { baseUrl: project.baseUrl }),
      },
      provenance,
    });
    edges.push({
      identity: {
        kind: "defines-project",
        from: configNode.id,
        to: projectId,
      },
      provenance,
    });

    for (const reference of project.references) {
      const rawTarget = normalizeInternalPath(
        posix.join(project.directory, reference),
      );
      const targetPath =
        configNodeByPath.has(rawTarget)
          ? rawTarget
          : normalizeInternalPath(posix.join(rawTarget, "tsconfig.json"));
      const target = projects.find((candidate) => candidate.path === targetPath);
      if (target === undefined) {
        const message = `Cannot resolve project reference "${reference}" from ${project.path}`;
        diagnostics.push({
          code: "ts-project-reference-unresolved",
          message,
          state: "unresolved",
          provenance: derivedProvenance(
            configNode,
            "unresolved",
            message,
          ),
        });
        continue;
      }
      edges.push({
        identity: {
          kind: "project-reference",
          from: projectId,
          to: nodeId(projectNodeIdentity(repository, target.path)),
          key: reference,
        },
        metadata: { reference },
        provenance,
      });
      projectReferences += 1;
    }
  }

  const candidates = baseGraph.nodes
    .filter(isSourceFile)
    .sort((left, right) =>
      left.identity.key.localeCompare(right.identity.key),
    );

  const metrics: TypeScriptExtractionMetrics = {
    candidateFiles: candidates.length,
    parsedFiles: 0,
    reusedSyntaxArtifacts: 0,
    resolvedInternalDependencies: 0,
    externalDependencies: 0,
    unresolvedDependencies: 0,
    exportedSymbols: 0,
    projects: projects.length,
    projectReferences,
  };

  for (const source of candidates) {
    const syntax = loadSyntax(store, repositoryRoot, source);
    if (syntax.reused) metrics.reusedSyntaxArtifacts += 1;
    else metrics.parsedFiles += 1;

    const provenance = [derivedProvenance(source)];
    const moduleIdentity = moduleNodeIdentity(
      repository,
      source.identity.key,
    );
    const moduleId = nodeId(moduleIdentity);
    additions.push({
      identity: moduleIdentity,
      metadata: {
        sourcePath: source.identity.key,
        language:
          sourceExtension(source.identity.key).startsWith(".j")
            ? "javascript"
            : "typescript",
        ...(blobIdentity(source) === undefined
          ? {}
          : { blobSha: blobIdentity(source)! }),
      },
      provenance,
    });
    edges.push({
      identity: {
        kind: "defines-module",
        from: source.id,
        to: moduleId,
      },
      provenance,
    });

    const project = nearestProject(source.identity.key, projects);
    if (project !== undefined) {
      edges.push({
        identity: {
          kind: "belongs-to-project",
          from: moduleId,
          to: nodeId(projectNodeIdentity(repository, project.path)),
        },
        provenance,
      });
    }

    for (const exported of syntax.artifact.exports) {
      const symbolIdentity = symbolNodeIdentity(
        repository,
        source.identity.key,
        exported,
      );
      const symbolId = nodeId(symbolIdentity);
      additions.push({
        identity: symbolIdentity,
        metadata: { name: exported, exportKind: "named-or-default" },
        provenance,
      });
      edges.push({
        identity: {
          kind: "exports",
          from: moduleId,
          to: symbolId,
          key: exported,
        },
        metadata: { name: exported },
        provenance,
      });
      metrics.exportedSymbols += 1;
    }

    for (const parseDiagnostic of syntax.artifact.diagnostics) {
      const location =
        parseDiagnostic.line === undefined
          ? ""
          : `:${parseDiagnostic.line}${parseDiagnostic.column === undefined ? "" : `:${parseDiagnostic.column}`}`;
      const message = `${source.identity.key}${location}: ${parseDiagnostic.message}`;
      diagnostics.push({
        code: "ts-parse-partial",
        message,
        state: "partial",
        provenance: derivedProvenance(source, "partial", message),
      });
    }

    for (const dependency of syntax.artifact.dependencies) {
      const resolution = resolveSpecifier(
        source.identity.key,
        dependency.specifier,
        project,
        allFiles,
      );
      const relationKind =
        dependency.kind === "re-export" ? "re-exports" : "imports";

      if (resolution.kind === "internal" && resolution.path !== undefined) {
        const target = fileByPath.get(resolution.path);
        if (target === undefined) {
          throw new Error(
            `Resolved file disappeared from graph: ${resolution.path}`,
          );
        }
        edges.push({
          identity: {
            kind: relationKind,
            from: source.id,
            to: target.id,
            key: canonicalJsonUnknown({
              specifier: dependency.specifier,
              syntax: dependency.kind,
            }),
          },
          metadata: {
            specifier: dependency.specifier,
            syntax: dependency.kind,
            typeOnly: dependency.typeOnly,
          },
          provenance,
        });
        metrics.resolvedInternalDependencies += 1;
      } else if (resolution.kind === "external") {
        const externalIdentity = externalNodeIdentity(
          repository,
          dependency.specifier,
        );
        const externalId = nodeId(externalIdentity);
        additions.push({
          identity: externalIdentity,
          metadata: { specifier: dependency.specifier },
          provenance,
        });
        edges.push({
          identity: {
            kind:
              dependency.kind === "re-export"
                ? "re-exports-external"
                : "imports-external",
            from: source.id,
            to: externalId,
            key: canonicalJsonUnknown({
              specifier: dependency.specifier,
              syntax: dependency.kind,
            }),
          },
          metadata: {
            specifier: dependency.specifier,
            syntax: dependency.kind,
            typeOnly: dependency.typeOnly,
          },
          provenance,
        });
        metrics.externalDependencies += 1;
      } else {
        diagnostics.push(
          diagnosticForImport(
            source,
            dependency.specifier,
            resolution.reason ?? "unresolved",
          ),
        );
        metrics.unresolvedDependencies += 1;
      }
    }
  }

  const graph = buildGraph({
    nodes: [
      ...baseGraph.nodes.map(nodeInput),
      ...additions,
    ],
    edges,
    diagnostics,
  });

  return { graph, metrics };
}

export function extractTypeScriptRepository(
  store: LocalArtifactStore,
  options: TypeScriptRepositoryExtractionOptions,
): TypeScriptRepositoryExtractionResult {
  const snapshot = ensureRepositorySnapshot(store, {
    ...options,
    analysis: typeScriptAnalysisConfiguration(),
  });
  const extracted = extractTypeScriptDependencies(
    store,
    snapshot.repositoryRoot,
    snapshot.graph,
  );
  return {
    ...snapshot,
    graph: extracted.graph,
    metrics: extracted.metrics,
  };
}

export function incrementalTypeScriptRepositoryUpdate(
  store: LocalArtifactStore,
  options: IncrementalTypeScriptRepositoryOptions,
): IncrementalTypeScriptRepositoryResult {
  const diff = diffGitRepository({
    repositoryPath: options.repositoryPath,
    baseRef: options.baseRef,
    targetRef: options.targetRef,
    ...(options.baseMode === undefined ? {} : { baseMode: options.baseMode }),
  });
  const common = {
    repositoryPath: options.repositoryPath,
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.pathRules === undefined ? {} : { pathRules: options.pathRules }),
    ...(options.discoverCodeowners === undefined
      ? {}
      : { discoverCodeowners: options.discoverCodeowners }),
  };

  const base = extractTypeScriptRepository(store, {
    ...common,
    ref: diff.baseCommit,
  });
  store.resetStats();
  const target = extractTypeScriptRepository(store, {
    ...common,
    ref: diff.targetCommit,
  });

  const analysis = typeScriptAnalysisConfiguration();
  const plan = planIncrementalUpdate({
    baseGraph: base.graph,
    targetGraph: target.graph,
    diff,
    cache: store.getStats(),
    previousAnalysis: analysis,
    analysis,
    invalidationEdgeKinds:
      options.invalidationEdgeKinds ?? ["imports", "re-exports"],
  });

  return {
    plan,
    targetGraph: target.graph,
    baseSnapshotKey: base.manifestKey,
    targetSnapshotKey: target.manifestKey,
    baseExtraction: base.metrics,
    targetExtraction: target.metrics,
  };
}
