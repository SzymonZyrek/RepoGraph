import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { affected, artifact, boundary, explain, type GraphProvider } from "../src/index.js";
import { FactCollector } from "../src/causal-providers.js";

test("Hacka context and VibeGuard capability impact share bounded repo/ref queries", async () => {
  const root = mkdtempSync(join(tmpdir(), "repograph-consumer-"));
  const cache = mkdtempSync(join(tmpdir(), "repograph-consumer-cache-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const paths = ["api.py", "client.ts", "contract.yaml", "test_api.py", "api.md", "unrelated.ts"];
  try {
    git("init", "-q"); git("config", "user.email", "test@example.org"); git("config", "user.name", "Fixture");
    paths.forEach(path => writeFileSync(join(root, path), "fixture\n"));
    git("add", "."); git("commit", "-qm", "consumer");
    const ref = git("rev-parse", "HEAD");
    const provider: GraphProvider = {
      id: "fixture-native", version: "1", fingerprint: context => context.commit,
      available: () => true,
      collect(context) {
        const facts = new FactCollector("fixture-native", context.commit, "native-build");
        const api = facts.add(artifact("api.py"));
        const client = facts.add(artifact("client.ts"));
        const contract = facts.add(artifact("contract.yaml", ["contract"]));
        const test = facts.add(artifact("test_api.py", ["validation"]));
        const docs = facts.add(artifact("api.md", ["documentation"]));
        const operation = facts.add(boundary("interface", "rest:payments:get:/payments"));
        facts.edge(api, operation); facts.edge(client, operation); facts.edge(operation, contract);
        facts.edge(test, api); facts.edge(docs, api);
        return facts.finish();
      },
    };
    const options = { repositoryPath: root, repository: "consumer/proof", ref, cacheDirectory: cache, providers: [provider] };
    const context = await affected(options, ["api.py"]);
    assert.deepEqual(context.nodes.filter(node => node.type === "artifact" && node.roles.includes("validation")).map(node => node.id), ["artifact:test_api.py"]);
    assert.deepEqual(context.nodes.filter(node => node.type === "artifact" && node.roles.includes("documentation")).map(node => node.id), ["artifact:api.md"]);
    assert.equal(context.nodes.some(node => node.id === "artifact:client.ts"), false);
    const contractChange = await affected(options, ["contract.yaml"]);
    assert.ok(contractChange.nodes.some(node => node.id === "artifact:client.ts"));
    assert.equal(contractChange.nodes.some(node => node.id === "artifact:unrelated.ts"), false);
    const overlays = [{ name: "vibeguard", authority: "authoritative", boundaries: [{ key: "payments", artifacts: ["api.py"] }, { key: "sibling", artifacts: ["unrelated.ts"] }] }];
    const impact = await affected({ ...options, overlays }, ["contract.yaml"], { relations: ["DEPENDS_ON", "CONTAINS"] });
    assert.ok(impact.nodes.some(node => node.id === "boundary:overlay:vibeguard:payments"));
    assert.equal(impact.nodes.some(node => node.id === "boundary:overlay:vibeguard:sibling"), false);
    const why = await explain({ ...options, overlays }, "artifact:contract.yaml", "boundary:overlay:vibeguard:payments", { relations: ["DEPENDS_ON", "CONTAINS"] });
    assert.equal(why.edges.length, 3);
    assert.ok(why.evidence.some(evidence => evidence.authority === "authoritative"));
    assert.equal(why.partial, false);
    const simultaneous = await Promise.all([affected(options, ["api.py"]), affected(options, ["contract.yaml"])]);
    assert.deepEqual(simultaneous[0], context);
    assert.deepEqual(simultaneous[1], contractChange);
    provider.available = () => false;
    const unavailable = await affected(options, ["api.py"]);
    assert.equal(unavailable.partial, true);
    assert.equal(unavailable.edges.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); }
});
