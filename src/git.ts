import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { matchesAnyRepoGlob, normalizeRepoPath } from "./glob.js";
import { buildGraph, nodeId } from "./graph.js";
import {
  effectivePathRule,
  matchingPathRules,
  normalizePathRules,
  parseCodeownersLike,
  type PathRule,
  type PathRuleInput,
} from "./path-rules.js";
import type {
  GraphDiagnostic,
  GraphDocument,
  GraphEdgeInput,
  GraphNodeInput,
  JsonObject,
  Provenance,
} from "./model.js";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_BINARY_CHECK_BYTES = 1024 * 1024;
const CODEOWNERS_CANDIDATES = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

type GitTreeEntryType = "blob" | "tree" | "commit";

export interface GitTreeEntry {
  mode: string;
  type: GitTreeEntryType;
  sha: string;
  path: string;
}

export interface GitIngestionPolicy {
  include?: string[];
  exclude?: string[];
  generated?: string[];
  vendor?: string[];
  binary?: {
    exclude?: boolean;
    maxBytes?: number;
  };
}

export interface GitIngestionOptions {
  repositoryPath: string;
  ref: string;
  repository?: string;
  policy?: GitIngestionPolicy;
  pathRules?: PathRuleInput[];
  discoverCodeowners?: boolean;
}

export interface GitIngestionResult {
  graph: GraphDocument;
  repositoryRoot: string;
  repository: string;
  requestedRef: string;
  commit: string;
  tree: string;
  codeownersPath?: string;
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
    const message =
      error instanceof Error ? error.message : "unknown git command failure";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
  }
}

function gitBuffer(cwd: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", [...args], {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown git command failure";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
  }
}

export function parseTree(raw: string): GitTreeEntry[] {
  if (raw.length === 0) return [];

  return raw
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf("\t");
      if (tab < 0) throw new Error(`Malformed git ls-tree record: ${record}`);

      const header = record.slice(0, tab).split(" ");
      if (header.length !== 3) {
        throw new Error(`Malformed git ls-tree header: ${record}`);
      }

      const [mode, type, sha] = header;
      if (
        mode === undefined ||
        sha === undefined ||
        (type !== "blob" && type !== "tree" && type !== "commit")
      ) {
        throw new Error(`Unsupported git ls-tree record: ${record}`);
      }

      return {
        mode,
        type,
        sha,
        path: normalizeRepoPath(record.slice(tab + 1)),
      };
    });
}

function provenance(
  repository: string,
  ref: string,
  commit: string,
  path?: string,
): Provenance {
  return {
    repository,
    ref,
    commit,
    ...(path === undefined ? {} : { path }),
    extractor: { name: "git-tree", version: "0.0.1" },
    origin: "source",
    method: "source-observation",
    state: "complete",
  };
}

function skippedDiagnostic(
  code: string,
  message: string,
  repository: string,
  ref: string,
  commit: string,
  path: string,
): GraphDiagnostic {
  return {
    code,
    message,
    state: "partial",
    provenance: {
      ...provenance(repository, ref, commit, path),
      state: "partial",
      diagnostic: message,
    },
  };
}

function repositoryNodeId(repository: string): string {
  return nodeId({ namespace: repository, kind: "repository", key: "." });
}

function pathNodeKind(entry: GitTreeEntry): "directory" | "file" | "symlink" | "submodule" {
  if (entry.type === "tree") return "directory";
  if (entry.type === "commit" || entry.mode === "160000") return "submodule";
  if (entry.mode === "120000") return "symlink";
  return "file";
}

function pathNodeId(repository: string, entry: GitTreeEntry): string {
  return nodeId({
    namespace: repository,
    kind: pathNodeKind(entry),
    key: entry.path,
  });
}

function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index < 0 ? undefined : path.slice(0, index);
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function findCodeownersEntry(entries: readonly GitTreeEntry[]): GitTreeEntry | undefined {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const candidate of CODEOWNERS_CANDIDATES) {
    const entry = byPath.get(candidate);
    if (entry?.type === "blob" && entry.mode !== "120000") return entry;
  }
  return undefined;
}

