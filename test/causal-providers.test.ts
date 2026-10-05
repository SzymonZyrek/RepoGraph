import assert from "node:assert/strict";
import { test } from "node:test";
import { artifact, boundary, validateFacts } from "../src/causal-model.js";
import { cargoFacts, FactCollector, interfaceFacts, markdownFacts, overlayFacts, scipFacts, scipIndexType } from "../src/causal-providers.js";

test("SCIP reduces Python/TS precise references to files, ignoring local/external symbol inventories", () => {
  const bytes = scipIndexType.encode(scipIndexType.fromObject({ metadata: { toolInfo: { name: "scip-python", version: "fixture" } }, documents: [
    { relativePath: "api.py", occurrences: [{ symbol: "model", symbolRoles: 0 }, { symbol: "local 1", symbolRoles: 0 }, { symbol: "external", symbolRoles: 0 }] },
    { relativePath: "model.py", occurrences: [{ symbol: "model", symbolRoles: 1 }] },
  ] })).finish();
  const facts = scipFacts(bytes, new Set(["api.py", "model.py"]));
  assert.equal(facts.edges.length, 1);
  assert.equal(facts.edges[0]!.from, "artifact:api.py");
  assert.equal(facts.edges[0]!.to, "artifact:model.py");
  assert.equal(facts.evidence[0]!.source, "scip-python@fixture");
  assert.equal(scipFacts(bytes, new Set(["api.py"])).partial, true);
});

test("Cargo consumes a native resolved workspace and excludes registry-only coordinates", () => {
  const facts = cargoFacts({ workspace_root: "/repo", workspace_members: ["web", "domain"],
    packages: [{ id: "web", manifest_path: "/repo/web/Cargo.toml" }, { id: "domain", manifest_path: "/repo/domain/Cargo.toml" }],
    resolve: { nodes: [{ id: "web", dependencies: ["domain", "registry"] }] },
  }, new Set(["web/Cargo.toml", "web/src/lib.rs", "domain/Cargo.toml", "domain/src/lib.rs"]));
  assert.ok(facts.edges.some(edge => edge.kind === "DEPENDS_ON" && edge.from === "boundary:workspace:web/Cargo.toml"));
  assert.equal(facts.nodes.some(node => node.id.includes("registry")), false);
});

test("documentation dependency direction and explicit capability overlays use only the core schema", () => {
  const paths = new Set(["docs/api.md", "api.py"]);
  const docs = markdownFacts("docs/api.md", ["../api.py", "https://example.org", "../missing.py"], paths, "blob");
  assert.equal(docs.edges[0]!.from, "artifact:docs/api.md");
  assert.equal(docs.edges[0]!.to, "artifact:api.py");
  assert.equal(docs.partial, true);
  const overlay = overlayFacts({ name: "vibeguard", authority: "authoritative", boundaries: [{ key: "payments", artifacts: ["api.py"] }] }, paths);
  assert.equal(overlay.edges[0]!.kind, "CONTAINS");
  assert.equal(overlay.evidence[0]!.authority, "authoritative");
  assert.throws(() => overlayFacts({ name: "bad", boundaries: [] }, paths), /authority/);
});

test("REST, SOAP and messaging normalize into interface boundaries with exact scoped identities", () => {
  const paths = new Set(["api.yaml", "api.wsdl", "events.yaml", "client.ts", "controller.py", "producer.py", "consumer.ts"]);
  for (const [family, path, source, key, consumers] of [
    ["openapi", "api.yaml", "openapi: 3.1.0\npaths:\n  /orders/{id}:\n    get: {}", "rest:orders:get:/orders/{id}", ["client.ts", "controller.py"]],
    ["wsdl", "api.wsdl", '<definitions targetNamespace="urn:orders"><portType name="Orders"><operation name="GetOrder"/></portType></definitions>', "soap:urn:orders:Orders:GetOrder", ["client.ts"]],
    ["asyncapi", "events.yaml", "asyncapi: 3.0.0\nchannels:\n  orders:\n    address: orders.created", "message:orders:orders.created", ["producer.py", "consumer.ts"]],
  ] as const) {
    const facts = interfaceFacts(family, path, source, paths, [{ interface: key, artifacts: [...consumers] }], "orders");
    assert.equal(facts.partial, false);
    assert.equal(facts.nodes.filter(node => node.type === "boundary").length, 1);
    assert.equal(facts.edges.length, consumers.length + 1);
    assert.ok(facts.edges.some(edge => edge.from === `boundary:interface:${key}` && edge.to === `artifact:${path}`));
    assert.equal(facts.edges.some(edge => consumers.includes(edge.to.replace("artifact:", "") as never)), false);
  }
  assert.throws(() => interfaceFacts("wsdl", "api.wsdl", '<!DOCTYPE x><definitions/>', paths), /unsafe/);
  assert.equal(interfaceFacts("openapi", "api.yaml", "openapi: 3.1.0\npaths: {}", paths).partial, true);
  assert.equal(interfaceFacts("asyncapi", "events.yaml", "asyncapi: 3.0.0\nchannels: {}", paths).partial, true);
  assert.equal(interfaceFacts("openapi", "api.yaml", "openapi: 3.1.0\npaths:\n  /orders:\n    get:\n      responses:\n        '200':\n          $ref: external.yaml#/response", paths).partial, true);
  assert.equal(interfaceFacts("wsdl", "api.wsdl", '<definitions targetNamespace="urn:orders"><import location="other.wsdl"/><portType name="Orders"><operation name="GetOrder"/></portType></definitions>', paths).partial, true);
});

test("closed model rejects invalid nodes, identities, roles and provider relations", () => {
  assert.throws(() => artifact("../outside.py")); assert.throws(() => boundary("UPPER", "key"));
  const facts = new FactCollector("fixture", "input", "deterministic-repo");
  facts.add(artifact("a.py")); facts.edge("artifact:a.py", "artifact:missing.py");
  assert.throws(() => facts.finish(), /Invalid causal/);
  const valid = new FactCollector("p", "input", "native-build").finish();
  valid.nodes.push({ id: "directory:src", type: "directory" } as never);
  assert.throws(() => validateFacts(valid), /Invalid\/duplicate/);
});
