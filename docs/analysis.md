# Enriched repository analysis

`analyzeRepository()` and the `repograph analyze` CLI command provide the default generic repository-intelligence graph for consumers that need more than raw Git/path facts.

The analysis is pinned to the exact requested Git revision and composes:

- Git tree, file, directory and path-rule facts;
- TypeScript/JavaScript imports, reexports and exported-symbol facts;
- deterministic package/workspace relationships;
- deterministic test-to-source filename conventions;
- explicitly declared package build entrypoints and type/contract entrypoints.

The output remains `repograph.graph/v1`. Every derived edge keeps extractor identity and exact repository/ref/commit provenance.

## CLI

```bash
repograph analyze \
  --repo /path/to/repository \
  --ref <exact-ref-or-sha> \
  --repository github.com/example/repository \
  --out analysis.json
```

The existing `build` command intentionally remains the lower-level Git/path ingestion surface. Consumers should use `analyze` when they want the built-in deterministic repository intelligence without importing the TypeScript library.

Include/exclude/generated/vendor filters are applied at Git ingestion before enrichment. No consumer capability, ownership, task-selection or review policy is inferred.
