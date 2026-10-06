# RepoGraph

Bounded causal repository intelligence from exact Git revisions. RepoGraph owns facts and causal queries; consumers own capability, review, task and test-execution policy.

This is a pre-public 0.0.7 engineering milestone. There is one current contract. Superseded graph-building, snapshot, migration and graph-bearing protocol systems are removed. Breaking changes are expected through 1.0.0; compatibility promises may start only afterward.

```ts
import { affected, explain } from '@repograph/core';
const repository = { repositoryPath: '/checkout', repository: 'owner/repo', ref: commitSha };
const answer = await affected(repository, ['src/model.py']);
const why = await explain(repository, 'artifact:src/model.py', 'artifact:tests/model.test.py');
```

```sh
repograph version
repograph index --repo . --ref HEAD
repograph affected --repo . --ref HEAD --changed src/model.py
repograph slice --repo . --ref HEAD --start artifact:src/model.py --direction in
repograph explain --repo . --ref HEAD --from artifact:src/model.py --to artifact:docs/api.md
```

Queries ensure the requested revision is indexed in an embedded, disk-backed LadybugDB store. Results contain only bounded Artifact/Boundary nodes, DEPENDS_ON/CONTAINS edges and selected provider evidence. Partial/truncated answers are explicit; an empty answer does not imply safety.

Supported runtimes: Node 22 or 24 on Windows x64 and Linux x64. Other Node versions/platforms are unverified. Toolchains are never silently installed or executed. See [provider configuration and query semantics](docs/bounded-queries.md).

Build and verify with `npm ci` and `npm run ci`. Produce a distributable tarball with `npm run package:pack`; prove an empty external consumer with `npm run package:proof`. Install the resulting `.cache/package/repograph-core-0.0.7.tgz` using `npm install /absolute/path/to/artifact.tgz`. No npm publication or 1.0 release is claimed.

Public root: VERSION, CAUSAL_SCHEMA, artifact, boundary, indexRepository, affected, slice, explain and their declared types. Advanced normalization helpers are confined to `@repograph/core/providers`; the optional read-only model is `@repograph/core/view`. Native storage details are not exported. See [release gates](docs/releases.md) and [consumer evidence](docs/consumers.md).
