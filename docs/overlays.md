# Generic overlays and authority (0.0.3)

RepoGraph accepts consumer-supplied domain facts without becoming the authority that invents those facts.

## Provenance contract

An explicit overlay fact carries three independent pieces of information:

- `origin: "overlay"` and `method: "explicit-overlay"`;
- a versioned overlay identity `{ name, version }`;
- `authority: "authoritative" | "advisory"`.

This distinction is inspectable on every overlay node and edge. RepoGraph does not derive authority from node/edge kinds and does not convert advisory evidence into authoritative configuration.

Non-overlay provenance cannot carry overlay identity or authority. Overlay provenance must carry both.

## Generic overlay application

`applyOverlay(graph, definition)` adds custom nodes and edges to the same normalized graph contract used by source and derived facts.

For example, a consumer can supply:

~~~text
owner:alice ──owns──> capability:payments ──contains──> file:src/payments/api.ts
~~~

The words `owner`, `capability`, `owns` and `contains` are opaque strings to RepoGraph. Their product meaning remains in the consumer.

Stable IDs use the normal RepoGraph identity rules. There is no second overlay graph.

## Path/glob mapping

`matchGraphNodesByPath` and `pathEdges` provide a generic way to attach a supplied node to repository nodes selected by deterministic path globs.

A mapping chooses:

- an explicit anchor node identity;
- a glob;
- an edge kind;
- optional target node kinds and direction.

It does not know what a capability, team, owner or review rule means.

Mappings are re-evaluated against each graph snapshot. The overlay's domain identity stays stable while file/path membership can follow the repository state.

## Conflicts and duplicates

RepoGraph never silently picks a winner for conflicting overlay metadata.

- duplicate identical declarations are accepted once and produce a diagnostic;
- conflicting declarations in one overlay are omitted and diagnosed;
- an overlay fact that conflicts with metadata already attached to the same stable identity is omitted and diagnosed;
- edges with missing endpoints and path mappings with missing anchors/no matches are unresolved diagnostics.

Equivalent overlay and repository facts may share a stable identity only when their metadata is equivalent; provenance then remains separately inspectable.

## Serialization and traversal

Overlay authority/name/version are part of provenance serialization and survive graph round trips. Existing traversal and causal-path APIs return the original edge provenance, so a consumer can see exactly which path segment is authoritative overlay configuration and which is derived repository evidence.

Evidence-aware traversal policy filtering is the next 0.0.3 slice (#14).
