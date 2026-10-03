# RepoGraph

RepoGraph builds a deterministic graph from a **local Git repository at an exact commit**. It exposes the same graph/query engine as a TypeScript library and a JSON CLI. Git is authoritative; exported graphs are disposable snapshots.

Version 0.0.1 represents repository structure and explicit path rules. It does not parse imports, infer code dependencies, assign ownership, run repository code, fetch remote repositories or maintain a cache.

## Requirements and installation

Node.js 24 or newer, npm, and Git on PATH. Build and install the tarball:

```sh
npm ci
npm run build
npm pack
# Run this in your consumer project; adjust the tarball location.
npm install /path/to/szymonzyrek-repograph-0.0.1.tgz
```

The package contains ESM, TypeScript declarations and the `repograph` executable. It is not published to a registry as part of this release. Package version comes exclusively from `package.json`.

## CLI examples

After installing the tarball, run against a local Git repository:

```sh
repograph --version
repograph build --repo . --repo-id example/project --ref HEAD > graph.json
repograph neighbors --graph graph.json --node README.md
repograph reverse-neighbors --graph graph.json --node README.md
repograph affected --graph graph.json --seed README.md
# Walk structural parents explicitly:
repograph affected --graph graph.json --seed README.md --edge-type contains
# Explain the reverse path from a file to the repository node:
# Obtain the repository node ID from graph.json and replace REPOSITORY_NODE_ID.
repograph explain --graph graph.json --from README.md --to REPOSITORY_NODE_ID --direction reverse --edge-type contains
```

`--ref` is resolved once to a full commit SHA. Branch names and tags are accepted, but pin a full SHA for evidence intended to remain reproducible. `--repo-id` is a stable caller-assigned namespace; use the same ID across clones and commits. Local filesystem paths and requested ref spelling are not serialized.

Queries accept node IDs or exact case-sensitive paths. `--seed` and `--edge-type` can repeat. Include/exclude flags also repeat. With the installed CLI, the executable resolves through npm's normal bin shim on Windows and Unix. From a source checkout, use `node dist/cli.js` after building.

Machine results are JSON on stdout. Errors are JSON on stderr, with exit code 1 and empty stdout:

```json
{"code":"UNKNOWN_NODE","message":"Node ID or path is not present in this snapshot","details":{"node":"missing.ts"}}
```

Other error codes include `INVALID_ARGUMENTS`, `INVALID_INPUT`, `INVALID_RULES`, `INVALID_PATTERN`, `INPUT_READ_FAILED`, `GIT_UNAVAILABLE`, `GIT_FAILED`, `INVALID_GRAPH`, `INVALID_ID`, `INVALID_PROVENANCE`, `DUPLICATE_ID`, `DANGLING_EDGE`, `FACT_CONFLICT` and `UNSUPPORTED_PATH_ENCODING`. Git stderr and local paths are not copied into exported errors. `--help` prints usage; `--version` prints the package version.

## Library

```ts
import {
  buildGraph, serializeGraph, loadGraph, affected,
  neighbors, reverseNeighbors, explainPath
} from '@szymonzyrek/repograph';

const document = await buildGraph({
  repoPath: '.', repoId: 'example/project', ref: 'HEAD',
  rules: {
    schemaVersion: 1,
    rules: [{ id: 'documentation', pattern: '**/*.md', metadata: { label: 'docs' } }]
  }
});
const graph = loadGraph(serializeGraph(document));
const impact = affected(graph, ['README.md']);
const immediate = reverseNeighbors(graph, 'README.md', { edgeTypes: ['applies_to'] });
const rule = immediate.find(item => item.node.type === 'rule');
if (rule) {
  const explanation = explainPath(graph, rule.node.id, 'README.md', {
    direction: 'forward', edgeTypes: ['applies_to']
  });
  console.log(explanation);
}
console.log(impact, neighbors(graph, 'README.md'));
```

`loadGraph` accepts JSON text or a document object and returns a validated `LoadedGraph` with adjacency indexes built once. Loaded records and arrays are frozen; do not mutate index maps. `buildGraph` returns a document; use `loadGraph` before queries. `GraphBuilder`, `nodeId` and `edgeId` support constructing generic graph fixtures with the same contract and duplicate convergence.

## Graph contract and query meaning

The schema-v1 document contains `producerVersion`, `repository: { id, commit }`, `policy`, `nodes`, `edges` and `diagnostics`. Nodes have `id`, `type`, `key`, `classification`, `metadata`, `provenance`. Edges additionally have `from`, `to`, `qualifier`. All metadata must be finite JSON values. Unknown fields and unsupported schema versions fail validation.

Built-in nodes: `repository`, `directory`, `file`, `gitlink`, `rule`. IDs are SHA-256 hashes of explicit identity tuples, prefixed with `n:` or `e:`. File identity is repository/type/path, not blob or commit: a rename changes the node ID while retaining `metadata.blobOid`. Modifying a file retains its ID but changes its snapshot facts. Directory paths are derived from included leaf paths. Git does not ordinarily track empty directories.

