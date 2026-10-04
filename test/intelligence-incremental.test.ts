import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildRepositoryIntelligence, graphEquals, LocalArtifactStore, StoreCorruptionError } from "../src/index.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
}
function commit(root: string): string {
  git(root, "add", "-A"); git(root, "commit", "-m", "revision"); return git(root, "rev-parse", "HEAD");
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "repograph-composition-"));
  git(root, "init", "-b", "main"); git(root, "config", "user.email", "test@example.test"); git(root, "config", "user.name", "Test");
  write(root, "package.json", '{"name":"fixture","main":"src/a.ts"}');
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", 'import { a } from "./a.js"; export const b = a;\n');
  write(root, "src/missing.ts", 'import "./later.js";\n');
  write(root, "src/a.test.ts", 'import "./a.js";\n');
  for (let i = 0; i < 12; i++) write(root, `other/m${i}.ts`, `export const value = ${i};\n`);
  const first = commit(root);
  const cache = mkdtempSync(join(tmpdir(), "repograph-composition-cache-"));
  let store = new LocalArtifactStore(cache);
  const build = (ref: string, cached = true) => buildRepositoryIntelligence({ repositoryPath: root, repository: "fixture/composition", ref, ...(cached ? { store } : {}) });
  const equivalent = (ref: string) => { const warm = build(ref); assert.equal(graphEquals(warm.graph, build(ref, false).graph), true); return warm; };
  return { root, cache, first, build, equivalent, restart: () => { store = new LocalArtifactStore(cache); } };
}

test("one-file maintenance is bounded, survives restart, and stale aliases retain exact provenance", () => {
  const f = fixture(); f.equivalent(f.first);
  write(f.root, "src/a.ts", "export const a = 2;\n"); const second = commit(f.root);
  f.restart(); const warm = f.equivalent(second);
  assert.equal(warm.metrics.composition.mode, "incremental");
  assert.equal(warm.metrics.composition.baseCommit, f.first);
  assert.equal(warm.metrics.composition.resolvedSourceFragments, 1);
  assert.equal(warm.metrics.composition.recomposedRelationshipFragments, 0);
  assert.equal(warm.metrics.tsjs.parsedFiles, 1);
  assert.equal(warm.metrics.tsjs.reusedSyntaxArtifacts, 0);
  assert.ok(warm.metrics.composition.inspectedPaths <= 2);
  assert.ok(warm.metrics.composition.encodedFragments <= 3 * 64);
  const stale = f.equivalent(f.first);
  assert.equal(stale.metrics.composition.mode, "exact");
  for (const fact of [...stale.graph.nodes, ...stale.graph.edges]) assert.ok(fact.provenance.every((p) => p.commit === f.first && p.ref === f.first));
  const alias = f.build("HEAD");
  assert.equal(alias.commit, second); assert.ok(alias.graph.nodes.every((n) => n.provenance.every((p) => p.ref === "HEAD" && p.commit === second)));
});

test("rename reuses syntax and invalidates importers, unresolved candidates, and test conventions", () => {
  const f = fixture(); f.build(f.first);
  git(f.root, "mv", "src/a.ts", "src/renamed.ts");
  let revision = commit(f.root); let warm = f.equivalent(revision);
  assert.equal(warm.metrics.tsjs.parsedFiles, 0);
  assert.equal(warm.metrics.composition.resolvedSourceFragments, 3);
  assert.equal(warm.metrics.relationships.testRelations, 0);
  assert.equal(warm.graph.edges.some((e) => e.identity.kind === "imports" && e.metadata?.specifier === "./a.js"), false);
  write(f.root, "src/later.ts", "export const later = 1;\n");
  revision = commit(f.root); warm = f.equivalent(revision);
  assert.equal(warm.metrics.composition.resolvedSourceFragments, 2);
  assert.equal(warm.graph.edges.some((e) => e.identity.kind === "imports" && e.metadata?.specifier === "./later.js"), true);
  git(f.root, "mv", "src/renamed.ts", "src/a.ts");
  revision = commit(f.root); warm = f.equivalent(revision);
  assert.equal(warm.metrics.tsjs.parsedFiles, 0); assert.equal(warm.metrics.relationships.testRelations, 1);
  git(f.root, "rm", "src/later.ts"); revision = commit(f.root); warm = f.equivalent(revision);
  assert.ok(warm.graph.diagnostics.some((d) => d.code === "tsjs-unresolved-import" && d.provenance?.path === "src/missing.ts"));
});

test("configuration, package, policy and CODEOWNERS invalidations remain explicit and equivalent", () => {
  const f = fixture(); f.build(f.first);
  for (const [path, text] of [
    ["tsconfig.json", '{"compilerOptions":{"baseUrl":".","paths":{"@a":["src/a.ts"]}}}'],
    ["package.json", '{"name":"fixture","main":"src/b.ts","types":"absent.d.ts"}'],
    [".github/CODEOWNERS", "src/** @owner\n"],
  ]) {
    write(f.root, path!, text!); const revision = commit(f.root); const warm = f.equivalent(revision);
    assert.equal(warm.metrics.composition.mode, "cold"); assert.ok(warm.metrics.composition.invalidationReasons.some((reason) => reason.includes(path!)));
  }
  write(f.root, "src/a.ts", "export const a = 3;\n"); const revision = commit(f.root); const warm = f.equivalent(revision);
  assert.equal(warm.metrics.composition.mode, "incremental"); assert.equal(warm.metrics.composition.resolvedSourceFragments, 1);
  const store = new LocalArtifactStore(f.cache);
  const options = { repositoryPath: f.root, repository: "fixture/composition", ref: revision, policy: { exclude: ["other/**"] } };
  const changedPolicy = buildRepositoryIntelligence({ ...options, store });
  assert.equal(changedPolicy.metrics.composition.mode, "cold"); assert.equal(graphEquals(changedPolicy.graph, buildRepositoryIntelligence(options).graph), true);
});

