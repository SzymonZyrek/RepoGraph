import { describe, it, expect } from 'vitest';
import { GraphBuilder, loadGraph, serializeGraph, canonicalJSON, nodeId, neighbors,
  reverseNeighbors, affected, explainPath, resolveNode, RepoGraphError, VERSION } from '../src/index.js';
import { graphFixture, commit, policy, p } from './fixture.js';

describe('contract', () => {
  it('converges reordered facts and provenance, and round trips canonically', () => {
    const { document } = graphFixture();
    const builder = new GraphBuilder('fixture',commit);
    for (const n of [...document.nodes].reverse()) { builder.addNode(n); builder.addNode({ ...n, provenance: [...n.provenance, p] }); }
    for (const e of [...document.edges].reverse()) { builder.addEdge(e); builder.addEdge(e); }
    const json = serializeGraph(document);
    expect(serializeGraph(builder.document(policy))).toBe(json);
    expect(serializeGraph(loadGraph(json).document)).toBe(json);
    expect(loadGraph(json).document.producerVersion).toBe(VERSION);
    expect(canonicalJSON({ z: { y: 1, a: [2,1] }, a: null })).toBe('{"a":null,"z":{"a":[2,1],"y":1}}');
    expect(nodeId('fixture','file','a')).toBe('n:a36faddc14a3995c9906d22bfcc351ccaf023718c5100ddd3e70a0c39a199e11');
    expect(()=>{ loadGraph(json).document.nodes[0]!.metadata.path='changed'; }).toThrow();
  });
  it('rejects conflicting nodes and edges and merges different source references', () => {
    const { builder, a, document } = graphFixture();
    builder.addNode({ ...a, provenance: [{ ...p, source: 'different' }] });
    expect(builder.document(policy).nodes.find(n=>n.id===a.id)!.provenance).toHaveLength(2);
    expect(()=>builder.addNode({...a,metadata:{different:true}})).toThrow('Conflicting fact');
    expect(()=>builder.addEdge({...document.edges[0]!,classification:'source'})).toThrow('Conflicting fact');
  });
  it('rejects malformed JSON, unknown schemas, invalid IDs, duplicates and endpoints', () => {
    const { document } = graphFixture();
    expect(()=>loadGraph('broken')).toThrow(RepoGraphError);
    expect(()=>loadGraph({...document,schemaVersion:2})).toThrow('unsupported schema');
    expect(()=>loadGraph({...document,nodes:[{...document.nodes[0]!,provenance:[]}]})).toThrow('Malformed');
    expect(()=>loadGraph({...document,nodes:[...document.nodes,document.nodes[0]!]})).toThrow('Duplicate node');
    expect(()=>loadGraph({...document,edges:[...document.edges,document.edges[0]!]})).toThrow('Duplicate edge');
    expect(()=>loadGraph({...document,nodes:[]})).toThrow('endpoint');
    expect(()=>loadGraph({...document,nodes:document.nodes.map((n,i)=>i===0?{...n,id:'bad'}:n)})).toThrow('identity mismatch');
    expect(()=>loadGraph({...document,edges:document.edges.map((e,i)=>i===0?{...e,id:'bad'}:e)})).toThrow('identity mismatch');
    expect(()=>loadGraph({...document,nodes:document.nodes.map((n,i)=>i===0?{...n,provenance:[{...p,commit:'b'.repeat(40)}]}:n)})).toThrow('different snapshot');
    expect(()=>canonicalJSON({ a: undefined })).toThrow('JSON-compatible');
    const error = new RepoGraphError('TEST','message');
    expect(error.toJSON()).toEqual({code:'TEST',message:'message',details:{}});
  });
  it('sorts policy sets without sorting meaningful rules', () => {
    const { builder } = graphFixture();
    const doc = builder.document({ ...policy, include: ['z','a','z'], exclude:['z','b','b'],
      rules: { schemaVersion:1,rules:[{id:'z',pattern:'z'},{id:'a',pattern:'a'}] } },
      [{code:'Z',message:'z'},{code:'A',message:'a'}]);
    expect(doc.policy.include).toEqual(['a','z']); expect(doc.policy.exclude).toEqual(['b','z']);
    expect(doc.policy.rules!.rules.map(r=>r.id)).toEqual(['z','a']); expect(doc.diagnostics[0]!.code).toBe('A');
  });
});
describe('queries', () => {
  it('resolves IDs and paths and filters both directions', () => {
    const { document, a, b, d } = graphFixture(); const graph = loadGraph(document);
    expect(resolveNode(graph,a.id)).toEqual(a);
    expect(neighbors(graph,'a')).toHaveLength(3);
    expect(neighbors(graph,'a',{edgeTypes:['applies_to']})).toHaveLength(2);
    expect(reverseNeighbors(graph,'b')[0]!.node.id).toBe(a.id);
    expect(reverseNeighbors(graph,'a')[0]!.node.id).toBe(d.id);
    expect(neighbors(graph,b.id,{edgeTypes:[]})).toEqual([]);
    expect(()=>neighbors(graph,'absent')).toThrow('not present');
  });
  it('closes cycles, deduplicates seeds, and omits structural edges by default', () => {
    const { document, a, isolated } = graphFixture(); const graph = loadGraph(document);
    const closure = affected(graph,['d','d']);
    expect(closure.seeds).toHaveLength(1); expect(closure.nodes).toHaveLength(4); expect(closure.edges).toHaveLength(5);
    expect(affected(graph,[isolated.id]).nodes).toHaveLength(1);
    expect(affected(graph,[isolated.id],{edgeTypes:['contains']}).nodes.map(n=>n.id)).toContain(a.id);
    expect(affected(graph,['d'],{edgeTypes:[]}).nodes).toHaveLength(1);
    expect(()=>affected(graph,[])).toThrow('At least one');
  });
  it('explains shortest causal paths with deterministic ties and full provenance', () => {
    const { document, a, b, c, d } = graphFixture(); const graph = loadGraph(document);
    const result = explainPath(graph,'a','d',{edgeTypes:['applies_to']});
    expect(result.found).toBe(true); expect(result.nodes.map(n=>n.id)).toEqual([a.id,[b.id,c.id].sort()[0],d.id]);
    expect(result.edges.every(e=>e.provenance[0]!.commit===commit)).toBe(true);
    expect(explainPath(graph,'d','a',{direction:'reverse'}).nodes).toHaveLength(3);
    expect(explainPath(graph,'a','a').nodes).toEqual([a]);
    expect(explainPath(graph,'isolated','d')).toEqual({found:false,nodes:[],edges:[]});
    expect(explainPath(graph,'a','d',{edgeTypes:[]})).toEqual({found:false,nodes:[],edges:[]});
    expect(()=>explainPath(graph,'a','absent')).toThrow('not present');
    expect(()=>explainPath(graph,'a','d',{direction:'bad' as 'forward'})).toThrow('direction');
  });
});