Each fact has one or more provenance records with `repoId`, full `commit`, `extractor`, `extractorVersion`, and optional `path`, `blobOid`, `source`, `line`, `index`. Source facts come directly from Git or explicit rules. Derived facts are rule matches. For CODEOWNERS edges, path/blob/line identify the rule source; the edge's target identifies the matched entry. Inline JSON rules identify their source by `inline-json` and array index, and their full content is retained in the policy.

Relations have distinct meanings:

| Relation | Direction | Meaning |
| --- | --- | --- |
| `contains` | repository/directory → directory/file/gitlink | Git tree structure |
| `applies_to` | rule → file/gitlink | Explicit path pattern match |

`neighbors` and `reverseNeighbors` return `{ node, edge }` pairs; no filter means all relations. `affected` returns `{ seeds, nodes, edges }`, including the seeds, and traverses reverse `applies_to` by default. Explicit `edgeTypes` replaces the default; an empty array visits only seeds. It returns graph reachability, not inferred code impact. `contains` must be requested explicitly for structural closure.

`explainPath` uses BFS, defaults to forward traversal over all relations, and returns `{ found, nodes, edges }`. It provides one shortest path with full fact provenance. Ties use ordinal node ID, then edge ID; cycles terminate. A missing path returns `found: false` with empty arrays. Unknown endpoints fail explicitly. The source-to-itself path contains that node and no edges.

Serialization sorts object keys, facts, diagnostic records and provenance, removes repeated provenance, and preserves meaningful rule order. No timestamps or absolute checkout paths appear. Identical facts converge through `GraphBuilder`; incompatible payloads under the same ID fail. Loading an exported document with duplicate IDs or dangling edges also fails.

## Filters and rules

```json
{
  "schemaVersion": 1,
  "rules": [
    { "id": "documentation", "pattern": "**/*.md", "metadata": { "label": "docs" } },
    { "id": "source", "pattern": "src/**" }
  ]
}
```

```sh
repograph build --repo . --repo-id example/project --ref HEAD --rules rules.json --include 'src/**' --include '**/*.md' --exclude 'vendor/**' > graph.json
```

JSON/filter globs use picomatch, match dotfiles, are case-sensitive and repository-relative. Use `**` for recursive matching. Leading `/`, negation, backslashes and `..` path segments are rejected; extglob operators are disabled. Include is a union; no include patterns means all entries. Exclude wins. Filters run before creating file nodes and matches; required ancestor directories remain. `policy` records filters and omitted leaf-entry count. Separate JSON rules match independently; no last-match policy is applied to them.

CODEOWNERS is discovered from the pinned commit in GitHub order: `.github/CODEOWNERS`, root `CODEOWNERS`, then `docs/CODEOWNERS`; only the first regular file is used. Symlinks are not followed. Rules use gitignore-like path semantics (`*`, `?`, `**`, anchored paths and directory suffixes), not the JSON glob dialect. The last valid matching line wins. A rule with no owners is retained and can override a previous match. Escaped spaces in patterns are supported; negation, character ranges, escaping `#` and invalid double-star segments produce diagnostics and are skipped. Files of 3 MB or more produce a diagnostic and no rules.

Owner tokens are preserved as plain metadata. RepoGraph does not contact GitHub to validate users, teams or permissions. JSON and CODEOWNERS rules have separate identities. CODEOWNERS is read even when its path is excluded from graph file nodes, because it is a rule input. Use `--no-codeowners` or `codeowners: false` to disable it.

For example, CODEOWNERS `docs/*` matches direct files, while `/docs/` includes descendants recursively. See [GitHub's CODEOWNERS syntax](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) for the reference semantics; identity/permission validation remains the consumer's responsibility.

## Git behavior and limitations

- Read committed trees through NUL-delimited Git output, never through working-tree file traversal. Dirty/untracked files do not affect results. Only rule blobs are read; normal binary/vendor/generated content is not parsed. Use explicit filters to omit unwanted nodes.
- Symlinks retain mode `120000` and the link blob OID, without following the target. Submodules retain a `gitlink` node and target commit, without fetching or walking their contents.
- Git SHA-1 and SHA-256 OIDs are accepted. Paths must be valid UTF-8; unsupported byte encodings fail instead of silently colliding. Case, spaces, tabs, newlines and Unicode are preserved.
- Git replacement objects and ambient `GIT_*` routing variables are ignored. The caller supplies the local repository/ref. No remote operations, services or repository hooks are invoked.
- This release has no persistent incremental state, import/call analysis, plugin runtime, cross-repository resolution, ownership policy or traversal budgets. Large graph ingestion/traversal currently operates in memory.

## Development and acceptance

```sh
npm ci
npm run check
```

`check` runs lint, strict type checking, unit/integration tests with coverage, build and installed-package smoke. Coverage minimums are 85% statements/lines/functions and 80% branches across production code. CI runs the full gate on Linux and tests/build/installed-package smoke on Windows. The smoke packs and installs the package into a temporary consumer, checks both library and CLI, and leaves the tarball at the repository root.

Fixtures cover deterministic identity and serialization, provenance, invalid schema/facts, graph cycles and shortest-path ties, pinned Git reads, rename/blob reuse, CODEOWNERS precedence, filters, symlinks, submodules and Unicode. See [CHANGELOG.md](CHANGELOG.md) for the release notes contract. Later releases add static dependencies, incremental reuse and consumer overlays; 0.0.1 should not be treated as those features.
