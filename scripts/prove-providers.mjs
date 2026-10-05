import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scipFacts, cargoFacts } from "../dist/src/causal-providers.js";
import { fingerprint } from "../dist/src/causal-model.js";
import { affected } from "../dist/src/repository-query.js";

const root = resolve("test/fixtures/providers/ts");
const output = resolve(".cache/provider-proof/index.scip");
mkdirSync(resolve(".cache/provider-proof"), { recursive: true });
execFileSync(process.execPath, [resolve("node_modules/@sourcegraph/scip-typescript/dist/src/main.js"), "index", "--output", output], { cwd: root, stdio: "inherit" });
const scip = scipFacts(readFileSync(output), new Set(["client.ts", "model.ts"]));
assert.ok(scip.edges.some(edge => edge.from === "artifact:client.ts" && edge.to === "artifact:model.ts"));
assert.equal(scip.nodes.some(node => node.type !== "artifact"), false);
console.log("SCIP TypeScript 0.4.0: real index -> file-level causal dependency passed");

const cache = mkdtempSync(join(tmpdir(), "repograph-native-providers-"));
const scipBytes = readFileSync(output);
const scipProvider = { id: "real-scip", version: "0.4.0", available: () => true,
  fingerprint: () => fingerprint(scipBytes),
  collect: context => scipFacts(scipBytes, new Set(context.paths), "real-scip", "test/fixtures/providers/ts") };
try {
  const options = { repositoryPath: process.cwd(), ref: "HEAD", cacheDirectory: cache, providers: [scipProvider] };
  const answer = await affected(options, ["test/fixtures/providers/ts/model.ts"]);
  assert.ok(answer.nodes.some(node => node.id === "artifact:test/fixtures/providers/ts/client.ts"));
  console.log("Real SCIP facts persisted and answered through bounded repo/ref queries");

if (process.argv.includes("--cargo")) {
  const cwd = resolve("test/fixtures/providers/cargo");
  const native = JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--format-version", "1"], { cwd, encoding: "utf8" }));
  const paths = [];
  const walk = directory => {
    for (const name of readdirSync(join(cwd, directory))) {
      const path = directory ? `${directory}/${name}` : name;
      if (statSync(join(cwd, path)).isDirectory()) { if (name !== "target" && name !== ".git") walk(path); }
      else paths.push(path);
    }
  };
  walk("");
  const facts = cargoFacts(native, new Set(paths));
  assert.ok(facts.edges.some(edge => edge.kind === "DEPENDS_ON" && edge.from === "boundary:workspace:web/Cargo.toml" && edge.to === "boundary:workspace:domain/Cargo.toml"));
  console.log("Cargo metadata: real native workspace -> causal boundaries passed");
  const cargoProvider = { id: "real-cargo", version: "1", available: () => true,
    fingerprint: () => fingerprint(JSON.stringify(native)),
    collect: context => cargoFacts(native, new Set(context.paths), "real-cargo", "test/fixtures/providers/cargo") };
  const answer = await affected({ ...options, providers: [scipProvider, cargoProvider] },
    ["test/fixtures/providers/cargo/domain/src/lib.rs"], { relations: ["DEPENDS_ON", "CONTAINS"] });
  assert.ok(answer.nodes.some(node => node.id === "boundary:workspace:test/fixtures/providers/cargo/web/Cargo.toml"));
  console.log("Real native workspace facts persisted and answered through bounded repo/ref queries");
}
} finally { rmSync(cache, { recursive: true, force: true }); }
