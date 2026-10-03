import type {
  ProtocolEdgeDto,
  ProtocolExplanationDto,
  ProtocolNodeDto,
  ProtocolProvenanceDto,
  ProtocolSliceDto,
  ProtocolUnavailable,
} from "./protocol.js";

export const GRAPH_VIEW_SCHEMA_VERSION = "repograph.view/v1" as const;

export type GraphViewInput = ProtocolSliceDto | ProtocolExplanationDto;

export interface GraphViewEvidence {
  origins: string[];
  methods: string[];
  states: string[];
  authorities: string[];
}

export interface GraphViewNode {
  id: string;
  kind: string;
  key: string;
  label: string;
  x: number;
  y: number;
  referenceOnly: boolean;
  causal: boolean;
  evidence: GraphViewEvidence;
  target?: string;
}

export interface GraphViewEdge {
  id: string;
  kind: string;
  from: string;
  to: string;
  causal: boolean;
  evidence: GraphViewEvidence;
}

export interface GraphViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphViewModel {
  schemaVersion: typeof GRAPH_VIEW_SCHEMA_VERSION;
  inputType: GraphViewInput["type"];
  availability: GraphViewInput["availability"];
  partial: boolean;
  truncated: boolean;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  bounds: GraphViewBounds;
  unavailable?: ProtocolUnavailable;
}

export interface GraphViewOptions {
  label?: (node: ProtocolNodeDto | undefined, id: string) => string | undefined;
  target?: (node: ProtocolNodeDto | undefined, id: string) => string | undefined;
  onOpen?: (node: GraphViewNode) => void;
  horizontalGap?: number;
  verticalGap?: number;
}

export interface GraphViewViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphViewSnapshot {
  model: GraphViewModel;
  viewport: GraphViewViewport;
  selectedNodeId?: string;
}

export interface RenderGraphViewOptions {
  width?: number;
  height?: number;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 56;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function evidence(values: readonly ProtocolProvenanceDto[]): GraphViewEvidence {
  return {
    origins: uniqueSorted(values.map((value) => value.origin)),
    methods: uniqueSorted(values.map((value) => value.method)),
    states: uniqueSorted(values.map((value) => value.state)),
    authorities: uniqueSorted(
      values.flatMap((value) =>
        value.authority === undefined ? [] : [value.authority],
      ),
    ),
  };
}

function metadataLabel(node: ProtocolNodeDto): string | undefined {
  const label = node.metadata?.label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

function inputEdges(input: GraphViewInput): ProtocolEdgeDto[] {
  if (input.type === "graph-slice") return [...input.edges];
  const byId = new Map<string, ProtocolEdgeDto>();
  for (const hop of input.hops) byId.set(hop.edge.id, hop.edge);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function causalEdgeIds(input: GraphViewInput): Set<string> {
  return input.type === "causal-explanation"
    ? new Set(input.hops.map((hop) => hop.edge.id))
    : new Set<string>();
}

function rootId(input: GraphViewInput): string {
  return input.type === "graph-slice" ? input.start : input.from;
}

function causalNodeIds(input: GraphViewInput): Set<string> {
  if (input.type !== "causal-explanation") return new Set<string>();
  const ids = new Set<string>([input.from, input.to]);
  for (const hop of input.hops) {
    ids.add(hop.fromNodeId);
    ids.add(hop.toNodeId);
  }
  return ids;
}

function positiveFinite(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new TypeError(label + " must be a positive finite number");
  }
  return result;
}

function layoutDepths(
  root: string,
  nodeIds: readonly string[],
  edges: readonly ProtocolEdgeDto[],
): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  for (const id of nodeIds) adjacency.set(id, new Set<string>());
  for (const edge of edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }

  const depth = new Map<string, number>();
  if (adjacency.has(root)) {
    depth.set(root, 0);
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const nextDepth = (depth.get(current) ?? 0) + 1;
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) {
        if (depth.has(neighbor)) continue;
        depth.set(neighbor, nextDepth);
        queue.push(neighbor);
      }
    }
  }

  const maxDepth = Math.max(-1, ...depth.values());
  for (const id of [...nodeIds].sort()) {
    if (!depth.has(id)) depth.set(id, maxDepth + 1);
  }
  return depth;
}

