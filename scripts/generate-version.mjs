import { readFileSync, writeFileSync } from "node:fs";

const version = readFileSync(new URL("../VERSION.txt", import.meta.url), "utf8").trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`VERSION.txt is not a semantic version: ${version}`);
}

writeFileSync(
  new URL("../src/generated-version.ts", import.meta.url),
  `// Generated from VERSION.txt. Do not edit.\nexport const VERSION = ${JSON.stringify(version)} as const;\n`,
);
