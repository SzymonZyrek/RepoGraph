import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  LocalArtifactStore,
  affectedClosure,
  buildRepositoryIntelligence,
  diffGitRepository,
  nodeId,
} from "../dist/src/index.js";

const CLUSTERS = 24;
const FILES_PER_CLUSTER = 10;
const TINY_COMMITS = 8;
const DEPENDENCY_EDIT_INDEX = Math.floor(FILES_PER_CLUSTER / 2);
const repositoryName = "eval/intelligence-high-velocity";

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
  if (index === 0) return `export const value = ${cluster + revision};\n`;
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
  const root = mkdtempSync(join(tmpdir(), "repograph-intelligence-eval-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repograph-eval@example.test");
  git(root, "config", "user.name", "RepoGraph Eval");

  for (let cluster = 0; cluster < CLUSTERS; cluster += 1) {
    for (let index = 0; index < FILES_PER_CLUSTER; index += 1) {
      write(root, pathFor(cluster, index), sourceFor(cluster, index));
    }
  }
  write(root, "package.json", JSON.stringify({
    name: "fixture-root",
    private: true,
    type: "module",
    main: "./src/c00/m9.ts",
    types: "./src/c00/m9.ts",
  }, null, 2) + "\n");
  write(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022" },
  }, null, 2) + "\n");

  let previous = commit(root, "initial synthetic repository");
  const scenarios = [];

  for (let revision = 1; revision <= TINY_COMMITS; revision += 1) {
    const cluster = revision % CLUSTERS;
    write(root, pathFor(cluster, FILES_PER_CLUSTER - 1), sourceFor(cluster, FILES_PER_CLUSTER - 1, revision));
    const target = commit(root, `tiny edit ${revision}`);
    scenarios.push({ kind: "tiny-edit", base: previous, target });
    previous = target;
  }

  git(root, "mv", pathFor(0, FILES_PER_CLUSTER - 1), "src/c00/m9-renamed.ts");
  let target = commit(root, "rename-only leaf");
  scenarios.push({ kind: "rename-only", base: previous, target });
  previous = target;

  write(
    root,
    pathFor(1, DEPENDENCY_EDIT_INDEX),
    sourceFor(1, DEPENDENCY_EDIT_INDEX, 0, DEPENDENCY_EDIT_INDEX - 2),
  );
  target = commit(root, "dependency-affecting edit");
  scenarios.push({ kind: "dependency-edit", base: previous, target });
  previous = target;

  for (let cluster = 0; cluster < CLUSTERS; cluster += 1) {
    for (let index = 0; index < FILES_PER_CLUSTER; index += 1) {
      const path = cluster === 0 && index === FILES_PER_CLUSTER - 1
        ? "src/c00/m9-renamed.ts"
        : pathFor(cluster, index);
      appendFileSync(join(root, path), "// mechanical edit\n");
    }
  }
  target = commit(root, "broad mechanical edit");
  scenarios.push({ kind: "broad-edit", base: previous, target });

  return { root, scenarios };
}

function buildAt(root, ref, store) {
  return buildRepositoryIntelligence({
    repositoryPath: root,
    repository: repositoryName,
    ref,
    discoverCodeowners: false,
    ...(store === undefined ? {} : { store }),
  });
}

function edgeSet(graph) {
  return new Set(graph.edges.map((edge) => edge.id));
}

function structuralDelta(base, target) {
  const before = edgeSet(base.graph);
  const after = edgeSet(target.graph);
  let added = 0;
  let removed = 0;
  for (const id of after) if (!before.has(id)) added += 1;
  for (const id of before) if (!after.has(id)) removed += 1;
  return { added, removed, total: added + removed };
}

function fileId(path) {
  return nodeId({ namespace: repositoryName, kind: "file", key: path });
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

const { root, scenarios } = createHistory();
const store = new LocalArtifactStore(mkdtempSync(join(tmpdir(), "repograph-intelligence-cache-")));
const samples = [];

for (const scenario of scenarios) {
  const base = buildAt(root, scenario.base, store);
  store.resetStats();

  const warmStart = performance.now();
  const warm = buildAt(root, scenario.target, store);
  const warmMs = performance.now() - warmStart;
  const cache = store.getStats();

  const coldStart = performance.now();
  const cold = buildAt(root, scenario.target);
  const coldMs = performance.now() - coldStart;

  const diff = diffGitRepository({
    repositoryPath: root,
    baseRef: scenario.base,
    targetRef: scenario.target,
    baseMode: "direct",
  });
  const delta = structuralDelta(base, warm);

  let affectedNodes = null;
  if (scenario.kind === "dependency-edit") {
    const changed = fileId(pathFor(1, DEPENDENCY_EDIT_INDEX));
    affectedNodes = affectedClosure(warm.graph, changed, {
      edgeKinds: ["imports", "reexports", "covers", "package-contains"],
      maxNodes: 1000,
    }).nodes.length;
  }

  samples.push({
    kind: scenario.kind,
    base: scenario.base.slice(0, 12),
    target: scenario.target.slice(0, 12),
    changedPaths: diff.changes.length,
    sourceFiles: warm.metrics.tsjs.sourceFiles,
    warmMs: round(warmMs),
    coldMs: round(coldMs),
    warmToColdRatio: round(warmMs / Math.max(coldMs, 0.01)),
    reparsedFiles: warm.metrics.tsjs.parsedFiles,
    reusedSyntaxArtifacts: warm.metrics.tsjs.reusedSyntaxArtifacts,
    packageManifests: warm.metrics.relationships.packageManifests,
    graphNodes: warm.graph.nodes.length,
    graphEdges: warm.graph.edges.length,
    structuralEdgeDelta: delta,
    affectedNodes,
    artifactHits: cache.artifactHits,
    artifactMisses: cache.artifactMisses,
    artifactWrites: cache.artifactWrites,
    artifactReuses: cache.artifactReuses,
    coldParsedFiles: cold.metrics.tsjs.parsedFiles,
  });
}

const staleRef = scenarios[1].target;
const stale = buildAt(root, staleRef, store);
const stalePinned = [...stale.graph.nodes, ...stale.graph.edges].every((fact) =>
  fact.provenance.every((item) => item.commit === staleRef)
);

const tiny = samples.filter((sample) => sample.kind === "tiny-edit");
const result = {
  fixture: {
    sourceFiles: CLUSTERS * FILES_PER_CLUSTER,
    clusters: CLUSTERS,
    filesPerCluster: FILES_PER_CLUSTER,
    tinyCommits: TINY_COMMITS,
  },
  summary: {
    tinyMedianWarmMs: round(median(tiny.map((sample) => sample.warmMs))),
    tinyMedianColdMs: round(median(tiny.map((sample) => sample.coldMs))),
    tinyMedianWarmToColdRatio: round(median(tiny.map((sample) => sample.warmToColdRatio))),
    tinyMedianReparsedFiles: round(median(tiny.map((sample) => sample.reparsedFiles))),
    staleExactShaPinned: stalePinned,
  },
  samples,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
