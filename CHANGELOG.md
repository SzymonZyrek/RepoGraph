# Changelog

## 0.0.3 — 2026-10-03

Pre-public repository-intelligence semantics milestone.

- Generic overlays can add consumer-owned nodes/edges while preserving explicit `authoritative` vs `advisory` provenance and overlay version identity (#13, #41).
- Evidence-aware traversal policies bound graph slices by direction, edge/node kinds, provenance method/state/authority and traversal budgets; causal explanations preserve matched provenance per hop (#14, #42).
- Deterministic repository relationships cover explicit local package dependencies, nearest-package membership, checked-in build entrypoints/type contracts and conservative test-to-source conventions (#15, #43, #44, #46).
- VibeGuard-shaped and Hacka-shaped fixtures prove the same public graph/provenance/traversal contract supports impact/review evidence and bounded task context without moving either consumer's policy into RepoGraph (#16, #45).
- The cross-consumer proof also verifies that a repository + exact base SHA + stable RepoGraph evidence node can survive a durable GitHub work-request handoff and resolve from a fresh pinned graph build.
- Parallel package-manifest work was reconciled before marking the milestone: 0.0.3 exposes one canonical repository-relationship API rather than two overlapping fact sources (#46).

Compatibility notes:

- Exported graph schema remains `repograph.graph/v1`.
- 0.0.x APIs remain experimental and may change before 1.0.0.
- RepoGraph remains headless repository intelligence: no GitHub write credential, webhook receiver, task queue or hidden workflow database is required by the consumer proof.
- This is an internal engineering milestone, not the public RepoGraph launch. The first public release target remains **1.0.0**.
- Work now moves to 0.0.4 extension/lifecycle/protocol hardening.

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
