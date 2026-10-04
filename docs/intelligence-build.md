# Building the built-in repository intelligence graph

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

An ordinary source-content edit inspects the changed path and its ancestor trees, parses or reuses that source's blob syntax, and replaces only its dependency/export fragment. It preserves package membership, entrypoint and test-convention facts. Import candidate indexes include unsuccessful candidates and all extension-priority alternatives; adding, deleting or renaming paths invalidates their importers. Rename-only changes reuse syntax when the parser mode remains compatible. Path changes update affected memberships/tests and package declarations/entrypoints. Package manifests, TS configuration and CODEOWNERS changes currently trigger explicit conservative cold invalidation.

Normalized Git/source/relationship fragments persist in immutable packs of at most 64 fragments. Ordinary edits replace only affected packs; unchanged packs retain their artifact keys without rehashing or encoding their facts. A separate intelligence index persists Git entries, candidate/reverse indexes, package/configuration facts and aggregate counts. Manifest pack addresses retain their logical fragment keys so missing index or pack artifacts can be recreated against the same immutable snapshot.

Loading all referenced packs, encoding the intelligence index/manifest, file-index construction, aggregate counts, canonical ordering, final provenance materialization and JSON serialization still scale with full output. Reusing maintenance fragments does not make the entire full-graph call proportional to changed files. See [the multi-size evaluation](evals/0.0.6-incremental-intelligence.md).

Missing referenced artifacts cause an explicit rebuild with a fallback reason. Store corruption propagates as an error; no partial snapshot is returned as complete evidence. The graph remains derived/disposable and can be rebuilt from Git.

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

Run `npm run eval:intelligence` explicitly to reproduce the 240/960/3,840-source evaluation. It holds cluster size constant, exercises eight sequential edits, unchanged-blob rename, dependency edit, broad edit and stale SHA, and asserts warm/cold graph equality at every revision. It remains opt-in, outside required CI.

The built-in TS/JS and relationship extractors each expose a complete standalone graph, so both contain the pinned base Git facts. The composed `build-intelligence` path recognizes those shared base fact identities and feeds them into final graph construction only once. Relationship-only package/test/build/contract facts are still added normally. This avoids redundant hashing, validation and provenance merging for the unchanged base graph without changing the resulting `repograph.graph/v1` document.

## Boundary

This command composes generic built-in repository evidence only.

It does not:

- add VibeGuard capability/Owner policy;
- choose Hacka task context;
- apply consumer overlays automatically;
- decide traversal/review/validation policy;
- run optional external extractor plugins.

Consumers apply overlays and traversal policy after the generic graph is built.
