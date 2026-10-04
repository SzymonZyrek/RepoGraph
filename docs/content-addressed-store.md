# Content-addressed store (0.0.2)

RepoGraph's local store reuses deterministic derived artifacts across Git commits without making the cache authoritative.

## Identity

An artifact key is derived from:

- source content identity (for example a Git blob SHA);
- artifact kind;
- extractor name + version;
- optional parser name + version;
- output/schema version.

The derived payload is not part of the key. For a given identity it is expected to be deterministic. If the same key is produced with different payload bytes, RepoGraph fails explicitly instead of overwriting the existing artifact.

## Layout and writes

The store is a normal local directory:

```text
<root>/
  artifacts/<prefix>/<digest>.json
  manifests/<prefix>/<digest>.json
```

Writes are create-only. RepoGraph writes a complete temporary file and atomically links it into its immutable final path. A process crash cannot expose a partially-written artifact as a valid cache entry.

The cache has no network service and can be deleted at any time.

## Snapshot manifests

A lightweight manifest is identified by repository + requested ref + resolved commit + optional build configuration identity and records:

- graph schema version;
- logical artifact names;
- immutable artifact keys.

Different commits can therefore point at the same artifact when their underlying source content and extractor/parser/schema identity are unchanged. Conversely, two builds of the same commit/ref with different include/exclude, parser, or extraction configuration can use distinct manifests by supplying `configurationIdentity`; this prevents configuration-sensitive snapshots from colliding. Omitting it (or using `default`) preserves the original default manifest identity.

Manifests cannot point at missing artifacts.

## Composed intelligence cache (0.0.6)

`buildRepositoryIntelligence` uses versioned `intelligence-index` and `intelligence-fragments` artifacts inside the same store and snapshot wrapper formats. Snapshot manifests identify an exact commit plus the complete intelligence configuration and use an internal facts ref; caller ref aliases do not duplicate analysis. Immutable packs hold at most 64 normalized Git/source/relationship fragments without target commit provenance. A separate index contains Git entries, dependency indexes, package/configuration facts and counts. Final graph materialization applies the requested ref and exact SHA.

Syntax artifacts distinguish the TypeScript parser's TS/TSX/JS/JSX modes, extractor/parser versions and syntax schema. Existing syntax artifacts and snapshots remain untouched. A changed parser/analysis/configuration identity cannot reuse an incompatible intelligence manifest.

Ordinary edits encode only changed packs; unchanged packs retain their keys. Full-graph builds still read all required packs and encode the full intelligence index/manifest. This remaining scaling cost is measured as cache I/O rather than attributed to relationship maintenance. The existing lifecycle inventory/GC follows direct manifest references to every pack, without a new database or daemon. Pack logical addresses preserve their fragment keys, allowing missing index/packs to be rebuilt without changing an immutable manifest. Missing artifacts trigger an explicit complete rebuild; malformed artifacts follow the store's corruption error behavior.

Intelligence artifacts use payload SHA-256 content identities. Reads request `getArtifact(key, { verifyContentIdentity: true })`; canonical encoded payload bytes are verified without rehashing graph identities or renormalizing unchanged facts. Non-canonical wrapper formatting uses a canonical-payload fallback. Valid JSON with changed payload facts raises `StoreCorruptionError`. The default `getArtifact(key)` behavior and existing source-content artifact formats remain unchanged.

## Observability

`LocalArtifactStore.getStats()` exposes artifact/manifest hits, misses, writes and reuses. These counters are process-local diagnostics; they are not persisted state.

## Deliberate non-goals

0.0.2's initial store does not implement:

- garbage collection or retention policy;
- corruption recovery;
- schema migration;
- remote/shared cache services;
- hidden mutable workflow state.

Those lifecycle concerns are tracked separately in #19.
