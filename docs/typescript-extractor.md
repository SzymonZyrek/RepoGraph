# TypeScript / JavaScript dependency extractor (0.0.2)

RepoGraph's first language-aware extractor provides deterministic module/import evidence for TS and JS repositories. It is deliberately narrower than compiler-grade code intelligence.

## Facts

For each included TS/JS source file RepoGraph adds:

- a `module` node;
- a `source-file` edge from module to the underlying Git file node;
- resolved `imports` edges between repository modules;
- exported `symbol` nodes and `exports` edges.

The module → file direction is intentional: reverse traversal from a changed file reaches its module and then modules that import it.

## Syntax covered

The extractor recognizes:

- ESM `import ... from`;
- side-effect imports;
- `export ... from`;
- `require("...")`;
- static-string `import("...")`;
- named/default TS/ES exports;
- common `exports.name = ...` and `module.exports.name = ...` assignments.

Dynamic expressions whose module target is not a static string are not converted into guessed edges.

## Resolution

0.0.2 resolves:

- relative repository imports;
- TS-style `.js` specifiers to matching `.ts/.tsx` sources;
- extensionless file/index imports;
- nearest `tsconfig*.json` `baseUrl`;
- `compilerOptions.paths` aliases, with more-specific patterns before broad wildcards.

External packages, built-ins and otherwise unresolved targets produce an explicit `ts-import-unresolved` diagnostic instead of a lower-quality edge.

`tsconfig extends` and project references are not recursively expanded in 0.0.2. Their presence is reported as `partial` diagnostics so consumers can see the fidelity boundary.

## Incremental extraction

Module syntax is cached by:

- Git blob identity;
- extractor version;
- TypeScript parser version;
- syntax artifact schema version.

A changed commit therefore reparses changed blobs while unchanged source blobs reuse their syntax artifacts. Resolution and graph assembly remain deterministic for the pinned snapshot.

## API

~~~ts
const structural = ingestGitRepository({
  repositoryPath,
  ref,
  repository,
});

const result = extractTypeScriptDependencies({
  repositoryPath,
  ref,
  repository,
  graph: structural.graph,
  store,
});
~~~

## CLI

~~~bash
node dist/src/cli.js build-ts \
  --repo . \
  --ref HEAD \
  --repository github.com/SzymonZyrek/RepoGraph \
  --cache-dir .repograph-cache
~~~

The command emits deterministic JSON containing the enriched graph and extraction metrics.

## Non-goals

This extractor does not attempt a whole-program call graph, runtime dispatch modeling or universal language indexing. More precise external evidence belongs behind the versioned extractor/evidence boundary planned in #17.
