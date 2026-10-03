import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli-run.js';
import { VERSION, affected, loadGraph, serializeGraph } from '../src/index.js';
import { graphFixture, repositoryFixture } from './fixture.js';

async function run(args: string[]) {
  let stdout = ''; let stderr = '';
  const code = await runCli(args,{stdout:text=>{stdout+=text;},stderr:text=>{stderr+=text;}});
  return {code,stdout,stderr};
}
describe('CLI shares library behavior', () => {
  let fixture: ReturnType<typeof repositoryFixture>; let graphPath: string;
  beforeAll(()=>{ fixture=repositoryFixture(); graphPath=join(fixture.root,'graph.json'); writeFileSync(graphPath,serializeGraph(graphFixture().document)); });
  afterAll(()=>fixture.dispose());
  it('versions, help, and executable entry point', async () => {
    expect((await run(['--version'])).stdout.trim()).toBe(VERSION);
    expect((await run(['--help'])).stdout).toContain('repograph build');
    const old = process.argv; const oldExit = process.exitCode;
    const output = vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    try { process.argv=['node','cli','--version']; await import('../src/cli.js'); expect(output).toHaveBeenCalledWith(`${VERSION}\n`); }
    finally { process.argv=old; process.exitCode=oldExit; output.mockRestore(); }
  });
  it('queries default and explicit filters, explanation directions and absence', async () => {
    const loaded=loadGraph(graphFixture().document);
    const result=await run(['affected','--graph',graphPath,'--seed','d','--seed','d']);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(affected(loaded,['d','d']));
    expect(JSON.parse((await run(['affected','--graph',graphPath,'--seed','isolated','--edge-type','contains'])).stdout).nodes).toHaveLength(2);
    expect(JSON.parse((await run(['neighbors','--graph',graphPath,'--node','a','--edge-type','contains'])).stdout)).toHaveLength(1);
    expect(JSON.parse((await run(['reverse-neighbors','--graph',graphPath,'--node','b'])).stdout)).toHaveLength(1);
    expect(JSON.parse((await run(['explain','--graph',graphPath,'--from','a','--to','d'])).stdout).found).toBe(true);
    expect(JSON.parse((await run(['explain','--graph',graphPath,'--from','d','--to','a','--direction','reverse','--edge-type','applies_to'])).stdout).nodes).toHaveLength(3);
    expect(JSON.parse((await run(['explain','--graph',graphPath,'--from','isolated','--to','d'])).stdout).found).toBe(false);
  });
  it('builds pinned graphs with rules, filters and codeowners switches', async () => {
    const rulesPath=join(fixture.root,'rules.json'); writeFileSync(rulesPath,JSON.stringify({schemaVersion:1,rules:[{id:'ts',pattern:'**/*.ts'}]}));
    const result=await run(['build','--repo',fixture.root,'--repo-id','fixture','--ref',fixture.first,'--rules',rulesPath,
      '--include','src/**','--exclude','**/.hidden','--no-codeowners']);
    expect(result.code).toBe(0);
    const graph=loadGraph(result.stdout); expect(graph.document.nodes.filter(n=>n.type==='rule')).toHaveLength(1);
    expect(graph.document.policy.codeowners).toBe(false);
    expect((await run(['build','--repo',fixture.root,'--repo-id','fixture','--ref',fixture.first])).code).toBe(0);
  });
  it('returns only structured stderr and failure status for invalid input', async () => {
    const broken=join(fixture.root,'broken.json'); writeFileSync(broken,'broken');
    const unknown=join(fixture.root,'unknown.json'); writeFileSync(unknown,'{"schemaVersion":2,"rules":[]}');
    const build=['build','--repo',fixture.root,'--repo-id','fixture','--ref',fixture.first];
    for (const args of [[],['wat'],['build','--unknown'],['build','positional'],['build','--repo'],['build'],
      ['neighbors','--graph',graphPath],['neighbors','--graph',graphPath,'--node','absent'],
      ['neighbors','--graph','missing','--node','a'],['neighbors','--graph',broken,'--node','a'],
      ['affected','--graph',graphPath],['explain','--graph',graphPath,'--direction','bad'],
      [...build,'--rules',broken],[...build,'--rules',unknown],[...build,'--rules','missing']]) {
      const result=await run(args); expect(result.code,args.join(' ')).toBe(1); expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({code:expect.any(String),message:expect.any(String),details:expect.any(Object)});
    }
    const messages:string[]=[];
    expect(await runCli(['--version'],{stdout:()=>{throw new Error('unexpected');},stderr:s=>messages.push(s)})).toBe(1);
    expect(JSON.parse(messages[0]!).code).toBe('INTERNAL_ERROR');
  });
});
