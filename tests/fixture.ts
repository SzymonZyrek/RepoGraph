import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphBuilder, nodeId, edgeId, type GraphNode, type Provenance } from '../src/index.js';

export const commit = 'a'.repeat(40);
export const policy = { include: [], exclude: [], codeowners: false, rules: null, omittedEntries: 0 };
export const p: Provenance = { repoId: 'fixture', commit, extractor: 'fixture', extractorVersion: '1' };
export function graphFixture() {
  const builder = new GraphBuilder('fixture', commit);
  const node = (key: string): GraphNode => builder.addNode({ id: nodeId('fixture', 'file', key), type: 'file', key,
    classification: 'source', metadata: { path: key }, provenance: [p] });
  const [a, b, c, d, isolated] = ['a', 'b', 'c', 'd', 'isolated'].map(node) as [GraphNode, GraphNode, GraphNode, GraphNode, GraphNode];
  const edge = (from: GraphNode, to: GraphNode, type = 'applies_to') => builder.addEdge({
    id: edgeId(type, from.id, to.id), from: from.id, to: to.id, type, qualifier: '',
    metadata: {}, classification: 'derived', provenance: [p]
  });
  edge(a,b); edge(a,c); edge(b,d); edge(c,d); edge(d,a); edge(a,isolated,'contains');
  return { builder, a, b, c, d, isolated, node, edge, document: builder.document(policy) };
}
export function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'repograph-test-'));
  const git = (args: string[], input?: string) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', ...(input !== undefined ? { input } : {}) }).trim();
  const write = (path: string, text: string) => writeFileSync(join(root, path), text);
  git(['init', '-q']); git(['config','core.autocrlf','false']); git(['config','user.name','Fixture']); git(['config','user.email','fixture@example.invalid']);
  write('base.txt', 'base\n'); git(['add','.']); git(['commit','-qm','base']); const base = git(['rev-parse','HEAD']);
  mkdirSync(join(root,'src')); mkdirSync(join(root,'.github')); mkdirSync(join(root,'docs'));
  write('src/a.ts', 'export const a = 1;\n'); write('src/space ü.ts', 'unicode\n'); write('src/.hidden', 'hidden');
  write('.github/CODEOWNERS', '* @default\n/src/ @dev @team/dev\nsrc/a.ts @special\n*.md\n!bad @ignored\n[bad] @ignored\n');
  write('CODEOWNERS','* @wrong\n'); write('docs/CODEOWNERS','* @also-wrong\n'); write('docs/a.md', 'docs');
  write('blob.bin', '\u0000\u0001');
  git(['add','.']);
  const symlinkBlob = git(['hash-object','-w','--stdin'], '/outside/not-followed\n');
  git(['update-index','--add','--cacheinfo',`120000,${symlinkBlob},link`]);
  git(['update-index','--add','--cacheinfo',`160000,${base},submodule`]);
  git(['commit','-qm','tree']); const first = git(['rev-parse','HEAD']);
  git(['mv','src/a.ts','src/renamed.ts']); git(['commit','-qm','rename']); const second = git(['rev-parse','HEAD']);
  return { root, git, write, first, second, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
