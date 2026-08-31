/**
 * Schema-aware machine-readable repair contract for completion-report validation.
 *
 * Converts AJV validation errors into actionable field-level repair instructions
 * with allowed enum values derived from schemas/cursor-completion-report.schema.json.
 */

import type { ErrorObject } from "ajv";
import type { CursorWorkOrder } from "../types.js";
import { getSchemaValidator } from "../util/io.js";
import {
  buildMinimalValidReportSkeleton,
  computeCompletionSchemaHash,
  getCompletionSchemaShape,
  loadCompletionReportSchema,
  type CompletionContractIdentity,
} from "./completion-contract.js";

interface JsonSchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  additionalProperties?: boolean;
  anyOf?: JsonSchemaNode[];
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
}

export interface NormalizedValidationError {
  instancePath: string;
  keyword: string;
  receivedValue: unknown;
  allowedValues: string[] | null;
  expectedType: string | null;
  missingProperties: string[] | null;
  additionalProperty: string | null;
  repairInstruction: string;
}

export interface CompletionReportRepairContract {
  schemaVersion: string;
  schemaHash: string;
  validationErrors: NormalizedValidationError[];
  minimalValidTemplate: Record<string, unknown>;
}

const SAFE_OTHER_FALLBACK_PATH = /^\/testResults\/\d+\/category$/;

/**
 * Validate report against canonical schema only; return AJV errors (never throws).
 */
export function getCompletionReportSchemaErrors(
  report: Record<string, unknown> | null,
): ErrorObject[] {
  if (!report) return [];
  const validate = getSchemaValidator("cursor-completion-report.schema.json");
  validate(report);
  return validate.errors ?? [];
}

/**
 * Build a machine-readable repair contract from schema validation failures.
 */
export function buildCompletionReportRepairContract(input: {
  report: Record<string, unknown>;
  workOrder: CursorWorkOrder;
  identity?: CompletionContractIdentity;
  ajvErrors?: ErrorObject[];
}): CompletionReportRepairContract {
  const schema = loadCompletionReportSchema();
  const shape = getCompletionSchemaShape();
  const errors =
    input.ajvErrors ?? getCompletionReportSchemaErrors(input.report);

  return {
    schemaVersion: shape.schemaVersionConst,
    schemaHash: computeCompletionSchemaHash(),
    validationErrors: normalizeCompletionReportValidationErrors(
      input.report,
      errors,
      schema,
    ),
    minimalValidTemplate: buildMinimalValidReportSkeleton(
      input.workOrder,
      input.identity ?? {},
    ),
  };
}

/**
 * Deterministic normalization of AJV errors for completion-report repair.
 */
export function normalizeCompletionReportValidationErrors(
  report: Record<string, unknown>,
  ajvErrors: ErrorObject[],
  schema: JsonSchemaNode = loadCompletionReportSchema(),
): NormalizedValidationError[] {
  const seen = new Set<string>();
  const normalized: NormalizedValidationError[] = [];

  for (const error of ajvErrors) {
    const key = dedupeKey(error);
    if (seen.has(key)) continue;
    seen.add(key);

    const instancePath = error.instancePath || "/";
    const keyword = error.keyword;
    const receivedValue = getValueAtInstancePath(report, instancePath);

    let allowedValues: string[] | null = null;
    let expectedType: string | null = null;
    let missingProperties: string[] | null = null;
    let additionalProperty: string | null = null;

    switch (keyword) {
      case "enum": {
        allowedValues = deriveAllowedEnumValues(schema, error);
        break;
      }
      case "type": {
        expectedType = deriveExpectedType(schema, error);
        break;
      }
      case "required": {
        missingProperties = deriveMissingProperties(error);
        break;
      }
      case "additionalProperties": {
        additionalProperty = deriveAdditionalProperty(error);
        break;
      }
      default:
        break;
    }

    normalized.push({
      instancePath,
      keyword,
      receivedValue,
      allowedValues,
      expectedType,
      missingProperties,
      additionalProperty,
      repairInstruction: buildRepairInstruction({
        instancePath,
        keyword,
        receivedValue,
        allowedValues,
        expectedType,
        missingProperties,
        additionalProperty,
      }),
    });
  }

  return normalized;
}

function dedupeKey(error: ErrorObject): string {
  const missing = error.params?.missingProperty ?? "";
  const additional = error.params?.additionalProperty ?? "";
  return `${error.instancePath}|${error.keyword}|${missing}|${additional}|${error.schemaPath}`;
}

