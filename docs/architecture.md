# Architecture

## Purpose

RepoGraph is a small, derived **causal graph of useful repository artifacts and boundaries**.

Its job is not to mirror everything knowable about a repository. It exists to answer bounded questions that materially help consumers:

- what may need re-evaluation after this artifact or interface changes?
- which validation, documentation, contract, configuration or build artifacts are relevant?
- why is an artifact relevant?
- which explicit package/workspace/service/capability/interface boundary does the affected slice reach?
- which graph region must be refreshed after a narrow Git diff?

Git remains authoritative. RepoGraph state is derived, disposable and reproducible.

## Core causal semantic

The default causal edge is:

```text
A -[DEPENDS_ON]-> B
```

It means:

> If B changes, A is a justified candidate for re-evaluation.

The relation is intentionally broader than an import edge.

Examples:

```text
src/api.py                DEPENDS_ON src/model.py
tests/test_api.py         DEPENDS_ON src/api.py
docs/api.md               DEPENDS_ON src/api.py
web/client.ts             DEPENDS_ON contracts/api.yaml
src/server.go             DEPENDS_ON contracts/api.yaml
.github/workflows/ci.yml  DEPENDS_ON scripts/test.sh
```

Reverse traversal answers “what may be affected by this change?”.

Direction is causal maintenance/validity, not syntax.

## Minimal graph model

RepoGraph 1.0 keeps the persisted query graph deliberately small.

### Artifact

The primary node is a repository artifact, normally a checked-in file:

```text
Artifact(path)
```

Artifacts may be source, tests, docs, schemas, configuration, build scripts, workflows or checked-in generated files.

A source file is already a useful module identity. Do not create a parallel module node merely because a language tool uses module terminology.

Artifacts may carry a small set of query-useful roles when justified:

- `validation`
- `documentation`
- `contract`
- `configuration`
- `build`
- `generated`

These roles help consumers select relevant results. They are not a taxonomy of file types.

### Boundary

A boundary is an explicit logical grouping or interaction surface that improves traversal:

```text
Boundary(kind, key)
```

Examples include:

- package/workspace/service;
- consumer-supplied capability;
- protocol/API interface.

RepoGraph may derive repository-native boundaries from explicit manifests/build systems. Consumer-domain boundaries are supplied as overlays; RepoGraph does not invent them.

### Interface boundary

Cross-component protocol dependencies use the same Boundary node with `kind=interface`.

Examples:

```text
Boundary(interface, rest:orders:get:/orders/{id})
Boundary(interface, soap:OrderService:GetOrder)
Boundary(interface, message:orders.created)
```

This gives a useful shared dependency point without creating protocol-specific core node types.

Prefer:

```text
consumer implementation DEPENDS_ON interface
provider implementation DEPENDS_ON interface
interface DEPENDS_ON contract artifact
```

when the contract is normative.

This is intentionally more precise than a blanket:

```text
consumer service DEPENDS_ON provider service
```

An internal provider implementation change should not automatically invalidate all remote consumers. A contract/interface change may.

### Structural edge

The only default non-causal relation is:

```text
Boundary -[CONTAINS]-> Artifact | Boundary
```

Containment is structure, not runtime dependency.

Do not add `TESTS`, `ENTRYPOINT`, `MEMBER_OF`, `CONTRACT`, `IMPLEMENTS` and similar edge kinds merely because those concepts exist. Prefer:

- `DEPENDS_ON` for causal re-evaluation;
- artifact roles for result selection;
- `CONTAINS` for explicit structure.

Add a new core relation only after a real consumer query proves these semantics are insufficient.

## Provider-first ingestion

RepoGraph is not a language parser collection.

It should prefer mature ecosystem tools that already know dependency/code/build/protocol graphs, then normalize only useful facts into the small RepoGraph model.

```text
precise code index / native build graph / protocol contract / repo relation / overlay
                                      │
                                      ▼
                                provider adapter
                                      │
                                      ▼
                          normalized candidate facts
                                      │
                                      ▼
                     Artifact / Boundary causal graph
                                      │
                                      ▼
                           embedded graph store
```

Provider architecture is described in [providers.md](providers.md).

Representative preferred sources include:

- SCIP code indexes;
- Cargo metadata;
- Go module/package tooling;
- MSBuild project graph;
- CMake File API;
- Bazel query/cquery;
- Nx ProjectGraph;
- JVM build/dependency tooling;
- OpenAPI;
- WSDL/SOAP tooling;
- AsyncAPI and explicit messaging configuration;
- small deterministic adapters for Markdown, schema/codegen and repository configuration.

