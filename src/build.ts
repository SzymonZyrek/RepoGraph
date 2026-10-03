import { GraphBuilder, nodeId, edgeId, type GraphDocument, type GraphNode, type Provenance, type RulesDocument } from './model.js';
import { git, parseTree } from './git.js';
import { glob, parseRules, parseCodeowners } from './rules.js';
import { VERSION } from './version.js';
import { RepoGraphError } from './error.js';

export interface BuildOptions {
  repoPath: string; repoId: string; ref: string;
  include?: string[]; exclude?: string[]; rules?: RulesDocument; codeowners?: boolean;
}
export async function buildGraph(options: BuildOptions): Promise<GraphDocument> {
  if (!options.repoPath || !options.repoId || !options.ref) throw new RepoGraphError('INVALID_INPUT', 'repoPath, repoId and ref are required');
  const include = options.include ?? []; const exclude = options.exclude ?? [];
  const included = include.map(glob); const excluded = exclude.map(glob);
  const rules = options.rules ? parseRules(options.rules) : null;
  const commit = (await git(options.repoPath, ['rev-parse', '--verify', '--end-of-options', `${options.ref}^{commit}`])).toString('utf8').trim();
  const entries = parseTree(await git(options.repoPath, ['ls-tree', '-rz', '--full-tree', commit]));
  const builder = new GraphBuilder(options.repoId, commit);
  const diagnostics: GraphDocument['diagnostics'] = [];
  const provenance = (extractor: string, extra: Partial<Provenance> = {}): Provenance => ({
    repoId: options.repoId, commit, extractor, extractorVersion: VERSION, ...extra
  });
  const node = (type: string, key: string, metadata: GraphNode['metadata'], p: Provenance, classification: GraphNode['classification'] = 'source') =>
    builder.addNode({ id: nodeId(options.repoId, type, key), type, key, metadata, classification, provenance: [p] });
  const edge = (type: string, from: GraphNode, to: GraphNode, p: Provenance, classification: GraphNode['classification']) =>
    builder.addEdge({ id: edgeId(type, from.id, to.id), type, from: from.id, to: to.id, qualifier: '', metadata: {}, classification, provenance: [p] });
  const root = node('repository', '', {}, provenance('git-tree'));
  const directories = new Map<string, GraphNode>([['', root]]);
  function directory(path: string): GraphNode {
    const existing = directories.get(path); if (existing) return existing;
    const parentPath = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    const parent = directory(parentPath);
    const current = node('directory', path, { path }, provenance('git-tree', { path }));
    directories.set(path, current); edge('contains', parent, current, provenance('git-tree', { path }), 'source');
    return current;
  }
  const files: GraphNode[] = [];
  let omittedEntries = 0;
  for (const entry of entries) {
    if ((included.length > 0 && !included.some(match => match(entry.path))) || excluded.some(match => match(entry.path))) { omittedEntries++; continue; }
    const p = provenance('git-tree', { path: entry.path, ...(entry.kind === 'blob' ? { blobOid: entry.oid } : {}) });
    const file = node(entry.kind === 'commit' ? 'gitlink' : 'file', entry.path,
      { path: entry.path, mode: entry.mode, ...(entry.kind === 'commit' ? { targetCommit: entry.oid } : { blobOid: entry.oid }) }, p);
    files.push(file);
    const parent = directory(entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/'))));
    edge('contains', parent, file, p, 'source');
  }
  if (rules) {
    for (const [index, rule] of rules.rules.entries()) {
      const p = provenance('path-glob', { source: 'inline-json', index });
      const current = node('rule', `json:${rule.id}`, { ...rule.metadata, pattern: rule.pattern, ruleId: rule.id, source: 'json' }, p);
      const matches = glob(rule.pattern);
      for (const file of files) if (matches(file.key)) {
        edge('applies_to', current, file, provenance('path-glob', { source: 'inline-json', index, path: file.key,
          ...(typeof file.metadata.blobOid === 'string' ? { blobOid: file.metadata.blobOid } : {}) }), 'derived');
      }
    }
  }
  if (options.codeowners !== false) {
    const source = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
      .map(path => entries.find(entry => entry.path === path && entry.kind === 'blob' && entry.mode !== '120000')).find(Boolean);
    if (source) {
      const text = (await git(options.repoPath, ['cat-file', 'blob', source.oid])).toString('utf8');
      const parsed = parseCodeowners(text, source.path); diagnostics.push(...parsed.diagnostics);
      const nodes = parsed.rules.map(rule => node('rule', `codeowners:${source.path}:${rule.line}`, {
        source: 'codeowners', pattern: rule.pattern, owners: rule.owners
      }, provenance('codeowners', { source: source.path, path: source.path, blobOid: source.oid, line: rule.line })));
      for (const file of files) {
        let winner = -1;
        for (const [index, rule] of parsed.rules.entries()) if (rule.matches(file.key)) winner = index;
        if (winner >= 0) edge('applies_to', nodes[winner]!, file,
          provenance('codeowners', { source: source.path, path: source.path, blobOid: source.oid, line: parsed.rules[winner]!.line }), 'derived');
      }
    }
  }
  return builder.document({ include, exclude, codeowners: options.codeowners !== false, rules, omittedEntries }, diagnostics);
}
