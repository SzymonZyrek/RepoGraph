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

A lightweight manifest is identified by repository + requested ref + resolved commit and records:

- graph schema version;
- logical artifact names;
- immutable artifact keys.

Different commits can therefore point at the same artifact when their underlying source content and extractor/parser/schema identity are unchanged.

Manifests cannot point at missing artifacts.

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
