import { execFileSync } from "node:child_process";

import { canonicalJsonUnknown } from "./canonical.js";
import {
  GraphConflictError,
  GraphValidationError,
  buildGraph,
  makeEdge,
  makeNode,
} from "./graph.js";
import type { GitIngestionResult } from "./git.js";
import type {
  EvidenceMethod,
  GraphDiagnostic,
  GraphDocument,
  GraphEdgeInput,
  GraphInput,
  GraphNodeInput,
  Provenance,
} from "./model.js";
import type { ArtifactIdentity } from "./store.js";

export const EXTRACTOR_PROTOCOL_VERSION = "repograph.extractor/v1" as const;

export type ExtractorExecutionBoundary = "in-process" | "external-process";

export interface ExtractorCapabilities {
  nodeKinds: string[];
  edgeKinds: string[];
  evidenceMethods: EvidenceMethod[];
  fidelity: string[];
  boundary: ExtractorExecutionBoundary;
}

export interface ExtractorDescriptor {
  protocolVersion: typeof EXTRACTOR_PROTOCOL_VERSION;
  name: string;
  version: string;
  outputSchemaVersion: string;
  capabilities: ExtractorCapabilities;
}

export interface ExtractorRequest {
  repository: string;
  ref: string;
  commit: string;
  graph: GraphDocument;
  repositoryRoot?: string;
}

export interface ExtractorOutput {
  nodes?: GraphNodeInput[];
  edges?: GraphEdgeInput[];
  diagnostics?: GraphDiagnostic[];
}

export interface ExtractorPlugin {
  descriptor: ExtractorDescriptor;
  extract(request: ExtractorRequest): ExtractorOutput;
}

