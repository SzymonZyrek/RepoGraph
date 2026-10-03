# Releases and versioning

## Version source of truth

`VERSION.txt` is the only hand-edited semantic version.

Build, typecheck and lint workflows generate `src/generated-version.ts` from that file. The generated file is ignored by Git and must never be edited or treated as a second version source.

The CLI reports the generated value through `repograph version`.

## Release notes contract

Every released version must have a `CHANGELOG.md` entry containing:

- the version;
- the release date;
- user-visible additions and behavior changes;
- compatibility or schema notes;
- migration/deprecation notes when relevant;
- the GitHub issues or pull requests that provide implementation evidence.

A release note must distinguish graph/schema compatibility from consumer-product behavior. RepoGraph release notes do not claim VibeGuard or Hacka policy changes unless those consumers explicitly ship them.

## Public release policy

All 0.0.x versions are pre-public engineering milestones. They exist to prove contracts and economics quickly; they are not public-launch candidates.

The first public release is **1.0.0**. Its criteria are evidence-driven and should be derived from consumer proofs, compatibility requirements and operational behavior after the pre-1.0 roadmap has stabilized.

## 0.0.x rule

A 0.0.x release may change experimental APIs, but persisted/exported schema changes still require an explicit schema-version change or migration note. Silent reinterpretation of an existing schema version is not allowed.


## External protocol compatibility

The versioned JSON wire contract is independent from the package semantic version.

Within a protocol major such as `repograph.protocol/v1`, changes are additive: existing required fields and stable feature semantics keep their meaning, while new optional fields or advertised features may be added. Breaking wire changes require a new protocol major and must be discoverable through `protocol-info`.

A protocol feature marked `deprecated` remains discoverable for at least one pre-1.0 engineering milestone before removal unless keeping it would preserve a security or correctness defect.

Release artifacts consumed by external callers must expose the same `VERSION.txt`-derived release version through both the TypeScript library and CLI protocol metadata. The stable protocol is the supported cross-process boundary; convenience CLI command output outside that protocol remains pre-1.0 experimental unless separately documented.