A provider-specific schema never becomes the RepoGraph public schema.

The current TypeScript/JavaScript source extractor is fallback/migration code, not the architectural template for adding languages.

## Protocol and interface dependencies

REST, SOAP and messaging dependencies are first-class causal evidence, but they do not expand the core graph vocabulary.

Machine-readable contracts are preferred:

- OpenAPI for REST operations;
- WSDL/XSD for SOAP services and operations;
- AsyncAPI for message/event channels and send/receive operations;
- explicit JMS queue/topic configuration when no AsyncAPI description exists.

The graph stores only stable interface identity and the causal relationships needed by queries.

It does not mirror:

- full OpenAPI schema trees;
- WSDL XML object models;
- SOAP envelopes;
- broker topology;
- runtime credentials;
- every header/parameter/message payload.

Detailed interface/provider semantics are described in [interfaces.md](interfaces.md).

## Evidence

The graph must remain explainable without storing verbose repeated provenance.

Repository identity and exact indexed revision are stored once as store metadata.

A normalized fact keeps only evidence that changes explanation or policy, for example:

- provider id/version or fingerprint;
- evidence class: precise index, native build, deterministic repository relation or explicit overlay;
- optional source artifact/path or interface operation/channel identity when useful;
- compact `complete | partial` state;
- overlay authority when supplied by a consumer.

Do not copy repository/ref/commit onto every node and edge.

Raw provider payloads, parser details and benchmark telemetry are cache/debug data, not graph entities.

## Embedded store

The normal runtime model is an embedded property graph database, currently to be proven with LadybugDB behind an internal storage adapter.

The store contains:

- current normalized query graph;
- exact indexed revision/config identity;
- small private bookkeeping needed for incremental refresh;
- provider fingerprints/cache references when they demonstrably save work.

The store does not contain Git history merely because Git has history. Git already owns that history.

The database implementation does not leak into the public RepoGraph API.

## Incremental refresh

For a new revision:

```text
Git diff
  ↓
identify providers whose relevant input changed
  ↓
reuse provider-native incremental behavior where available
  ↓
collect/normalize changed evidence
  ↓
transactionally replace affected facts
  ↓
serve bounded queries
```

RepoGraph should not implement sophisticated per-language incremental parsing when the provider already owns it.

If a provider produces a whole-project index, correctness comes first. Replace that provider's normalized facts transactionally and optimize only after measurement demonstrates a real problem.

## Queries

The primary API is repository/ref/query, not “build a giant graph document and pass it back”.

Conceptually:

```text
affected(repo, ref, artifacts, policy)
slice(repo, ref, start, policy)
explain(repo, ref, from, to, policy)
```

Indexing may be explicit for tooling but should normally be ensured internally by the query path.

Results are bounded, deterministic and inspectable.

## JSON boundary

JSON remains useful for small CLI/protocol responses.

It is not the persistence model.

A normal response carries repository/revision once, followed by only selected nodes, edges and compact evidence needed for the answer.

A full graph export may exist as an explicit debugging/interchange operation. It is not the normal consumer workflow or a core performance target.

## Consumer boundary

RepoGraph provides causal repository evidence.

VibeGuard owns capability definitions, ownership, review policy and user-facing governance. It may supply capability boundaries as explicit overlays.

HackaTeam owns task selection, execution workflow, context budgets and GitHub coordination. It consumes bounded repository evidence.

Neither consumer should build a competing long-lived dependency graph.

## Schema admission rule

Every proposed persisted node kind, edge kind, role or property must answer:

1. Which concrete consumer query does it improve?
2. Give a case where the answer is materially worse without it.
3. Why must it be persisted rather than derived on demand?
4. What is its invalidation/update cost?
5. Which real consumer/evaluation justifies it?

If those questions cannot be answered, do not store it.

## Non-goals for 1.0

RepoGraph does not aim to be:

- a compiler frontend;
- a universal AST/call graph;
- a package registry mirror;
- a Git history database;
- a protocol/API catalog;
- a vector database;
- a GitHub orchestration service;
- a consumer policy engine;
- a giant JSON graph generator.

The target is narrower: **reuse trustworthy dependency sources, normalize the small causal graph we actually need, keep it in an embedded graph store, and answer bounded questions.**
