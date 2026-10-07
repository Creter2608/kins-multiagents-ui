/**
 * src/main/services/frontendDesignStealthPack.ts
 * Curated, version-pinned design appendix combining pbakaus/impeccable
 * and nextlevelbuilder/ui-ux-pro-max-skill into a token-efficient stealth rule module.
 */

import type { StealthRuleTarget } from "../../shared/contracts.js";

export const FRONTEND_DESIGN_PACK_REVISION = "1.0.0";

const FRONTEND_DESIGN_APPENDIX = `
<!-- FRONTEND_DESIGN_STEALTH_PACK_START -->
## 🎨 Frontend Design & UX Quality Invariants (Impeccable + UI/UX Pro Max)

When working on UI structure, visual styling, components, layouts, or user interactions:

### 1. Precedence Hierarchy (Non-Negotiable)
1. **Security & Accessibility (WCAG AA)**: Always takes precedence over aesthetics.
2. **Incumbent Project Design System**: Always preserve existing repository tokens, themes, and conventions.
3. **Anti-AI Slop & Aesthetic Guidance**: Apply only where compatible with levels 1 and 2.

---

### 2. Anti-AI Slop Invariants (Impeccable Rules)
Eliminate common AI-generated template anti-patterns:
- **No Unsolicited Gradients**: Do NOT default to purple-to-blue gradients or neon accent halos.
- **No Nested Card Hell**: Do not nest cards inside cards, or wrap every layout section in bordered containers.
- **Controlled Radius**: Restrict \`border-radius\` to consistent scales (4px, 8px, 12px); avoid arbitrary oversized rounding (>32px) unless established by existing tokens.
- **Color Contrast & Tinting**: Never use pure washed-out gray text on colored backgrounds. Avoid pure dead black (\`#000\`) or flat gray — prefer subtly tinted slate/zinc neutrals with sufficient contrast.
- **Typography Discipline**: Do not default blindly to Inter, Arial, or system fonts without checking project tokens. Establish clear scale hierarchies (base 16px body, 1.5 line-height).
- **Subtle Motion**: Avoid bouncy, elastic easing or section-wide scroll fades. Keep transitions contextual, snappy (150ms–250ms), and purposeful.

### Agent Design Commands & Self-Review
Before finalizing UI changes, mentally execute:
- \`/critique\`: Verify visual hierarchy, scanning flow, and clarity.
- \`/distill\`: Remove superfluous borders, redundant decorators, and clutter.
- \`/harden\`: Verify error states, empty states, text overflow, and responsive wrapping.
- \`/polish\`: Align padding, margin rhythm, and verify against design tokens.

---

### 3. UX Quality & Pre-Delivery Checklist (UI/UX Pro Max)
Follow strict UX priority order (Priority 1–4 are blocking criteria):
- **[A11y] Contrast Ratio**: Normal body text must meet **4.5:1** minimum contrast; large text (18pt / 14pt bold) must meet **3:1**.
- **[A11y] Keyboard & Focus**: Interactive elements MUST maintain visible focus indicators (\`focus-visible:ring\`).
- **[A11y] Screen Readers**: Icon-only buttons MUST declare an explicit \`aria-label\`. Decorative icons must have \`aria-hidden="true"\`.
- **[A11y] Motion Sensitivity**: Always respect \`@media (prefers-reduced-motion: reduce)\` or disable aggressive animations.
- **[Touch & Targets]**: Interactive click/tap targets MUST measure at least **44×44px** with \`cursor-pointer\` and >= 8px touch spacing.
- **[Iconography]**: NEVER use raw emojis as UI icons; always use standard SVG icons (Lucide, Heroicons, Radix).
- **[Responsive Layout]**: Verify layout integrity across 375px (mobile), 768px (tablet), 1024px, and 1440px without unintentional horizontal scrolling.
- **[Overflow Resilience]**: Chips, badges, and headings must reflow cleanly without text truncation or broken line wraps.
<!-- FRONTEND_DESIGN_STEALTH_PACK_END -->
`.trim();

export function compileFrontendDesignStealthPack(_target: StealthRuleTarget): string {
  return FRONTEND_DESIGN_APPENDIX;
}
