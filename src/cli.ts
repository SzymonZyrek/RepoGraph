#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

import { canonicalJsonUnknown } from "./canonical.js";
import { ingestGitRepository } from "./git.js";
import { incrementalRepositoryUpdate } from "./incremental.js";
import { loadGraph } from "./io.js";\nimport { explainWithPolicy, parseTraversalPolicy, traverseWithPolicy } from "./policy.js";
import { createRepositorySnapshot } from "./snapshot.js";
import { LocalArtifactStore } from "./store.js";
import {
  affectedClosure,
  neighbors,
  shortestPath,
  type TraversalDirection,
} from "./traversal.js";
import { VERSION } from "./generated-version.js";

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError("usage", `Missing value for --${name}`);
    }
    index += 1;
    values.set(name, [...(values.get(name) ?? []), value]);
  }

  return { positionals, values };
}

function one(args: ParsedArgs, name: string, required = false): string | undefined {
  const values = args.values.get(name);
  if (values === undefined || values.length === 0) {
    if (required) throw new CliError("usage", `Missing --${name}`);
    return undefined;
  }
  if (values.length > 1) throw new CliError("usage", `--${name} may only be specified once`);
  return values[0];
}

function many(args: ParsedArgs, name: string): string[] {
  return args.values.get(name) ?? [];
}

function integerOption(args: ParsedArgs, name: string): number | undefined {
  const raw = one(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError("usage", `--${name} must be a non-negative integer`);
  }
  return parsed;
}

function directionOption(args: ParsedArgs): TraversalDirection | undefined {
  const direction = one(args, "direction");
  if (direction === undefined) return undefined;
  if (direction !== "out" && direction !== "in" && direction !== "both") {
    throw new CliError("usage", "--direction must be out, in, or both");
  }
  return direction;
}

function output(value: unknown, path?: string): void {
  const serialized = `${canonicalJsonUnknown(value)}\n`;
  if (path === undefined) {
    process.stdout.write(serialized);
  } else {
    writeFileSync(path, serialized);
  }
}

function usage(): never {
  throw new CliError(
    "usage",
    [
      "repograph version",
      "repograph build --repo PATH --ref REF [--repository NAME] [--out FILE]",
      "repograph snapshot --repo PATH --ref REF --cache-dir DIR [--repository NAME] [--out FILE] [--graph-out FILE]",
      "repograph update --repo PATH --base BASE --ref TARGET --cache-dir DIR [--base-mode direct|merge-base] [--out FILE] [--graph-out FILE]",
      "repograph neighbors --graph FILE --node ID [--direction out|in|both] [--edge KIND]",
      "repograph affected --graph FILE --node ID [--edge KIND] [--max-depth N] [--max-nodes N]",
      "repograph explain --graph FILE --from ID --to ID [--direction out|in|both] [--edge KIND] [--max-depth N]",\n      "repograph traverse-policy --graph FILE --node ID --policy FILE",\n      "repograph explain-policy --graph FILE --from ID --to ID --policy FILE",
    ].join("\n"),
  );
}

