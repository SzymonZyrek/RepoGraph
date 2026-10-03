import { readFileSync, writeFileSync } from "node:fs";

import { parseGraph, serializeGraph } from "./graph.js";
import type { GraphDocument } from "./model.js";

export function loadGraph(path: string): GraphDocument {
  return parseGraph(readFileSync(path, "utf8"));
}

export function saveGraph(path: string, graph: GraphDocument): void {
  writeFileSync(path, `${serializeGraph(graph)}\n`);
}
