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
import assert from "node:assert/strict";

import {
  LocalArtifactStore,
  affectedClosure,
  buildRepositoryIntelligence,
  canonicalJsonUnknown,
  diffGitRepository,
  graphEquals,
  nodeId,
} from "../dist/src/index.js";

let CLUSTERS = 24;
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

function evaluate(sourceFiles) {
CLUSTERS = sourceFiles / FILES_PER_CLUSTER;
const { root, scenarios } = createHistory();
const store = new LocalArtifactStore(mkdtempSync(join(tmpdir(), "repograph-intelligence-cache-")));
const samples = [];
const initialStart = performance.now();
const initial = buildAt(root, scenarios[0].base, store);
const initialMs = performance.now() - initialStart;
assert.ok(graphEquals(initial.graph, buildAt(root, scenarios[0].base).graph), "initial graph equality");

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
  assert.ok(graphEquals(warm.graph, cold.graph), `${sourceFiles} ${scenario.kind}: warm/cold equality`);
  if (scenario.kind === "tiny-edit") {
    assert.equal(warm.metrics.composition.mode, "incremental");
    assert.equal(warm.metrics.composition.resolvedSourceFragments, 1);
    assert.equal(warm.metrics.composition.recomposedRelationshipFragments, 0);
    assert.equal(warm.metrics.tsjs.parsedFiles, 1);
    assert.ok(warm.metrics.composition.encodedFragments <= 3 * 64, "bounded fragment-pack encoding");
  }
  if (scenario.kind === "rename-only") assert.equal(warm.metrics.tsjs.parsedFiles, 0);

  const diff = diffGitRepository({
    repositoryPath: root,
    baseRef: scenario.base,
    targetRef: scenario.target,
    baseMode: "direct",
  });
  const delta = structuralDelta(base, warm);

  const affected = new Set();
  const beforeNodes = new Set(base.graph.nodes.map((node) => node.id));
  const afterNodes = new Set(warm.graph.nodes.map((node) => node.id));
  for (const change of diff.changes) {
    for (const [graph, ids, path] of [[base.graph, beforeNodes, change.oldPath ?? change.path], [warm.graph, afterNodes, change.path]]) {
    if (!ids.has(fileId(path))) continue;
    for (const node of affectedClosure(graph, fileId(path), {
      edgeKinds: ["imports", "reexports", "tests"],
      maxNodes: 1000,
    }).nodes) affected.add(node.id);
    }
  }
  const serializationStart = performance.now();
  const serialized = canonicalJsonUnknown(warm.graph);
  const serializationMs = performance.now() - serializationStart;

  samples.push({
    kind: scenario.kind,
    base: scenario.base,
    parent: git(root, "rev-parse", `${scenario.target}^`),
    target: scenario.target,
    changedPaths: diff.changes.length,
    changes: diff.changes,
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
    affectedNodes: affected.size,
    serializationMs: round(serializationMs),
    serializedBytes: Buffer.byteLength(serialized),
    artifactHits: cache.artifactHits,
    artifactMisses: cache.artifactMisses,
    artifactWrites: cache.artifactWrites,
    artifactReuses: cache.artifactReuses,
    coldParsedFiles: cold.metrics.tsjs.parsedFiles,
    composition: warm.metrics.composition,
    timings: warm.metrics.timings,
    coldTimings: cold.metrics.timings,
    warmColdEqual: true,
  });
}

const staleRef = scenarios[1].target;
const staleStart = performance.now();
const stale = buildAt(root, staleRef, store);
const staleWarmMs = performance.now() - staleStart;
const staleColdStart = performance.now();
const staleCold = buildAt(root, staleRef);
const staleColdMs = performance.now() - staleColdStart;
assert.ok(graphEquals(stale.graph, staleCold.graph), "stale graph equality");
const stalePinned = [...stale.graph.nodes, ...stale.graph.edges].every((fact) =>
  fact.provenance.every((item) => item.commit === staleRef)
);

const tiny = samples.filter((sample) => sample.kind === "tiny-edit");
assert.ok(stalePinned);
const result = {
  environment: { node: process.version, platform: process.platform, architecture: process.arch, git: git(root, "--version"), measuredAt: new Date().toISOString() },
  fixture: {
    sourceFiles: CLUSTERS * FILES_PER_CLUSTER,
    clusters: CLUSTERS,
    filesPerCluster: FILES_PER_CLUSTER,
    tinyCommits: TINY_COMMITS,
  },
  summary: {
    initial: { commit: initial.commit, parent: null, warmMs: round(initialMs), composition: initial.metrics.composition, timings: initial.metrics.timings, graphNodes: initial.graph.nodes.length, graphEdges: initial.graph.edges.length, warmColdEqual: true },
    tinyMedianWarmMs: round(median(tiny.map((sample) => sample.warmMs))),
    tinyMedianColdMs: round(median(tiny.map((sample) => sample.coldMs))),
    tinyMedianWarmToColdRatio: round(median(tiny.map((sample) => sample.warmToColdRatio))),
    tinyMedianReparsedFiles: round(median(tiny.map((sample) => sample.reparsedFiles))),
    staleExactShaPinned: stalePinned,
    stale: { commit: staleRef, parent: git(root, "rev-parse", `${staleRef}^`), warmMs: round(staleWarmMs), coldMs: round(staleColdMs), composition: stale.metrics.composition, timings: stale.metrics.timings, warmColdEqual: true },
  },
  samples,
};

process.stderr.write(`Evaluated ${sourceFiles} sources: warm median ${result.summary.tinyMedianWarmMs} ms, cold ${result.summary.tinyMedianColdMs} ms\n`);
return result;
}

const result = { schema: "repograph.intelligence-economics/v2", evaluations: [240, 960, 3840].map(evaluate) };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
