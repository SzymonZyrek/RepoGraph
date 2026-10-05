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

## 0.0.5 — consumer integration

**Status:** complete on 2026-10-03.

**Goal:** close concrete gaps exposed by real consumer integration without weakening the headless/core boundary.

- optional framework-free read-only view over bounded protocol DTOs (#21, #56);
- full built-in repository-intelligence composition available through library and CLI (#55, #57);
- direct proof that the full intelligence graph feeds the stable `repograph.protocol/v1` boundary;
- one canonical external-consumer CLI surface (`build-intelligence`) rather than synonymous commands (#59).

This milestone was discovered from live HackaTeam/VibeGuard work after the planned 0.0.4 foundation had already completed. It does not turn RepoGraph into either consumer's product layer.


## 0.0.6 — bounded embedded causal queries

The architecture correction implements the minimal Artifact/Boundary model, provider-first normalized evidence, REST/SOAP/messaging interface boundaries, transactional embedded graph persistence and primary repo/ref CLI/library queries. Historical whole-graph utilities remain migration/debug interchange. See [bounded queries](bounded-queries.md) and [index/query evaluation](evals/0.0.6-bounded-index.md).

Acceptance is tracked by #76, #77, #78, #80 and #81 under #61. RepoGraph-level consumer-contract fixtures share this path; actual application rollout and public compatibility freeze are separate 0.0.7 acceptance work (#70/#68). Native Linux/Windows install and query proof must pass before claiming completion.

## 1.0.0 — first public release

The planned 0.0.1–0.0.4 foundation plus the consumer-discovered 0.0.5 integration layer are complete. 1.0.0 remains intentionally evidence-driven rather than cosmetic: release criteria should now be cut from real VibeGuard/Hacka integrations, upgrade behavior, protocol compatibility and the usefulness of bounded explanations.