test("missing artifacts rebuild explicitly, corrupt artifacts fail, and uncached parents fall back", () => {
  const f = fixture(); f.build(f.first);
  const manifestFiles = readdirSync(join(f.cache, "manifests"), { recursive: true }).map(String).filter((path) => path.endsWith(".json"));
  const manifest = JSON.parse(readFileSync(join(f.cache, "manifests", manifestFiles[0]!), "utf8")) as { artifacts: Array<{ artifactKey: string }> };
  const key = manifest.artifacts[0]!.artifactKey; const digest = key.slice("artifact-sha256-".length);
  const path = join(f.cache, "artifacts", digest.slice(0, 2), `${digest}.json`);
  rmSync(path); const rebuilt = f.equivalent(f.first);
  assert.equal(rebuilt.metrics.composition.mode, "cold"); assert.ok(rebuilt.metrics.composition.invalidationReasons.some((reason) => reason.startsWith("missing-artifact:")));
  writeFileSync(path, "invalid"); assert.throws(() => f.build(f.first), StoreCorruptionError);
  write(f.root, "src/a.ts", "export const a = 4;\n"); commit(f.root);
  write(f.root, "src/a.ts", "export const a = 5;\n"); const target = commit(f.root);
  const result = f.equivalent(target); assert.equal(result.metrics.composition.mode, "cold"); assert.ok(result.metrics.composition.invalidationReasons.includes("no-compatible-first-parent"));
});

test("sparse ingestion preserves directories, excluded diagnostics, reserved paths and executable modes", () => {
  const f = fixture();
  write(f.root, "only/included.ts", "export const one = 1;\n");
  write(f.root, "only/ignored.txt", "excluded\n");
  write(f.root, "$root", "reserved filename\n");
  write(f.root, "__proto__", "reserved filename\n");
  let revision = commit(f.root);
  const store = new LocalArtifactStore(f.cache);
  const build = (cached: boolean) => buildRepositoryIntelligence({ repositoryPath: f.root, repository: "fixture/composition", ref: revision, policy: { exclude: ["**/ignored.txt"] }, ...(cached ? { store } : {}) });
  build(true);
  git(f.root, "rm", "only/included.ts"); revision = commit(f.root);
  let warm = build(true); assert.equal(graphEquals(warm.graph, build(false).graph), true);
  assert.equal(warm.graph.nodes.some((n) => n.identity.kind === "directory" && n.identity.key === "only"), false);
  write(f.root, "only/ignored.txt", "excluded changed\n"); revision = commit(f.root);
  warm = build(true); assert.equal(graphEquals(warm.graph, build(false).graph), true);
  git(f.root, "update-index", "--chmod=+x", "src/b.ts"); git(f.root, "commit", "-m", "mode"); revision = git(f.root, "rev-parse", "HEAD");
  warm = build(true); assert.equal(graphEquals(warm.graph, build(false).graph), true); assert.equal(warm.metrics.tsjs.parsedFiles, 0);
});

test("rename across parser modes does not reuse incompatible syntax", () => {
  const f = fixture(); write(f.root, "src/view.tsx", "export const view = <section/>;\n"); let revision = commit(f.root); f.build(revision);
  git(f.root, "mv", "src/view.tsx", "src/view.ts"); revision = commit(f.root);
  const warm = f.equivalent(revision); assert.equal(warm.metrics.tsjs.parsedFiles, 1);
});

test("missing fragment packs rebuild the same immutable manifest instead of returning partial evidence", () => {
  const f = fixture(); f.build(f.first);
  write(f.root, "src/a.ts", "export const a = 9;\n"); const target = commit(f.root); f.equivalent(target);
  const manifestPaths = readdirSync(join(f.cache, "manifests"), { recursive: true }).map(String).filter((path) => path.endsWith(".json"));
  const manifest = manifestPaths.map((path) => JSON.parse(readFileSync(join(f.cache, "manifests", path), "utf8")) as { commit: string; artifacts: Array<{ logicalKey: string; artifactKey: string }> }).find((m) => m.commit === target)!;
  const fragment = manifest.artifacts.find((r) => r.logicalKey.startsWith("pack:"))!;
  const digest = fragment.artifactKey.slice("artifact-sha256-".length);
  rmSync(join(f.cache, "artifacts", digest.slice(0, 2), `${digest}.json`));
  const rebuilt = f.equivalent(target); assert.equal(rebuilt.metrics.composition.mode, "cold"); assert.ok(rebuilt.metrics.composition.invalidationReasons.some((r) => r.startsWith("missing-artifact:")));
});
