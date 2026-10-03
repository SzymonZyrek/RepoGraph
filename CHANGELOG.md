# Changelog

## 0.0.2 — 2026-10-03

Pre-public incremental dependency-engine milestone.

- Content-addressed derived artifacts and configuration-scoped snapshot manifests with restart-safe reuse (#9, #31).
- Git diff/update planning for add/modify/delete/rename, merge-base selection, narrow reverse invalidation and reuse/touched metrics (#10).
- Deterministic TypeScript/JavaScript dependency extraction with provenance, path-alias resolution, unresolved diagnostics and blob-level syntax reuse (#11).
- TypeScript parser pinned as a runtime dependency so extractor/cache identity is reproducible in consumer installs (#38).
- High-velocity economics harness and recorded evidence: normal one-file commits reparse one of 240 source files and measured at about 8% of cold rebuild wall time in the reference CI run; rename-only reparses nothing (#12, #39).
- The same eval deliberately records the broad-change crossover: a 240-path mechanical edit was slower incrementally than a clean rebuild, so that case remains visible rather than being presented as an optimization win.

Compatibility notes:

- Exported graph schema remains `repograph.graph/v1`.
- 0.0.x APIs remain experimental and may change before 1.0.0.
- Cache/store state is derived and disposable. If a future pre-1.0 store contract changes incompatibly, deleting the cache and rebuilding is valid; no authoritative user data is stored there.
- This is an internal engineering milestone, not the public RepoGraph launch. The first public release target remains **1.0.0**.

## 0.0.1 — 2026-10-03

First deterministic kernel release.

- Typed graph nodes/edges with stable identities and provenance (#6).
- Pinned Git tree ingestion, content identities, path filtering and CODEOWNERS-like rules (#7).
- Deterministic traversal/query API, CLI, CI and coverage baseline (#8).
- Exported graph schema remains `repograph.graph/v1`.

There are no migration notes because this is the first implementation release.