function emptyBounds(): GraphViewBounds {
  return { x: 0, y: 0, width: 1, height: 1 };
}

export function createGraphViewModel(
  input: GraphViewInput,
  options: GraphViewOptions = {},
): GraphViewModel {
  if (input.availability === "unavailable") {
    return {
      schemaVersion: GRAPH_VIEW_SCHEMA_VERSION,
      inputType: input.type,
      availability: input.availability,
      partial: input.partial,
      truncated: input.truncated,
      nodes: [],
      edges: [],
      bounds: emptyBounds(),
      ...(input.unavailable === undefined ? {} : { unavailable: input.unavailable }),
    };
  }

  const horizontalGap = positiveFinite(options.horizontalGap, 260, "horizontalGap");
  const verticalGap = positiveFinite(options.verticalGap, 110, "verticalGap");
  const sourceNodes = new Map(input.nodes.map((node) => [node.id, node]));
  const edges = inputEdges(input);
  const ids = new Set(input.nodes.map((node) => node.id));
  ids.add(rootId(input));
  for (const edge of edges) {
    ids.add(edge.from);
    ids.add(edge.to);
  }

  const depths = layoutDepths(rootId(input), [...ids], edges);
  const grouped = new Map<number, string[]>();
  for (const id of [...ids].sort()) {
    const depth = depths.get(id) ?? 0;
    grouped.set(depth, [...(grouped.get(depth) ?? []), id]);
  }

  const causalNodes = causalNodeIds(input);
  const nodes: GraphViewNode[] = [];
  for (const [depth, group] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...group].sort();
    ordered.forEach((id, index) => {
      const source = sourceNodes.get(id);
      const label =
        options.label?.(source, id) ??
        (source === undefined ? id : metadataLabel(source) ?? source.key);
      const target = options.target?.(source, id);
      nodes.push({
        id,
        kind: source?.kind ?? "reference",
        key: source?.key ?? id,
        label,
        x: depth * horizontalGap,
        y: index * verticalGap,
        referenceOnly: source === undefined,
        causal: causalNodes.has(id),
        evidence: evidence(source?.provenance ?? []),
        ...(target === undefined ? {} : { target }),
      });
    });
  }

  const causalEdges = causalEdgeIds(input);
  const viewEdges: GraphViewEdge[] = edges
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      causal: causalEdges.has(edge.id),
      evidence: evidence(edge.provenance),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (nodes.length === 0) {
    return {
      schemaVersion: GRAPH_VIEW_SCHEMA_VERSION,
      inputType: input.type,
      availability: input.availability,
      partial: input.partial,
      truncated: input.truncated,
      nodes,
      edges: viewEdges,
      bounds: emptyBounds(),
    };
  }

  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT));

  return {
    schemaVersion: GRAPH_VIEW_SCHEMA_VERSION,
    inputType: input.type,
    availability: input.availability,
    partial: input.partial,
    truncated: input.truncated,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: viewEdges,
    bounds: {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    },
  };
}

function paddedViewport(bounds: GraphViewBounds, padding: number): GraphViewViewport {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new TypeError("padding must be a non-negative finite number");
  }
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: Math.max(1, bounds.width + padding * 2),
    height: Math.max(1, bounds.height + padding * 2),
  };
}

export class GraphViewController {
  readonly model: GraphViewModel;
  private readonly options: GraphViewOptions;
  private viewportState: GraphViewViewport;
  private selected: string | undefined;

  constructor(input: GraphViewInput, options: GraphViewOptions = {}) {
    this.options = options;
    this.model = createGraphViewModel(input, options);
    this.viewportState = paddedViewport(this.model.bounds, 32);
  }

  snapshot(): GraphViewSnapshot {
    return {
      model: this.model,
      viewport: { ...this.viewportState },
      ...(this.selected === undefined ? {} : { selectedNodeId: this.selected }),
    };
  }

  select(nodeId?: string): GraphViewSnapshot {
    if (
      nodeId !== undefined &&
      !this.model.nodes.some((node) => node.id === nodeId)
    ) {
      throw new TypeError("Unknown view node: " + nodeId);
    }
    this.selected = nodeId;
    return this.snapshot();
  }

