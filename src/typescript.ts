import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix } from "node:path";

import * as ts from "typescript";

import { toJsonValue } from "./canonical.js";
import { buildGraph, nodeId } from "./graph.js";
import { normalizeRepoPath } from "./glob.js";
import type {
  GraphDiagnostic,
  GraphDocument,
  GraphEdgeInput,
  GraphNode,
  GraphNodeInput,
  JsonObject,
  JsonValue,
  Provenance,
} from "./model.js";
import {
  artifactKey,
  type ArtifactIdentity,
  type LocalArtifactStore,
} from "./store.js";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const EXTRACTOR = { name: "typescript-js-modules", version: "0.0.2" } as const;
const SYNTAX_SCHEMA = "repograph.ts-module-syntax/v1";
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

type ImportKind = "import" | "export-from" | "require" | "dynamic-import";

interface SyntaxImport {
  specifier: string;
  kind: ImportKind;
  typeOnly: boolean;
}

interface ModuleSyntax {
  imports: SyntaxImport[];
  exports: string[];
}

interface TsConfigRules {
  path: string;
  directory: string;
  baseUrl?: string;
  paths: Array<{ pattern: string; targets: string[] }>;
}

export interface TypeScriptExtractionOptions {
  repositoryPath: string;
  ref: string;
  graph: GraphDocument;
  repository?: string;
  store?: LocalArtifactStore;
  tsconfigPaths?: string[];
}

export interface TypeScriptExtractionMetrics {
  sourceFiles: number;
  parsedArtifacts: number;
  reusedArtifacts: number;
  modules: number;
  symbols: number;
  resolvedImports: number;
  unresolvedImports: number;
}

export interface TypeScriptExtractionResult {
  graph: GraphDocument;
  metrics: TypeScriptExtractionMetrics;
}

function gitText(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function gitRaw(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sourceKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    path.endsWith(".js") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function stringLiteralText(value: ts.Expression | undefined): string | undefined {
  return value !== undefined && ts.isStringLiteralLike(value)
    ? value.text
    : undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function commonJsExportName(left: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(left)) {
    if (ts.isIdentifier(left.expression) && left.expression.text === "exports") {
      return left.name.text;
    }
    if (
      ts.isPropertyAccessExpression(left.expression) &&
      ts.isIdentifier(left.expression.expression) &&
      left.expression.expression.text === "module" &&
      left.expression.name.text === "exports"
    ) {
      return left.name.text;
    }
    if (
      ts.isIdentifier(left.expression) &&
      left.expression.text === "module" &&
      left.name.text === "exports"
    ) {
      return "default";
    }
  }
  return undefined;
}

function parseModuleSyntax(path: string, source: string): ModuleSyntax {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourceKind(path),
  );
  const imports: SyntaxImport[] = [];
  const exports = new Set<string>();

  const addImport = (
    specifier: string | undefined,
    kind: ImportKind,
    typeOnly = false,
  ): void => {
    if (specifier === undefined || specifier.length === 0) return;
    imports.push({ specifier, kind, typeOnly });
  };

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      addImport(
        stringLiteralText(statement.moduleSpecifier),
        "import",
        statement.importClause?.isTypeOnly ?? false,
      );
    } else if (ts.isExportDeclaration(statement)) {
      addImport(
        statement.moduleSpecifier === undefined
          ? undefined
          : stringLiteralText(statement.moduleSpecifier),
        "export-from",
        statement.isTypeOnly,
      );
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exports.add(element.name.text);
        }
      }
    } else if (
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement))
    ) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        exports.add("default");
      } else if (statement.name !== undefined) {
        exports.add(statement.name.text);
      }
    } else if (
      ts.isVariableStatement(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) exports.add(name);
      }
    } else if (ts.isExportAssignment(statement)) {
      exports.add("default");
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        addImport(specifier, "require");
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addImport(specifier, "dynamic-import");
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const name = commonJsExportName(node.left);
      if (name !== undefined) exports.add(name);
    }

    ts.forEachChild(node, visit);
  };
  visit(file);

  const importMap = new Map<string, SyntaxImport>();
  for (const item of imports) {
    const key = `${item.kind}\0${item.typeOnly ? "1" : "0"}\0${item.specifier}`;
    importMap.set(key, item);
  }

  return {
    imports: [...importMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value),
    exports: [...exports].sort(),
  };
}

