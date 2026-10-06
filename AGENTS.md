# Mandatory pre-release rule — one implementation

Through and including 1.0.0, maintain exactly one current implementation and contract. Do not introduce or retain backwards-compatibility layers, legacy APIs, deprecated execution paths, migration code, version negotiation, alternate old schemas, or compatibility aliases. Delete superseded code, tests and documentation; update consumers directly to the current contract. Breaking changes are expected before the first public release. Compatibility promises may only be introduced after 1.0.0.

This explicit Owner instruction overrides older issue text and documentation asking for deprecation, migration or preservation of pre-release interfaces. Never keep an old system beside its replacement merely to avoid changing consumers.

## Product boundary

RepoGraph provides bounded repository/ref causal queries and attributable evidence. Consumers own capability, ownership, review, test-execution and task policy. Source providers normalize into the closed Artifact/Boundary graph; do not grow language frontends or consumer-specific APIs.

## Delivery

Preserve unrelated work; use an isolated worktree. VERSION.txt is the sole hand-edited application version source. Verify the current implementation with focused behavioral tests and the existing coverage gates. Prove packed-package use in clean consumers on supported Linux/Windows runtimes before claiming delivery. Keep raw evaluations in .cache, and disclose unverified external evidence.
