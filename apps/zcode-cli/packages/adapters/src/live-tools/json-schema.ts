import { LiveToolConfigurationError } from "./errors.js";
import type { LiveToolJsonSchema } from "./types.js";

const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 512;
const MAX_TEXT_LENGTH = 4_096;
const SUPPORTED_SCHEMA_VERSIONS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
]);
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const SCHEMA_KEYS = new Set([
  "$schema",
  "additionalProperties",
  "const",
  "default",
  "description",
  "enum",
  "items",
  "maxItems",
  "maximum",
  "maxLength",
  "minItems",
  "minimum",
  "minLength",
  "oneOf",
  "properties",
  "required",
  "title",
  "type",
]);
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseLiveToolJsonSchema(
  value: unknown,
  label: string,
  manifestPath: string,
  options: { requireObjectRoot: boolean },
): LiveToolJsonSchema {
  const state = { nodes: 0 };
  const schema = validateSchemaNode(value, label, manifestPath, 0, state, true);
  if (options.requireObjectRoot && schema.type !== "object") {
    throw invalidSchema(`${label} must declare an object root`, manifestPath);
  }
  if (!options.requireObjectRoot && schema.type === undefined && schema.oneOf === undefined) {
    throw invalidSchema(`${label} must declare type or oneOf`, manifestPath);
  }
  return deepFreeze(schema) as LiveToolJsonSchema;
}

function validateSchemaNode(
  value: unknown,
  label: string,
  manifestPath: string,
  depth: number,
  state: { nodes: number },
  isRoot: boolean,
): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw invalidSchema(`${label} exceeds schema depth ${MAX_SCHEMA_DEPTH}`, manifestPath);
  }
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) {
    throw invalidSchema(`${label} exceeds schema node limit ${MAX_SCHEMA_NODES}`, manifestPath);
  }

  const schema = requireRecord(value, label, manifestPath);
  assertExactKeys(schema, SCHEMA_KEYS, label, manifestPath);
  if (!isRoot && Object.hasOwn(schema, "$schema")) {
    throw invalidSchema(`${label} may not set nested $schema`, manifestPath);
  }
  if (schema.$schema !== undefined && !SUPPORTED_SCHEMA_VERSIONS.has(schema.$schema as string)) {
    throw invalidSchema(`${label} must use a supported JSON Schema version`, manifestPath);
  }
  if (schema.title !== undefined) requireText(schema.title, `${label}.title`, manifestPath);
  if (schema.description !== undefined)
    requireText(schema.description, `${label}.description`, manifestPath);
  if (schema.default !== undefined)
    assertJsonValue(schema.default, `${label}.default`, manifestPath, depth);
  if (schema.const !== undefined)
    assertJsonValue(schema.const, `${label}.const`, manifestPath, depth);
  if (schema.enum !== undefined) {
    const values = requireArray(schema.enum, `${label}.enum`, manifestPath);
    if (values.length === 0) throw invalidSchema(`${label}.enum must not be empty`, manifestPath);
    values.forEach((entry, index) =>
      assertJsonValue(entry, `${label}.enum[${index}]`, manifestPath, depth),
    );
  }

  if (schema.type !== undefined) validateSchemaType(schema.type, `${label}.type`, manifestPath);
  if (schema.properties !== undefined)
    validateProperties(schema, label, manifestPath, depth, state);
  if (schema.required !== undefined) validateRequired(schema, label, manifestPath);
  if (schema.additionalProperties !== undefined)
    validateAdditionalProperties(schema, label, manifestPath);
  if (schema.items !== undefined) validateItems(schema, label, manifestPath, depth, state);
  if (schema.oneOf !== undefined) validateOneOf(schema, label, manifestPath, depth, state);

  validateIntegerBound(schema, "minLength", label, manifestPath);
  validateIntegerBound(schema, "maxLength", label, manifestPath);
  validateIntegerBound(schema, "minItems", label, manifestPath);
  validateIntegerBound(schema, "maxItems", label, manifestPath);
  validateNumberBound(schema, "minimum", label, manifestPath);
  validateNumberBound(schema, "maximum", label, manifestPath);
  validateBoundOrder(schema, "minLength", "maxLength", label, manifestPath);
  validateBoundOrder(schema, "minItems", "maxItems", label, manifestPath);
  validateBoundOrder(schema, "minimum", "maximum", label, manifestPath);
  return schema;
}

function validateProperties(
  schema: Record<string, unknown>,
  label: string,
  manifestPath: string,
  depth: number,
  state: { nodes: number },
): void {
  if (!hasSchemaType(schema.type, "object")) {
    throw invalidSchema(`${label}.properties requires object type`, manifestPath);
  }
  const properties = requireRecord(schema.properties, `${label}.properties`, manifestPath);
  for (const [key, child] of Object.entries(properties)) {
    assertSafeObjectKey(key, `${label}.properties`, manifestPath);
    validateSchemaNode(child, `${label}.properties.${key}`, manifestPath, depth + 1, state, false);
  }
}

function validateRequired(
  schema: Record<string, unknown>,
  label: string,
  manifestPath: string,
): void {
  if (!hasSchemaType(schema.type, "object")) {
    throw invalidSchema(`${label}.required requires object type`, manifestPath);
  }
  const required = requireStringArray(schema.required, `${label}.required`, manifestPath);
  if (new Set(required).size !== required.length) {
    throw invalidSchema(`${label}.required must not repeat fields`, manifestPath);
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const field of required) {
    if (!Object.hasOwn(properties, field)) {
      throw invalidSchema(
        `${label}.required field ${field} must be declared in properties`,
        manifestPath,
      );
    }
  }
}