  panBy(dx: number, dy: number): GraphViewSnapshot {
    if (![dx, dy].every(Number.isFinite)) {
      throw new TypeError("pan delta must be finite");
    }
    this.viewportState = {
      ...this.viewportState,
      x: this.viewportState.x + dx,
      y: this.viewportState.y + dy,
    };
    return this.snapshot();
  }

  zoomBy(factor: number, centerX?: number, centerY?: number): GraphViewSnapshot {
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new TypeError("zoom factor must be a positive finite number");
    }
    const cx = centerX ?? this.viewportState.x + this.viewportState.width / 2;
    const cy = centerY ?? this.viewportState.y + this.viewportState.height / 2;
    if (![cx, cy].every(Number.isFinite)) {
      throw new TypeError("zoom center must be finite");
    }
    const width = this.viewportState.width / factor;
    const height = this.viewportState.height / factor;
    const xRatio = (cx - this.viewportState.x) / this.viewportState.width;
    const yRatio = (cy - this.viewportState.y) / this.viewportState.height;
    this.viewportState = {
      x: cx - width * xRatio,
      y: cy - height * yRatio,
      width,
      height,
    };
    return this.snapshot();
  }

  fit(padding = 32): GraphViewSnapshot {
    this.viewportState = paddedViewport(this.model.bounds, padding);
    return this.snapshot();
  }

  open(nodeId?: string): boolean {
    const id = nodeId ?? this.selected;
    if (id === undefined || this.options.onOpen === undefined) return false;
    const node = this.model.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) throw new TypeError("Unknown view node: " + id);
    this.options.onOpen(node);
    return true;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function number(value: number): string {
  return Number(value.toFixed(3)).toString();
}

export function renderGraphViewSvg(
  snapshot: GraphViewSnapshot,
  options: RenderGraphViewOptions = {},
): string {
  const width = positiveFinite(options.width, 960, "width");
  const height = positiveFinite(options.height, 540, "height");
  const nodes = new Map(snapshot.model.nodes.map((node) => [node.id, node]));

  const edgeMarkup = snapshot.model.edges
    .map((edge) => {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (from === undefined || to === undefined) return "";
      const className = edge.causal ? "rg-edge rg-causal" : "rg-edge";
      return '<line class="' + className +
        '" data-edge-id="' + escapeXml(edge.id) +
        '" data-edge-kind="' + escapeXml(edge.kind) +
        '" x1="' + number(from.x + NODE_WIDTH / 2) +
        '" y1="' + number(from.y + NODE_HEIGHT / 2) +
        '" x2="' + number(to.x + NODE_WIDTH / 2) +
        '" y2="' + number(to.y + NODE_HEIGHT / 2) + '"/>';
    })
    .join("");

  const nodeMarkup = snapshot.model.nodes
    .map((node) => {
      const classes = [
        "rg-node",
        node.referenceOnly ? "rg-reference" : "",
        node.causal ? "rg-causal" : "",
        snapshot.selectedNodeId === node.id ? "rg-selected" : "",
      ].filter(Boolean).join(" ");
      const target = node.target === undefined
        ? ""
        : ' data-target="' + escapeXml(node.target) + '"';
      return '<g class="' + classes +
        '" data-node-id="' + escapeXml(node.id) +
        '" data-node-kind="' + escapeXml(node.kind) + '"' + target +
        ' transform="translate(' + number(node.x) + " " + number(node.y) + ')">' +
        '<rect width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" rx="8"/>' +
        '<text x="12" y="23">' + escapeXml(node.label) + '</text>' +
        '<text class="rg-kind" x="12" y="43">' + escapeXml(node.kind) + '</text>' +
        "</g>";
    })
    .join("");

  const status = snapshot.model.availability === "unavailable"
    ? snapshot.model.unavailable?.message ?? "Evidence unavailable"
    : snapshot.model.partial
      ? "Partial repository evidence"
      : "Repository evidence";

  return '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' +
    escapeXml(status) +
    '" width="' + number(width) +
    '" height="' + number(height) +
    '" viewBox="' +
    [snapshot.viewport.x, snapshot.viewport.y, snapshot.viewport.width, snapshot.viewport.height]
      .map(number)
      .join(" ") +
    '">' + edgeMarkup + nodeMarkup + "</svg>";
}