function parseStoredSyntax(value: JsonValue): ModuleSyntax {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored TS/JS syntax artifact must be an object");
  }

  const raw = value as { [key: string]: JsonValue };
  if (!Array.isArray(raw.imports) || !Array.isArray(raw.exports)) {
    throw new Error("Stored TS/JS syntax artifact has invalid arrays");
  }

  const imports = raw.imports.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Stored import[${index}] must be an object`);
    }
    const record = item as { [key: string]: JsonValue };
    if (
      typeof record.specifier !== "string" ||
      (record.kind !== "import" &&
        record.kind !== "export-from" &&
        record.kind !== "require" &&
        record.kind !== "dynamic-import") ||
      typeof record.typeOnly !== "boolean"
    ) {
      throw new Error(`Stored import[${index}] is invalid`);
    }
    return {
      specifier: record.specifier,
      kind: record.kind,
      typeOnly: record.typeOnly,
    };
  });

  const exports = raw.exports.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Stored export[${index}] must be a string`);
    }
    return item;
  });

  return { imports, exports };
}

function syntaxArtifactIdentity(blobSha: string): ArtifactIdentity {
  return {
    contentIdentity: `git-object:${blobSha}`,
    artifactKind: "typescript-module-syntax",
    extractor: EXTRACTOR,
    parser: { name: "typescript", version: ts.version },
    schemaVersion: SYNTAX_SCHEMA,
  };
}

function readOrParseSyntax(input: {
  store?: LocalArtifactStore;
  blobSha: string;
  path: string;
  source: string;
}): { syntax: ModuleSyntax; reused: boolean } {
  const identity = syntaxArtifactIdentity(input.blobSha);
  if (input.store !== undefined) {
    const existing = input.store.getArtifact(artifactKey(identity));
    if (existing !== undefined) {
      return { syntax: parseStoredSyntax(existing.payload), reused: true };
    }
  }

  const syntax = parseModuleSyntax(input.path, input.source);
  if (input.store !== undefined) {
    input.store.putArtifact(identity, toJsonValue(syntax));
  }
  return { syntax, reused: false };
}

function normalizeCandidate(path: string): string {
  return normalizeRepoPath(posix.normalize(path));
}

function extensionCandidates(path: string): string[] {
  const extension = posix.extname(path);
  if (extension === ".js") {
    return [
      path.slice(0, -3) + ".ts",
      path.slice(0, -3) + ".tsx",
      path,
      path.slice(0, -3) + ".jsx",
    ];
  }
  if (extension === ".mjs") {
    return [path.slice(0, -4) + ".mts", path];
  }
  if (extension === ".cjs") {
    return [path.slice(0, -4) + ".cts", path];
  }
  if (extension.length > 0) return [path];

  return SOURCE_EXTENSIONS.flatMap((candidateExtension) => [
    path + candidateExtension,
    posix.join(path, "index" + candidateExtension),
  ]);
}

function resolveCandidate(
  sourcePaths: ReadonlySet<string>,
  candidate: string,
): string | undefined {
  for (const path of extensionCandidates(normalizeCandidate(candidate))) {
    if (sourcePaths.has(path)) return path;
  }
  return undefined;
}

function patternMatch(
  pattern: string,
  specifier: string,
): string | undefined | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  if (pattern.indexOf("*", star + 1) >= 0) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function nearestConfig(
  importer: string,
  configs: readonly TsConfigRules[],
): TsConfigRules | undefined {
  return configs
    .filter((config) => {
      if (config.directory.length === 0) return true;
      return (
        importer === config.directory ||
        importer.startsWith(config.directory + "/")
      );
    })
    .sort(
      (left, right) =>
        right.directory.split("/").length - left.directory.split("/").length,
    )[0];
}

