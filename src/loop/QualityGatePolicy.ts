import type { PhaseId, QualityGateBlock } from "../engine.js";

export interface QualityGatePolicyContext {
  readonly phase: PhaseId;
  readonly revision: number;
  readonly block: QualityGateBlock;
  readonly globalCycleBudget: number;
  readonly globalCycleUsage: number;
  readonly qualityRemediationBudget: number;
  readonly qualityRemediationUsage: number;
  readonly specificationIntegrityValid: boolean;
  readonly baselineVerificationPassed: boolean;
  readonly hasCriticalSecurityFinding: boolean;
}

export interface QualityGatePolicyDecisionInput {
  readonly action: "remediate" | "override_quality_gate" | "reject";
  readonly expectedRevision: number;
  readonly artifactHash: string;
  readonly reason: string;
  readonly feedback?: string | undefined;
  readonly ticketReference?: string | undefined;
}

export type QualityGateDecisionPlan =
  | { readonly permitted: true; readonly targetPhase: PhaseId }
  | { readonly permitted: false; readonly code: string; readonly message: string };

/**
 * Pure deterministic quality-gate decision planner.
 * Evaluates requested human dispositions against governing policies.
 * No I/O, no persistence, no side-effects.
 */
export function planQualityGateDecision(
  context: QualityGatePolicyContext,
  input: QualityGatePolicyDecisionInput
): QualityGateDecisionPlan {
  // 1. Phase validation
  if (context.phase !== "BLOCKED") {
    return {
      permitted: false,
      code: "INVALID_PHASE",
      message: `Quality gate decisions are only permitted in BLOCKED phase (current: ${context.phase})`
    };
  }

  // 2. Exact revision check
  if (input.expectedRevision !== context.revision) {
    return {
      permitted: false,
      code: "REVISION_MISMATCH",
      message: `Expected revision ${input.expectedRevision} does not match current state revision ${context.revision}`
    };
  }

  // 3. Non-blank reason requirement
  if (!input.reason || !input.reason.trim()) {
    return {
      permitted: false,
      code: "BLANK_REASON",
      message: "A non-blank justification reason is required for quality gate disposition"
    };
  }

  // 4. Exact artifact hash match
  if (!input.artifactHash || input.artifactHash.trim() !== context.block.artifactHash.trim()) {
    return {
      permitted: false,
      code: "ARTIFACT_HASH_MISMATCH",
      message: `Supplied artifact hash '${input.artifactHash ?? "missing"}' does not match active block artifact hash '${context.block.artifactHash}'`
    };
  }

  // 5. Protected invariant: specification integrity
  if (!context.specificationIntegrityValid) {
    return {
      permitted: false,
      code: "SPECIFICATION_INTEGRITY",
      message: "Quality gate action denied: protected specification integrity (.eval/) violation detected"
    };
  }

  // 6. Protected invariant: baseline verification
  if (!context.baselineVerificationPassed) {
    return {
      permitted: false,
      code: "BASELINE_VERIFICATION_FAILED",
      message: "Quality gate action denied: baseline test verification has not passed"
    };
  }

  // 7. Disposition-specific rules
  switch (input.action) {
    case "remediate": {
      if (!input.feedback || !input.feedback.trim()) {
        return {
          permitted: false,
          code: "BLANK_FEEDBACK",
          message: "Remediation feedback cannot be blank. Actionable guidance must be provided for Layer 2."
        };
      }
      if (
        !context.block.remediationRemaining ||
        context.qualityRemediationUsage >= context.qualityRemediationBudget
      ) {
        return {
          permitted: false,
          code: "REMEDIATION_BUDGET_EXHAUSTED",
          message: `Quality remediation budget exhausted (${context.qualityRemediationUsage}/${context.qualityRemediationBudget})`
        };
      }
      if (context.globalCycleUsage >= context.globalCycleBudget) {
        return {
          permitted: false,
          code: "GLOBAL_CYCLES_EXHAUSTED",
          message: `Global loop cycle limit reached (${context.globalCycleUsage}/${context.globalCycleBudget})`
        };
      }
      return { permitted: true, targetPhase: "EXECUTE" };
    }

    case "override_quality_gate": {
      if (!context.block.overridePermitted) {
        return {
          permitted: false,
          code: "OVERRIDE_NOT_PERMITTED",
          message: "Quality gate override is not permitted for this failure block"
        };
      }
      if (context.hasCriticalSecurityFinding) {
        return {
          permitted: false,
          code: "CRITICAL_SECURITY_FINDING",
          message: "Cannot override quality gate: critical security finding present"
        };
      }
      return { permitted: true, targetPhase: "RELEASE_GATE" };
    }

    case "reject": {
      return { permitted: true, targetPhase: "FAILED" };
    }

    default: {
      return {
        permitted: false,
        code: "UNRECOGNIZED_ACTION",
        message: `Unrecognized quality gate action: ${(input as any).action}`
      };
    }
  }
}
