# Extractor and plugin contract

RepoGraph 0.0.4 introduces a versioned extractor boundary so language parsers and external code-intelligence sources can evolve without changing graph-kernel semantics.

## Descriptor

Every extractor declares a normalized `repograph.extractor/v1` descriptor:

- extractor name and version;
- output schema version;
- node and edge kinds it may emit;
- evidence methods it may claim;
- evidence-fidelity labels;
- execution boundary: `in-process` or `external-process`.

Descriptor arrays are canonicalized so plugin ordering and duplicate capability declarations do not change output identity.

Extractors cannot claim `explicit-overlay` evidence. Explicit product configuration remains an overlay concern, not parser authority.

## Pinned request

Each run is tied to the same repository, requested ref and exact commit as the base graph. Extractor facts must carry matching provenance and the exact extractor name/version.

The host validates:

- declared node/edge kinds;
- repository/ref/commit provenance;
- extractor name/version;
- allowed evidence method;
- ordinary graph identity/endpoint invariants.

Invalid facts are omitted and represented as structured diagnostics. A plugin failure does not discard facts from other extractors.

## Composition and disagreement

Extractors run against the same pinned base graph and their outputs are composed deterministically.

Equivalent facts with the same stable identity and metadata converge into one graph fact with multiple provenance records. This allows, for example, a native syntax extractor and a compiler-aware external index to agree on one symbol or relationship.

If two extractors use the same stable identity but disagree on metadata, RepoGraph does not choose a hidden winner. The already-accepted fact remains and an `extractor-node-conflict` or `extractor-edge-conflict` diagnostic records the disagreement.

## External process boundary

`createExternalProcessExtractor` runs a configured executable directly, without a shell, and exchanges canonical JSON over stdin/stdout.

The wire request contains the pinned repository/ref/commit and base graph. The local repository path is withheld by default and is included only when `exposeRepositoryRoot: true` is explicitly configured.

The adapter also enforces:

- configured descriptor must declare `external-process`;
- returned descriptor must exactly match the configured normalized descriptor;
- bounded timeout and stdout buffer;
- normal host validation of every returned fact.

This is a process boundary, not an operating-system sandbox. A caller that needs stronger isolation should run the executable inside its own sandbox/container and point the adapter at that launcher.

## Cache identity

`extractorArtifactIdentity` converts a plugin descriptor into the existing content-addressed artifact identity. The extractor name/version therefore participates in `artifactKey`.

Upgrading extractor A changes only A's derived artifact keys. Extractor B's keys remain unchanged for the same content/parser/schema identity.

## Fixture proof

`test/extractor.test.ts` proves:

- native and external-index facts converge deterministically;
- both provenance methods remain inspectable;
- conflicting facts produce diagnostics rather than silent precedence;
- invalid/failed plugins degrade independently;
- changing one extractor version changes only that extractor's artifact identity.

The external fixture is intentionally protocol-shaped rather than SCIP-specific. A SCIP or other compiler-index adapter can live behind the same contract without making that format a RepoGraph core dependency.
