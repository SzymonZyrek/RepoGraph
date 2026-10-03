# TypeScript / JavaScript dependency extraction (0.0.2)

RepoGraph's first language-aware extractor is deliberately module-level. It provides useful deterministic dependency evidence without trying to become a compiler-grade code-intelligence platform.

## Facts emitted

For included `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files, the extractor adds:

- `imports` edges for static imports, import-equals, dynamic imports and `require("...")`;
- `reexports` edges for `export ... from "..."`;
- exported `symbol` nodes and `exports` edges for named/default exports;
- exact provenance back to the pinned repository/ref/commit/path and extractor version.

The existing Git file node is the module identity. That keeps file changes and dependency traversal on the same stable node instead of inventing a second parallel module graph.

## Resolution

The extractor resolves repository-local relative imports and root `tsconfig.json` `baseUrl` / `paths` aliases. Common TypeScript source substitutions such as a `./foo.js` specifier resolving to `foo.ts` are supported.

A missing repository-local import becomes an `unresolved` diagnostic and creates no edge. Bare package imports that do not resolve through a configured alias are recorded as partial external evidence and also create no fake internal edge.

This is intentionally conservative: **prefer no edge to an invented edge**.

## Incremental parsing

Syntax extraction is cached by Git blob identity plus extractor, TypeScript parser and syntax-schema versions. Across commits:

- unchanged blobs reuse their syntax artifact without reparsing;
- changed blobs are reparsed;
- import resolution is recalculated against the current snapshot, because aliases and repository layout can change even when an importer blob does not.

That split preserves reuse without making stale resolution authoritative.

## Non-goals

0.0.2 does not attempt a universal call graph, full type-flow analysis, package-manager graph, or replacement for TypeScript/LSIF/SCIP-class indexing. Higher-fidelity external evidence belongs behind the versioned extractor/evidence boundary tracked in #17.
