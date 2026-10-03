# RepoGraph

**A small, inspectable dependency-intelligence graph for Git repositories.**

RepoGraph turns a pinned repository revision into reusable facts about files, modules, symbols, contracts and their relationships. It answers bounded questions such as:

- What can this change affect?
- Why is this module, test or contract relevant?
- Which source evidence supports that path?
- What can be reused after a narrow Git diff?

It is designed as shared infrastructure for products that need repository understanding without making the graph itself a source of policy.

> **Status:** pre-public development. 0.0.x versions are engineering milestones; **1.0.0 is the first public release**. **0.0.2 is complete:** deterministic graph + incremental reuse/diff planning + TS/JS dependency extraction are now proven on the high-velocity eval. Work moves to 0.0.3 semantics and consumer proof.

## The boundary

RepoGraph owns generic repository intelligence:

- Git tree, file and path facts pinned to a ref;
- typed nodes and edges with deterministic identities;
- provenance for derived facts;
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

## 0.0.2 quick start

```bash
npm install
npm run ci
npm run build

node dist/src/cli.js version
node dist/src/cli.js build --repo . --ref HEAD --repository github.com/SzymonZyrek/RepoGraph --out graph.json

# incremental 0.0.2 path
node dist/src/cli.js snapshot --repo . --ref HEAD --repository github.com/SzymonZyrek/RepoGraph --cache-dir .repograph-cache
node dist/src/cli.js update --repo . --base HEAD~1 --ref HEAD --repository github.com/SzymonZyrek/RepoGraph --cache-dir .repograph-cache
```

Query by stable node ID:

```bash
node dist/src/cli.js neighbors --graph graph.json --node NODE_ID --direction in
node dist/src/cli.js affected --graph graph.json --node NODE_ID --edge depends-on
node dist/src/cli.js explain --graph graph.json --from NODE_ID --to OTHER_NODE_ID
```

All CLI output is deterministic JSON. Invalid input exits non-zero and writes a structured JSON error to stderr.

## Planned releases

| Release | Delivers |
|---|---|
| **0.0.1** | Deterministic graph kernel: typed contract, Git/path ingestion, traversal, CLI/library baseline |
| **0.0.2** | Incremental dependency engine: content-addressed snapshots, Git diffs, TS/JS extraction |
| **0.0.3** | Repository-intelligence semantics: overlays, provenance/authority, traversal policies, consumer proof |
| **0.0.4** | Extension boundary: extractor contract, cross-repo edges, lifecycle hardening, stable external protocol |
| **1.0.0** | First public release, after pre-1.0 contracts are proven by real consumers |

The dependency-linked roadmap lives in [GitHub issue #1](https://github.com/SzymonZyrek/RepoGraph/issues/1).

## Documentation

- [Architecture and invariants](docs/architecture.md)
- [Graph contract](docs/graph-contract.md)
- [Pinned Git ingestion](docs/git-ingestion.md)
- [Content-addressed store](docs/content-addressed-store.md)
- [Incremental updates](docs/incremental-updates.md)
- [TypeScript/JavaScript extractor](docs/tsjs-extractor.md)
- [Generic overlays and authority](docs/overlays.md)
- [0.0.2 incremental economics evidence](docs/evals/0.0.2-incremental-economics.md)
- [Consumers: VibeGuard and HackaTeam](docs/consumers.md)
- [Release/version contract](docs/releases.md)\n- [Traversal policy contract](docs/traversal-policies.md)
- [Roadmap and delivery rules](docs/roadmap.md)

## Principles

1. **Git is authoritative.** Graph state is derived, disposable and reproducible.
2. **Evidence is not policy.** Extracted relationships explain; consumers decide.
3. **Prefer no edge to a speculative edge.**
4. **Every answer is bounded and inspectable.**
5. **A new commit must not require a whole-repository rebuild.**
6. **The library stays headless by default.**
