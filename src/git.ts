import { spawn } from 'node:child_process';
import { RepoGraphError } from './error.js';

export function git(repoPath: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Ignore replace objects and ambient Git routing variables: the requested repository is authoritative.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['--no-replace-objects', '-C', repoPath, ...args], { env, windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.resume();
    child.on('error', () => reject(new RepoGraphError('GIT_UNAVAILABLE', 'Cannot start Git')));
    child.on('close', code => {
      if (code !== 0) reject(new RepoGraphError('GIT_FAILED', 'Git could not read the requested repository/ref', { operation: args[0], exitCode: code }));
      else resolve(Buffer.concat(chunks));
    });
  });
}
export interface TreeEntry { mode: string; kind: string; oid: string; path: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const text = data.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(data)) throw new RepoGraphError('UNSUPPORTED_PATH_ENCODING', 'Git paths must be valid UTF-8');
  return text.split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, kind, oid] = record.slice(0, tab).split(' ');
    if (tab < 0 || !mode || !kind || !oid) throw new RepoGraphError('INVALID_GIT_TREE', 'Malformed Git tree entry');
    return { mode, kind, oid, path: record.slice(tab + 1) };
  });
}
