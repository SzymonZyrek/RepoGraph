import { execFileSync } from "node:child_process";
import { posix } from "node:path";

import * as ts from "typescript";

import { buildGraph, nodeId } from "./graph.js";
import type { GitIngestionResult } from "./git.js";
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
  artifactKey,
  type ArtifactIdentity,
  type LocalArtifactStore,
  type StoreStats,
} from "./store.js";

export const TSJS_EXTRACTOR = {
  name: "repograph-tsjs",
  version: "0.0.2",
} as const;

export const TSJS_SYNTAX_SCHEMA_VERSION = "repograph.tsjs-syntax/v1" as const;

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

type ImportRelation =
  | "import"
  | "reexport"
  | "import-equals"
  | "dynamic-import"
  | "require";

interface SyntaxImport {
  specifier: string;
  relation: ImportRelation;
  typeOnly: boolean;
}

interface SyntaxFacts {
  imports: SyntaxImport[];
  exports: string[];
}

interface TsConfigResolution {
  baseUrl: string;
  paths: Record<string, string[]>;
}

export interface TsJsExtractionMetrics {
  sourceFiles: number;
  parsedFiles: number;
  reusedSyntaxArtifacts: number;
  resolvedDependencies: number;
  unresolvedDependencies: number;
  externalDependencies: number;
}

export interface TsJsExtractionOptions {
  store?: LocalArtifactStore;
  tsconfigPath?: string;
}

export interface TsJsExtractionResult {
  graph: GraphDocument;
  metrics: TsJsExtractionMetrics;
  cache?: StoreStats;
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

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function collectBindingNames(name: ts.BindingName, values: Set<string>): void {
  if (ts.isIdentifier(name)) {
    values.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, values);
    }
  }
}

function stringArgument(node: ts.CallExpression): string | undefined {
  const first = node.arguments[0];
  return first !== undefined && ts.isStringLiteralLike(first)
    ? first.text
    : undefined;
}

function parseSyntax(path: string, text: string): SyntaxFacts {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const imports: SyntaxImport[] = [];
  const exports = new Set<string>();

  const addImport = (
    specifier: string,
    relation: ImportRelation,
    typeOnly = false,
  ): void => {
    imports.push({ specifier, relation, typeOnly });
  };

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      addImport(
        statement.moduleSpecifier.text,
        "import",
        statement.importClause?.isTypeOnly ?? false,
      );
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      addImport(
        statement.moduleSpecifier.text,
        "reexport",
        statement.isTypeOnly,
      );
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      addImport(
        statement.moduleReference.expression.text,
        "import-equals",
        statement.isTypeOnly,
      );
    }

    if (ts.isExportAssignment(statement)) {
      exports.add("default");
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exports.add(element.name.text);
        }
      } else {
        exports.add(statement.exportClause.name.text);
      }
      continue;
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;

    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      exports.add("default");
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      exports.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, exports);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const specifier = stringArgument(node);
      if (specifier !== undefined) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          addImport(specifier, "dynamic-import");
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        ) {
          addImport(specifier, "require");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const uniqueImports = new Map<string, SyntaxImport>();
  for (const item of imports) {
    uniqueImports.set(
      `${item.relation}\0${item.specifier}\0${item.typeOnly ? "1" : "0"}`,
      item,
    );
  }

  return {
    imports: [...uniqueImports.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => item),
    exports: [...exports].sort(),
  };
}

function syntaxPayload(facts: SyntaxFacts): JsonValue {
  return {
    imports: facts.imports.map((item) => ({
      specifier: item.specifier,
      relation: item.relation,
      typeOnly: item.typeOnly,
    })),
    exports: facts.exports,
  };
}

function decodeSyntax(value: JsonValue): SyntaxFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Cached TS/JS syntax artifact must be an object");
  }
  const rawImports = value.imports;
  const rawExports = value.exports;
  if (!Array.isArray(rawImports) || !Array.isArray(rawExports)) {
    throw new Error("Cached TS/JS syntax artifact has invalid shape");
  }

  const imports = rawImports.map((item): SyntaxImport => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Cached TS/JS import fact must be an object");
    }
    const specifier = item.specifier;
    const relation = item.relation;
    const typeOnly = item.typeOnly;
    if (
      typeof specifier !== "string" ||
      (relation !== "import" &&
        relation !== "reexport" &&
        relation !== "import-equals" &&
        relation !== "dynamic-import" &&
        relation !== "require") ||
      typeof typeOnly !== "boolean"
    ) {
      throw new Error("Cached TS/JS import fact has invalid fields");
    }
    return { specifier, relation, typeOnly };
  });

  const exports = rawExports.map((item) => {
    if (typeof item !== "string") {
      throw new Error("Cached TS/JS export name must be a string");
    }
    return item;
  });

  return { imports, exports };
}

