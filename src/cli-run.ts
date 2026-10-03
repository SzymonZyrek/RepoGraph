import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { canonicalJson } from "./canonical.js";
import { ingestGitRepository } from "./git.js";
import { parseGraph, serializeGraph } from "./graph.js";
import {
  affected,
  explainPath,
  neighbors,
  reverseNeighbors,
  type QueryOptions,
} from "./query.js";
import { VERSION } from "./version.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Diagnostic {
  code: string;
  message: string;
}

const usage = [
  "repograph build --repo PATH --ref REF [--repository ID] [--include GLOB] [--exclude GLOB] [--no-codeowners]",
  "repograph neighbors --graph FILE --node ID_OR_KEY [--edge-kind KIND]",
  "repograph reverse-neighbors --graph FILE --node ID_OR_KEY [--edge-kind KIND]",
  "repograph affected --graph FILE --seed ID_OR_KEY [--seed ...] [--edge-kind KIND] [--max-depth N]",
  "repograph explain --graph FILE --from ID_OR_KEY --to ID_OR_KEY [--reverse] [--edge-kind KIND] [--max-depth N]",
  "repograph --version",
].join("\n");

function diagnostic(code: string, message: string): Diagnostic {
  return { code, message };
}

function writeDiagnostic(io: CliIO, value: Diagnostic): number {
  io.stderr(`${canonicalJson(value)}\n`);
  return 1;
}

function required(
  values: Record<string, string | boolean | string[] | undefined>,
  name: string,
): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function list(
  values: Record<string, string | boolean | string[] | undefined>,
  name: string,
): string[] | undefined {
  const value = values[name];
  return Array.isArray(value) ? value : undefined;
}

function queryOptions(
  values: Record<string, string | boolean | string[] | undefined>,
): QueryOptions {
  const edgeKinds = list(values, "edge-kind");
  const rawDepth = values["max-depth"];
  if (rawDepth === undefined) {
    return edgeKinds === undefined ? {} : { edgeKinds };
  }
  if (typeof rawDepth !== "string" || !/^\d+$/.test(rawDepth)) {
    throw new Error("--max-depth must be a non-negative integer");
  }
  const maxDepth = Number(rawDepth);
  return edgeKinds === undefined ? { maxDepth } : { edgeKinds, maxDepth };
}

function readGraph(path: string) {
  return parseGraph(readFileSync(path, "utf8"));
}

export function runCli(args: readonly string[], io: CliIO): number {
  try {
    if (args.length === 1 && args[0] === "--version") {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
      io.stdout(`${usage}\n`);
      return args.length === 0 ? 1 : 0;
    }

    const command = args[0]!;
    const rest = args.slice(1);

    if (command === "build") {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          repo: { type: "string" },
          ref: { type: "string" },
          repository: { type: "string" },
          include: { type: "string", multiple: true },
          exclude: { type: "string", multiple: true },
          "no-codeowners": { type: "boolean" },
        },
      });
      const normalized = values as Record<string, string | boolean | string[] | undefined>;
      const include = list(normalized, "include");
      const exclude = list(normalized, "exclude");
      const repository = normalized.repository;
      const result = ingestGitRepository({
        repositoryPath: required(normalized, "repo"),
        ref: required(normalized, "ref"),
        ...(typeof repository === "string" ? { repository } : {}),
        ...(
          include !== undefined || exclude !== undefined
            ? {
                policy: {
                  ...(include === undefined ? {} : { include }),
                  ...(exclude === undefined ? {} : { exclude }),
                },
              }
            : {}
        ),
        discoverCodeowners: normalized["no-codeowners"] !== true,
      });
      io.stdout(`${serializeGraph(result.graph)}\n`);
      return 0;
    }

    const commonOptions = {
      graph: { type: "string" as const },
      "edge-kind": { type: "string" as const, multiple: true },
      "max-depth": { type: "string" as const },
    };

    if (command === "neighbors" || command === "reverse-neighbors") {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          ...commonOptions,
          node: { type: "string" },
        },
      });
      const normalized = values as Record<string, string | boolean | string[] | undefined>;
      const graph = readGraph(required(normalized, "graph"));
      const node = required(normalized, "node");
      const result =
        command === "neighbors"
          ? neighbors(graph, node, queryOptions(normalized))
          : reverseNeighbors(graph, node, queryOptions(normalized));
      io.stdout(`${canonicalJson(result)}\n`);
      return 0;
    }

    if (command === "affected") {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          ...commonOptions,
          seed: { type: "string", multiple: true },
        },
      });
      const normalized = values as Record<string, string | boolean | string[] | undefined>;
      const seeds = list(normalized, "seed");
      if (seeds === undefined || seeds.length === 0) {
        throw new Error("--seed is required");
      }
      const result = affected(
        readGraph(required(normalized, "graph")),
        seeds,
        queryOptions(normalized),
      );
      io.stdout(`${canonicalJson(result)}\n`);
      return 0;
    }

    if (command === "explain") {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          ...commonOptions,
          from: { type: "string" },
          to: { type: "string" },
          reverse: { type: "boolean" },
        },
      });
      const normalized = values as Record<string, string | boolean | string[] | undefined>;
      const result = explainPath(
        readGraph(required(normalized, "graph")),
        required(normalized, "from"),
        required(normalized, "to"),
        normalized.reverse === true ? "reverse" : "forward",
        queryOptions(normalized),
      );
      io.stdout(`${canonicalJson(result)}\n`);
      return 0;
    }

    return writeDiagnostic(io, diagnostic("invalid-command", `Unknown command: ${command}`));
  } catch (error) {
    return writeDiagnostic(
      io,
      diagnostic(
        "invalid-input",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}
