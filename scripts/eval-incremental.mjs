import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  LocalArtifactStore,
  diffGitRepository,
  extractTypeScriptJavaScriptDependencies,
  ingestGitRepository,
  planIncrementalUpdate,
} from "../dist/src/index.js";

const CLUSTERS = 24;
const FILES_PER_CLUSTER = 10;
const TINY_COMMITS = 8;
const repositoryName = "eval/high-velocity";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function pathFor(cluster, index) {
  return `src/c${String(cluster).padStart(2, "0")}/m${index}.ts`;
}

function sourceFor(cluster, index, revision = 0, dependency = index - 1) {
  if (index === 0) {
    return `export const value = ${cluster + revision};\n`;
  }
  return [
    `import { value as previous } from "./m${dependency}.js";`,
    `export const value = previous + ${index + revision};`,
    "",
  ].join("\n");
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function createHistory() {
  const root = mkdtempSync(join(tmpdir(), "repograph-eval-repo-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph-eval@example.test");
  git(root, "config", "user.name", "RepoGraph Eval");

  for (let cluster = 0; cluster < CLUSTERS; cluster += 1) {
    for (let index = 0; index < FILES_PER_CLUSTER; index += 1) {
      write(root, pathFor(cluster, index), sourceFor(cluster, index));
    }
  }
  write(
    root,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { target: "ES2022" } }, null, 2) + "\n",
  );

  let previous = commit(root, "initial synthetic repository");
  const scenarios = [];

  for (let revision = 1; revision <= TINY_COMMITS; revision += 1) {
    const cluster = revision % CLUSTERS;
    write(
      root,
      pathFor(cluster, FILES_PER_CLUSTER - 1),
      sourceFor(cluster, FILES_PER_CLUSTER - 1, revision),
    );
    const target = commit(root, `tiny edit ${revision}`);
    scenarios.push({ kind: "tiny-edit", base: previous, target, baseMode: "direct" });
    previous = target;
  }

  git(
    root,
    "mv",
    pathFor(0, FILES_PER_CLUSTER - 1),
    "src/c00/m9-renamed.ts",
  );
  let target = commit(root, "rename-only leaf");
  scenarios.push({ kind: "rename-only", base: previous, target, baseMode: "direct" });
  previous = target;

  write(
    root,
    pathFor(1, FILES_PER_CLUSTER - 1),
    sourceFor(1, FILES_PER_CLUSTER - 1, 0, FILES_PER_CLUSTER - 3),
  );
  target = commit(root, "dependency-affecting edit");
  scenarios.push({
    kind: "dependency-edit",
    base: previous,
    target,
    baseMode: "direct",
  });
  previous = target;

  for (let cluster = 0; cluster < CLUSTERS; cluster += 1) {
    for (let index = 0; index < FILES_PER_CLUSTER; index += 1) {
      const path =
        cluster === 0 && index === FILES_PER_CLUSTER - 1
          ? "src/c00/m9-renamed.ts"
          : pathFor(cluster, index);
      appendFileSync(join(root, path), "// mechanical edit\n");
    }
  }
  target = commit(root, "broad mechanical edit");
  scenarios.push({ kind: "broad-edit", base: previous, target, baseMode: "direct" });
  previous = target;

  git(root, "checkout", "-b", "feature-eval");
  write(
    root,
    pathFor(2, FILES_PER_CLUSTER - 1),
    sourceFor(2, FILES_PER_CLUSTER - 1, 100),
  );
  commit(root, "feature branch tiny edit");

  git(root, "checkout", "main");
  write(
    root,
    pathFor(3, FILES_PER_CLUSTER - 1),
    sourceFor(3, FILES_PER_CLUSTER - 1, 200),
  );
  const preMerge = commit(root, "main branch tiny edit");
  git(root, "merge", "--no-ff", "feature-eval", "-m", "merge feature branch");
  target = git(root, "rev-parse", "HEAD");
  scenarios.push({
    kind: "branch-merge",
    base: preMerge,
    target,
    baseMode: "merge-base",
  });

  return { root, scenarios };
}

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
  }
  return total;
}

function safeDirectoryBytes(path) {
  try {
    return directoryBytes(path);
  } catch {
    return 0;
  }
}

