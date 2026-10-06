# Distribution and release gates

VERSION.txt is the only edited version. Runtime reads that file; packaging derives the npm manifest version from it into a temporary distribution directory. The root package remains private and contains no version field. No generated version source exists.

Through 1.0.0 there is one current implementation. Delete superseded contracts and update consumers directly. Do not add deprecation windows, old schema handlers, data migrations or compatibility aliases.

Supported runtime matrix: Node 22 and 24, Linux x64 and Windows x64. PR CI must pass lint, strict TypeScript, behavioral tests with unchanged 80% lines/functions and 70% branches, real SCIP/Cargo normalization and packed external package installation/library/CLI queries on all four combinations. Native package installation uses the upstream Ladybug install script and its platform binary; disabling scripts is not a supported install flow.

Public entry points:

- Root: VERSION, CAUSAL_SCHEMA, artifact, boundary, indexRepository, affected, slice, explain and their types.
- /providers: normalization helpers and FactCollector. Providers may emit only the closed causal model.
- /view: createGraphViewModel and its current model types; read-only presentation of a bounded answer.
- CLI: version, index, affected, slice, explain. Repeated changed/start/edge flags are supported; singular options reject duplicates. Invalid inputs fail with nonzero exit and compact JSON errors.

Performance evaluation is opt-in (`npm run eval:index`), with raw output under .cache. It is not a permanent PR tax.

Before a public release: all four CI jobs must pass the exact release head, real VibeGuard/Hacka consumer proofs must be recorded, the generated tarball version/library/CLI must equal VERSION.txt, the release tag must be v<VERSION.txt>, and package licensing/publication must be explicitly decided by the repository Owner. Current package metadata is UNLICENSED; building a tarball does not grant a public license or publish to npm.

Desired main protection: require pull requests, all four `test (ubuntu-latest, 22/24)` and `test (windows-latest, 22/24)` checks, and an up-to-date branch; disallow force pushes/deletion. Repository administration policy is verified separately from ordinary write access.
