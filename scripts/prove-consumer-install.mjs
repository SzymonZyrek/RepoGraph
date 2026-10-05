import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "repograph-ladybug-consumer-"));
try {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, dependencies: { "@ladybugdb/core": "0.21.2" } }));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run through npm run consumer:install so the npm CLI path is explicit");
  execFileSync(process.execPath, [npm, "install", "--no-audit", "--no-fund"], { cwd: directory, stdio: "inherit" });
  // The native module stays loaded until process exit on Windows. Isolate the
  // consumer so cleanup happens after its binary is unloaded.
  writeFileSync(join(directory, "probe.mjs"), `import assert from 'node:assert/strict';
import { Database, Connection } from '@ladybugdb/core';
const db = new Database('consumer.lbdb', 67108864);
const connection = new Connection(db, 2);
try { const result = await connection.query('RETURN 1 AS installed');
  assert.equal((await result.getAll())[0].installed, 1); result.close();
} finally { await connection.close(); await db.close(); }`);
  execFileSync(process.execPath, [join(directory, "probe.mjs")], { cwd: directory, stdio: "inherit" });
  console.log("Clean external Node consumer: packaged Ladybug native binary and disk-backed DB passed");
} finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
