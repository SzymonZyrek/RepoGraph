# Graph contract (0.0.1)

This is the legacy interchange model. The primary 0.0.6 persisted/query model is [Artifact / Boundary / DEPENDS_ON / CONTAINS](bounded-queries.md), with revision metadata once and deduplicated compact evidence. This older model remains for migration/debug utilities.

RepoGraph graph state is deterministic, derived and disposable.

## Identity

Node IDs are SHA-256 hashes of an explicit identity tuple:

- `namespace`
- `kind`
- `key`

Edge IDs are SHA-256 hashes of:

- `kind`
- source node ID
- target node ID
- optional explicit edge key

Insertion order, extraction order and provenance do not participate in identity.

Duplicate facts with the same identity converge by merging unique provenance. If the same identity carries conflicting metadata, RepoGraph fails explicitly instead of choosing a winner.

## Provenance

Every node and edge has one or more provenance records containing repository/ref plus optional commit, path and extractor identity.

The contract keeps three different dimensions separate:

- `origin`: source, derived or overlay;
- `method`: source observation, deterministic extraction, external index or explicit overlay;
- `state`: complete, partial or unresolved.

There is deliberately no universal numeric confidence score.

Partial or unresolved extraction can be attached to provenance and can also be represented as a graph-level structured diagnostic. Missing evidence should not be turned into speculative edges.

## Serialization

The exported schema version is `repograph.graph/v1`.

Graph serialization:

- sorts object keys canonically;
- sorts nodes and edges by stable ID;
- deduplicates and canonically sorts provenance;
- validates edge endpoints;
- rejects unknown schema versions;
- recomputes IDs during parsing and rejects tampered identities.

Equivalent graph inputs therefore serialize byte-for-byte identically regardless of insertion order.
