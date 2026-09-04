export const LOOP_PHASES = [
  "INITIALIZE",
  "SPEC_GATE",
  "ISOLATE",
  "DETECT_STACKS",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "REALITY_CHECK",
  "RELEASE_GATE",
  "COMPLETE"
] as const;

export type LoopPhase = typeof LOOP_PHASES[number];

export function isLoopPhase(phase: string): phase is LoopPhase {
  return (LOOP_PHASES as readonly string[]).includes(phase);
}

export type PhaseStatus = "completed" | "current" | "pending";

export interface PhaseDisplayItem {
  readonly phase: LoopPhase;
  readonly status: PhaseStatus;
}

/**
 * Computes display status for each phase in the canonical pipeline.
 * If currentPhase is 'VERIFY', the first 6 are 'completed', VERIFY is 'current', and later are 'pending'.
 */
export function computePhaseStatuses(currentPhase: string): readonly PhaseDisplayItem[] {
  const currentIndex = LOOP_PHASES.indexOf(currentPhase as LoopPhase);
  if (currentIndex === -1) {
    return LOOP_PHASES.map((phase) => ({ phase, status: "pending" as const }));
  }

  return LOOP_PHASES.map((phase, idx) => {
    let status: PhaseStatus = "pending";
    if (idx < currentIndex) {
      status = "completed";
    } else if (idx === currentIndex) {
      status = "current";
    }
    return { phase, status };
  });
}

/**
 * Returns the next canonical phase in sequence, clamping at COMPLETE.
 */
export function nextLoopPhase(current: LoopPhase): LoopPhase {
  const idx = LOOP_PHASES.indexOf(current);
  if (idx === -1 || idx >= LOOP_PHASES.length - 1) {
    return current;
  }
  return LOOP_PHASES[idx + 1]!;
}

/**
 * Returns the previous canonical phase in sequence, clamping at INITIALIZE.
 */
export function previousLoopPhase(current: LoopPhase): LoopPhase {
  const idx = LOOP_PHASES.indexOf(current);
  if (idx <= 0) {
    return current;
  }
  return LOOP_PHASES[idx - 1]!;
}
