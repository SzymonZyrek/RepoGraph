function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globFragment(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += escapeRegex(character);
    }
  }
  return result;
}

export function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function matchesRepoGlob(path: string, rawPattern: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  let pattern = normalizeRepoPath(rawPattern.trim());
  if (pattern.length === 0) return false;

  const directoryPattern = pattern.endsWith("/");
  if (directoryPattern) pattern = pattern.slice(0, -1);

  const hasSlash = pattern.includes("/");
  const fragment = globFragment(pattern);

  const source = hasSlash
    ? directoryPattern
      ? `^${fragment}(?:/.*)?$`
      : `^${fragment}$`
    : directoryPattern
      ? `(?:^|/)${fragment}(?:/.*)?$`
      : `(?:^|/)${fragment}(?:$|/)`;

  return new RegExp(source).test(normalizedPath);
}

export function matchesAnyRepoGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesRepoGlob(path, pattern));
}