function resolveSpecifier(input: {
  importer: string;
  specifier: string;
  sourcePaths: ReadonlySet<string>;
  configs: readonly TsConfigRules[];
}): string | undefined {
  if (input.specifier.startsWith(".")) {
    return resolveCandidate(
      input.sourcePaths,
      posix.join(posix.dirname(input.importer), input.specifier),
    );
  }

  if (input.specifier.startsWith("/")) return undefined;

  const config = nearestConfig(input.importer, input.configs);
  if (config === undefined) return undefined;

  for (const rule of config.paths) {
    const wildcard = patternMatch(rule.pattern, input.specifier);
    if (wildcard === null) continue;
    for (const target of rule.targets) {
      const candidate = target.includes("*")
        ? target.replace("*", wildcard ?? "")
        : target;
      const resolved = resolveCandidate(
        input.sourcePaths,
        posix.join(config.baseUrl ?? config.directory, candidate),
      );
      if (resolved !== undefined) return resolved;
    }
  }

  if (config.baseUrl !== undefined) {
    return resolveCandidate(
      input.sourcePaths,
      posix.join(config.baseUrl, input.specifier),
    );
  }

  return undefined;
}

function tsconfigPaths(
  graph: GraphDocument,
  explicit?: readonly string[],
): string[] {
  if (explicit !== undefined) {
    return [...new Set(explicit.map(normalizeRepoPath))].sort();
  }
  return graph.nodes
    .filter(
      (node) =>
        node.identity.kind === "file" &&
        /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(node.identity.key),
    )
    .map((node) => node.identity.key)
    .sort();
}

function parseConfigs(input: {
  graph: GraphDocument;
  repositoryRoot: string;
  commit: string;
  ref: string;
  repository: string;
  explicit?: readonly string[];
  diagnostics: GraphDiagnostic[];
}): TsConfigRules[] {
  const filePaths = new Set(
    input.graph.nodes
      .filter((node) => node.identity.kind === "file")
      .map((node) => node.identity.key),
  );
  const results: TsConfigRules[] = [];

  for (const path of tsconfigPaths(input.graph, input.explicit)) {
    if (!filePaths.has(path)) continue;
    const raw = gitRaw(input.repositoryRoot, ["show", `${input.commit}:${path}`]);
    const parsed = ts.parseConfigFileTextToJson(path, raw);
    if (parsed.error !== undefined) {
      input.diagnostics.push({
        code: "tsconfig-parse-error",
        message: ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
        state: "unresolved",
        provenance: unresolvedProvenance(
          input.repository,
          input.ref,
          input.commit,
          path,
          "Unable to parse tsconfig",
        ),
      });
      continue;
    }

    const config =
      typeof parsed.config === "object" &&
      parsed.config !== null &&
      !Array.isArray(parsed.config)
        ? (parsed.config as Record<string, unknown>)
        : {};
    const compilerOptions =
      typeof config.compilerOptions === "object" &&
      config.compilerOptions !== null &&
      !Array.isArray(config.compilerOptions)
        ? (config.compilerOptions as Record<string, unknown>)
        : {};

    const directory = normalizeRepoPath(posix.dirname(path));
    const normalizedDirectory = directory === "." ? "" : directory;
    const rawBaseUrl =
      typeof compilerOptions.baseUrl === "string"
        ? compilerOptions.baseUrl
        : undefined;
    const baseUrl =
      rawBaseUrl === undefined
        ? undefined
        : normalizeCandidate(posix.join(normalizedDirectory, rawBaseUrl));

    const paths: Array<{ pattern: string; targets: string[] }> = [];
    if (
      typeof compilerOptions.paths === "object" &&
      compilerOptions.paths !== null &&
      !Array.isArray(compilerOptions.paths)
    ) {
      for (const [pattern, rawTargets] of Object.entries(
        compilerOptions.paths as Record<string, unknown>,
      )) {
        if (!Array.isArray(rawTargets)) continue;
        const targets = rawTargets.filter(
          (value): value is string => typeof value === "string",
        );
        if (targets.length > 0) paths.push({ pattern, targets });
      }
    }

    if (typeof config.extends === "string") {
      input.diagnostics.push({
        code: "tsconfig-extends-not-expanded",
        message: `tsconfig extends is not expanded in 0.0.2: ${config.extends}`,
        state: "partial",
        provenance: partialProvenance(
          input.repository,
          input.ref,
          input.commit,
          path,
          "tsconfig extends not expanded",
        ),
      });
    }

    results.push({
      path,
      directory: normalizedDirectory,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      paths: paths.sort((left, right) => left.pattern.localeCompare(right.pattern)),
    });
  }

  return results;
}