function enrichedAt(root, ref, store) {
  const ingestion = ingestGitRepository({
    repositoryPath: root,
    repository: repositoryName,
    ref,
    discoverCodeowners: false,
  });
  const extracted = extractTypeScriptJavaScriptDependencies(ingestion, {
    ...(store === undefined ? {} : { store }),
  });
  return { ingestion, ...extracted };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function evaluateScenario(root, scenario, store, cacheRoot) {
  // In steady state the base snapshot/syntax already exists.
  const base = enrichedAt(root, scenario.base, store);
  store.resetStats();
  const bytesBefore = safeDirectoryBytes(cacheRoot);

  const incrementalStart = performance.now();
  const target = enrichedAt(root, scenario.target, store);
  const diff = diffGitRepository({
    repositoryPath: root,
    baseRef: scenario.base,
    targetRef: scenario.target,
    baseMode: scenario.baseMode,
  });
  const cache = store.getStats();
  const plan = planIncrementalUpdate({
    baseGraph: base.graph,
    targetGraph: target.graph,
    diff,
    cache,
    invalidationEdgeKinds: ["imports", "reexports"],
  });
  const incrementalMs = performance.now() - incrementalStart;
  const bytesAfter = safeDirectoryBytes(cacheRoot);

  const fullStart = performance.now();
  const full = enrichedAt(root, scenario.target);
  const fullMs = performance.now() - fullStart;

  return {
    kind: scenario.kind,
    base: scenario.base.slice(0, 12),
    target: scenario.target.slice(0, 12),
    changedPaths: diff.changes.length,
    incrementalMs: round(incrementalMs),
    fullRebuildMs: round(fullMs),
    incrementalToFullRatio: round(incrementalMs / Math.max(fullMs, 0.01)),
    sourceFiles: target.metrics.sourceFiles,
    reparsedFiles: target.metrics.parsedFiles,
    reusedSyntaxArtifacts: target.metrics.reusedSyntaxArtifacts,
    fullRebuildParsedFiles: full.metrics.parsedFiles,
    resolvedDependencies: target.metrics.resolvedDependencies,
    touchedNodes: plan.metrics.touchedNodes,
    invalidatedNodes: plan.metrics.invalidatedNodes,
    touchedEdges: plan.metrics.touchedEdges,
    artifactHits: cache.artifactHits,
    artifactMisses: cache.artifactMisses,
    artifactWrites: cache.artifactWrites,
    artifactReuses: cache.artifactReuses,
    cacheGrowthBytes: bytesAfter - bytesBefore,
  };
}

const { root, scenarios } = createHistory();
const cacheRoot = mkdtempSync(join(tmpdir(), "repograph-eval-cache-"));
const store = new LocalArtifactStore(cacheRoot);
const samples = scenarios.map((scenario) =>
  evaluateScenario(root, scenario, store, cacheRoot),
);

const tiny = samples.filter((sample) => sample.kind === "tiny-edit");
const normal = samples.filter((sample) => sample.kind !== "broad-edit");

const result = {
  fixture: {
    sourceFiles: CLUSTERS * FILES_PER_CLUSTER,
    clusters: CLUSTERS,
    filesPerCluster: FILES_PER_CLUSTER,
    tinyCommits: TINY_COMMITS,
    scenarios: samples.length,
  },
  summary: {
    tinyMedianIncrementalMs: round(median(tiny.map((sample) => sample.incrementalMs))),
    tinyMedianFullRebuildMs: round(median(tiny.map((sample) => sample.fullRebuildMs))),
    tinyMedianIncrementalToFullRatio: round(
      median(tiny.map((sample) => sample.incrementalToFullRatio)),
    ),
    tinyMedianReparsedFiles: round(
      median(tiny.map((sample) => sample.reparsedFiles)),
    ),
    tinyMedianInvalidatedNodes: round(
      median(tiny.map((sample) => sample.invalidatedNodes)),
    ),
    normalMaxReparsedFraction: round(
      Math.max(
        ...normal.map((sample) => sample.reparsedFiles / sample.sourceFiles),
      ),
    ),
    normalMaxTouchedNodeFraction: round(
      Math.max(
        ...normal.map((sample) => sample.touchedNodes / sample.sourceFiles),
      ),
    ),
    finalCacheBytes: safeDirectoryBytes(cacheRoot),
  },
  samples,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
