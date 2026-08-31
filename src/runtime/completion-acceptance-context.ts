/**
 * Persisted completion acceptance context between Phase 2 and post-Sol gate.
 */

import type { CursorWorkOrder } from "../types.js";
import type { StructuredWorkerReportDiagnostics } from "./worker-report-diagnostics.js";

export interface CompletionAcceptanceContextArtifact {
  schemaVersion: "completion-acceptance-context-1.0";
  workOrder: CursorWorkOrder;
  diagnostics: StructuredWorkerReportDiagnostics;
}

export function buildCompletionAcceptanceContextArtifact(input: {
  workOrder: CursorWorkOrder;
  diagnostics: StructuredWorkerReportDiagnostics;
}): CompletionAcceptanceContextArtifact {
  return {
    schemaVersion: "completion-acceptance-context-1.0",
    workOrder: input.workOrder,
    diagnostics: input.diagnostics,
  };
}
