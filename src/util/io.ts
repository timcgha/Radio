import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repository root (Radio control plane). */
export const PROJECT_ROOT = path.resolve(__dirname, "../..");

export function resolveRepoPath(...parts: string[]): string {
  return path.join(PROJECT_ROOT, ...parts);
}

export function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function loadSchema(schemaFileName: string): object {
  return readJsonFile<object>(resolveRepoPath("schemas", schemaFileName));
}

let ajvInstance: Ajv2020 | null = null;

export function getAjv(): Ajv2020 {
  if (!ajvInstance) {
    ajvInstance = new Ajv2020({
      allErrors: true,
      strict: false,
      validateSchema: false,
    });
  }
  return ajvInstance;
}

const validatorCache = new Map<string, ValidateFunction>();

export function getSchemaValidator(schemaFileName: string): ValidateFunction {
  const cached = validatorCache.get(schemaFileName);
  if (cached) return cached;
  const schema = loadSchema(schemaFileName);
  const validate = getAjv().compile(schema);
  validatorCache.set(schemaFileName, validate);
  return validate;
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown schema error";
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
    .join("; ");
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic JSON canonicalization (sorted object keys, no whitespace variance).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}
