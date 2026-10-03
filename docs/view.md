# Optional read-only graph view

RepoGraph's presentation layer is deliberately optional. It consumes only the bounded generic DTOs from `repograph.protocol/v1`; it does not query repositories, mutate graph state, or introduce consumer policy.

Import it through the dedicated subpath:

```ts
import {
  GraphViewController,
  renderGraphViewSvg,
} from "@repograph/core/view";
```

## Boundary

The view accepts only `ProtocolSliceDto` or `ProtocolExplanationDto`.

It preserves generic repository facts:

- node and edge kinds;
- causal-path focus;
- provenance method/origin/state/authority;
- partial, truncated and unavailable states;
- reference-only endpoints when a bounded DTO names an endpoint without embedding its node payload.

It does not define VibeGuard capability/Owner actions, Hacka task semantics, approval state, routing policy, or a visual app shell.

## Embedding model

`GraphViewController` owns only ephemeral presentation state:

- selected node;
- pan;
- zoom;
- fit-to-bounds;
- an optional host `onOpen` callback.

The host remains responsible for wiring pointer/keyboard events and deciding what opening a repository object means.

`renderGraphViewSvg()` returns deterministic, script-free SVG. It includes semantic `data-node-id`, `data-node-kind`, `data-edge-id`, and `data-edge-kind` attributes so a host can bind interactions without an iframe or a duplicate graph engine.

No built-in color/theme system is imposed. Consumers own their product styling.

## Labels and destinations

Hosts may provide label and target resolvers when constructing the controller/model. RepoGraph falls back to protocol metadata `label`, then the generic node key. Missing bounded endpoints are shown as `referenceOnly` nodes rather than receiving invented metadata.

## Consumer proof

The test fixture covers two shapes through the same view contract:

- a VibeGuard-shaped causal explanation containing generic capability and owner overlay nodes;
- a Hacka-shaped bounded context slice containing source, test and contract nodes.

Those names exist only in tests as example generic node kinds. Core view logic contains no consumer-specific branch or policy.
