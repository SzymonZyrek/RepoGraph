import { matchesRepoGlob } from "./glob.js";

export interface PathRule {
  pattern: string;
  targets: string[];
  order: number;
  sourcePath?: string;
  source: "repository" | "overlay";
}

export interface PathRuleInput {
  pattern: string;
  targets: string[];
  sourcePath?: string;
  source?: "repository" | "overlay";
}

export function parseCodeownersLike(
  content: string,
  sourcePath: string,
): PathRuleInput[] {
  const rules: PathRuleInput[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    const pattern = parts.shift();
    if (pattern === undefined || pattern.length === 0 || parts.length === 0) {
      continue;
    }

    rules.push({
      pattern,
      targets: parts,
      sourcePath,
      source: "repository",
    });
  }

  return rules;
}

export function normalizePathRules(inputs: readonly PathRuleInput[]): PathRule[] {
  return inputs.map((input, order) => ({
    pattern: input.pattern,
    targets: [...input.targets],
    order,
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    source: input.source ?? (input.sourcePath === undefined ? "overlay" : "repository"),
  }));
}

export function matchingPathRules(
  path: string,
  rules: readonly PathRule[],
): PathRule[] {
  return rules.filter((rule) => matchesRepoGlob(path, rule.pattern));
}

export function effectivePathRule(
  path: string,
  rules: readonly PathRule[],
): PathRule | undefined {
  const matches = matchingPathRules(path, rules);
  return matches.at(-1);
}
