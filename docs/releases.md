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

## 0.0.x rule

Until 0.1.0, a 0.0.x release may change experimental APIs, but persisted/exported schema changes still require an explicit schema-version change or migration note. Silent reinterpretation of an existing schema version is not allowed.