function completeProvenance(
  repository: string,
  ref: string,
  commit: string,
  path: string,
): Provenance {
  return {
    repository,
    ref,
    commit,
    path,
    extractor: EXTRACTOR,
    origin: "derived",
    method: "deterministic-extraction",
    state: "complete",
  };
}

function unresolvedProvenance(
  repository: string,
  ref: string,
  commit: string,
  path: string,
  diagnostic: string,
): Provenance {
  return {
    ...completeProvenance(repository, ref, commit, path),
    state: "unresolved",
    diagnostic,
  };
}

function partialProvenance(
  repository: string,
  ref: string,
  commit: string,
  path: string,
  diagnostic: string,
): Provenance {
  return {
    ...completeProvenance(repository, ref, commit, path),
    state: "partial",
    diagnostic,
  };
}

function existingGraphInput(graph: GraphDocument): {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  diagnostics: GraphDiagnostic[];
} {
  return {
    nodes: graph.nodes.map(({ identity, metadata, provenance }) => ({
      identity,
      ...(metadata === undefined ? {} : { metadata }),
      provenance,
    })),
    edges: graph.edges.map(({ identity, metadata, provenance }) => ({
      identity,
      ...(metadata === undefined ? {} : { metadata }),
      provenance,
    })),
    diagnostics: [...graph.diagnostics],
  };
}

function fileNodeByPath(
  graph: GraphDocument,
  path: string,
): GraphNode | undefined {
  return graph.nodes.find(
    (node) => node.identity.kind === "file" && node.identity.key === path,
  );
}

function languageForPath(path: string): string {
  return path.endsWith(".js") ||
    path.endsWith(".jsx") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs")
    ? "javascript"
    : "typescript";
}

