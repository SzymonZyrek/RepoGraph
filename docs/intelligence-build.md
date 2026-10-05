# Building the built-in repository intelligence graph

This full-graph surface is deprecated for normal consumers as of 0.0.6. Retain it only for migration/debug interchange. Use [bounded repo/ref queries](bounded-queries.md) for indexing, impact, slices and explanations.

RepoGraph has two intentionally different build surfaces.

## `build`: raw pinned Git facts

`repograph build` keeps the original low-level behavior. It ingests the exact Git tree/ref and emits repository/file/path facts only.

Use it when a consumer deliberately wants the graph kernel without language/package relationship extraction.

## `build-intelligence`: composed built-in evidence

`repograph build-intelligence` composes the built-in deterministic evidence sources for one exact repository/ref:

1. pinned Git/file facts;
2. TypeScript/JavaScript import/export dependency evidence;
3. package, test, build-entrypoint and contract relationships.

The result is still one normal `repograph.graph/v1` document. There is no second consumer-specific graph.

Example:

```bash
node dist/src/cli.js build-intelligence \
  --repo /workspace/repo \
  --ref 0123456789abcdef0123456789abcdef01234567 \
  --repository owner/repo \
  --cache-dir .repograph-cache \
  --metrics-out intelligence-metrics.json \
  --out intelligence.json
```

The graph can be consumed directly by the stable external protocol:

```bash
node dist/src/cli.js protocol --request request.json
```

where the request embeds the generated graph and uses `repograph.protocol/v1` `slice` or `explain`.

## Determinism and provenance

The build resolves the requested ref to an exact commit before extraction. Source and derived facts preserve repository/ref/commit/path provenance from their underlying extractors.

Equivalent facts emitted by multiple built-in stages converge through the normal stable graph identity rules.

Diagnostics from stages are deduplicated canonically; disagreement is not turned into invented edges.

## Cache behavior

`--cache-dir` is optional. Versioned intelligence artifacts use the existing `LocalArtifactStore` and snapshot manifests. Builds resolve the exact commit first and reuse its manifest when available. Otherwise they reuse only a compatible first-parent manifest and a pinned Git diff; they do not search historical commits for a favorable baseline.

The intelligence manifest uses an internal facts ref independent of the caller's requested ref. Facts omit target commit provenance; final materialization applies the current requested ref and exact commit. The artifact identity includes the Git tree, ingestion policy, path rules, CODEOWNERS discovery, requested TS configuration path, parser version and analysis/schema versions. Configuration contents belong to the pinned tree, and configuration changes trigger conservative invalidation. Existing store/snapshot wrappers and old snapshots are preserved.

An ordinary source-content edit inspects the changed path and its ancestor trees, parses or reuses that source's blob syntax, and replaces only its dependency/export fragment. It preserves package membership, entrypoint and test-convention facts. Import candidate indexes include unsuccessful candidates and all extension-priority alternatives; adding, deleting or renaming paths invalidates their importers. Rename-only changes reuse syntax when the parser mode remains compatible. Path changes update affected memberships/tests and indexed package entrypoints. Package edits parse changed manifests, update their declarations and affected local/workspace dependents, and reassign memberships only when package regions change. TS configuration edits re-resolve indexed configuration-dependent importers while preserving package/test relationships. CODEOWNERS and incompatible ingestion/analysis settings trigger explicit conservative cold invalidation.

Normalized Git/source/relationship fragments persist in immutable packs of at most 64 fragments. Ordinary edits replace only affected packs; unchanged packs retain their artifact keys without rehashing or encoding their facts. A separate intelligence index persists Git entries, candidate/reverse indexes, package/configuration facts and aggregate counts. Manifest pack addresses retain their logical fragment keys so missing index or pack artifacts can be recreated against the same immutable snapshot.

