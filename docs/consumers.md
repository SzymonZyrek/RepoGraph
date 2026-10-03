# Consumers

RepoGraph is shared infrastructure, not a replacement for its consumers.

## VibeGuard

VibeGuard is the product interface for Founders and Owners: it understands capabilities, confirmed configuration, ownership and review routing.

### VibeGuard keeps authority over

- capability definitions and topology;
- Founder-confirmed path rules;
- ownership lifecycle;
- review-routing policy;
- product actions and wording.

### RepoGraph provides

- files, modules, symbols and contracts;
- dependency edges and causal paths;
- affected slices after a change;
- provenance and incremental reuse.

VibeGuard maps its confirmed capability topology into generic overlays, then combines those overlays with repository evidence. A changed file may be connected to a capability through a module chain, but the extracted chain is evidence — not an automatic ownership decision.

The normal UI stays compact:

~~~text
changed file → module/dependency chain → capability → Owner/review outcome
~~~

The full evidence slice is an optional drill-down. VibeGuard must not build a competing dependency graph or expose raw graph serialization.

Tracking: [VibeGuard #182](https://github.com/ateshgahofmine/VibeGuard/issues/182), [#149](https://github.com/ateshgahofmine/VibeGuard/issues/149), [#152](https://github.com/ateshgahofmine/VibeGuard/issues/152).

## HackaTeam

HackaTeam uses RepoGraph as an optional, deterministic source for task context and validation selection.

### HackaTeam keeps authority over

- task selection and Tick/ExecuteTask semantics;
- context budgets;
- GitHub coordination state;
- the final choice of what to execute.

### RepoGraph provides

- a pinned-ref graph query;
- relevant implementation, tests and contracts;
- affected slices and causal explanations;
- provenance attached to evidence items.

Hacka consumes the CLI/JSON contract and translates returned facts into an evidence packet. If RepoGraph is unavailable, it falls back to direct repository inspection; it does not block unrelated work or introduce a hidden task database.

Tracking: [HackaTeam #54](https://github.com/ateshgahofmine/HackaTeam/issues/54).

## Shared presentation, later

Both products may eventually use an optional read-only graph renderer. That renderer is only a view of the same bounded graph-slice contract:

- RepoGraph owns generic rendering mechanics;
- consumers supply their own labels, destinations and inspector content;
- VibeGuard's capability/Owner/review UX stays in VibeGuard;
- Hacka has no requirement to use a visual renderer.

This extraction happens only after consumer proofs establish a stable contract: [RepoGraph #21](https://github.com/SzymonZyrek/RepoGraph/issues/21).
