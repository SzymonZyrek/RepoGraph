import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { RepoGraphError } from './error.js';
import { VERSION } from './version.js';
import { buildGraph } from './build.js';
import { loadGraph, serializeGraph, canonicalJSON } from './model.js';
import { parseRules } from './rules.js';
import { neighbors, reverseNeighbors, affected, explainPath } from './query.js';

export interface CliIO { stdout: (text: string) => void; stderr: (text: string) => void }
const usage = 'repograph build --repo PATH --repo-id ID --ref REF [--include GLOB] [--exclude GLOB] [--rules JSON] [--no-codeowners]\n' +
  'repograph neighbors|reverse-neighbors --graph JSON --node ID_OR_PATH [--edge-type TYPE]\n' +
  'repograph affected --graph JSON --seed ID_OR_PATH [--seed ...] [--edge-type TYPE]\n' +
  'repograph explain --graph JSON --from ID_OR_PATH --to ID_OR_PATH [--direction forward|reverse] [--edge-type TYPE]\n' +
  'repograph --version | --help';
async function input(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch { throw new RepoGraphError('INPUT_READ_FAILED', 'Cannot read input file'); }
}
export async function runCli(args: string[], io: CliIO): Promise<number> {
  try {
    if (args.length === 1 && args[0] === '--version') { io.stdout(`${VERSION}\n`); return 0; }
    if (args.length === 1 && args[0] === '--help') { io.stdout(`${usage}\n`); return 0; }
    const command = args[0];
    const allowed: Record<string, string[]> = {
      build: ['repo', 'repo-id', 'ref', 'include', 'exclude', 'rules', 'no-codeowners'],
      neighbors: ['graph', 'node', 'edge-type'], 'reverse-neighbors': ['graph', 'node', 'edge-type'],
      affected: ['graph', 'seed', 'edge-type'], explain: ['graph', 'from', 'to', 'direction', 'edge-type']
    };
    if (!command || !allowed[command]) throw new RepoGraphError('INVALID_ARGUMENTS', 'Unknown or missing command', { usage });
    const options = Object.fromEntries(allowed[command].map(name => [name, name === 'no-codeowners'
      ? { type: 'boolean' as const } : { type: 'string' as const, multiple: ['include', 'exclude', 'seed', 'edge-type'].includes(name) }]));
    let values;
    try { const parsed = parseArgs({ args: args.slice(1), options, strict: true, allowPositionals: false }); values = parsed.values; }
    catch { throw new RepoGraphError('INVALID_ARGUMENTS', 'Unknown option, positional argument, or missing option value', { usage }); }
    const required = (name: string): string => {
      const value = values[name];
      if (typeof value !== 'string' || !value) throw new RepoGraphError('INVALID_ARGUMENTS', `--${name} is required`);
      return value;
    };
    const list = (name: string): string[] | undefined => {
      const value = values[name]; return Array.isArray(value) ? value as string[] : undefined;
    };
    if (command === 'build') {
      let rules;
      if (values.rules) {
        const text = await input(required('rules'));
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new RepoGraphError('INVALID_RULES', 'Rules file is not valid JSON'); }
        rules = parseRules(parsed);
      }
      const graph = await buildGraph({ repoPath: required('repo'), repoId: required('repo-id'), ref: required('ref'),
        ...(list('include') ? { include: list('include')! } : {}), ...(list('exclude') ? { exclude: list('exclude')! } : {}),
        ...(rules ? { rules } : {}), codeowners: values['no-codeowners'] !== true });
      io.stdout(`${serializeGraph(graph)}\n`); return 0;
    }
    const graph = loadGraph(await input(required('graph')));
    const filters = list('edge-type'); const queryOptions = filters ? { edgeTypes: filters } : {};
    let result;
    if (command === 'neighbors') result = neighbors(graph, required('node'), queryOptions);
    else if (command === 'reverse-neighbors') result = reverseNeighbors(graph, required('node'), queryOptions);
    else if (command === 'affected') {
      const seeds = list('seed');
      if (!seeds?.length) throw new RepoGraphError('INVALID_ARGUMENTS', '--seed is required');
      result = affected(graph, seeds, queryOptions);
    } else {
      const direction = values.direction ?? 'forward';
      if (direction !== 'forward' && direction !== 'reverse') throw new RepoGraphError('INVALID_ARGUMENTS', '--direction must be forward or reverse');
      result = explainPath(graph, required('from'), required('to'), { ...queryOptions, direction });
    }
    io.stdout(`${canonicalJSON(result)}\n`); return 0;
  } catch (error) {
    const diagnostic = error instanceof RepoGraphError ? error : new RepoGraphError('INTERNAL_ERROR', 'Unexpected RepoGraph failure');
    io.stderr(`${canonicalJSON(diagnostic.toJSON())}\n`); return 1;
  }
}