function buildPathRuleNodes(
  repository: string,
  ref: string,
  commit: string,
  rules: readonly PathRule[],
): GraphNodeInput[] {
  return rules.map((rule) => ({
    identity: {
      namespace: repository,
      kind: "path-rule",
      key: `${rule.sourcePath ?? "<overlay>"}:${rule.order}:${rule.pattern}`,
    },
    metadata: {
      pattern: rule.pattern,
      targets: rule.targets,
      order: rule.order,
      source: rule.source,
      ...(rule.sourcePath === undefined ? {} : { sourcePath: rule.sourcePath }),
    },
    provenance: [
      rule.source === "repository"
        ? provenance(repository, ref, commit, rule.sourcePath)
        : {
            repository,
            ref,
            commit,
            origin: "overlay",
            method: "explicit-overlay",
            state: "complete",
            overlay: { name: "repograph-path-rules", version: "1" },
            authority: "advisory",
          },
    ],
  }));
}

export function ingestGitRepository(
  options: GitIngestionOptions,
  cachedEntries?: GitTreeEntry[],
): GitIngestionResult {
  const repositoryRoot = realpathSync(
    gitText(options.repositoryPath, ["rev-parse", "--show-toplevel"]),
  );
  const requestedRef = options.ref;
  const commit = gitText(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${requestedRef}^{commit}`,
  ]);
  const tree = gitText(repositoryRoot, ["rev-parse", `${commit}^{tree}`]);
  const repository = options.repository ?? `file://${repositoryRoot}`;

  const entries = cachedEntries ?? parseTree(
    gitText(repositoryRoot, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit]),
  );
  const policy = options.policy ?? {};
  const diagnostics: GraphDiagnostic[] = [];
  const includedLeafEntries: GitTreeEntry[] = [];

  for (const entry of entries) {
    if (entry.type === "tree") continue;
    const path = entry.path;

    if (
      policy.include !== undefined &&
      policy.include.length > 0 &&
      !matchesAnyRepoGlob(path, policy.include)
    ) {
      continue;
    }

    if (matchesAnyRepoGlob(path, policy.exclude ?? [])) {
      diagnostics.push(
        skippedDiagnostic(
          "path-excluded",
          `Path excluded by ingestion policy: ${path}`,
          repository,
          requestedRef,
          commit,
          path,
        ),
      );
      continue;
    }

    if (matchesAnyRepoGlob(path, policy.generated ?? [])) {
      diagnostics.push(
        skippedDiagnostic(
          "generated-excluded",
          `Generated path excluded by ingestion policy: ${path}`,
          repository,
          requestedRef,
          commit,
          path,
        ),
      );
      continue;
    }

    if (matchesAnyRepoGlob(path, policy.vendor ?? [])) {
      diagnostics.push(
        skippedDiagnostic(
          "vendor-excluded",
          `Vendor path excluded by ingestion policy: ${path}`,
          repository,
          requestedRef,
          commit,
          path,
        ),
      );
      continue;
    }

    if (
      pathNodeKind(entry) === "file" &&
      policy.binary?.exclude === true
    ) {
      const size = Number(gitText(repositoryRoot, ["cat-file", "-s", entry.sha]));
      const maxBytes = policy.binary.maxBytes ?? DEFAULT_BINARY_CHECK_BYTES;
      if (size <= maxBytes) {
        if (looksBinary(gitBuffer(repositoryRoot, ["cat-file", "blob", entry.sha]))) {
          diagnostics.push(
            skippedDiagnostic(
              "binary-excluded",
              `Binary file excluded by ingestion policy: ${path}`,
              repository,
              requestedRef,
              commit,
              path,
            ),
          );
          continue;
        }
      } else {
        diagnostics.push(
          skippedDiagnostic(
            "binary-check-skipped",
            `Binary check skipped above ${maxBytes} bytes: ${path}`,
            repository,
            requestedRef,
            commit,
            path,
          ),
        );
      }
    }

    includedLeafEntries.push(entry);
  }

  const includedPaths = new Set(includedLeafEntries.map((entry) => entry.path));
  const requiredDirectories = new Set<string>();
  for (const path of includedPaths) {
    let parent = parentPath(path);
    while (parent !== undefined) {
      requiredDirectories.add(parent);
      parent = parentPath(parent);
    }
  }

  const includedEntries = entries.filter(
    (entry) =>
      includedPaths.has(entry.path) ||
      (entry.type === "tree" && requiredDirectories.has(entry.path)),
  );

  const graphNodes: GraphNodeInput[] = [
    {
      identity: { namespace: repository, kind: "repository", key: "." },
      metadata: { commit, tree },
      provenance: [provenance(repository, requestedRef, commit)],
    },
  ];

  for (const entry of includedEntries) {
    const kind = pathNodeKind(entry);
    const metadata: JsonObject = {
      mode: entry.mode,
      gitObject: entry.sha,
    };

    if (kind === "directory") metadata.treeSha = entry.sha;
    if (kind === "file" || kind === "symlink") metadata.blobSha = entry.sha;
    if (kind === "submodule") metadata.commitSha = entry.sha;
    if (kind === "symlink") {
      metadata.target = gitBuffer(repositoryRoot, ["cat-file", "blob", entry.sha]).toString("utf8");
    }

    graphNodes.push({
      identity: { namespace: repository, kind, key: entry.path },
      metadata,
      provenance: [provenance(repository, requestedRef, commit, entry.path)],
    });
  }

  const graphEdges: GraphEdgeInput[] = [];
  const entryByPath = new Map(includedEntries.map((entry) => [entry.path, entry]));

  for (const entry of includedEntries) {
    const parent = parentPath(entry.path);
    const parentId =
      parent === undefined
        ? repositoryNodeId(repository)
        : (() => {
            const parentEntry = entryByPath.get(parent);
            if (parentEntry === undefined) {
              throw new Error(`Missing included parent directory for ${entry.path}`);
            }
            return pathNodeId(repository, parentEntry);
          })();

    graphEdges.push({
      identity: {
        kind: "contains",
        from: parentId,
        to: pathNodeId(repository, entry),
      },
      provenance: [provenance(repository, requestedRef, commit, entry.path)],
    });
  }

  const discoveredCodeowners =
    options.discoverCodeowners === false ? undefined : findCodeownersEntry(entries);
  const discoveredRules =
    discoveredCodeowners === undefined
      ? []
      : parseCodeownersLike(
          gitText(repositoryRoot, ["cat-file", "blob", discoveredCodeowners.sha]),
          discoveredCodeowners.path,
        );

  const rules = normalizePathRules([
    ...discoveredRules,
    ...(options.pathRules ?? []),
  ]);

  graphNodes.push(
    ...buildPathRuleNodes(repository, requestedRef, commit, rules),
  );

  const ruleNodeIds = new Map(
    rules.map((rule) => [
      rule,
      nodeId({
        namespace: repository,
        kind: "path-rule",
        key: `${rule.sourcePath ?? "<overlay>"}:${rule.order}:${rule.pattern}`,
      }),
    ]),
  );

  for (const entry of includedEntries) {
    if (entry.type === "tree") continue;
    const matches = matchingPathRules(entry.path, rules);
    const effective = effectivePathRule(entry.path, rules);
    for (const rule of matches) {
      graphEdges.push({
        identity: {
          kind: "path-rule-match",
          from: ruleNodeIds.get(rule)!,
          to: pathNodeId(repository, entry),
        },
        metadata: { effective: rule === effective },
        provenance: [
          rule.source === "repository"
            ? provenance(repository, requestedRef, commit, rule.sourcePath)
            : {
                repository,
                ref: requestedRef,
                commit,
                origin: "overlay",
                method: "explicit-overlay",
                state: "complete",
                overlay: { name: "repograph-path-rules", version: "1" },
                authority: "advisory",
              },
        ],
      });
    }
  }

  return {
    graph: buildGraph({
      nodes: graphNodes,
      edges: graphEdges,
      diagnostics,
    }),
    repositoryRoot,
    repository,
    requestedRef,
    commit,
    tree,
    ...(discoveredCodeowners === undefined
      ? {}
      : { codeownersPath: discoveredCodeowners.path }),
  };
}
