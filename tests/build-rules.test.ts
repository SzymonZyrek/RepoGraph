import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGraph, serializeGraph, parseRules, affected, loadGraph } from '../src/index.js';
import { parseCodeowners, glob } from '../src/rules.js';
import { parseTree, git } from '../src/git.js';
import { repositoryFixture } from './fixture.js';

describe('pinned Git ingestion', () => {
  let fixture: ReturnType<typeof repositoryFixture>;
  beforeAll(()=>{ fixture = repositoryFixture(); }); afterAll(()=>fixture.dispose());
  const options = () => ({ repoPath:fixture.root,repoId:'fixture',ref:fixture.first });
  it('preserves exact source identity, symlinks, gitlinks and CODEOWNERS precedence', async () => {
    const graph = await buildGraph(options());
    const file = graph.nodes.find(n=>n.key==='src/a.ts')!;
    const symlink = graph.nodes.find(n=>n.key==='link')!; const gitlink = graph.nodes.find(n=>n.key==='submodule')!;
    expect(symlink.metadata.mode).toBe('120000'); expect(gitlink.type).toBe('gitlink'); expect(gitlink.metadata.targetCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(file.provenance[0]!.blobOid).toBe(file.metadata.blobOid);
    expect(graph.nodes.find(n=>n.key==='blob.bin')).toBeDefined();
    expect(graph.nodes.find(n=>n.key==='src/space ü.ts')).toBeDefined();
    expect(graph.nodes.find(n=>n.key==='src/.hidden')).toBeDefined();
    const matching = affected(loadGraph(graph),['src/a.ts']).nodes.find(n=>n.type==='rule')!;
    expect(matching.metadata.owners).toEqual(['@special']);
    expect(affected(loadGraph(graph),['src/space ü.ts']).nodes.find(n=>n.type==='rule')!.metadata.owners).toEqual(['@dev','@team/dev']);
    expect(affected(loadGraph(graph),['docs/a.md']).nodes.find(n=>n.type==='rule')!.metadata.owners).toEqual([]);
    expect(graph.diagnostics).toHaveLength(2);
    expect(graph.nodes.filter(n=>n.type==='rule').every(n=>n.provenance[0]!.source==='.github/CODEOWNERS')).toBe(true);
  });
  it('ignores checkout dirt and ref spelling, while rename preserves blob identity', async () => {
    const first = await buildGraph(options());
    fixture.write('src/renamed.ts','dirty\n'); fixture.write('.github/CODEOWNERS','* @dirty\n');
    const repeated = await buildGraph(options()); expect(serializeGraph(repeated)).toBe(serializeGraph(first));
    const second = await buildGraph({...options(),ref:fixture.second});
    const old = first.nodes.find(n=>n.key==='src/a.ts')!; const renamed = second.nodes.find(n=>n.key==='src/renamed.ts')!;
    expect(old.id).not.toBe(renamed.id); expect(old.metadata.blobOid).toBe(renamed.metadata.blobOid);
    expect(second.nodes.find(n=>n.key==='src/a.ts')).toBeUndefined();
    expect(serializeGraph(await buildGraph({...options(),ref:'HEAD'}))).toBe(serializeGraph(second));
  });
  it('filters before relationships, retains ancestors and applies independent JSON rules', async () => {
    const rules = parseRules({schemaVersion:1,rules:[{id:'all',pattern:'src/**',metadata:{label:'all'}},{id:'ts',pattern:'**/*.ts'}]});
    const graph = await buildGraph({...options(), include:['src/**'],exclude:['**/a.ts'],rules});
    expect(graph.nodes.find(n=>n.key==='src/a.ts')).toBeUndefined(); expect(graph.nodes.find(n=>n.key==='src')).toBeDefined();
    expect(graph.nodes.find(n=>n.key==='src/.hidden')).toBeDefined();
    expect(graph.policy.omittedEntries).toBeGreaterThan(0);
    expect(affected(loadGraph(graph),['src/space ü.ts']).nodes.filter(n=>n.type==='rule')).toHaveLength(3);
    const empty = await buildGraph({...options(),include:['absent/**'],codeowners:false});
    expect(empty.nodes).toHaveLength(1); expect(empty.edges).toEqual([]);
  });
  it('falls back to root/docs CODEOWNERS, respects disabling, and rejects bad input', async () => {
    fixture.git(['rm','-f','.github/CODEOWNERS']); fixture.git(['commit','-qm','root codeowners']);
    const rootGraph = await buildGraph({...options(),ref:'HEAD'});
    expect(rootGraph.nodes.find(n=>n.type==='rule')!.provenance[0]!.source).toBe('CODEOWNERS');
    fixture.git(['rm','CODEOWNERS']); fixture.git(['commit','-qm','docs codeowners']);
    expect((await buildGraph({...options(),ref:'HEAD'})).nodes.find(n=>n.type==='rule')!.provenance[0]!.source).toBe('docs/CODEOWNERS');
    fixture.git(['rm','docs/CODEOWNERS']); fixture.git(['commit','-qm','none']);
    expect((await buildGraph({...options(),ref:'HEAD'})).nodes.some(n=>n.type==='rule')).toBe(false);
    expect((await buildGraph({...options(),codeowners:false})).nodes.some(n=>n.type==='rule')).toBe(false);
    await expect(buildGraph({...options(),ref:'missing-ref'})).rejects.toThrow('Git could not read');
    await expect(buildGraph({...options(),ref:''})).rejects.toThrow('required');
    await expect(buildGraph({...options(),exclude:['!bad']})).rejects.toThrow('repository-relative');
    await expect(buildGraph({...options(),rules:{schemaVersion:1,rules:[{id:'x',pattern:'!bad'}]}})).rejects.toThrow('repository-relative');
  });
});
describe('rule parsing and Git diagnostics', () => {
  it('validates JSON rules and glob syntax without policy magic', () => {
    for (const input of [{schemaVersion:2,rules:[]},{schemaVersion:1,rules:[{id:'x',pattern:'a'},{id:'x',pattern:'b'}]}]) expect(()=>parseRules(input)).toThrow();
    for (const pattern of ['', '!bad', '/root', '../bad', 'a\\b', '[bad']) expect(()=>glob(pattern)).toThrow();
    expect(glob('**/*')('.github/a')).toBe(true); expect(glob('*.ts')('A.TS')).toBe(false);
    expect(glob('src/**')('src/a.ts')).toBe(true);
  });
  it('handles CODEOWNERS anchoring, wildcards, directory matches and invalid patterns', () => {
    const parsed = parseCodeowners('# comment\n\n/*.js @root\n*.ts @any # inline\ndocs/ @docs\na/**/b?.md @nested\nspace\\ name @space\n!bad\n[x]\na\\b\n***\n/\na//b\na**b\n', 'CODEOWNERS');
    expect(parsed.diagnostics).toHaveLength(7);
    const [root,any,docs,nested,space] = parsed.rules;
    expect(root!.matches('a.js')).toBe(true); expect(root!.matches('src/a.js')).toBe(false);
    expect(any!.matches('src/a.ts')).toBe(true); expect(any!.matches('src/A.TS')).toBe(false);
    expect(docs!.matches('x/docs/a.md')).toBe(true); expect(docs!.matches('docs')).toBe(false);
    expect(nested!.matches('a/b1.md')).toBe(true); expect(nested!.matches('a/x/y/b2.md')).toBe(true);
    expect(space!.matches('space name')).toBe(true);
    expect(parseCodeowners('a\0b @x','CODEOWNERS').diagnostics).toHaveLength(1);
    expect(parseCodeowners('x'.repeat(3*1024*1024),'CODEOWNERS').diagnostics[0]!.code).toBe('CODEOWNERS_TOO_LARGE');
    expect(parseCodeowners('abc/** @x','CODEOWNERS').rules[0]!.matches('abc/deep/file')).toBe(true);
    const examples = parseCodeowners('docs/* @direct\n/docs/ @recursive\n/apps/github\n**/logs @logs\n', 'CODEOWNERS').rules;
    expect(examples[0]!.matches('docs/getting-started.md')).toBe(true);
    expect(examples[0]!.matches('docs/build-app/troubleshooting.md')).toBe(false);
    expect(examples[1]!.matches('docs/build-app/troubleshooting.md')).toBe(true);
    expect(examples[1]!.matches('nested/docs/a.md')).toBe(false);
    expect(examples[2]!.matches('apps/github/a.ts')).toBe(true);
    expect(examples[3]!.matches('deeply/nested/logs/a.log')).toBe(true);
  });
  it('parses NUL tree records and rejects malformed/non-UTF8 paths', async () => {
    expect(parseTree(Buffer.from(`100644 blob ${'a'.repeat(40)}\ta\tb\n\0`))[0]!.path).toBe('a\tb\n');
    expect(()=>parseTree(Buffer.from([0xff]))).toThrow('UTF-8');
    expect(()=>parseTree(Buffer.from('bad\0'))).toThrow('Malformed');
    await expect(git('/nonexistent-repograph-repo',['status'])).rejects.toThrow('Git could not read');
    vi.stubEnv('PATH','');
    try { await expect(git('.',['status'])).rejects.toThrow('Cannot start Git'); }
    finally { vi.unstubAllEnvs(); }
  });
});
