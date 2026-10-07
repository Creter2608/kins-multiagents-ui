/**
 * src/shared/phaseTemplateBinding.ts
 * Pure deterministic phase-to-template binding contract for enforced Superpowers prompt templates.
 */

export type EnforcedTemplatePhase = "PLAN" | "EXECUTE" | "VERIFY";

export type EnforcedTemplateId =
  | "plan-document-reviewer-prompt"
  | "implementer-prompt"
  | "task-reviewer-prompt";

export interface CompiledPhaseTemplate {
  readonly phase: EnforcedTemplatePhase;
  readonly templateId: EnforcedTemplateId;
  readonly sourcePath: string;
  readonly sha256: string;
  readonly content: string;
}

export function bindEnforcedPhaseTemplate(
  phase: EnforcedTemplatePhase,
  template: CompiledPhaseTemplate
): string {
  if (phase !== template.phase) {
    throw new Error(
      `Phase mismatch in template binding: expected phase '${phase}', received template for phase '${template.phase}'`
    );
  }

  return [
    `<enforced-superpowers-template phase="${template.phase}" id="${template.templateId}" sha256="${template.sha256}">`,
    template.content,
    `</enforced-superpowers-template>`
  ].join("\n");
}
