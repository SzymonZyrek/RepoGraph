# Repo/ref queries (0.0.6)

The primary interface is `indexRepository`, `affected`, `slice` and `explain` from `@repograph/core`. Queries ensure the exact requested commit is indexed, then read bounded adjacency and selected evidence from an embedded LadybugDB index. Consumers never supply, build or materialize a GraphDocument. An unchanged revision reads metadata and bounded facts; it does not enumerate the repository tree again.

```ts
import { affected, explain } from '@repograph/core';
const repo = { repositoryPath: '/checkout', repository: 'owner/repo', ref: commitSha };
const impact = await affected(repo, ['src/model.py'], {
  relations: ['DEPENDS_ON', 'CONTAINS'], maxNodes: 200, maxDepth: 16,
});
const why = await explain(repo, 'artifact:src/model.py', 'boundary:overlay:vibeguard:payments', {
  relations: ['DEPENDS_ON', 'CONTAINS'],
});
```

```sh
repograph index --repo . --ref HEAD
repograph affected --repo . --ref HEAD --changed src/model.py
repograph slice --repo . --ref HEAD --start artifact:src/model.py --direction in
repograph explain --repo . --ref HEAD --from artifact:src/model.py --to artifact:docs/api.md
```

Defaults are reverse `DEPENDS_ON` traversal, depth 16, 200 nodes and 1000 edges. Explicit `CONTAINS` enables boundary crossing; it is structural, not a runtime dependency. Hard limits are depth 64, 1000 nodes and 5000 edges. Nodes/edges have readable identities and evidence references; repository/commit occur once. Evidence is deduplicated. No timings, cache counters, source text or native DB types appear in ordinary answers. Unknown starts and unavailable providers are partial; traversal exhaustion is truncated. An absent explanation is not evidence that a change is safe when either flag is set.

## Provider inputs

`.repograph.json` is read from the requested Git revision. Explicit descriptors take precedence over discovery of committed `index.scip`, `cargo.metadata.json`, `openapi.{json,yaml}`, `service.wsdl` and `asyncapi.{json,yaml}`. Discovered source/build indexes use a `<payload>.sources.json` companion for source hashes. Provider payloads must be committed artifacts. The engine never installs or executes toolchains. Generate external indexes explicitly in your build workflow; runtime `GraphProvider` implementations may supply existing native tooling behind their own declared availability/fingerprint contract.

```json
{
  "providers": [
    {
      "type": "scip", "path": "indexes/code.scip",
      "sources": { "src/model.py": "sha256-of-source-bytes" }
    },
    {
      "type": "openapi", "path": "contracts/orders.yaml", "scope": "orders",
      "bindings": [{
        "interface": "rest:orders:get:/orders/{id}",
        "artifacts": ["web/client.ts", "src/controller.py"]
      }]
    }
  ],
  "overlays": [{
    "name": "vibeguard", "authority": "authoritative",
    "boundaries": [{ "key": "payments", "artifacts": ["src/controller.py"] }]
  }]
}
```

SCIP uses its standard protobuf wire format and reduces definitions/references to artifact dependencies. Document-local symbols and external registry symbols are not persisted. `sources` must cover every indexed document and match its bytes; missing/stale source hashes discard that provider's dependencies and mark coverage partial. Cargo metadata likewise requires source hashes for the manifests/lockfile defining its resolved workspace. Native package identities are reduced to workspace manifest boundaries; registry-only coordinates are discarded.

OpenAPI JSON/YAML, WSDL XML and AsyncAPI JSON/YAML create `Boundary(kind=interface)` nodes. Contract-to-interface and explicit binding edges retain exact source/provider attribution. There is no consumer-to-provider implementation edge: changing the shared contract reaches both, changing unrelated server/producer code does not. REST/channel identities include a configured scope (default contract path); WSDL identities include namespace/port/operation. Cross-repository equivalence is never inferred from names or URLs. External contract references not resolved by these adapters require a provider with resolved tooling output; no speculative contract edge is added.

Markdown local links create `documentation DEPENDS_ON referenced artifact` edges. Blob syntax is cached independently of path, so rename-only unchanged Markdown reparses no blobs. Validation/documentation roles follow explicit filename conventions; provider-specific syntax, symbols, directories, history and arbitrary metadata are absent from the core. The historical TS/JS extractor is a migration/fallback utility, not the default source provider.

## Persistence and updates

The disposable index defaults to `.cache/repograph/<repository-key>.lbdb`. Revision/config metadata is checked before answers. Provider-owned node claims, causal edges and compact evidence are refreshed in one transaction with the revision update; a failure rolls back all changes. Converging facts retain independent provider attribution. Source payloads are read from Git blobs, never from a checked-out working tree. On a narrow change unchanged provider fingerprints are reused, while whole-project providers may replace their normalized fact set. Warm queries read only selected facts; cold/incremental maintenance may scan repository/provider manifests. No changed-files-only total indexing cost is claimed.

Deleting the cache rebuilds equivalent bounded answers from Git/providers. Existing `GraphDocument`, `buildRepositoryIntelligence`, `build-intelligence`, `--graph`, and `repograph.protocol/v1` graph-bearing requests remain migration/debug interchange only. They are not the new consumer path and must not be frozen as the 1.0 contract. `repograph.causal/v1` is the experimental compact result schema; public freeze remains #68, after #70 consumer proof.
