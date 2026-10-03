import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'repograph-smoke-'));
// Invoke npm's JavaScript CLI rather than Windows .cmd shell shims.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run via npm run smoke');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = args => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' }).trim();
try {
  const pack = JSON.parse(npm(['pack', '--json'], root));
  const tarball = resolve(root, pack[0].filename);
  writeFileSync(join(work, 'package.json'), '{"private":true,"type":"module"}');
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], work);
  git(['init', '-q']); git(['config', 'core.autocrlf', 'false']); git(['config', 'user.name', 'Smoke']); git(['config', 'user.email', 'smoke@example.invalid']);
  writeFileSync(join(work, 'README.md'), '# Smoke\n');
  writeFileSync(join(work, 'CODEOWNERS'), '*.md @docs\n');
  git(['add', 'README.md', 'CODEOWNERS']); git(['commit', '-qm', 'fixture']);
  const cli = join(work, 'node_modules', '@szymonzyrek', 'repograph', 'dist', 'cli.js');
  const run = args => execFileSync(process.execPath, [cli, ...args], { cwd: work, encoding: 'utf8' });
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.equal(run(['--version']).trim(), version);
  assert.equal(npm(['exec', '--offline', '--', 'repograph', '--version'], work).trim(), version);
  const graph = run(['build', '--repo', work, '--repo-id', 'smoke', '--ref', 'HEAD']);
  writeFileSync(join(work, 'graph.json'), graph);
  assert.equal(graph, run(['build', '--repo', work, '--repo-id', 'smoke', '--ref', git(['rev-parse', 'HEAD'])]));
  const affected = run(['affected', '--graph', 'graph.json', '--seed', 'README.md']);
  assert.equal(JSON.parse(affected).nodes.length, 2);
  writeFileSync(join(work, 'verify.mjs'), `import { loadGraph, affected, buildGraph, serializeGraph } from '@szymonzyrek/repograph';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const graph = readFileSync('graph.json', 'utf8');
assert.deepEqual(affected(loadGraph(graph), ['README.md']), JSON.parse(readFileSync('affected.json', 'utf8')));
assert.equal(serializeGraph(await buildGraph({repoPath: '.', repoId: 'smoke', ref: 'HEAD'})) + '\\n', graph);
`);
  writeFileSync(join(work, 'affected.json'), affected);
  execFileSync(process.execPath, ['verify.mjs'], { cwd: work, stdio: 'pipe' });
  run(['neighbors', '--graph', 'graph.json', '--node', 'README.md']);
  run(['reverse-neighbors', '--graph', 'graph.json', '--node', 'README.md']);
  const rule = JSON.parse(graph).nodes.find(n => n.type === 'rule');
  assert.equal(JSON.parse(run(['explain', '--graph', 'graph.json', '--from', rule.id, '--to', 'README.md'])).found, true);
  console.log(`Installed library/CLI smoke passed: ${pack[0].filename}`);
} finally { rmSync(work, { recursive: true, force: true }); }
