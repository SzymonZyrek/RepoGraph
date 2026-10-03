# Architecture

## Purpose

RepoGraph is a deterministic, reusable graph of repository facts. It is not a platform database, orchestration service or policy engine.

A graph is built for an exact repository/ref. Its derived state can be discarded and rebuilt from Git.

## Core model

Every node and edge has a stable identity, a type and provenance.

~~~text
Repository
  └─ directory
      └─ file/blob
          └─ module / symbol / artifact

file ──imports──> module
test ──covers──> module
artifact ──exports──> contract
~~~

The initial model stays generic. A consumer may add overlay facts such as:

~~~text
capability:payments ──contains──> module:checkout
owner:alice ──owns──> capability:payments
~~~

RepoGraph records those facts and their authority/provenance, but it never decides whether a person should own a capability or whether a review is required.

## Provenance and authority

A useful graph must distinguish facts that look similar but mean different things:

| Fact | Example | Meaning |
|---|---|---|
| Source fact | file exists at a pinned commit | observed directly from Git |
| Derived fact | module A imports module B | extracted with a named parser/version |
| Explicit overlay | a capability contains a module | supplied by a consumer |
| Authoritative overlay | Founder-confirmed capability configuration | authoritative only in that consumer's domain |

The graph must preserve this distinction through traversal, persistence and serialization.

## Queries

Consumers ask bounded questions through a traversal policy:

- allowed node/edge kinds;
- direction;
- depth or work budget;
- stop conditions;
- deterministic tie-breaking.

A response contains the selected slice, causal paths and an explicit partial/truncated/unavailable state where relevant. It never silently implies a whole-repository answer.

## Incremental state

Derived artifacts are content-addressed. A commit/ref manifest points to reusable artifacts; a changed ref does not automatically mean a changed file, parser result or edge.

The intended update flow is:

~~~text
Git diff → changed blobs → narrow extraction → affected slice → updated manifest
~~~

Schema/parser/extractor version changes are explicit global invalidators. Cache data is an optimisation, never authority.

## Public boundary

RepoGraph is headless first:

- TypeScript library;
- deterministic JSON/CLI;
- stable error and feature-discovery contract.

A later optional view layer may render a bounded graph slice, but it cannot define product vocabulary or consumer policy. See [consumers.md](consumers.md).


## Evidence fidelity

Provenance answers both **where a fact came from** and **how it was obtained**.

RepoGraph should preserve evidence classes such as:

- direct Git/source observation;
- explicit or authoritative consumer overlay;
- deterministic native extraction;
- precise externally indexed evidence;
- partial/unresolved extraction as a diagnostic/state rather than invented edges.

Do not attach one universal numeric confidence score to edges. The evidence classes are not naturally comparable on one scalar, and consumer policies may intentionally treat them differently.

Traversal policies can filter by evidence method/fidelity and causal explanations preserve that classification.

## External code intelligence

RepoGraph should own the normalized graph contract, identities, provenance and traversal — not every compiler frontend.

The versioned extractor/plugin boundary may ingest precomputed external code-intelligence indexes (a SCIP-like fixture is a useful example) alongside RepoGraph-native extractors.

Native and external sources must map deterministically into the same graph identities. Overlap converges when equivalent; disagreement remains inspectable rather than being hidden by silent precedence.

This keeps the initial TypeScript/JavaScript extractor deliberately narrow while leaving a path to compiler-aware multi-language evidence without rebuilding an entire Sourcegraph-class indexing stack.