function validateAdditionalProperties(
  schema: Record<string, unknown>,
  label: string,
  manifestPath: string,
): void {
  if (!hasSchemaType(schema.type, "object") || typeof schema.additionalProperties !== "boolean") {
    throw invalidSchema(
      `${label}.additionalProperties must be boolean for object schemas`,
      manifestPath,
    );
  }
}

function validateItems(
  schema: Record<string, unknown>,
  label: string,
  manifestPath: string,
  depth: number,
  state: { nodes: number },
): void {
  if (!hasSchemaType(schema.type, "array")) {
    throw invalidSchema(`${label}.items requires array type`, manifestPath);
  }
  validateSchemaNode(schema.items, `${label}.items`, manifestPath, depth + 1, state, false);
}

function validateOneOf(
  schema: Record<string, unknown>,
  label: string,
  manifestPath: string,
  depth: number,
  state: { nodes: number },
): void {
  const alternatives = requireArray(schema.oneOf, `${label}.oneOf`, manifestPath);
  if (alternatives.length === 0)
    throw invalidSchema(`${label}.oneOf must not be empty`, manifestPath);
  alternatives.forEach((alternative, index) =>
    validateSchemaNode(
      alternative,
      `${label}.oneOf[${index}]`,
      manifestPath,
      depth + 1,
      state,
      false,
    ),
  );
}

function validateSchemaType(value: unknown, label: string, manifestPath: string): void {
  const types = Array.isArray(value) ? value : [value];
  if (
    types.length === 0 ||
    types.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))
  ) {
    throw invalidSchema(`${label} contains an unsupported JSON Schema type`, manifestPath);
  }
  if (new Set(types).size !== types.length) {
    throw invalidSchema(`${label} must not repeat JSON Schema types`, manifestPath);
  }
}

function validateIntegerBound(
  schema: Record<string, unknown>,
  key: "maxItems" | "maxLength" | "minItems" | "minLength",
  label: string,
  manifestPath: string,
): void {
  const value = schema[key];
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw invalidSchema(`${label}.${key} must be a non-negative safe integer`, manifestPath);
  }
}

function validateNumberBound(
  schema: Record<string, unknown>,
  key: "maximum" | "minimum",
  label: string,
  manifestPath: string,
): void {
  const value = schema[key];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw invalidSchema(`${label}.${key} must be a finite number`, manifestPath);
  }
}

function validateBoundOrder(
  schema: Record<string, unknown>,
  minimum: string,
  maximum: string,
  label: string,
  manifestPath: string,
): void {
  const lower = schema[minimum];
  const upper = schema[maximum];
  if (typeof lower === "number" && typeof upper === "number" && lower > upper) {
    throw invalidSchema(`${label}.${minimum} must not exceed ${maximum}`, manifestPath);
  }
}

function assertJsonValue(value: unknown, label: string, manifestPath: string, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) throw invalidSchema(`${label} exceeds JSON depth`, manifestPath);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw invalidSchema(`${label} must be a finite JSON number`, manifestPath);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonValue(entry, `${label}[${index}]`, manifestPath, depth + 1),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertSafeObjectKey(key, label, manifestPath);
      assertJsonValue(child, `${label}.${key}`, manifestPath, depth + 1);
    }
    return;
  }
  throw invalidSchema(`${label} is not a JSON value`, manifestPath);
}

function hasSchemaType(value: unknown, wanted: string): boolean {
  return Array.isArray(value) ? value.includes(wanted) : value === wanted;
}

function requireRecord(
  value: unknown,
  label: string,
  manifestPath: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidSchema(`${label} must be an object`, manifestPath);
  for (const key of Object.keys(value)) assertSafeObjectKey(key, label, manifestPath);
  return value;
}

function requireArray(value: unknown, label: string, manifestPath: string): unknown[] {
  if (!Array.isArray(value)) throw invalidSchema(`${label} must be an array`, manifestPath);
  return value;
}

function requireStringArray(value: unknown, label: string, manifestPath: string): string[] {
  return requireArray(value, label, manifestPath).map((entry, index) =>
    requireText(entry, `${label}[${index}]`, manifestPath),
  );
}

function requireText(value: unknown, label: string, manifestPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw invalidSchema(
      `${label} must be non-empty text up to ${MAX_TEXT_LENGTH} characters`,
      manifestPath,
    );
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  manifestPath: string,
): void {
  for (const key of Object.keys(value)) {
    assertSafeObjectKey(key, label, manifestPath);
    if (!allowed.has(key))
      throw invalidSchema(`${label} has unsupported field ${key}`, manifestPath);
  }
}

function assertSafeObjectKey(key: string, label: string, manifestPath: string): void {
  if (FORBIDDEN_OBJECT_KEYS.has(key)) {
    throw invalidSchema(`${label} has unsafe field ${key}`, manifestPath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSchema(message: string, manifestPath: string): LiveToolConfigurationError {
  return new LiveToolConfigurationError("invalid_schema", message, { path: manifestPath });
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isRecord(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
