# Consumers

RepoGraph is shared infrastructure, not a replacement for its consumers.

## 0.0.6 bounded migration boundary

Consumers call `affected`, `slice` or `explain` with repository/ref and compact policy. Index maintenance is implicit. No GraphDocument is passed between consumer and RepoGraph. `test/bounded-consumers.test.ts` proves VibeGuard-shaped capability overlays and Hacka-shaped implementation/validation/contracts/docs selection on the same persisted causal graph. These are consumer-contract fixtures, not claims that either product has shipped this adapter upgrade; real application migration remains #70 and Hacka's own integration work. Older fixtures retain evidence of the transitional graph/protocol contract only.

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


## System loop: intelligence, control and execution

RepoGraph participates in a wider closed loop, but it does not orchestrate that loop.

~~~text
GitHub
  │ durable code / refs / issues / PRs / checks
  ▼
RepoGraph
  │ pinned-revision repository intelligence
  ▼
VibeGuard
  │ Founder + Owner decisions, policy and execution handoff
  ▼
GitHub-native work request
  ▼
HackaTeam (or another execution provider)
  │ commits / PR / validation evidence
  ▼
GitHub
  └── next pinned revision → RepoGraph
~~~

The important boundary is transport versus intelligence:

- GitHub is the durable coordination and event surface.
- RepoGraph derives inspectable facts from a pinned repository state.
- VibeGuard owns human-facing technology governance and product authority.
- HackaTeam owns execution workflow, not governance.

### No RepoGraph control-plane service in the initial architecture

RepoGraph does not need its own GitHub App, webhook receiver, task queue or long-running orchestration service to satisfy the current consumers. VibeGuard and HackaTeam already have GitHub-facing responsibilities and can invoke RepoGraph against an exact ref.

A transport/service layer is justified only if multiple independent consumers later prove they need the same always-on ingestion behavior. Until then, keeping RepoGraph headless avoids duplicated authorization, webhook durability and source-of-truth semantics.

### Cross-consumer identity

The same repository/ref and deterministic RepoGraph schema should produce compatible node/edge identities and provenance whether queried by VibeGuard or HackaTeam. This makes it possible to link:

~~~text
impact evidence
  → durable work request
  → implementation PR
  → validation evidence
~~~

without RepoGraph becoming the owner of that workflow.

Executable compatibility proof: [0.0.3 consumer compatibility](evals/0.0.3-consumer-compatibility.md).

Tracking:
- VibeGuard control-plane direction: https://github.com/ateshgahofmine/VibeGuard/issues/186
- HackaTeam work-request contract: https://github.com/ateshgahofmine/HackaTeam/issues/55
- consumer compatibility proof: https://github.com/SzymonZyrek/RepoGraph/issues/16
- stable external protocol: https://github.com/SzymonZyrek/RepoGraph/issues/20
