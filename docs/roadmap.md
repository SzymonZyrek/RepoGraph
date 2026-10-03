# Roadmap

The release sequence is deliberately layered. Each release earns the next by proving an invariant rather than accumulating unvalidated capability.

Versions 0.0.x are pre-public engineering milestones and may change incompatibly when consumer evidence shows the contract is wrong. **1.0.0 is the first public release**; its criteria will be derived from the VibeGuard/Hacka consumer proofs and stabilized external contract rather than from polishing every pre-release milestone as if it were public.

## 0.0.1 — deterministic graph kernel

**Goal:** a repository/ref can be converted into a typed, deterministic graph and queried through both library and CLI.

- graph contract, stable identities and provenance;
- Git tree/file/path ingestion;
- traversal, reverse traversal and causal path explanation;
- package, tests and CI baseline.

Issues: [#2](https://github.com/SzymonZyrek/RepoGraph/issues/2), [#6](https://github.com/SzymonZyrek/RepoGraph/issues/6), [#7](https://github.com/SzymonZyrek/RepoGraph/issues/7), [#8](https://github.com/SzymonZyrek/RepoGraph/issues/8).

## 0.0.2 — incremental dependency engine

**Goal:** routine changes cost proportionally to the changed/affected surface.

- content-addressed artifacts and commit manifests;
- diff-driven narrow invalidation;
- TypeScript/JavaScript dependency extraction;
- high-velocity evaluation.

Issues: [#3](https://github.com/SzymonZyrek/RepoGraph/issues/3), [#9](https://github.com/SzymonZyrek/RepoGraph/issues/9), [#10](https://github.com/SzymonZyrek/RepoGraph/issues/10), [#11](https://github.com/SzymonZyrek/RepoGraph/issues/11), [#12](https://github.com/SzymonZyrek/RepoGraph/issues/12).

## 0.0.3 — repository-intelligence semantics

**Goal:** consumers can use one normalized graph for impact, context, validation and ownership evidence without moving their policy into RepoGraph.

- generic overlays with authority/provenance;
- traversal policies and causal explanations;
- tests/build/contract relationships where deterministic;
- VibeGuard- and Hacka-shaped compatibility fixtures.

Issues: [#4](https://github.com/SzymonZyrek/RepoGraph/issues/4), [#13](https://github.com/SzymonZyrek/RepoGraph/issues/13), [#14](https://github.com/SzymonZyrek/RepoGraph/issues/14), [#15](https://github.com/SzymonZyrek/RepoGraph/issues/15), [#16](https://github.com/SzymonZyrek/RepoGraph/issues/16).

## 0.0.4 — extension and external-consumer boundary

**Status:** complete on 2026-10-03. Optional presentation extraction remains non-blocking.

**Goal:** consumers can upgrade independently and safely use RepoGraph as a library or CLI.

- versioned extractor/plugin contract;
- explicit cross-repository package/artifact edges;
- lifecycle, GC, corruption recovery and schema migration;
- stable protocol and normalized bounded graph-slice contract.

Issues: [#5](https://github.com/SzymonZyrek/RepoGraph/issues/5), [#17](https://github.com/SzymonZyrek/RepoGraph/issues/17), [#18](https://github.com/SzymonZyrek/RepoGraph/issues/18), [#19](https://github.com/SzymonZyrek/RepoGraph/issues/19), [#20](https://github.com/SzymonZyrek/RepoGraph/issues/20).

## Optional presentation extraction

After the 0.0.4 contract is proven by at least two consumers, an optional read-only renderer can be extracted. It is not a release blocker and must remain generic/headless-compatible.

Tracking: [#21](https://github.com/SzymonZyrek/RepoGraph/issues/21).


## 1.0.0 — first public release

The 0.0.x foundation is complete. 1.0.0 remains intentionally evidence-driven rather than cosmetic: release criteria should now be cut from real VibeGuard/Hacka integrations, upgrade behavior, protocol compatibility and the usefulness of bounded explanations. Optional #21 can proceed in parallel and does not redefine the headless core.
