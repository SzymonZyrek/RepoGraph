# Cross-repository coordinate bridges

RepoGraph can compose multiple already-pinned repository graphs and add explicit dependency bridges between them. This is intentionally not a package manager or remote resolver.

## Model

Each supplied repository snapshot carries:

- repository identity;
- requested ref;
- exact commit;
- its RepoGraph document.

Cross-repository dependencies use an explicit coordinate node:

```text
consumer package/node
        │ depends-on-coordinate
        ▼
package/artifact coordinate
        │ coordinate-resolves-to
        ▼
producer package/artifact
```

Coordinates contain a kind (`package` or `artifact`), ecosystem, name and exact version.

## Producer resolution

For package coordinates, RepoGraph may resolve the producer from the package facts already present in the supplied snapshots. The match must be unique on ecosystem + package name + exact version.

If no supplied snapshot matches, RepoGraph emits `cross-repo-producer-unresolved`. It does not query npm, Maven, GitHub, a registry or the network.

If multiple supplied snapshots match, RepoGraph emits `cross-repo-producer-ambiguous` and requires an explicit producer locator.

Artifact coordinates always require an explicit producer locator. This keeps arbitrary build artifacts and contracts inspectable without pretending RepoGraph can discover their publication semantics automatically.

## Provenance

Bridge nodes and edges use explicit-overlay provenance from the mapping definition, pinned independently to the consumer and producer repository/ref/commit.

The coordinate node carries provenance from both sides. The resolution edge records producer repository/ref/commit metadata as well.

## Traversal budget

`crossRepositoryAffected` follows only the two bridge edge kinds and counts transitions between repository namespaces.

Callers set:

- `maxRepositoryHops`;
- `maxNodes`.

A shared package can therefore reveal direct consumers without accidentally traversing an unbounded organization-wide graph. If a downstream relation exists beyond the budget, the result is marked `truncated`.

## Consumer-supplied mappings

Mappings identify:

- the consumer graph node;
- the exact coordinate;
- optionally an explicit producer graph node.

This is the initial 0.0.4 contract. Lockfile/manifests adapters may generate these mappings later, but they must feed the same explicit bridge model rather than introduce hidden remote resolution.

The executable fixtures in `test/cross-repo.test.ts` cover:

- a two-hop shared-package chain across three repositories;
- an unrelated repository staying outside the affected slice;
- unresolved coordinates with no network fallback;
- ambiguous producers requiring explicit disambiguation;
- explicit artifact coordinates;
- repository-hop and node budgets.
