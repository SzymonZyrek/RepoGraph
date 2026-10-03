# Package manifest relationships (0.0.3)

RepoGraph can enrich a pinned Git graph with deterministic package relationships from checked-in `package.json` files.

This extractor is deliberately conservative. It represents only relationships that can be justified directly from the pinned manifest content and repository tree.

## Facts emitted

For every valid checked-in `package.json` file, the extractor adds a `package` node keyed by the manifest path.

It emits:

- `declares-package`: the manifest file declares the package node;
- `belongs-to-package`: a repository file belongs to its nearest ancestor package manifest;
- `package-depends-on`: one internal package explicitly names another internal package in `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`.

Dependency edges preserve the declared scope and version/range specifier as metadata.

Every derived fact carries the pinned repository/ref/commit/path plus the `repograph-package-manifests` extractor identity.

## Internal versus external dependencies

RepoGraph does not invent package nodes for registry dependencies.

A dependency becomes a `package-depends-on` edge only when its package name resolves to exactly one checked-in package manifest in the same repository graph.

If no internal package has that name, the dependency is counted as external and no graph edge is created.

If multiple manifests declare the same package name, RepoGraph emits diagnostics and creates no dependency edge for that ambiguous target.

This follows the core rule: **prefer no edge to a speculative edge**.

## Package ownership of files

A file is assigned to the nearest ancestor directory containing a valid `package.json`.

For nested packages, the deepest matching package wins deterministically. This creates a useful path from changed source files to package-level dependencies without relying on folder-name conventions such as `packages/*`.

The extractor does not require the root manifest to declare npm workspaces. Checked-in package manifests are repository facts regardless of the package manager used.

## Non-goals

This slice does not yet infer:

- build target outputs;
- generated artifact relationships;
- test-to-source naming conventions;
- OpenAPI/GraphQL/schema ownership;
- package-manager lockfile resolution;
- registry or remote dependency graphs.

Those relationships belong to later bounded slices of issue #15 and must keep the same deterministic-evidence rule.