Loading all referenced packs, encoding the intelligence index/manifest, file-index construction, aggregate counts, canonical ordering, final provenance materialization and JSON serialization still scale with full output. Reusing maintenance fragments does not make the entire full-graph call proportional to changed files. See [the multi-size evaluation](evals/0.0.6-incremental-intelligence.md).

Missing referenced artifacts cause an explicit rebuild with a fallback reason. Intelligence index/pack payload fingerprints are verified on reads, including valid JSON with corrupted facts. Store corruption propagates as an error; no partial snapshot is returned as complete evidence. Target SHA/ref provenance is materialized separately; optional commit absence on explicit overlay declarations remains compatible with the standalone graph. The graph remains derived/disposable and can be rebuilt from Git.

The metrics file records:

- resolved repository/ref/commit;
- total graph nodes/edges/diagnostics;
- TS/JS parse/reuse metrics;
- deterministic repository-relationship metrics;
- composition metrics showing how many base Git nodes/edges were reused instead of rebuilt from the relationship stage;
- cache stats when a cache is used.
- composition mode (`cold`, `incremental`, `exact`), first-parent base commit, fallback/invalidation reasons and changed paths;
- inspected Git path/blob identities, resolved source fragments, recomposed relationship fragments, reused fragments and materialized nodes/edges;
- encoded fragments and written/reused fragment packs, exposing the bounded pack-write work separately from full snapshot-index I/O;
- phase timings for Git/change discovery, extraction/resolution, relationship maintenance, cache I/O and graph materialization;
- CLI serialization and output-write timings, separately from library build time.

`parsedFiles` and `reusedSyntaxArtifacts` count actual parser/cache work performed in this call. An exact manifest hit reports zero for both: it skips syntax extraction entirely. Dependency and relationship counts describe the full result, while composition counters describe maintenance work. Syntax-cache I/O is included in the overall cache phase and excluded from extraction/resolution time. `inspectedBlobs` counts changed Git blob identities, rather than claiming every such blob was reparsed.

Package manifest facts also retain the standalone extractor's blob cache. `parsedPackageManifests` counts manifests parsed during this call; `reusedPackageArtifacts` counts manifest facts retained from compatible intelligence fragments or loaded from the package cache. `membershipFilesVisited` reports actual membership maintenance work. `indexedFiles`, `packageManifestCandidates` and `testFileCandidates` describe the complete maintained index, including on an exact manifest hit. `packageCacheIoMs` is charged to cache I/O rather than relationship maintenance. These counters preserve the package-cache and indexed-lookup improvements on current main.

Run `npm run eval:intelligence` explicitly to reproduce the 240/960/3,840-source evaluation. It holds cluster size constant, exercises eight sequential edits, unchanged-blob rename, dependency edit, broad edit and stale SHA, and asserts warm/cold graph equality at every revision. It remains opt-in, outside required CI.

Completed size evaluations are checkpointed atomically to `.cache/intelligence-economics.checkpoint.json`. Set `REPOGRAPH_EVAL_RESUME=1` to resume after interruption; the harness verifies the compiled-code/harness fingerprint before reusing completed results. Partial checkpoints are not final evidence. Batched Git-diff auditing avoids per-path process startup for broad edits, and the broad reverse slice is computed as an indexed union outside measured build wall time.

The built-in TS/JS and relationship extractors retain complete standalone graphs. The composed `build-intelligence` path calls their fragment-producing internals and assembles base Git facts once with dependency/package/test/build/contract fragments. The existing base/relationship-only/duplicate-skipped counters remain available; their meaning is the number of facts the standalone wrappers would otherwise duplicate. Cached normalized fragments retain stable IDs, so unchanged identities are not rehashed during assembly.

## Boundary

This command composes generic built-in repository evidence only.

It does not:

- add VibeGuard capability/Owner policy;
- choose Hacka task context;
- apply consumer overlays automatically;
- decide traversal/review/validation policy;
- run optional external extractor plugins.

Consumers apply overlays and traversal policy after the generic graph is built.