function syntaxArtifactIdentity(node: GraphNode): ArtifactIdentity {
  const blob = node.metadata?.blobSha ?? node.metadata?.gitObject;
  if (typeof blob !== "string") {
    throw new Error(`Source file ${node.identity.key} has no Git blob identity`);
  }
  return {
    contentIdentity: `git-blob:${blob}`,
    artifactKind: "tsjs-syntax",
    extractor: TSJS_EXTRACTOR,
    parser: { name: "typescript", version: ts.version },
    schemaVersion: TSJS_SYNTAX_SCHEMA_VERSION,
  };
}

function getSyntaxFacts(
  ingestion: GitIngestionResult,
  node: GraphNode,
  store: LocalArtifactStore | undefined,
): { facts: SyntaxFacts; reused: boolean } {
  const identity = syntaxArtifactIdentity(node);
  if (store !== undefined) {
    const cached = store.getArtifact(artifactKey(identity));
    if (cached !== undefined) {
      return { facts: decodeSyntax(cached.payload), reused: true };
    }
  }

  const facts = parseSyntax(
    node.identity.key,
    gitText(ingestion.repositoryRoot, ingestion.commit, node.identity.key),
  );
  if (store !== undefined) {
    store.putArtifact(identity, syntaxPayload(facts));
  }
  return { facts, reused: false };
}

function normalizeRepoPath(path: string): string | undefined {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return undefined;
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function candidatePaths(candidate: string): string[] {
  const normalized = normalizeRepoPath(candidate);
  if (normalized === undefined) return [];

  const result = new Set<string>([normalized]);
  const extension = posix.extname(normalized);
  const stem = extension.length === 0 ? normalized : normalized.slice(0, -extension.length);

  if (extension === ".js") {
    result.add(`${stem}.ts`);
    result.add(`${stem}.tsx`);
    result.add(`${stem}.d.ts`);
  } else if (extension === ".jsx") {
    result.add(`${stem}.tsx`);
    result.add(`${stem}.ts`);
  } else if (extension === ".mjs") {
    result.add(`${stem}.mts`);
  } else if (extension === ".cjs") {
    result.add(`${stem}.cts`);
  } else if (extension.length === 0) {
    for (const sourceExtension of SOURCE_EXTENSIONS) {
      result.add(`${normalized}${sourceExtension}`);
      result.add(`${normalized}/index${sourceExtension}`);
    }
    result.add(`${normalized}.d.ts`);
    result.add(`${normalized}/index.d.ts`);
  }

  return [...result];
}

function matchPathPattern(
  pattern: string,
  specifier: string,
): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return undefined;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function readTsConfig(
  ingestion: GitIngestionResult,
  paths: ReadonlySet<string>,
  requestedPath: string,
  diagnostics: GraphDiagnostic[],
): TsConfigResolution {
  if (!paths.has(requestedPath)) {
    return { baseUrl: ".", paths: {} };
  }

  const provenance: Provenance = {
    repository: ingestion.repository,
    ref: ingestion.requestedRef,
    commit: ingestion.commit,
    path: requestedPath,
    extractor: TSJS_EXTRACTOR,
    origin: "derived",
    method: "deterministic-extraction",
    state: "partial",
  };

  const parsed = ts.parseConfigFileTextToJson(
    requestedPath,
    gitText(ingestion.repositoryRoot, ingestion.commit, requestedPath),
  );
  if (parsed.error !== undefined || parsed.config === undefined) {
    diagnostics.push({
      code: "tsjs-tsconfig-invalid",
      message: `Could not parse ${requestedPath}; alias resolution disabled`,
      state: "partial",
      provenance,
    });
    return { baseUrl: ".", paths: {} };
  }

  const compilerOptions = parsed.config.compilerOptions;
  const baseUrl =
    typeof compilerOptions?.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const rawPaths = compilerOptions?.paths;
  const result: Record<string, string[]> = {};

  if (typeof rawPaths === "object" && rawPaths !== null && !Array.isArray(rawPaths)) {
    for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (Array.isArray(targets)) {
        const strings = targets.filter((target): target is string => typeof target === "string");
        if (strings.length > 0) result[pattern] = strings;
      }
    }
  }

  return { baseUrl, paths: result };
}

function firstExisting(
  candidate: string,
  paths: ReadonlySet<string>,
): string | undefined {
  return candidatePaths(candidate).find((path) => paths.has(path));
}