export function extractTypeScriptDependencies(
  options: TypeScriptExtractionOptions,
): TypeScriptExtractionResult {
  const repositoryRoot = realpathSync(
    gitText(options.repositoryPath, ["rev-parse", "--show-toplevel"]),
  );
  const commit = gitText(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${options.ref}^{commit}`,
  ]);
  const repositoryNode = options.graph.nodes.find(
    (node) => node.identity.kind === "repository",
  );
  const repository =
    options.repository ??
    repositoryNode?.identity.namespace ??
    `file://${repositoryRoot}`;

  const graphCommit = repositoryNode?.metadata?.commit;
  if (typeof graphCommit === "string" && graphCommit !== commit) {
    throw new Error(
      `Graph commit ${graphCommit} does not match extractor ref ${commit}`,
    );
  }

  const input = existingGraphInput(options.graph);
  const diagnostics = input.diagnostics;
  const sourceNodes = options.graph.nodes
    .filter(
      (node) =>
        node.identity.kind === "file" && isSourcePath(node.identity.key),
    )
    .sort((left, right) => left.identity.key.localeCompare(right.identity.key));
  const sourcePaths = new Set(sourceNodes.map((node) => node.identity.key));
  const configs = parseConfigs({
    graph: options.graph,
    repositoryRoot,
    commit,
    ref: options.ref,
    repository,
    ...(options.tsconfigPaths === undefined
      ? {}
      : { explicit: options.tsconfigPaths }),
    diagnostics,
  });

  const syntaxByPath = new Map<string, ModuleSyntax>();
  let parsedArtifacts = 0;
  let reusedArtifacts = 0;

  for (const fileNode of sourceNodes) {
    const path = fileNode.identity.key;
    const blobSha = fileNode.metadata?.blobSha;
    if (typeof blobSha !== "string") {
      diagnostics.push({
        code: "ts-source-missing-blob",
        message: `Source file lacks Git blob identity: ${path}`,
        state: "unresolved",
        provenance: unresolvedProvenance(
          repository,
          options.ref,
          commit,
          path,
          "Source file lacks Git blob identity",
        ),
      });
      continue;
    }

    const source = gitRaw(repositoryRoot, ["show", `${commit}:${path}`]);
    const parsed = readOrParseSyntax({
      ...(options.store === undefined ? {} : { store: options.store }),
      blobSha,
      path,
      source,
    });
    syntaxByPath.set(path, parsed.syntax);
    if (parsed.reused) reusedArtifacts += 1;
    else parsedArtifacts += 1;
  }

  const moduleIds = new Map<string, string>();
  for (const fileNode of sourceNodes) {
    if (!syntaxByPath.has(fileNode.identity.key)) continue;
    const path = fileNode.identity.key;
    const identity = { namespace: repository, kind: "module", key: path };
    const id = nodeId(identity);
    moduleIds.set(path, id);
    input.nodes.push({
      identity,
      metadata: {
        language: languageForPath(path),
        ...(typeof fileNode.metadata?.blobSha === "string"
          ? { blobSha: fileNode.metadata.blobSha }
          : {}),
      },
      provenance: [completeProvenance(repository, options.ref, commit, path)],
    });
    input.edges.push({
      identity: {
        kind: "source-file",
        from: id,
        to: fileNode.id,
      },
      provenance: [completeProvenance(repository, options.ref, commit, path)],
    });
  }

  let resolvedImports = 0;
  let unresolvedImports = 0;
  let symbols = 0;

  for (const [path, syntax] of [...syntaxByPath.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const from = moduleIds.get(path);
    if (from === undefined) continue;

    const importsByTarget = new Map<
      string,
      Array<{ specifier: string; kind: ImportKind; typeOnly: boolean }>
    >();

    for (const item of syntax.imports) {
      const target = resolveSpecifier({
        importer: path,
        specifier: item.specifier,
        sourcePaths,
        configs,
      });
      if (target === undefined || !moduleIds.has(target)) {
        unresolvedImports += 1;
        diagnostics.push({
          code: "ts-import-unresolved",
          message: `Unable to resolve "${item.specifier}" from ${path}`,
          state: "unresolved",
          provenance: unresolvedProvenance(
            repository,
            options.ref,
            commit,
            path,
            `Unresolved module specifier: ${item.specifier}`,
          ),
        });
        continue;
      }

      resolvedImports += 1;
      importsByTarget.set(target, [
        ...(importsByTarget.get(target) ?? []),
        item,
      ]);
    }

    for (const [target, items] of [...importsByTarget.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const to = moduleIds.get(target);
      if (to === undefined) continue;
      const details = items
        .map((item) => ({
          kind: item.kind,
          specifier: item.specifier,
          typeOnly: item.typeOnly,
        }))
        .sort((left, right) =>
          `${left.kind}\0${left.specifier}\0${left.typeOnly}`.localeCompare(
            `${right.kind}\0${right.specifier}\0${right.typeOnly}`,
          ),
        );
      input.edges.push({
        identity: { kind: "imports", from, to },
        metadata: { imports: toJsonValue(details) },
        provenance: [completeProvenance(repository, options.ref, commit, path)],
      });
    }

    for (const name of syntax.exports) {
      const symbolIdentity = {
        namespace: repository,
        kind: "symbol",
        key: `${path}#${name}`,
      };
      const symbolId = nodeId(symbolIdentity);
      input.nodes.push({
        identity: symbolIdentity,
        metadata: { name, module: path },
        provenance: [completeProvenance(repository, options.ref, commit, path)],
      });
      input.edges.push({
        identity: {
          kind: "exports",
          from,
          to: symbolId,
        },
        provenance: [completeProvenance(repository, options.ref, commit, path)],
      });
      symbols += 1;
    }
  }

  return {
    graph: buildGraph({
      nodes: input.nodes,
      edges: input.edges,
      diagnostics,
    }),
    metrics: {
      sourceFiles: sourceNodes.length,
      parsedArtifacts,
      reusedArtifacts,
      modules: moduleIds.size,
      symbols,
      resolvedImports,
      unresolvedImports,
    },
  };
}
