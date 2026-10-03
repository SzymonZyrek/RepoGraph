import type { JsonValue } from "./model.js";

function assertFiniteNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError("Canonical JSON does not support NaN or infinite numbers");
  }
}

export function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    assertFiniteNumber(value);
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object" && value !== null) {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) object[key] = toJsonValue(item);
    }
    return object;
  }

  throw new TypeError(`Value is not JSON serializable: ${typeof value}`);
}

export function canonicalize(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    assertFiniteNumber(value);
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key]!);
  }
  return sorted;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalJsonUnknown(value: unknown): string {
  return canonicalJson(toJsonValue(value));
}
