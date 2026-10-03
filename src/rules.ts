import picomatch from 'picomatch';
import { RepoGraphError } from './error.js';
import { rulesSchema, type RulesDocument, type GraphDocument } from './model.js';

export function parseRules(input: unknown): RulesDocument {
  const result = rulesSchema.safeParse(input);
  if (!result.success) throw new RepoGraphError('INVALID_RULES', 'Malformed rules or unsupported schema', { issues: result.error.issues });
  const seen = new Set<string>();
  for (const rule of result.data.rules) {
    if (seen.has(rule.id)) throw new RepoGraphError('INVALID_RULES', 'Duplicate rule ID', { id: rule.id });
    seen.add(rule.id); glob(rule.pattern);
  }
  return result.data;
}
export function glob(pattern: string): (path: string) => boolean {
  if (!pattern || pattern.startsWith('!') || pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').includes('..')) {
    throw new RepoGraphError('INVALID_PATTERN', 'Use a nonempty repository-relative glob without negation, backslashes or parent traversal', { pattern });
  }
  try { return picomatch(pattern, { dot: true, nocase: false, nonegate: true, noext: true, strictBrackets: true }); }
  catch { throw new RepoGraphError('INVALID_PATTERN', 'Malformed glob', { pattern }); }
}

export interface CodeownersRule {
  pattern: string; owners: string[]; line: number; matches: (path: string) => boolean;
}
/** CODEOWNERS patterns are gitignore-like, not general-purpose glob expressions. */
function codeownersMatcher(pattern: string): (path: string) => boolean {
  if (pattern.startsWith('!') || /[[\]\\]/.test(pattern) || pattern.split('/').includes('..') || pattern.includes('***')) {
    throw new Error('Unsupported CODEOWNERS pattern');
  }
  const anchored = pattern.startsWith('/');
  let body = anchored ? pattern.slice(1) : pattern;
  const directory = body.endsWith('/');
  if (directory) body = body.slice(0, -1);
  if (!body || body.includes('//')) throw new Error('Empty CODEOWNERS pattern');
  const rooted = anchored || body.includes('/');
  let expression = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '*') {
      if (body[i + 1] === '*') {
        const segmentStart = i === 0 || body[i - 1] === '/';
        const segmentEnd = i + 2 === body.length || body[i + 2] === '/';
        if (!segmentStart || !segmentEnd) throw new Error('Double star must be a path segment');
        if (body[i + 2] === '/') { expression += '(?:[^/]+/)*'; i += 2; }
        else { expression += '.*'; i++; }
      } else expression += '[^/]*';
    } else if (ch === '?') expression += '[^/]';
    else expression += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // A terminal wildcard selects leaf paths, not every descendant of a matched directory (docs/*).
  const finalSegment = body.slice(body.lastIndexOf('/') + 1);
  const suffix = directory ? '/.+' : /[*?]/.test(finalSegment) ? '' : '(?:/.*)?';
  const regex = new RegExp(`${rooted ? '^' : '(?:^|/)'}${expression}${suffix}$`);
  return path => regex.test(path);
}
export function parseCodeowners(text: string, source: string): { rules: CodeownersRule[]; diagnostics: GraphDocument['diagnostics'] } {
  const rules: CodeownersRule[] = []; const diagnostics: GraphDocument['diagnostics'] = [];
  if (Buffer.byteLength(text, 'utf8') >= 3 * 1024 * 1024) {
    return { rules, diagnostics: [{ code: 'CODEOWNERS_TOO_LARGE', message: 'CODEOWNERS must be smaller than 3 MB', source }] };
  }
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const content = raw.replace(/#.*$/, '').trim();
    if (!content) continue;
    // Escaped spaces are allowed in paths; escaping # and other syntax is not.
    const placeholder = '\u0000';
    const tokens = content.replace(/\\ /g, placeholder).split(/\s+/).map(s => s.replaceAll(placeholder, ' '));
    const pattern = tokens[0]!; const owners = tokens.slice(1);
    try {
      if (raw.includes(placeholder)) throw new Error('NUL in rule');
      rules.push({ pattern, owners, line: index + 1, matches: codeownersMatcher(pattern) });
    } catch {
      diagnostics.push({ code: 'INVALID_CODEOWNERS_PATTERN', message: `Unsupported pattern: ${pattern}`, source, line: index + 1 });
    }
  }
  return { rules, diagnostics };
}