function getValueAtInstancePath(
  report: Record<string, unknown>,
  instancePath: string,
): unknown {
  if (!instancePath || instancePath === "/") return report;
  const segments = instancePath.split("/").filter(Boolean);
  let current: unknown = report;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deriveAllowedEnumValues(
  schema: JsonSchemaNode,
  error: ErrorObject,
): string[] {
  const fromSchema = resolveEnumAtSchemaPath(schema, error.schemaPath);
  if (fromSchema.length > 0) return fromSchema;

  const fromParams = error.params?.allowedValues;
  if (Array.isArray(fromParams)) {
    return fromParams.map(String);
  }
  return [];
}

function deriveExpectedType(
  schema: JsonSchemaNode,
  error: ErrorObject,
): string | null {
  const node = resolveSchemaNodeAtSchemaPath(schema, error.schemaPath);
  if (node?.type) {
    return Array.isArray(node.type) ? node.type.join(" | ") : String(node.type);
  }
  if (error.params?.type) return String(error.params.type);
  return null;
}

function deriveMissingProperties(error: ErrorObject): string[] {
  const single = error.params?.missingProperty;
  if (typeof single === "string") return [single];
  const plural = error.params?.missingProperties;
  if (Array.isArray(plural)) return plural.map(String);
  return [];
}

function deriveAdditionalProperty(error: ErrorObject): string | null {
  const prop = error.params?.additionalProperty;
  return typeof prop === "string" ? prop : null;
}

function resolveEnumAtSchemaPath(
  schema: JsonSchemaNode,
  schemaPath: string,
): string[] {
  const node = resolveSchemaNodeAtSchemaPath(schema, schemaPath);
  if (!node) return [];
  if (Array.isArray(node.enum)) {
    return node.enum.map(String);
  }
  // schemaPath may end at /enum — walk to parent const/enum
  const parentPath = schemaPath.replace(/\/enum$/, "");
  if (parentPath !== schemaPath) {
    const parent = resolveSchemaNodeAtSchemaPath(schema, parentPath);
    if (parent && Array.isArray(parent.enum)) {
      return parent.enum.map(String);
    }
  }
  return [];
}

function resolveSchemaNodeAtSchemaPath(
  schema: JsonSchemaNode,
  schemaPath: string,
): JsonSchemaNode | null {
  if (!schemaPath.startsWith("#/")) return null;
  const segments = schemaPath.slice(2).split("/");
  let node: JsonSchemaNode = schema;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === "properties") {
      const key = segments[++i];
      if (!key || !node.properties?.[key]) return null;
      node = node.properties[key]!;
      continue;
    }
    if (segment === "items") {
      if (!node.items) return null;
      node = node.items;
      continue;
    }
    if (segment === "$defs") {
      const key = segments[++i];
      if (!key || !node.$defs?.[key]) return null;
      node = node.$defs[key]!;
      continue;
    }
    if (segment === "anyOf") {
      const index = Number(segments[++i]);
      if (!node.anyOf?.[index]) return null;
      node = node.anyOf[index]!;
      if (node.$ref) {
        node = resolveRef(schema, node.$ref) ?? node;
      }
      continue;
    }
    if (segment === "enum" || segment === "type" || segment === "required") {
      return node;
    }
  }
  return node;
}

function resolveRef(
  root: JsonSchemaNode,
  ref: string,
): JsonSchemaNode | null {
  if (!ref.startsWith("#/")) return null;
  return resolveSchemaNodeAtSchemaPath(root, ref);
}

function supportsOtherFallback(
  instancePath: string,
  allowedValues: string[] | null,
): boolean {
  return (
    allowedValues !== null &&
    allowedValues.includes("OTHER") &&
    SAFE_OTHER_FALLBACK_PATH.test(instancePath)
  );
}

function buildRepairInstruction(input: {
  instancePath: string;
  keyword: string;
  receivedValue: unknown;
  allowedValues: string[] | null;
  expectedType: string | null;
  missingProperties: string[] | null;
  additionalProperty: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`FIELD: ${input.instancePath || "/"}`);

  switch (input.keyword) {
    case "enum": {
      lines.push(`RECEIVED: ${formatValue(input.receivedValue)}`);
      if (input.allowedValues && input.allowedValues.length > 0) {
        lines.push(`ALLOWED: ${input.allowedValues.join(" | ")}`);
        lines.push(
          `CORRECTION: Replace the value at ${input.instancePath} with exactly one ALLOWED value. Do not invent values outside this set.`,
        );
        if (supportsOtherFallback(input.instancePath, input.allowedValues)) {
          lines.push(
            "If none of the legal categories accurately matches the existing result, use OTHER.",
          );
        }
      } else {
        lines.push(
          "CORRECTION: Replace with a schema-legal enum value at this field.",
        );
      }
      break;
    }
    case "required": {
      if (input.missingProperties && input.missingProperties.length > 0) {
        lines.push(`MISSING: ${input.missingProperties.join(", ")}`);
        lines.push(
          `CORRECTION: Add the missing required ${input.missingProperties.length === 1 ? "property" : "properties"} at ${input.instancePath || "root"}.`,
        );
      }
      break;
    }
    case "additionalProperties": {
      if (input.additionalProperty) {
        lines.push(`ILLEGAL_PROPERTY: ${input.additionalProperty}`);
        lines.push(
          `CORRECTION: Remove property "${input.additionalProperty}" from ${input.instancePath || "root"}.`,
        );
      }
      break;
    }
    case "type": {
      lines.push(`RECEIVED: ${formatValue(input.receivedValue)}`);
      if (input.expectedType) {
        lines.push(`EXPECTED_TYPE: ${input.expectedType}`);
        lines.push(
          `CORRECTION: Change the value at ${input.instancePath} to the EXPECTED_TYPE.`,
        );
      }
      break;
    }
    default: {
      lines.push(`RECEIVED: ${formatValue(input.receivedValue)}`);
      lines.push(
        "CORRECTION: Fix this field to satisfy the canonical completion-report schema.",
      );
      break;
    }
  }

  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(missing)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Resolve allowed enum values for an instance path directly from the canonical schema.
 * Used by drift tests — production repair guidance uses AJV errors + schema derivation.
 */
export function deriveAllowedEnumValuesForInstancePath(
  instancePath: string,
  schema: JsonSchemaNode = loadCompletionReportSchema(),
): string[] {
  const segments = instancePath.split("/").filter(Boolean);
  let node: JsonSchemaNode = schema;

  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      if (!node.items) return [];
      node = node.items;
      continue;
    }
    if (!node.properties?.[segment]) return [];
    node = node.properties[segment]!;
    if (node.$ref) {
      const resolved = resolveRef(schema, node.$ref);
      if (!resolved) return [];
      node = resolved;
    }
  }

  if (Array.isArray(node.enum)) {
    return node.enum.map(String);
  }
  return [];
}
