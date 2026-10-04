# Changelog

## 0.0.6 — 2026-10-04

Pre-public incremental composed-intelligence engineering slice (#61).

- Exact-commit intelligence manifests reuse Git facts, resolved source fragments, package memberships, entrypoints and test conventions across first-parent builds and process restarts.
- Import candidate indexes include unsuccessful resolution candidates, so additions, deletions and renames invalidate affected importers. Rename-only source moves reuse blob syntax when the parser mode remains compatible.
- Ordinary source-content edits maintain one source fragment and preserve package/test relationships. Package/configuration/CODEOWNERS changes use explicit conservative cold invalidation.
- Normalized fragments assemble once into the existing graph schema with current requested-ref/exact-SHA provenance, diagnostic deduplication, endpoint checks and conflict validation.
- Metrics separate maintenance, cache I/O, full graph materialization and CLI serialization. The opt-in economics harness checks warm/cold equivalence at 240, 960 and 3,840 source files.
- Fragment packs contain at most 64 facts fragments, so ordinary edits encode only affected packs. Full output, reading referenced packs and snapshot-index/manifest I/O still scale with repository size; this release does not claim a changed-files-only total build cost. See the measured evaluation document for limits.

Graph, protocol, store and snapshot wrapper schemas remain unchanged. `VERSION.txt` remains the release-version source. **1.0.0 remains the first public release.**

## 0.0.5 — 2026-10-03

Pre-public consumer-integration milestone cut from requirements discovered after the 0.0.4 foundation.

- Optional framework-free read-only graph view consumes only the bounded `repograph.protocol/v1` slice/explanation DTO, preserving generic RepoGraph semantics and host-owned product vocabulary (#21, #56).
- External consumers can build the full built-in repository-intelligence graph through `buildRepositoryIntelligence()` and `repograph build-intelligence`, rather than being limited to the raw Git/file graph (#55, #57).
- The full intelligence build composes pinned Git facts, TypeScript/JavaScript dependencies, deterministic package/test/build/contract relationships, optional content-addressed syntax-cache reuse and metrics evidence into the existing `repograph.graph/v1` contract (#57).
- The resulting graph is proven directly consumable by `repograph.protocol/v1`, closing the concrete boundary gap found during live HackaTeam/VibeGuard integration work (#57).
- Repository/docs cleanup after 0.0.4 fixed release metadata without rewriting main history (#54).
- A parallel synonymous CLI proposal was closed in favor of the stronger single `build-intelligence` surface, avoiding duplicate public commands (#59).

Compatibility notes:

- Exported graph schema remains `repograph.graph/v1`.
- Stable cross-process wire contract remains `repograph.protocol/v1`; no breaking wire change is introduced.
- The read-only view is optional through `@repograph/core/view` and does not make a UI framework part of the headless core.
- Lower-level TypeScript APIs and convenience CLI surfaces remain pre-1.0.
- This is still an internal engineering milestone. **1.0.0 remains the first public RepoGraph release.**

## 0.0.4 — 2026-10-03

Pre-public extension, multi-repository and external-consumer milestone.

- Versioned extractor/plugin protocol supports native and external-process fact sources, deterministic composition, provenance validation, conflict diagnostics and per-extractor cache identity (#17, #49).
- Explicit cross-repository package/artifact coordinate bridges connect only supplied pinned snapshots or caller-selected producers; unresolved dependencies never trigger implicit network/registry resolution, and traversal is bounded by repository hops (#18, #50).
- Content-addressed store lifecycle now exposes inventory/reclaimable metrics, reference-aware GC, conservative corruption handling, targeted rebuild invalidation and explicit schema-migration hooks (#19, #51).
- Stable `repograph.protocol/v1` gives TypeScript and CLI consumers the same bounded slice/explanation wire contract, feature/version negotiation, normalized generic presentation DTOs and machine-readable failures (#20, #52).
- Protocol v1 enforces bounded defaults/hard limits and distinguishes unavailable evidence from transport/request failures, so consumers can render missing/partial/truncated state without requesting an unbounded graph dump.
- The 0.0.4 dependency slices remain headless: no RepoGraph GitHub write credential, webhook receiver, task queue, registry resolver or hidden authoritative database was introduced.

Compatibility notes:

- Exported graph schema remains `repograph.graph/v1`.
- Store and snapshot wrapper schemas remain `repograph.store/v1` and `repograph.snapshot/v1`; incompatible derived cache state may be rebuilt, while known wrapper migrations can be explicit.
- The new stable cross-process wire contract is `repograph.protocol/v1`. Additive optional fields may evolve inside v1; breaking wire changes require a new protocol major.
- Lower-level TypeScript APIs remain 0.0.x experimental until the first public release.
- This is an internal engineering milestone, not the public RepoGraph launch. **1.0.0 remains the first public release.**
- Optional read-only presentation extraction (#21) is intentionally non-blocking and may proceed independently after this milestone.

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
