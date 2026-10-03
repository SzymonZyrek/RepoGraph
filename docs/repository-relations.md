# Repository relationship extractor

`extractRepositoryRelationships` adds generic repository facts that are useful for validation, impact and context selection without turning RepoGraph into a package manager or test framework.

The extractor is deliberately conservative. It emits an edge only when the relationship is explicit in repository data or follows a narrow, unambiguous filename convention.

## Facts

### Package manifests

Every checked-in `package.json` becomes a generic `package` node linked from its manifest with `declares-package`.

Local package dependencies are emitted as `package-dependency` only when the target is unambiguous and the dependency is explicitly local:

- `workspace:` specifiers resolve by package name;
- `file:` and `link:` specifiers resolve by repository-relative package directory.

Ordinary semver dependencies are not guessed to be local merely because a package with the same name exists in the repository.

### Build artifacts and contracts

Checked-in package entrypoints are linked from the package node:

- `main`, `module`, `bin` and non-types `exports` leaves become `package-build-entrypoint`;
- `types`, `typings` and `exports` leaves under a `types` condition become `package-contract`.

If an explicit target is not present at the pinned revision, RepoGraph emits a partial diagnostic instead of inventing a file edge. This is common for generated `dist/` output that is intentionally not committed.

### Tests

A `tests` edge is emitted only when a test filename maps to exactly one checked-in source file under one of these conventions:

- same directory: `thing.test.ts -> thing.ts` or `thing.spec.ts -> thing.ts`;
- `__tests__` sibling directory: `src/__tests__/thing.test.ts -> src/thing.ts`.

RepoGraph does not automatically map a broad `test/` tree to `src/`. Consumers can still use language-level import edges or explicit overlays for repository-specific conventions.

## Provenance and failure behavior

All emitted relationship facts use deterministic-extraction provenance pinned to repository/ref/commit and the manifest or test path that justified the edge.

Invalid package manifests, unresolved explicit workspace dependencies, ambiguous workspace package names and missing explicit entrypoints are diagnostics. Missing heuristic test matches are simply omitted.

This preserves the core rule: prefer no edge over a speculative edge.
