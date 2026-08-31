/**
 * Narrow classification of execution outcomes: machine-recoverable plumbing
 * failures vs real human gates. Not a Failure Controller.
 */

export type ExecutionOutcomeClass =
  | "MACHINE_RECOVERABLE"
  | "REAL_HUMAN_GATE"
  | "SUCCESS"
  | "NON_SUCCESS";

export type MachineRecoverableFailureCode =
  | "WORKER_REPORT_SCHEMA_INVALID"
  | "WORKER_REPORT_PARSE_FAILED"
  | "WORKER_REPORT_ENVELOPE_MISSING"
  | "WORKER_REPORT_SCHEMA_REPAIR_EXHAUSTED";

export type RealHumanGateCode =
  | "PRODUCT_SCOPE_CHANGE"
  | "MERGE_APPROVAL"
  | "PRODUCTION_DEPLOYMENT"
  | "NEW_AUTHORITY_OR_BUDGET"
  | "AMBIGUOUS_PRODUCT_DECISION"
  | "PROGRAM_ACCEPTANCE"
  | "SPECIALIST_REVIEW_REQUIRED"
  | "POLICY_REQUIRE_HUMAN"
  | "REQUEST_HUMAN_APPROVAL";

export interface ExecutionOutcomeClassification {
  class: ExecutionOutcomeClass;
  machineRecoverable: boolean;
  code: MachineRecoverableFailureCode | RealHumanGateCode | "SUCCESS" | "OTHER";
  summary: string;
}

/**
 * Schema-invalid or parse-failed worker reports are routine execution errors.
 */
export function classifyWorkerReportDiagnostics(input: {
  structuredWorkerReportRequired: boolean;
  reportValid: boolean;
  diagnosticStatus: string | null;
}): ExecutionOutcomeClassification {
  if (!input.structuredWorkerReportRequired) {
    return {
      class: input.reportValid ? "SUCCESS" : "NON_SUCCESS",
      machineRecoverable: false,
      code: input.reportValid ? "SUCCESS" : "OTHER",
      summary: input.reportValid
        ? "Structured report not required"
        : "Report invalid but structured report not required",
    };
  }

  if (input.reportValid) {
    return {
      class: "SUCCESS",
      machineRecoverable: false,
      code: "SUCCESS",
      summary: "Schema-valid structured worker report",
    };
  }

  const status = input.diagnosticStatus ?? "UNAVAILABLE_OR_INVALID";
  if (
    status === "SCHEMA_INVALID" ||
    status === "JSON_PARSE_FAILED" ||
    status === "UNAVAILABLE_OR_INVALID"
  ) {
    const code: MachineRecoverableFailureCode =
      status === "JSON_PARSE_FAILED"
        ? "WORKER_REPORT_PARSE_FAILED"
        : "WORKER_REPORT_SCHEMA_INVALID";
    return {
      class: "MACHINE_RECOVERABLE",
      machineRecoverable: true,
      code,
      summary: `Routine report-format failure (${status}) — bounded same-worker repair permitted`,
    };
  }

  return {
    class: "NON_SUCCESS",
    machineRecoverable: false,
    code: "OTHER",
    summary: `Worker report invalid (${status}) — not classified as routine schema repair`,
  };
}

export function isMachineRecoverableFailure(
  classification: ExecutionOutcomeClassification,
): boolean {
  return classification.machineRecoverable;
}

export function isRealHumanGate(
  classification: ExecutionOutcomeClassification,
): boolean {
  return classification.class === "REAL_HUMAN_GATE";
}

export function classifyPolicyHumanGate(primaryCode: string | null): ExecutionOutcomeClassification {
  return {
    class: "REAL_HUMAN_GATE",
    machineRecoverable: false,
    code: "POLICY_REQUIRE_HUMAN",
    summary: `Policy requires human judgment (${primaryCode ?? "REQUIRE_HUMAN"})`,
  };
}
