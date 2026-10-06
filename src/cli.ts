#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { affected, explain, indexRepository, slice } from "./repository-query.js";
import { queryPolicy, type CausalEdgeKind, type QueryPolicy } from "./causal-model.js";
import { VERSION } from "./version.js";

async function run(args: string[]): Promise<void> {
  const command = args.shift();
  if (command === "version" && !args.length) { process.stdout.write(`${VERSION}\n`); return; }
  if (!["index", "affected", "slice", "explain"].includes(command ?? "")) throw new Error("Expected version, index, affected, slice or explain");
  const values = new Map<string, string[]>();
  const allowed = new Set(["repo", "ref", "repository", "cache-dir", "out", "direction", "edge", "max-depth", "max-nodes", "max-edges",
    ...(command === "affected" ? ["changed"] : command === "slice" ? ["start"] : command === "explain" ? ["from", "to"] : [])]);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!.replace(/^--/, ""); const value = args[i + 1];
    if (!args[i]!.startsWith("--") || !allowed.has(name) || !value || value.startsWith("--")) throw new Error(`Invalid option ${args[i]}`);
    values.set(name, [...values.get(name) ?? [], value]);
  }
  const one = (name: string, required = false): string | undefined => {
    const found = values.get(name) ?? [];
    if (found.length > 1 || (required && !found.length)) throw new Error(`Expected one --${name}`);
    return found[0];
  };
  const many = (name: string): string[] => { const found = values.get(name) ?? []; if (!found.length) throw new Error(`Missing --${name}`); return found; };
  const options = { repositoryPath: one("repo", true)!, ref: one("ref", true)!,
    ...(one("repository") ? { repository: one("repository")! } : {}), ...(one("cache-dir") ? { cacheDirectory: one("cache-dir")! } : {}) };
  const policy: QueryPolicy = {};
  if (one("direction")) policy.direction = one("direction") as "in" | "out" | "both";
  if (values.has("edge")) policy.relations = values.get("edge") as CausalEdgeKind[];
  for (const [flag, field] of [["max-depth", "maxDepth"], ["max-nodes", "maxNodes"], ["max-edges", "maxEdges"]] as const) {
    if (one(flag) !== undefined) policy[field] = Number(one(flag));
  }
  queryPolicy(policy);
  const answer = command === "index" ? await indexRepository(options) : command === "affected" ? await affected(options, many("changed"), policy) :
    command === "slice" ? await slice(options, many("start"), policy) : await explain(options, one("from", true)!, one("to", true)!, policy);
  const json = `${JSON.stringify(answer)}\n`; const out = one("out");
  if (out) writeFileSync(out, json); else process.stdout.write(json);
}
try { await run(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${JSON.stringify({ error: { code: "repograph-error", message: error instanceof Error ? error.message : String(error) } })}\n`); process.exitCode = 1; }
