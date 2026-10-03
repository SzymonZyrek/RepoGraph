# Content-addressed store (0.0.2)

RepoGraph's local cache is derived infrastructure, not authority. It can be deleted at any time and rebuilt from Git plus deterministic extractors.

## Artifact identity

An immutable artifact key is SHA-256 over the canonical descriptor:

- content identity (normally a Git blob SHA or another exact content hash);
- artifact kind;
- extractor name and version;
- optional parser version;
- output/schema version;
- RepoGraph store schema version.

Commit SHA and path are deliberately absent from artifact identity. Two commits can therefore reuse the same derived artifact when they reference the same content and extractor contract.

If the same artifact descriptor ever produces different payload bytes, the store fails with an explicit conflict instead of silently replacing the old value. This makes extractor nondeterminism inspectable.

## Snapshot manifests

A lightweight manifest is keyed by:

- repository identity;
- resolved commit SHA;
- configuration identity;
- optional requested ref alias.

The configuration identity distinguishes graphs built from the same commit with different include/exclude or other ingestion/extraction policies. Including the requested ref keeps two aliases for the same commit from colliding while artifact reuse remains content-addressed and independent of refs.

A manifest records the pinned tree and references from content/path/node facts to immutable artifact keys. Manifests do not duplicate artifact payloads. The local backend refuses to persist a manifest that points at a missing local artifact, and consumers can follow manifest references directly with `readArtifactByKey()`.

## Local persistence

`LocalContentStore` writes canonical JSON below a caller-selected root:

~~~text
cache/
  artifacts/ab/abcdef....json
  manifests/cd/cdef01....json
~~~

Writes use a temporary file followed by an atomic rename. Existing immutable objects are verified rather than overwritten.

The in-process `stats` counters expose cache hits, misses and successful writes. A new process can open the same directory and reuse valid artifacts immediately.

## Lifecycle

Cache deletion is always legal. Rebuilding the same descriptor with a deterministic extractor yields the same artifact key and equivalent canonical payload.

Garbage collection and long-term retention policy are intentionally deferred to the 0.0.4 persistence-lifecycle slice.
