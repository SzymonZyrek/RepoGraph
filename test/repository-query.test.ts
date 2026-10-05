import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fingerprint } from "../src/causal-model.js";
import { scipIndexType } from "../src/causal-providers.js";
import { affected, explain, indexRepository, slice } from "../src/repository-query.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "repograph-query-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "fixture@example.org"); git("config", "user.name", "Fixture");
  const put = (path: string, value: string | Uint8Array) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), value); };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  return { dir, git, put, commit };
}

test("implicit index, draft overlays, causal contracts, warm/stale/rebuild equivalence and narrow updates", async () => {
  const repo = fixture(); const cache = mkdtempSync(join(tmpdir(), "repograph-index-"));
  const api = "export const order = 1;\n";
  const client = "import { order } from './api';\nexport const submit = order;\n";
  repo.put("src/api.ts", api); repo.put("src/client.ts", client);
  repo.put("server.py", "# implementation\n"); repo.put("docs/api.md", "[API](../src/api.ts)\n");
  repo.put("contracts/orders.yaml", "openapi: 3.1.0\npaths:\n  /orders:\n    get: {}\n");
  repo.put("index.scip", scipIndexType.encode(scipIndexType.fromObject({ documents: [
    { relativePath: "src/api.ts", occurrences: [{ symbol: "order", symbolRoles: 1 }] },
    { relativePath: "src/client.ts", occurrences: [{ symbol: "order", symbolRoles: 0 }] },
  ] })).finish());
  repo.put(".repograph.json", JSON.stringify({ providers: [
    { type: "scip", path: "index.scip", sources: { "src/api.ts": fingerprint(api), "src/client.ts": fingerprint(client) } },
    { type: "openapi", path: "contracts/orders.yaml", scope: "orders", bindings: [{ interface: "rest:orders:get:/orders", artifacts: ["src/client.ts", "server.py"] }] },
  ] }));
  const first = repo.commit();
  const options = { repositoryPath: repo.dir, ref: first, repository: "fixture/orders", cacheDirectory: cache };
  try {
    const answer = await affected(options, ["src/api.ts"]);
    assert.equal(answer.partial, false); assert.equal(answer.truncated, false);
    assert.deepEqual(answer.nodes.map(node => node.id), ["artifact:docs/api.md", "artifact:src/api.ts", "artifact:src/client.ts"]);
    assert.deepEqual(await affected(options, ["src/api.ts"]), answer);
    assert.equal(JSON.stringify(answer).includes("cacheHit"), false);
    assert.equal(answer.nodes.some(node => "commit" in node), false);
    const contract = await affected(options, ["contracts/orders.yaml"]);
    assert.ok(contract.nodes.some(node => node.id === "artifact:server.py"));
    assert.ok(contract.nodes.some(node => node.id === "artifact:src/client.ts"));
    assert.equal((await affected(options, ["server.py"])).nodes.some(node => node.id === "artifact:src/client.ts"), false);
    const overlay = { name: "vibeguard", authority: "advisory", boundaries: [{ key: "orders", artifacts: ["src/client.ts"] }] };
    const impact = await affected({ ...options, overlays: [overlay] }, ["src/api.ts"], { relations: ["DEPENDS_ON", "CONTAINS"] });
    assert.ok(impact.nodes.some(node => node.id === "boundary:overlay:vibeguard:orders"));
    assert.ok(impact.evidence.some(item => item.authority === "advisory"));
    const why = await explain(options, "artifact:src/api.ts", "artifact:src/client.ts");
    assert.equal(why.nodes.length, 2);
    const direct = await slice(options, ["artifact:src/client.ts"], { direction: "out", maxDepth: 1 });
    assert.ok(direct.nodes.some(node => node.id === "artifact:src/api.ts"));
    assert.equal((await affected(options, ["missing.py"])).partial, true);
    assert.equal((await affected(options, ["src/api.ts"], { maxNodes: 1 })).truncated, true);
    await assert.rejects(affected(options, ["src/api.ts"], { maxDepth: 1000 }), /maxDepth/);
    const cli = JSON.parse(execFileSync(process.execPath, [resolve("dist/src/cli.js"), "affected", "--repo", repo.dir, "--ref", first, "--repository", "fixture/orders", "--cache-dir", cache, "--changed", "src/api.ts"], { encoding: "utf8" })) as unknown;
    assert.deepEqual(cli, answer);
    repo.put("server.py", "# narrow edit\n"); const second = repo.commit();
    const metrics = { refreshedProviders: 0, reusedProviders: 0, parsedDocumentationBlobs: 0 };
    await indexRepository({ ...options, ref: second }, metrics);
    assert.equal(metrics.refreshedProviders, 1); assert.equal(metrics.parsedDocumentationBlobs, 0);
    repo.git("mv", "docs/api.md", "docs/renamed.md"); const third = repo.commit();
    const rename = { refreshedProviders: 0, reusedProviders: 0, parsedDocumentationBlobs: 0 };
    await indexRepository({ ...options, ref: third }, rename);
    assert.equal(rename.parsedDocumentationBlobs, 0);
    repo.put("src/api.ts", "export const order = 2;\n"); const staleIndex = repo.commit();
    const partial = await affected({ ...options, ref: staleIndex }, ["src/api.ts"]);
    assert.equal(partial.partial, true);
    assert.equal(partial.nodes.some(node => node.id === "artifact:src/client.ts"), false);
    assert.ok(partial.diagnostics.some(message => message.includes("snapshot")));
    assert.deepEqual(await affected(options, ["src/api.ts"]), answer);
    rmSync(cache, { recursive: true, force: true }); mkdirSync(cache);
    assert.deepEqual(await affected(options, ["src/api.ts"]), answer);
    assert.ok(readFileSync(join(repo.dir, "src/api.ts"), "utf8").includes("2")); // stale queries did not checkout/mutate Git.
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); }
});

test("missing provider tooling never installs a tool or invents dependencies", async () => {
  const repo = fixture(); repo.put("a.py", "print('a')\n");
  repo.put(".repograph.json", JSON.stringify({ providers: [{ type: "scip", path: "missing.scip" }] }));
  const ref = repo.commit(); const cache = mkdtempSync(join(tmpdir(), "repograph-missing-"));
  try {
    const answer = await affected({ repositoryPath: repo.dir, ref, cacheDirectory: cache }, ["a.py"]);
    assert.equal(answer.partial, true); assert.equal(answer.edges.length, 0);
    assert.ok(answer.diagnostics.some(message => message.includes("unavailable")));
  } finally { rmSync(repo.dir, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); }
});
