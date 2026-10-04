# Dependency providers

RepoGraph is provider-first: it reuses dependency/code-intelligence/build/protocol graphs already produced by mature ecosystem tools instead of reimplementing language and platform semantics.

## What RepoGraph owns

RepoGraph owns:

- provider discovery/capability negotiation;
- normalization into the minimal causal graph;
- compact evidence/source identity;
- incremental merge/update semantics;
- graph storage;
- bounded causal queries.

RepoGraph does not own:

- compiler frontends;
- package-manager resolution;
- build-system semantics;
- framework route resolution when existing tooling exposes it;
- protocol object models;
- a universal source parser.

## Provider classes

### Precise code-intelligence providers

Preferred for source-level relationships when available.

SCIP is the primary common interchange candidate. Existing SCIP indexers cover multiple major language ecosystems, so RepoGraph can consume precise reference/definition evidence without owning those frontends.

Normalize only the useful result:

```text
reference in A resolves to definition in B
             ↓
Artifact(A) DEPENDS_ON Artifact(B)
```

Do not persist the full symbol universe by default.

Symbol nodes belong in the graph only after a consumer-backed evaluation shows they materially improve a real query.

### Native build/workspace/package providers

Use the repository's own graph when it already knows the configured dependency structure.

Representative sources:

| Ecosystem | Preferred source | Typical normalized output |
| --- | --- | --- |
| Rust | `cargo metadata --format-version 1` | boundary dependencies / containment |
| Go | module/package tooling, `go mod graph` | boundary dependencies |
| .NET | MSBuild project graph | project boundary dependencies |
| C/C++ | CMake File API or build-system graph | target boundaries/dependencies |
| Bazel | `query` / `cquery` | target/artifact dependencies |
| Nx | ProjectGraph / `nx graph --print` | workspace boundary dependencies |
| JVM | Gradle/Maven graph; `jdeps` where useful | project/package/class evidence |

The table is illustrative. RepoGraph does not promise to bundle every tool.

Do not reimplement manifest/build resolution when the native system already exposes the configured graph.

### Protocol/interface providers

Machine-readable interaction contracts cover dependencies that source-import graphs cannot see.

Preferred contract sources:

- OpenAPI for REST operations;
- WSDL/XSD tooling for SOAP services/operations;
- AsyncAPI for message/event channels and operations;
- explicit messaging/JMS configuration when a standard contract is unavailable.

Normalize useful interaction surfaces to:

```text
Boundary(kind=interface)
DEPENDS_ON
CONTAINS
```

Do not import entire OpenAPI/WSDL/AsyncAPI object models into the graph.

See [interfaces.md](interfaces.md).

### Repository-relation providers

Small deterministic adapters cover useful repository relationships not normally owned by code/build/protocol providers:

- Markdown/local documentation references;
- schema/code-generation declarations;
- checked-in generated-file manifests;
- CI/build script references;
- explicit repository configuration mapping docs/specs/contracts to implementation.

No semantic-similarity guessing is required for 1.0.

### Consumer overlay providers

Consumers may supply explicit boundaries and relations, for example VibeGuard capability topology.

RepoGraph stores/traverses those facts while preserving their explicit authority. It does not invent product-domain meaning.

## Provider contract

A provider has a narrow job.

Conceptually:

```ts
interface GraphProvider {
  id: string;
  version: string;

  probe(repo): ProviderAvailability;

  collect(input): {
    artifacts?: ArtifactFact[];
    boundaries?: BoundaryFact[];
    dependencies?: DependencyFact[];
    containment?: ContainmentFact[];
    diagnostics?: CompactDiagnostic[];
  };
}
```

The concrete API may evolve before the 1.0 public-contract freeze. The invariant is more important:

> Providers return normalized candidate facts; they do not inject arbitrary graph schema.

A dependency candidate means:

> Changing target B is a justified reason to re-evaluate source A.

Provider internals may consume protobuf, JSON, XML, CLI output, compiler APIs, build databases, DOT, or other formats. Those formats do not become RepoGraph's public contract.

## Selection

Prefer evidence roughly in this order:

```text
explicit configured provider
    ↓
precise existing code/protocol index
    ↓
native workspace/build graph
    ↓
small deterministic repository adapter
    ↓
minimal built-in fallback when it still earns its maintenance cost
```

These sources are complementary rather than globally exclusive.

A repository may use SCIP for source dependencies, Cargo for crate boundaries, OpenAPI for REST interfaces, AsyncAPI for messaging, and a tiny Markdown provider at the same time.

Equivalent normalized facts converge.

Conflicting evidence stays attributable to its provider and is surfaced only when it affects an answer. Do not build a universal numeric-confidence model.

## Availability

RepoGraph 1.0 must not silently install compilers, package managers or indexers.

A provider can be:

- already available in the repository/dev environment;
- supplied as a prebuilt index artifact;
- explicitly configured by the caller;
- invoked through a documented provider command.

Unavailable evidence reduces coverage explicitly. RepoGraph does not invent approximate edges merely to make the graph look complete.

## Incrementality

Reuse provider-native incrementality when it exists.

Otherwise cache provider output using the smallest stable identity that actually saves work, such as:

- provider id/version;
- relevant Git tree/blob identity;
- build/configuration fingerprint.

On a narrow Git diff:

1. identify providers whose relevant input changed;
2. rerun only the useful provider surface when supported;
3. normalize changed facts;
4. transactionally update affected graph facts.

If a provider fundamentally produces a whole-project index, correctness comes first. Replacing that provider's normalized fact set is acceptable; do not build custom incremental machinery until measurements show it matters.

## Evidence normalization

Persist only evidence that changes trust/explanation:

- provider id/version/fingerprint;
- evidence class:
  - `precise-index`
  - `native-build`
  - `protocol-contract`
  - `deterministic-repo`
  - `explicit-overlay`
- optional source artifact/path/interface identity;
- `complete | partial`;
- overlay authority when relevant.

Repository/ref/commit are revision/store metadata and are not repeated per fact.

Raw provider payloads are cache/debug artifacts, not graph nodes.

## Current TypeScript/JavaScript extractor

The existing built-in TS/JS extractor was useful to prove the product idea, but it is not the template for language support.

Before 1.0:

- compare it with a mature external provider such as a SCIP TypeScript indexer;
- prefer the mature provider when it supplies equal or better useful evidence with acceptable setup;
- retain the internal extractor only if its zero-setup fallback value justifies maintenance;
- do not expand it toward compiler-grade analysis.

## Provider admission rule

Before adding or maintaining a provider, answer:

1. Which concrete RepoGraph query does it improve?
2. Which mature tool already knows this graph?
3. What useful facts will RepoGraph normalize from it?
4. What source-specific data will RepoGraph deliberately discard?
5. How is provider availability/partial coverage surfaced?
6. What is the update/invalidation cost?

If the provider mostly adds data with no demonstrated query value, do not add it.
