# TypeScript / JavaScript dependency extractor (0.0.2)

RepoGraph's first language-aware extractor is intentionally a deterministic **module dependency source**, not a whole-program compiler or call-graph engine.

## What it extracts

For tracked `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files it records:

- static imports;
- re-exports;
- dynamic `import()`;
- CommonJS `require()`;
- exported top-level names;
- TS project membership and project references;
- external package specifiers.

Internal dependency edges are file-to-file `imports` / `re-exports` edges. This keeps reverse impact traversal precise: changing one dependency reaches only files that actually depend on it and their transitive dependants.

## Resolution

The resolver supports:

- relative imports;
- extensionless files and `index.*`;
- common JS-to-TS substitutions such as `./x.js -> ./x.ts`;
- nearest `tsconfig.json` `baseUrl`;
- single-wildcard `compilerOptions.paths` aliases;
- TS project references where the referenced config exists in the pinned tree.

Bare package imports become explicit `external-module` nodes. A relative/path-alias import that cannot be resolved produces an `unresolved` diagnostic and **no invented edge**.

## Incremental cache boundary

Parsing is cached per exact Git blob SHA with the TypeScript parser version and extractor/schema identity.

The cached artifact contains syntax-level specifiers and exports, not resolved repository paths. Resolution is intentionally redone against each snapshot because a rename, `tsconfig` change or alias change can alter resolution while source bytes remain identical.

This means:

- unchanged source blobs avoid reparsing across commits and process restarts;
- rename-only files reuse parser work;
- changed files get new syntax artifacts;
- resolver work stays cheap and snapshot-correct.

## Limits

0.0.2 does not attempt a whole-program call graph, type-driven overload resolution, or compiler-grade symbol/reference indexing. Consumers that later require that precision should use the external extractor/evidence boundary planned for #17 rather than expanding this extractor into a custom compiler frontend.