function run(argv: readonly string[]): void {
  const command = argv[0];
  if (command === undefined) usage();

  const args = parseArgs(argv.slice(1));

  if (command === "version") {
    output({ version: VERSION });
    return;
  }

  if (command === "build") {
    const repositoryPath = one(args, "repo", true)!;
    const ref = one(args, "ref", true)!;
    const repository = one(args, "repository");
    const out = one(args, "out");

    const result = ingestGitRepository({
      repositoryPath,
      ref,
      ...(repository === undefined ? {} : { repository }),
      policy: {
        ...(many(args, "include").length === 0 ? {} : { include: many(args, "include") }),
        ...(many(args, "exclude").length === 0 ? {} : { exclude: many(args, "exclude") }),
        ...(many(args, "generated").length === 0 ? {} : { generated: many(args, "generated") }),
        ...(many(args, "vendor").length === 0 ? {} : { vendor: many(args, "vendor") }),
      },
    });
    output(result.graph, out);
    return;
  }

  if (command === "snapshot") {
    const repositoryPath = one(args, "repo", true)!;
    const ref = one(args, "ref", true)!;
    const cacheDir = one(args, "cache-dir", true)!;
    const repository = one(args, "repository");
    const out = one(args, "out");
    const graphOut = one(args, "graph-out");
    const result = createRepositorySnapshot(new LocalArtifactStore(cacheDir), {
      repositoryPath,
      ref,
      ...(repository === undefined ? {} : { repository }),
      policy: {
        ...(many(args, "include").length === 0 ? {} : { include: many(args, "include") }),
        ...(many(args, "exclude").length === 0 ? {} : { exclude: many(args, "exclude") }),
        ...(many(args, "generated").length === 0 ? {} : { generated: many(args, "generated") }),
        ...(many(args, "vendor").length === 0 ? {} : { vendor: many(args, "vendor") }),
      },
    });
    if (graphOut !== undefined) output(result.graph, graphOut);
    output({
      cache: result.cache,
      manifest: result.manifest,
      manifestKey: result.manifestKey,
      reusedSnapshot: result.reusedSnapshot,
    }, out);
    return;
  }

  if (command === "update") {
    const repositoryPath = one(args, "repo", true)!;
    const baseRef = one(args, "base", true)!;
    const targetRef = one(args, "ref", true)!;
    const cacheDir = one(args, "cache-dir", true)!;
    const repository = one(args, "repository");
    const baseMode = one(args, "base-mode");
    const out = one(args, "out");
    const graphOut = one(args, "graph-out");
    if (baseMode !== undefined && baseMode !== "direct" && baseMode !== "merge-base") {
      throw new CliError("usage", "--base-mode must be direct or merge-base");
    }
    const result = incrementalRepositoryUpdate(new LocalArtifactStore(cacheDir), {
      repositoryPath,
      baseRef,
      targetRef,
      ...(repository === undefined ? {} : { repository }),
      ...(baseMode === undefined ? {} : { baseMode }),
      policy: {
        ...(many(args, "include").length === 0 ? {} : { include: many(args, "include") }),
        ...(many(args, "exclude").length === 0 ? {} : { exclude: many(args, "exclude") }),
        ...(many(args, "generated").length === 0 ? {} : { generated: many(args, "generated") }),
        ...(many(args, "vendor").length === 0 ? {} : { vendor: many(args, "vendor") }),
      },
    });
    if (graphOut !== undefined) output(result.targetGraph, graphOut);
    output({
      baseSnapshotKey: result.baseSnapshotKey,
      cache: result.cache,
      plan: result.plan,
      targetSnapshotKey: result.targetSnapshotKey,
    }, out);
    return;
  }

  if (command === "traverse-policy") {
    const graph = loadGraph(one(args, "graph", true)!);
    const policy = parseTraversalPolicy(readFileSync(one(args, "policy", true)!, "utf8"));
    output(traverseWithPolicy(graph, one(args, "node", true)!, policy));
    return;
  }

  if (command === "explain-policy") {
    const graph = loadGraph(one(args, "graph", true)!);
    const policy = parseTraversalPolicy(readFileSync(one(args, "policy", true)!, "utf8"));
    output(explainWithPolicy(
      graph,
      one(args, "from", true)!,
      one(args, "to", true)!,
      policy,
    ));
    return;
  }

  if (command === "neighbors") {
    const graph = loadGraph(one(args, "graph", true)!);
    const result = neighbors(graph, one(args, "node", true)!, {
      ...(directionOption(args) === undefined ? {} : { direction: directionOption(args)! }),
      ...(many(args, "edge").length === 0 ? {} : { edgeKinds: many(args, "edge") }),
    });
    output(result);
    return;
  }

  if (command === "affected") {
    const graph = loadGraph(one(args, "graph", true)!);
    const maxDepth = integerOption(args, "max-depth");
    const maxNodes = integerOption(args, "max-nodes");
    const result = affectedClosure(graph, one(args, "node", true)!, {
      ...(many(args, "edge").length === 0 ? {} : { edgeKinds: many(args, "edge") }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxNodes === undefined ? {} : { maxNodes }),
    });
    output(result);
    return;
  }

  if (command === "explain") {
    const graph = loadGraph(one(args, "graph", true)!);
    const direction = directionOption(args);
    const maxDepth = integerOption(args, "max-depth");
    const result = shortestPath(
      graph,
      one(args, "from", true)!,
      one(args, "to", true)!,
      {
        ...(direction === undefined ? {} : { direction }),
        ...(many(args, "edge").length === 0 ? {} : { edgeKinds: many(args, "edge") }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
      },
    );
    output(result);
    return;
  }

  usage();
}

try {
  run(process.argv.slice(2));
} catch (error) {
  const code = error instanceof CliError ? error.code : "repograph-error";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${canonicalJsonUnknown({ error: { code, message } })}\n`);
  process.exitCode = 1;
}
