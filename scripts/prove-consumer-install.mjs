import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "repograph-ladybug-consumer-"));
try {
  const artifact = JSON.parse(readFileSync(".cache/package/artifact.json", "utf8"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@repograph/core": `file:${resolve(".cache/package", artifact.filename)}` } }));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run through npm run package:proof");
  execFileSync(process.execPath, [npm, "install", "--no-audit", "--no-fund"], { cwd: directory, stdio: "inherit" });
  // The native module stays loaded until process exit on Windows. Isolate the
  // consumer so cleanup happens after its binary is unloaded.
  writeFileSync(join(directory, "probe.mjs"), `import assert from 'node:assert/strict';
import { VERSION, affected, explain } from '@repograph/core';
import { createGraphViewModel } from '@repograph/core/view';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const git = (...args) => execFileSync('git', args, {cwd:'repo',encoding:'utf8'}).trim();
mkdirSync('repo'); git('init','-q'); git('config','user.email','proof@example.org'); git('config','user.name','Proof');
writeFileSync('repo/source.py','value = 1\\n'); writeFileSync('repo/test_source.md','[source](source.py)');
git('add','.'); git('commit','-qm','fixture'); const ref = git('rev-parse','HEAD');
assert.equal(VERSION, ${JSON.stringify(artifact.version)});
const options = {repositoryPath:'repo',repository:'external/proof',ref};
const answer = await affected(options,['source.py']);
assert.ok(answer.nodes.some(node => node.id === 'artifact:test_source.md'));
assert.deepEqual(await affected(options,['source.py']),answer);
assert.equal(answer.commit,ref); assert.equal(answer.partial,true);
const why = await explain(options,'artifact:source.py','artifact:test_source.md');
assert.equal(why.edges.length,1); assert.equal(createGraphViewModel(why).nodes.length,2);
const cli = 'node_modules/@repograph/core/dist/src/cli.js';
assert.equal(execFileSync(process.execPath,[cli,'version'],{encoding:'utf8'}).trim(),VERSION);
assert.deepEqual(JSON.parse(execFileSync(process.execPath,[cli,'affected','--repo','repo','--repository','external/proof','--ref',ref,'--changed','source.py'],{encoding:'utf8'})),answer);
assert.throws(() => execFileSync(process.execPath,[cli,'build-intelligence'],{stdio:'pipe'}));`);
  writeFileSync(join(directory, "consumer.ts"), `import { affected, type CausalAnswer } from '@repograph/core';\nimport { createGraphViewModel } from '@repograph/core/view';\nconst result: Promise<CausalAnswer> = affected({repositoryPath: '.', ref: 'HEAD'}, ['a.py']);\nresult.then(createGraphViewModel);`);
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.ts"], { cwd: directory, stdio: "inherit" });
  execFileSync(process.execPath, [join(directory, "probe.mjs")], { cwd: directory, stdio: "inherit" });
  console.log("Packed external consumer: TypeScript, library/view, CLI, native disk persistence and exact-ref bounded queries passed");
} finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
