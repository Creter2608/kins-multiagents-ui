export type LoopErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_TRUST_ANCHOR_MISSING"
  | "INTEGRITY_MISMATCH"
  | "ASSERTION_SCHEMA_INVALID"
  | "TRANSITION_INVALID"
  | "BUDGET_EXHAUSTED"
  | "STATE_INVALID"
  | "STATE_CONFLICT"
  | "EXECUTION_FAILED"
  | "INTERNAL_ERROR";

export type ErrorClass =
  | "configuration"
  | "integrity"
  | "validation"
  | "transition"
  | "budget"
  | "state"
  | "execution"
  | "internal";

export class LoopError extends Error {
  readonly code: LoopErrorCode;
  readonly classification: ErrorClass;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LoopErrorCode,
    classification: ErrorClass,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "LoopError";
    this.code = code;
    this.classification = classification;
    this.details = Object.freeze({ ...details });
    Object.setPrototypeOf(this, LoopError.prototype);
  }
}

export function classifyUnknownError(error: unknown): LoopError {
  if (error instanceof LoopError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LoopError("INTERNAL_ERROR", "internal", `Unclassified error: ${message}`, {
    originalError: String(error)
  });
}