export interface ExternalProcessExtractorOptions {
  descriptor: ExtractorDescriptor;
  command: string;
  args?: string[];
  exposeRepositoryRoot?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const EXTRACTOR_EVIDENCE_METHODS: readonly EvidenceMethod[] = [
  "source-observation",
  "deterministic-extraction",
  "external-index",
];

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function uniqueSorted(values: readonly string[], label: string): string[] {
  const normalized = values.map((value, index) =>
    nonEmpty(value, `${label}[${index}]`),
  );
  return [...new Set(normalized)].sort();
}

export function normalizeExtractorDescriptor(
  descriptor: ExtractorDescriptor,
): ExtractorDescriptor {
  if (descriptor.protocolVersion !== EXTRACTOR_PROTOCOL_VERSION) {
    throw new TypeError(
      `Unsupported extractor protocol: ${String(descriptor.protocolVersion)}`,
    );
  }

  if (
    descriptor.capabilities.boundary !== "in-process" &&
    descriptor.capabilities.boundary !== "external-process"
  ) {
    throw new TypeError(
      `Unsupported extractor boundary: ${String(descriptor.capabilities.boundary)}`,
    );
  }

  const evidenceMethods = uniqueSorted(
    descriptor.capabilities.evidenceMethods,
    "capabilities.evidenceMethods",
  ) as EvidenceMethod[];
  if (evidenceMethods.length === 0) {
    throw new TypeError("capabilities.evidenceMethods must not be empty");
  }
  for (const method of evidenceMethods) {
    if (!EXTRACTOR_EVIDENCE_METHODS.includes(method)) {
      throw new TypeError(
        `Extractor evidence method is not allowed: ${String(method)}`,
      );
    }
  }

  const fidelity = uniqueSorted(
    descriptor.capabilities.fidelity,
    "capabilities.fidelity",
  );
  if (fidelity.length === 0) {
    throw new TypeError("capabilities.fidelity must not be empty");
  }

  return {
    protocolVersion: EXTRACTOR_PROTOCOL_VERSION,
    name: nonEmpty(descriptor.name, "extractor.name"),
    version: nonEmpty(descriptor.version, "extractor.version"),
    outputSchemaVersion: nonEmpty(
      descriptor.outputSchemaVersion,
      "extractor.outputSchemaVersion",
    ),
    capabilities: {
      nodeKinds: uniqueSorted(
        descriptor.capabilities.nodeKinds,
        "capabilities.nodeKinds",
      ),
      edgeKinds: uniqueSorted(
        descriptor.capabilities.edgeKinds,
        "capabilities.edgeKinds",
      ),
      evidenceMethods,
      fidelity,
      boundary: descriptor.capabilities.boundary,
    },
  };
}

function descriptorKey(descriptor: ExtractorDescriptor): string {
  const normalized = normalizeExtractorDescriptor(descriptor);
  return `${normalized.name}\0${normalized.version}\0${normalized.outputSchemaVersion}`;
}

function requestFor(
  ingestion: GitIngestionResult,
  graph: GraphDocument,
  exposeRepositoryRoot: boolean,
): ExtractorRequest {
  return {
    repository: ingestion.repository,
    ref: ingestion.requestedRef,
    commit: ingestion.commit,
    graph,
    ...(exposeRepositoryRoot
      ? { repositoryRoot: ingestion.repositoryRoot }
      : {}),
  };
}

function graphInput(graph: GraphDocument): Required<GraphInput> {
  return {
    nodes: graph.nodes.map((node) => ({
      identity: node.identity,
      ...(node.metadata === undefined ? {} : { metadata: node.metadata }),
      provenance: node.provenance,
    })),
    edges: graph.edges.map((edge) => ({
      identity: edge.identity,
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
      provenance: edge.provenance,
    })),
    diagnostics: [...graph.diagnostics],
  };
}

function diagnosticProvenance(
  descriptor: ExtractorDescriptor,
  request: ExtractorRequest,
  message: string,
): Provenance {
  return {
    repository: request.repository,
    ref: request.ref,
    commit: request.commit,
    extractor: {
      name: descriptor.name,
      version: descriptor.version,
    },
    origin: "derived",
    method: descriptor.capabilities.evidenceMethods[0]!,
    state: "partial",
    diagnostic: message,
  };
}

function hostDiagnostic(
  descriptor: ExtractorDescriptor,
  request: ExtractorRequest,
  code: string,
  message: string,
): GraphDiagnostic {
  return {
    code,
    message,
    state: "partial",
    provenance: diagnosticProvenance(descriptor, request, message),
  };
}

function provenanceMatches(
  provenance: Provenance,
  descriptor: ExtractorDescriptor,
  request: ExtractorRequest,
): boolean {
  return (
    provenance.repository === request.repository &&
    provenance.ref === request.ref &&
    provenance.commit === request.commit &&
    provenance.origin !== "overlay" &&
    provenance.extractor?.name === descriptor.name &&
    provenance.extractor.version === descriptor.version &&
    descriptor.capabilities.evidenceMethods.includes(provenance.method)
  );
}

function validateFactProvenance(
  values: readonly Provenance[],
  descriptor: ExtractorDescriptor,
  request: ExtractorRequest,
): void {
  if (values.length === 0) {
    throw new GraphValidationError("extractor fact must carry provenance");
  }
  if (
    values.some(
      (provenance) => !provenanceMatches(provenance, descriptor, request),
    )
  ) {
    throw new GraphValidationError(
      "extractor fact provenance does not match descriptor/request",
    );
  }
}

function validateDeclaredKind(
  kind: string,
  declared: readonly string[],
  label: string,
): void {
  if (declared.length > 0 && !declared.includes(kind)) {
    throw new GraphValidationError(
      `${label} kind ${kind} is not declared by extractor capabilities`,
    );
  }
}

function addDiagnostic(
  graph: GraphDocument,
  diagnostic: GraphDiagnostic,
): GraphDocument {
  const input = graphInput(graph);
  return buildGraph({
    ...input,
    diagnostics: [...input.diagnostics, diagnostic],
  });
}

export function applyExtractorOutput(
  graph: GraphDocument,
  descriptorInput: ExtractorDescriptor,
  request: ExtractorRequest,
  output: ExtractorOutput,
): GraphDocument {
  const descriptor = normalizeExtractorDescriptor(descriptorInput);
  let current = graph;

  for (const nodeInput of output.nodes ?? []) {
    try {
      validateDeclaredKind(
        nodeInput.identity.kind,
        descriptor.capabilities.nodeKinds,
        "node",
      );
      validateFactProvenance(nodeInput.provenance, descriptor, request);
      makeNode(nodeInput);
      const input = graphInput(current);
      current = buildGraph({
        ...input,
        nodes: [...input.nodes, nodeInput],
      });
    } catch (error) {
      const conflict = error instanceof GraphConflictError;
      current = addDiagnostic(
        current,
        hostDiagnostic(
          descriptor,
          request,
          conflict ? "extractor-node-conflict" : "extractor-invalid-node",
          `${descriptor.name}@${descriptor.version} node rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  for (const edgeInput of output.edges ?? []) {
    try {
      validateDeclaredKind(
        edgeInput.identity.kind,
        descriptor.capabilities.edgeKinds,
        "edge",
      );
      validateFactProvenance(edgeInput.provenance, descriptor, request);
      makeEdge(edgeInput);
      const input = graphInput(current);
      current = buildGraph({
        ...input,
        edges: [...input.edges, edgeInput],
      });
    } catch (error) {
      const conflict = error instanceof GraphConflictError;
      current = addDiagnostic(
        current,
        hostDiagnostic(
          descriptor,
          request,
          conflict ? "extractor-edge-conflict" : "extractor-invalid-edge",
          `${descriptor.name}@${descriptor.version} edge rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  for (const item of output.diagnostics ?? []) {
    try {
      if (item.provenance === undefined) {
        throw new GraphValidationError(
          "extractor diagnostic must carry provenance",
        );
      }
      validateFactProvenance([item.provenance], descriptor, request);
      current = addDiagnostic(current, item);
    } catch (error) {
      current = addDiagnostic(
        current,
        hostDiagnostic(
          descriptor,
          request,
          "extractor-invalid-diagnostic",
          `${descriptor.name}@${descriptor.version} diagnostic rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  return current;
}

export function runExtractors(
  ingestion: GitIngestionResult,
  plugins: readonly ExtractorPlugin[],
): GraphDocument {
  const baseGraph = ingestion.graph;
  let graph = baseGraph;

  const normalized = plugins
    .map((plugin) => ({
      plugin,
      descriptor: normalizeExtractorDescriptor(plugin.descriptor),
    }))
    .sort((left, right) =>
      descriptorKey(left.descriptor).localeCompare(
        descriptorKey(right.descriptor),
      ),
    );

  for (const { plugin, descriptor } of normalized) {
    const request = requestFor(ingestion, baseGraph, true);
    try {
      const output = plugin.extract(request);
      graph = applyExtractorOutput(graph, descriptor, request, output);
    } catch (error) {
      graph = addDiagnostic(
        graph,
        hostDiagnostic(
          descriptor,
          request,
          "extractor-failed",
          `${descriptor.name}@${descriptor.version} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  return graph;
}

export function extractorArtifactIdentity(
  descriptorInput: ExtractorDescriptor,
  input: Omit<ArtifactIdentity, "extractor">,
): ArtifactIdentity {
  const descriptor = normalizeExtractorDescriptor(descriptorInput);
  return {
    ...input,
    extractor: {
      name: descriptor.name,
      version: descriptor.version,
    },
  };
}

function parseWireOutput(value: unknown): {
  descriptor: ExtractorDescriptor;
  output: ExtractorOutput;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("external extractor response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.descriptor !== "object" ||
    record.descriptor === null ||
    Array.isArray(record.descriptor)
  ) {
    throw new TypeError("external extractor response descriptor is missing");
  }
  if (
    typeof record.output !== "object" ||
    record.output === null ||
    Array.isArray(record.output)
  ) {
    throw new TypeError("external extractor response output is missing");
  }

  return {
    descriptor: normalizeExtractorDescriptor(
      record.descriptor as ExtractorDescriptor,
    ),
    output: record.output as ExtractorOutput,
  };
}

export function createExternalProcessExtractor(
  options: ExternalProcessExtractorOptions,
): ExtractorPlugin {
  const descriptor = normalizeExtractorDescriptor(options.descriptor);
  if (descriptor.capabilities.boundary !== "external-process") {
    throw new TypeError(
      "external process extractor must declare external-process boundary",
    );
  }
  const args = [...(options.args ?? [])];
  const timeout = options.timeoutMs ?? 30_000;
  const maxBuffer = options.maxOutputBytes ?? 16 * 1024 * 1024;

  return {
    descriptor,
    extract(request) {
      const wireRequest = {
        protocolVersion: EXTRACTOR_PROTOCOL_VERSION,
        repository: request.repository,
        ref: request.ref,
        commit: request.commit,
        graph: request.graph,
        ...(options.exposeRepositoryRoot === true &&
        request.repositoryRoot !== undefined
          ? { repositoryRoot: request.repositoryRoot }
          : {}),
      };

      const stdout = execFileSync(options.command, args, {
        input: `${canonicalJsonUnknown(wireRequest)}\n`,
        encoding: "utf8",
        timeout,
        maxBuffer,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parsed = parseWireOutput(JSON.parse(stdout) as unknown);

      if (
        canonicalJsonUnknown(parsed.descriptor) !==
        canonicalJsonUnknown(descriptor)
      ) {
        throw new TypeError(
          "external extractor response descriptor does not match configured descriptor",
        );
      }
      return parsed.output;
    },
  };
}
