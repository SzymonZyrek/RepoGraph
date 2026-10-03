# Git ingestion (0.0.1)

RepoGraph reads repository structure from Git objects, never from the mutable working tree.

## Pinning

`ingestGitRepository()` resolves the requested ref to an exact commit first. Every fact records both the requested ref and resolved commit. Tree/file data is then read from that commit with `git ls-tree` and `git cat-file`.

Changing an uncommitted working tree therefore cannot change the graph for a pinned commit.

## Identity and content reuse

Repository objects use path identity:

- repository: `repository:.`
- directory: path
- file: path
- symlink: path
- submodule/gitlink: path

Git object identity is stored separately in metadata:

- directories retain `treeSha`;
- files and symlinks retain `blobSha`;
- submodules retain the gitlink `commitSha`.

A pure rename therefore changes the path node ID while preserving the blob identity. Later incremental versions can reuse extraction by blob SHA instead of pretending a rename is the same path fact.

## Filters

The ingestion policy can declare:

- include globs;
- exclude globs;
- generated-path globs;
- vendor-path globs;
- binary exclusion with a maximum inspection size.

Required ancestor directories remain in the graph for included descendants. Explicitly excluded/generated/vendor/binary files are omitted, but RepoGraph emits structured diagnostics with pinned provenance so the omission stays inspectable.

Binary detection in 0.0.1 is deliberately conservative: it checks for NUL bytes in a bounded blob sample. Files above the configured check size remain included and produce a `binary-check-skipped` diagnostic.

## Symlinks and submodules

Symlinks are represented as `symlink` nodes. RepoGraph stores the symlink blob SHA and target text; it does not follow the target.

Gitlinks are represented as `submodule` nodes with their pinned commit SHA. RepoGraph does not initialize or recursively inspect a submodule during repository ingestion.

## CODEOWNERS-like rules

By default RepoGraph discovers the first pinned CODEOWNERS file in this order:

1. `.github/CODEOWNERS`
2. `CODEOWNERS`
3. `docs/CODEOWNERS`

Rules become explicit `path-rule` nodes. Matching files receive `path-rule-match` edges. All matching rules remain inspectable, while the last matching rule is marked `effective: true`.

Caller-supplied generic path rules can be appended as explicit overlays. RepoGraph preserves their targets as metadata; it does not interpret those targets as product ownership policy.
