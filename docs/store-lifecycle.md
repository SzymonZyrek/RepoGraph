# Artifact store lifecycle

RepoGraph cache state is derived and disposable, but long-running consumers should not need to delete the entire cache just because history grows or one file is corrupt.

The 0.0.4 lifecycle API adds inspection, reference-aware garbage collection and bounded recovery around the existing content-addressed store.

## Inventory

`inspectArtifactStore(root)` reports:

- artifact and manifest file counts;
- valid vs corrupt entries;
- bytes by section and total bytes;
- unreferenced valid artifacts and reclaimable bytes;
- manifest references whose artifacts are missing or corrupt.

Inspection validates the same artifact and snapshot contracts used by `LocalArtifactStore`.

## Reference-aware garbage collection

`collectArtifactStoreGarbage(root, options)` treats retained snapshot manifests as roots.

A caller may supply a `retainManifest(manifest, file)` hook. Artifacts reachable from at least one retained manifest survive even if another historical manifest is removed.

Without a hook, every valid manifest is retained and only unreferenced artifacts are collectible.

The operation supports `dryRun` and reports exact deleted keys plus reclaimed bytes.

Corrupt manifests are conservative by default: if they are retained, GC cannot know what they referenced, so it protects all artifacts. A caller may opt into `deleteCorrupt` to remove corrupt manifests and then collect newly unreachable artifacts.

## Recovery

`recoverArtifactStore(root)` validates artifacts first, then manifests.

Default recovery policy is `rebuild`:

- malformed/corrupt artifacts are removed;
- malformed/corrupt manifests are removed;
- otherwise-valid manifests that reference a removed/missing artifact are invalidated;
- unrelated artifacts and manifests remain untouched.

The next normal snapshot/extractor run therefore sees a cache miss and rebuilds only affected derived state. No stale fact is returned from a corrupt entry.

Set `corruption: "error"` when callers prefer a hard failure instead of automatic invalidation.

## Schema compatibility and migrations

Unknown artifact or snapshot wrapper schema versions follow an explicit policy:

- `incompatibleSchema: "rebuild"` (default) removes the incompatible derived entry;
- `incompatibleSchema: "error"` surfaces the incompatibility.

Consumers may provide narrow `StoreSchemaMigration` hooks for known compatible wrapper migrations. A migration declares artifact/snapshot kind, exact from-version and exact current to-version. The migrated record is validated against the current store contract before it replaces the old file.

There is no implicit best-effort schema coercion.

## High-churn behavior

A typical retention policy can keep only manifests selected by the hosting consumer (for example the refs/releases it still cares about). Shared content-addressed artifacts survive as long as any retained manifest references them; old unique artifacts become reclaimable.

This keeps cache growth proportional to retained history rather than forcing periodic full-cache deletion.