function resolveSpecifier(
  importerPath: string,
  specifier: string,
  files: ReadonlySet<string>,
  config: TsConfigResolution,
): { path?: string; external: boolean } {
  if (specifier.startsWith(".")) {
    const candidate = posix.join(posix.dirname(importerPath), specifier);
    const resolved = firstExisting(candidate, files);
    return resolved === undefined
      ? { external: false }
      : { path: resolved, external: false };
  }

  if (specifier.startsWith("/")) {
    const resolved = firstExisting(specifier.slice(1), files);
    return resolved === undefined
      ? { external: false }
      : { path: resolved, external: false };
  }

  const patterns = Object.entries(config.paths).sort(
    ([left], [right]) =>
      Number(left.includes("*")) - Number(right.includes("*")) ||
      right.length - left.length,
  );
  for (const [pattern, targets] of patterns) {
    const wildcard = matchPathPattern(pattern, specifier);
    if (wildcard === undefined) continue;
    for (const target of targets) {
      const expanded = target.replace("*", wildcard);
      const candidate = posix.join(config.baseUrl, expanded);
      const resolved = firstExisting(candidate, files);
      if (resolved !== undefined) return { path: resolved, external: false };
    }
    return { external: false };
  }

  return { external: true };
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
    extractor: TSJS_EXTRACTOR,
    origin: "derived",
    method: "deterministic-extraction",
    state,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

export function extractTypeScriptJavaScriptDependencies(
  ingestion: GitIngestionResult,
  options: TsJsExtractionOptions = {},
): TsJsExtractionResult {
  const inputs = graphInputs(ingestion.graph);
  const fileNodes = ingestion.graph.nodes.filter(
    (node) => node.identity.kind === "file",
  );
  const files = new Set(fileNodes.map((node) => node.identity.key));
  const sourceNodes = fileNodes.filter((node) => isSourcePath(node.identity.key));
  const byPath = new Map(fileNodes.map((node) => [node.identity.key, node]));
  const tsconfigPath = options.tsconfigPath ?? "tsconfig.json";
  const config = readTsConfig(ingestion, files, tsconfigPath, inputs.diagnostics);

  let parsedFiles = 0;
  let reusedSyntaxArtifacts = 0;
  let resolvedDependencies = 0;
  let unresolvedDependencies = 0;
  let externalDependencies = 0;

  for (const sourceNode of sourceNodes) {
    const syntax = getSyntaxFacts(ingestion, sourceNode, options.store);
    if (syntax.reused) reusedSyntaxArtifacts += 1;
    else parsedFiles += 1;

    for (const exportedName of syntax.facts.exports) {
      const symbolIdentity = {
        namespace: ingestion.repository,
        kind: "symbol",
        key: `${sourceNode.identity.key}#export:${exportedName}`,
      };
      inputs.nodes.push({
        identity: symbolIdentity,
        metadata: {
          name: exportedName,
          modulePath: sourceNode.identity.key,
          exported: true,
        },
        provenance: [factProvenance(ingestion, sourceNode.identity.key)],
      });
      inputs.edges.push({
        identity: {
          kind: "exports",
          from: sourceNode.id,
          to: nodeId(symbolIdentity),
          key: exportedName,
        },
        metadata: { name: exportedName },
        provenance: [factProvenance(ingestion, sourceNode.identity.key)],
      });
    }

    for (const dependency of syntax.facts.imports) {
      const resolution = resolveSpecifier(
        sourceNode.identity.key,
        dependency.specifier,
        files,
        config,
      );

      if (resolution.path !== undefined) {
        const target = byPath.get(resolution.path);
        if (target === undefined) {
          throw new Error(`Resolved module path is not present in graph: ${resolution.path}`);
        }
        inputs.edges.push({
          identity: {
            kind: dependency.relation === "reexport" ? "reexports" : "imports",
            from: sourceNode.id,
            to: target.id,
            key: `${dependency.relation}:${dependency.specifier}`,
          },
          metadata: {
            specifier: dependency.specifier,
            relation: dependency.relation,
            typeOnly: dependency.typeOnly,
          },
          provenance: [factProvenance(ingestion, sourceNode.identity.key)],
        });
        resolvedDependencies += 1;
        continue;
      }

      if (resolution.external) {
        externalDependencies += 1;
        inputs.diagnostics.push({
          code: "tsjs-external-module",
          message: `External module not represented as an internal edge: ${dependency.specifier} from ${sourceNode.identity.key}`,
          state: "partial",
          provenance: factProvenance(
            ingestion,
            sourceNode.identity.key,
            "partial",
            `External module: ${dependency.specifier}`,
          ),
        });
      } else {
        unresolvedDependencies += 1;
        inputs.diagnostics.push({
          code: "tsjs-unresolved-import",
          message: `Unresolved repository import: ${dependency.specifier} from ${sourceNode.identity.key}`,
          state: "unresolved",
          provenance: factProvenance(
            ingestion,
            sourceNode.identity.key,
            "unresolved",
            `Unresolved import: ${dependency.specifier}`,
          ),
        });
      }
    }
  }

  return {
    graph: buildGraph(inputs),
    metrics: {
      sourceFiles: sourceNodes.length,
      parsedFiles,
      reusedSyntaxArtifacts,
      resolvedDependencies,
      unresolvedDependencies,
      externalDependencies,
    },
    ...(options.store === undefined ? {} : { cache: options.store.getStats() }),
  };
}
