# External protocol v1

RepoGraph 0.0.4 exposes a versioned JSON protocol for consumers that should not depend on internal TypeScript object shapes or convenience CLI commands.

The stable wire version is:

```text
repograph.protocol/v1
```

The TypeScript library and the `repograph protocol` CLI command use the same parser and executor.

## Discovery and negotiation

`repograph protocol-info` prints the current protocol metadata:

- protocol version;
- RepoGraph release version;
- graph schema version;
- supported features and their stability status;
- default and hard traversal limits.

Programmatic callers can use `protocolInfo()` and `negotiateProtocol()`.

An `info` request may include `acceptedProtocolVersions`. RepoGraph reports the current version when compatible, or `null` when there is no match.

Unknown additive fields are ignored within protocol v1. A breaking request/response change requires a new protocol major such as `repograph.protocol/v2`.

## Request operations

### info

```json
{
  "operation": "info",
  "requestId": "optional-correlation-id",
  "acceptedProtocolVersions": ["repograph.protocol/v1"]
}
```

### slice

```json
{
  "protocolVersion": "repograph.protocol/v1",
  "operation": "slice",
  "requestId": "impact-123",
  "graph": { "...": "repograph.graph/v1 document" },
  "start": "node:stable-id",
  "policy": { "...": "repograph.traversal-policy/v1 document" }
}
```

The policy is optional. When omitted, the protocol applies bounded defaults rather than the larger internal traversal defaults.

### explain

```json
{
  "protocolVersion": "repograph.protocol/v1",
  "operation": "explain",
  "graph": { "...": "repograph.graph/v1 document" },
  "from": "node:source-id",
  "to": "node:target-id",
  "policy": { "...": "repograph.traversal-policy/v1 document" }
}
```

## Hard bounds

The protocol is intentionally bounded:

- default depth: 6;
- default returned traversal nodes: 200;
- maximum depth: 64;
- maximum returned traversal nodes: 1000.

Requests above the hard bounds return `invalid-request`.

These limits are protocol constraints, not graph-kernel limits. Library consumers that deliberately need broader internal traversal can still call lower-level APIs directly.

## Response envelope

Every protocol response contains:

- `protocolVersion`;
- `releaseVersion`;
- `ok`;
- optional echoed `requestId`;
- either `data` or `error`.

Protocol failures are machine-readable:

```json
{
  "protocolVersion": "repograph.protocol/v1",
  "releaseVersion": "<VERSION.txt-derived-release>",
  "ok": false,
  "error": {
    "code": "unsupported-protocol",
    "message": "..."
  }
}
```

The CLI writes protocol envelopes to stdout. A valid protocol request that returns `ok:false` exits with status 2. Malformed CLI invocation or malformed request-file JSON still uses the existing CLI stderr error envelope.

## Presentation DTO

`slice` and `explain` do not return an unbounded raw graph dump.

Nodes are normalized to generic repository facts:

- stable id;
- namespace;
- kind;
- key;
- optional generic metadata;
- provenance.

Edges expose:

- stable id;
- kind;
- from/to ids;
- optional key and generic metadata;
- provenance.

Causal explanation hops additionally preserve the provenance that matched the traversal policy.

The DTO contains no VibeGuard capability wording, Owner/review decisions, Founder confirmation state or Hacka execution state. Consumers supply their own labels and actions.

## Availability, partial and truncated state

A missing start/target node or a missing causal path is a successful protocol operation with `availability: "unavailable"` and a machine-readable reason. This lets inspection UIs distinguish unavailable evidence from a broken protocol request.

Slices also report `partial` and `truncated` explicitly.

## Compatibility policy

Within `repograph.protocol/v1`:

- existing required fields keep their meaning;
- new optional fields may be added;
- new feature names may be advertised;
- consumers must ignore unknown optional fields;
- stable feature semantics are not silently reinterpreted.

Breaking wire changes require a new protocol major. Deprecated features remain discoverable with `status: "deprecated"` for at least one pre-1.0 engineering milestone before removal, unless a security/correctness issue makes continued support unsafe.

The TypeScript library outside this wire contract remains 0.0.x experimental until 1.0.0.

## CLI examples

Feature discovery:

```bash
node dist/src/cli.js protocol-info
```

Request from a file:

```bash
node dist/src/cli.js protocol --request request.json
```

Request over stdin:

```bash
cat request.json | node dist/src/cli.js protocol --request -
```

The same request can be executed in-process with `executeProtocolRequest(request)`.
