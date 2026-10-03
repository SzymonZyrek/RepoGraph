# RepoGraph

**A small, inspectable dependency-intelligence graph for Git repositories.**

RepoGraph turns a pinned repository revision into reusable facts about files, modules, symbols, contracts and their relationships. It answers bounded questions such as:

- What can this change affect?
- Why is this module, test or contract relevant?
- Which source evidence supports that path?
- What can be reused after a narrow Git diff?

It is designed as shared infrastructure for products that need repository understanding without making the graph itself a source of policy.

> **Status:** pre-public development. `0.0.x` releases are implementation milestones; the first public release target is **1.0.0**.

## What 0.0.1 contains

The first usable kernel now includes:

- deterministic typed node/edge identities and canonical serialization;
- exact provenance on graph facts;
- pinned Git tree ingestion from Git objects rather than the mutable working tree;
- path filters and generic CODEOWNERS-like path rules;
- forward and reverse neighbors;
- transitive reverse affected closure with edge-kind/depth bounds;
- shortest causal path explanation;
- TypeScript library exports and a deterministic JSON CLI.

### CLI

```bash
npm install
npm run build

node dist/src/cli.js build --repo . --ref HEAD > graph.json
node dist/src/cli.js neighbors --graph graph.json --node src/index.ts
node dist/src/cli.js reverse-neighbors --graph graph.json --node src/index.ts
node dist/src/cli.js affected --graph graph.json --seed src/index.ts
node dist/src/cli.js explain --graph graph.json --from . --to src/index.ts
```

CLI failures return a non-zero exit code and a machine-readable JSON diagnostic on stderr.

## The boundary

RepoGraph owns generic repository intelligence:

- Git tree, file and path facts pinned to a ref;
- typed nodes and edges with deterministic identities;
- provenance for derived facts;
- TypeScript/JavaScript dependency extraction;
- incremental diff updates and affected slices;
- reverse traversal and causal explanations;
- optional generic overlays and cross-repository edges;
- a stable library and JSON/CLI contract.

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

See [Architecture](docs/architecture.md) for the model and invariants.

## Why a separate project?

A dependency graph becomes brittle when each product builds its own version of file parsing, reverse dependencies, caches and “why did this match?” logic. RepoGraph provides one disposable, reproducible graph derived from Git, while each consumer retains its own authoritative configuration and decisions.

That means:

- VibeGuard can map confirmed capabilities and ownership onto graph evidence without turning extracted edges into authority.
- HackaTeam can assemble bounded task context from the same pinned-revision facts without adopting VibeGuard semantics.
- neither consumer must run a permanent graph service or maintain a parallel source of truth.

See [Consumer integration](docs/consumers.md).

## Planned releases

| Release | Delivers |
|---|---|
| **0.0.1** | Deterministic graph kernel: typed contract, Git/path ingestion, traversal, CLI/library baseline |
| **0.0.2** | Incremental dependency engine: content-addressed snapshots, Git diffs, TS/JS extraction |
| **0.0.3** | Repository-intelligence semantics: overlays, provenance/authority, traversal policies, consumer proof |
| **0.0.4** | Extension boundary: extractor contract, cross-repo edges, lifecycle hardening, stable external protocol |
| **1.0.0** | First public release after the pre-public contracts and consumer proofs have stabilized |

The detailed, dependency-linked roadmap lives in [GitHub issue #1](https://github.com/SzymonZyrek/RepoGraph/issues/1). The future optional read-only graph view is deliberately deferred until the contract is proven by consumers; see [#21](https://github.com/SzymonZyrek/RepoGraph/issues/21).

## Documentation

- [Architecture and invariants](docs/architecture.md)
- [Pinned Git ingestion](docs/git-ingestion.md)
- [Consumers: VibeGuard and HackaTeam](docs/consumers.md)
- [Roadmap and delivery rules](docs/roadmap.md)

## Principles

1. **Git is authoritative.** Graph state is derived, disposable and reproducible.
2. **Evidence is not policy.** Extracted relationships explain; consumers decide.
3. **Prefer no edge to a speculative edge.**
4. **Every answer is bounded and inspectable.**
5. **A new commit must not require a whole-repository rebuild.**
6. **The library stays headless by default.**
