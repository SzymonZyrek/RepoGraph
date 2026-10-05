# RepoGraph

**A small, inspectable dependency-intelligence graph for Git repositories.**

RepoGraph turns a pinned repository revision into a small causal graph of useful artifacts, logical boundaries and interaction interfaces. It answers bounded questions such as:

- What can this change affect?
- Why is this module, test or contract relevant?
- Which source evidence supports that path?
- What can be reused after a narrow Git diff?

It is designed as shared infrastructure for products that need repository understanding without making the graph itself a source of policy.

> **Status:** pre-public development. **0.0.6** uses provider-first ingestion and bounded repo/ref queries over an embedded graph store. Existing full-graph APIs are migration/debug interchange. **1.0.0 is the first public release**; its public contract freeze and real application migration remain separate acceptance work.

## The boundary

RepoGraph owns generic repository intelligence:

- a minimal `Artifact / Boundary / DEPENDS_ON / CONTAINS` causal model;
- provider-first normalization of mature code/build/protocol graph sources;
- exact revision identity and compact provenance for derived facts;
- deterministic traversal, reverse traversal and causal explanations;
- path-rule evidence;
- a library and JSON/CLI boundary.

It does **not** decide product policy. Capability definitions, ownership, review routing, task selection, LLM suggestions and human approval remain with its consumers.

```text
repository facts + explicit generic overlays
                  ↓
              RepoGraph
                  ↓
       bounded evidence and causal paths
          ↙                         ↘
   VibeGuard                    HackaTeam
impact / review              task context / validation
```

## Quick start

```bash
npm ci
npm run ci
npm run build

node dist/src/cli.js version
node dist/src/cli.js index --repo . --ref HEAD
node dist/src/cli.js affected --repo . --ref HEAD --changed src/model.py
node dist/src/cli.js slice --repo . --ref HEAD --start artifact:src/model.py --direction in
node dist/src/cli.js explain --repo . --ref HEAD --from artifact:src/model.py --to artifact:docs/api.md
```

Indexing is implicit for queries. Configure source/build/contract providers in `.repograph.json`; absent or stale provider evidence is explicitly partial. See [bounded queries](docs/bounded-queries.md).

```ts
import { affected } from '@repograph/core';
const answer = await affected({ repositoryPath: '.', ref: commitSha }, ['src/model.py']);
```

All CLI output is deterministic JSON. Invalid input exits non-zero and writes a structured JSON error to stderr.

## Planned releases

| Release | Delivers |
|---|---|
| **0.0.1** | Deterministic graph kernel: typed contract, Git/path ingestion, traversal, CLI/library baseline |
| **0.0.2** | Incremental dependency engine: content-addressed snapshots, Git diffs, TS/JS extraction |
| **0.0.3** | Repository-intelligence semantics: overlays, provenance/authority, traversal policies, consumer proof |
| **0.0.4** | Extension boundary: extractor contract, cross-repo edges, lifecycle hardening, stable external protocol |
| **0.0.5** | Consumer integration: full intelligence build + optional generic read-only view |
| **0.0.6** | Architecture correction: embedded graph queries, minimal causal schema, provider-first ingestion, REST/SOAP/messaging interfaces |
| **1.0.0** | First public release, after pre-1.0 contracts are proven by real consumers |

The dependency-linked roadmap lives in [GitHub issue #1](https://github.com/SzymonZyrek/RepoGraph/issues/1).

## Documentation

- [Architecture and invariants](docs/architecture.md)
- [Bounded repo/ref API, CLI and provider configuration](docs/bounded-queries.md)
- [Provider-first dependency ingestion](docs/providers.md)
- [Protocol and interface dependencies](docs/interfaces.md)
- [Graph contract](docs/graph-contract.md)
- [Pinned Git ingestion](docs/git-ingestion.md)
- [Content-addressed store](docs/content-addressed-store.md)
- [Artifact store lifecycle: GC, recovery and migrations](docs/store-lifecycle.md)
- [Incremental updates](docs/incremental-updates.md)
- [TypeScript/JavaScript extractor](docs/tsjs-extractor.md)
- [Repository relationships: packages, artifacts, contracts and tests](docs/repository-relations.md)
- [Extractor and external-process plugin contract](docs/extractors.md)
- [Cross-repository coordinate bridges](docs/cross-repository.md)
- [External protocol v1](docs/protocol.md)
- [Built-in repository intelligence build](docs/intelligence-build.md)
- [Optional read-only graph view](docs/view.md)
- [Generic overlays and authority](docs/overlays.md)
- [0.0.2 incremental economics evidence](docs/evals/0.0.2-incremental-economics.md)
- [0.0.3 consumer compatibility proof](docs/evals/0.0.3-consumer-compatibility.md)
- [Consumers: VibeGuard and HackaTeam](docs/consumers.md)
- [Release/version contract](docs/releases.md)
- [Traversal policy contract](docs/traversal-policies.md)
- [Roadmap and delivery rules](docs/roadmap.md)

## Principles

1. **Git is authoritative.** Graph state is derived, disposable and reproducible.
2. **Evidence is not policy.** Extracted relationships explain; consumers decide.
3. **Prefer no edge to a speculative edge.**
4. **Every answer is bounded and inspectable.**
5. **Prefer mature dependency/build/protocol providers over custom language frontends.**
6. **A new commit should refresh only the provider/graph surface that needs it when practical.**
7. **JSON is a bounded wire/debug format, not the primary graph store.**
8. **The library stays headless by default.**
