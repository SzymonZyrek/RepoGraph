# Incremental repository updates (0.0.2)

RepoGraph updates repository intelligence from an exact Git diff and the content-addressed store introduced in #9.

## Snapshot identity

Snapshot manifests are keyed by:

- repository identity;
- requested ref;
- resolved commit;
- ingestion/extraction configuration identity.

The manifest also records the resolved Git tree. The optional configuration identity added in #31 is used by repository snapshots, so two builds of the same commit with different include/exclude, parser, extractor, chunking or schema settings do not collide. Existing default v1 manifests remain readable.

Artifact identity remains content-addressed. Configuration changes invalidate snapshot reuse, not immutable artifacts whose own extractor/parser/schema identity still matches.

## Repository snapshot operation

`createRepositorySnapshot()` ingests a pinned commit and stores:

- one reusable artifact for every included Git object;
- one exact graph-document artifact;
- a lightweight snapshot manifest referring to those artifacts.

`ensureRepositorySnapshot()` first checks the manifest/store and can restore an already-indexed graph after a process restart without rewalking the repository.

Git object artifacts deliberately exclude path and executable mode. A rename or chmod with identical blob content therefore reuses content-derived work.

## Git diff

`diffGitRepository()` resolves exact commits and runs rename-aware Git diffing. Changes are normalized as:

- added;
- modified;
- deleted;
- renamed.

Rename records include similarity and exact before/after Git object IDs. `contentChanged=false` is the explicit rename-only signal.

The caller can choose a direct base or `merge-base` semantics.

## Invalidation plan

`planIncrementalUpdate()` reports:

- changed node IDs;
- changed/outgoing or structurally changed edge IDs;
- reverse affected nodes;
- reused/touched node and edge counts;
- artifact writes/reuses for the target snapshot.

Schema, extractor, parser and chunk-version changes are explicit global invalidators. They are surfaced as named reasons rather than hidden cache misses.

## CLI

~~~bash
node dist/src/cli.js snapshot \
  --repo . --ref HEAD \
  --repository github.com/SzymonZyrek/RepoGraph \
  --cache-dir .repograph-cache

node dist/src/cli.js update \
  --repo . --base HEAD~1 --ref HEAD \
  --repository github.com/SzymonZyrek/RepoGraph \
  --cache-dir .repograph-cache
~~~

Both commands emit deterministic JSON. `update` returns the bounded change/invalidation plan and cache metrics.
