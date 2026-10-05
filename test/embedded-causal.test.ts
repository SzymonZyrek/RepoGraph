import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifact, boundary } from "../src/causal-model.js";
import { FactCollector } from "../src/causal-providers.js";
import { EmbeddedCausalStore } from "../src/embedded-store.js";

test("Ladybug persists the minimal graph and traverses causal interfaces without provider/consumer coupling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repograph-causal-"));
  const path = join(dir, "index.lbdb");
  const facts = new FactCollector("fixture", "first", "explicit-overlay", undefined, "authoritative");
  const contract = facts.add(artifact("contracts/orders.yaml", ["contract"]));
  const client = facts.add(artifact("web/client.ts"));
  const server = facts.add(artifact("src/server.py"));
  const docs = facts.add(artifact("docs/api.md", ["documentation"]));
  const operation = facts.add(boundary("interface", "rest:orders:get:/orders"));
  const capability = facts.add(boundary("overlay", "vibeguard:orders"));
  facts.edge(operation, contract); facts.edge(client, operation); facts.edge(server, operation);
  facts.edge(docs, server); facts.edge(capability, server, "CONTAINS");
  let store = new EmbeddedCausalStore(path);
  try {
    await store.open(); await store.replace("fixture/repo", "a", "config", [facts.finish()]);
    const answer = await store.query("fixture/repo", "a", [contract]);
    assert.deepEqual(answer.nodes.map(node => node.id), [contract, docs, operation, server, client].sort());
    assert.equal(answer.partial, false); assert.equal(answer.truncated, false);
    assert.equal(answer.evidence.length, 1);
    const internal = await store.query("fixture/repo", "a", [server]);
    assert.equal(internal.nodes.some(node => node.id === client), false);
    const impact = await store.query("fixture/repo", "a", [server], { relations: ["DEPENDS_ON", "CONTAINS"] });
    assert.ok(impact.nodes.some(node => node.id === capability));
    const why = await store.query("fixture/repo", "a", [contract], {}, client);
    assert.equal(why.nodes.length, 3); assert.equal(why.edges.length, 2);
    assert.equal((await store.query("fixture/repo", "a", [contract], { maxNodes: 2 })).truncated, true);
    assert.equal((await store.query("fixture/repo", "a", [contract], { maxDepth: 0 })).truncated, true);
    await assert.rejects(store.query("fixture/repo", "stale", [contract]), /not indexed/);
    await store.close(); store = new EmbeddedCausalStore(path); await store.open();
    assert.deepEqual(await store.query("fixture/repo", "a", [contract]), answer);
    const conflict = new FactCollector("other", "second", "native-build");
    conflict.add(artifact("other.py"));
    const conflicting = conflict.finish();
    conflicting.evidence[0]!.id = answer.evidence[0]!.id;
    await assert.rejects(store.replace("fixture/repo", "b", "config", [conflicting]));
    assert.deepEqual(await store.query("fixture/repo", "a", [contract]), answer);
    const invalid = facts.finish(); invalid.edges[0]!.to = "artifact:missing";
    await assert.rejects(store.replace("fixture/repo", "b", "config", [invalid]), /Invalid causal/);
    assert.deepEqual(await store.query("fixture/repo", "a", [contract]), answer);
    const empty = new FactCollector("fixture", "empty", "explicit-overlay").finish();
    await store.replace("fixture/repo", "b", "config", [empty]);
    assert.equal((await store.query("fixture/repo", "b", [contract])).nodes.length, 0);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("converging providers retain independent attribution and remove only released facts/roles", async () => {
  const store = new EmbeddedCausalStore(":memory:");
  try {
    await store.open();
    const p = new FactCollector("p", "one", "precise-index");
    p.edge(p.add(artifact("a.py", ["validation"])), p.add(artifact("b.py")));
    const q = new FactCollector("q", "two", "deterministic-repo");
    q.edge(q.add(artifact("a.py", ["documentation"])), q.add(artifact("b.py")));
    await store.replace("fixture", "a", "config", [p.finish(), q.finish()]);
    const answer = await store.query("fixture", "a", ["artifact:b.py"]);
    assert.equal(answer.edges.length, 1); assert.equal(answer.edges[0]!.evidence.length, 2);
    assert.equal(answer.evidence.length, 2);
    assert.deepEqual(answer.nodes.find(node => node.id === "artifact:a.py"), artifact("a.py", ["documentation", "validation"]));
    await store.replace("fixture", "b", "config", [], ["p"]);
    const retained = await store.query("fixture", "b", ["artifact:b.py"], { direction: "both" });
    assert.equal(retained.edges.length, 1); assert.equal(retained.evidence.length, 1);
    assert.deepEqual(retained.nodes.find(node => node.id === "artifact:a.py"), artifact("a.py", ["documentation"]));
    assert.equal((await store.query("fixture", "b", ["artifact:a.py"], {}, "artifact:not-reachable.py")).nodes.length, 0);
    await store.rows("MATCH (m:Metadata) SET m.schema='incompatible'");
    await assert.rejects(store.open(), /Unsupported causal index schema/);
  } finally { await store.close(); }
});
