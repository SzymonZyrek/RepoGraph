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

`--cache-dir` is optional. When supplied, the TS/JS syntax extractor reuses content-addressed artifacts for unchanged Git blobs. The final graph remains derived/disposable and can always be rebuilt from Git.

The metrics file records:

- resolved repository/ref/commit;
- total graph nodes/edges/diagnostics;
- TS/JS parse/reuse metrics;
- deterministic repository-relationship metrics;
- cache stats when a cache is used.

## Boundary

This command composes generic built-in repository evidence only.

It does not:

- add VibeGuard capability/Owner policy;
- choose Hacka task context;
- apply consumer overlays automatically;
- decide traversal/review/validation policy;
- run optional external extractor plugins.

Consumers apply overlays and traversal policy after the generic graph is built.
