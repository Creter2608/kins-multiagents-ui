import test from "node:test";
import assert from "node:assert/strict";
import {
  EccSkillContextInjector,
  type EccSkillInput
} from "../src/main/services/EccSkillContextInjector.js";

test("ecc-skill-injector: Assertion 1 - stripping boilerplate, comments, badges, and whitespace", () => {
  const injector = new EccSkillContextInjector();

  const rawSkill: EccSkillInput = {
    id: "skill:database-tuning",
    name: "Database Tuning",
    description: "Postgres optimization guide",
    content: `---
name: Database Tuning
tools: sql_exec
---

<!-- This is an internal maintainer comment that should not cost LLM tokens -->
[![CI](https://github.com/test/badge.svg)](https://github.com/test)
![Architecture Diagram](https://example.com/arch.png)

# Database Tuning Instructions

Rule 1: Always explain query plans.



Rule 2: Prefer composite indexes.



`
  };

  const result = injector.injectAndOptimizeSkills([rawSkill]);

  assert.equal(result.metrics.includedSkillCount, 1);
  assert.equal(result.metrics.truncatedSkillCount, 0);
  assert.ok(result.metrics.originalBytes > result.metrics.compactedBytes);
  assert.ok(result.metrics.savingsRatio > 0);

  const markdown = result.synthesizedMarkdown;
  assert.ok(!markdown.includes("<!-- This is an internal maintainer comment"));
  assert.ok(!markdown.includes("[![CI]"));
  assert.ok(!markdown.includes("tools: sql_exec")); // frontmatter stripped
  assert.ok(markdown.includes("### Skill: Database Tuning"));
  assert.ok(markdown.includes("> Postgres optimization guide"));
  assert.ok(markdown.includes("Rule 1: Always explain query plans."));
  assert.ok(markdown.includes("Rule 2: Prefer composite indexes."));
  assert.ok(!markdown.includes("\n\n\n")); // whitespace collapsed
});

test("ecc-skill-injector: Assertion 2 - graceful per-skill truncation at paragraph boundary", () => {
  // Injector with 200 bytes per-skill budget
  const injector = new EccSkillContextInjector({
    maxPerSkillBytes: 200,
    maxTotalSkillBytes: 1024
  });

  const longSkill: EccSkillInput = {
    id: "skill:long-guide",
    name: "Long Guide",
    content: `
Paragraph 1: Initial setup instructions and environment requirements.

Paragraph 2: Second section detailing advanced configurations and complex setups.

Paragraph 3: Extra section that definitely pushes the length far beyond the budget limit.
`
  };

  const result = injector.injectAndOptimizeSkills([longSkill]);

  assert.equal(result.metrics.includedSkillCount, 1);
  assert.equal(result.metrics.truncatedSkillCount, 1);
  assert.ok(result.synthesizedMarkdown.includes("[TRUNCATED: SKILL_BUDGET_REACHED]"));
  assert.ok(result.metrics.compactedBytes <= 250);
});

test("ecc-skill-injector: Assertion 3 - dynamic multi-skill budget packing and fallback reference cards", () => {
  // Small total budget of 150 bytes, per-skill limit 60 bytes
  const injector = new EccSkillContextInjector({
    maxPerSkillBytes: 60,
    maxTotalSkillBytes: 150
  });

  const skillA: EccSkillInput = {
    id: "skill:a",
    name: "Skill Alpha",
    description: "Alpha instructions",
    content: "Alpha rule details for deployment. Some extra text to consume budget."
  };

  const skillB: EccSkillInput = {
    id: "skill:b",
    name: "Skill Beta",
    description: "Beta instructions",
    content: "Beta rule details for testing. Some extra text to consume budget."
  };

  const skillC: EccSkillInput = {
    id: "skill:c",
    name: "Skill Gamma",
    description: "Gamma instructions",
    content: "Gamma extensive rule details that cannot fit in remaining budget."
  };

  const result = injector.injectAndOptimizeSkills([skillA, skillB, skillC]);

  assert.equal(result.metrics.includedSkillCount, 3);
  assert.ok(result.synthesizedMarkdown.includes("### Skill: Skill Alpha"));
  assert.ok(result.synthesizedMarkdown.includes("### Skill: Skill Beta"));
  assert.ok(result.synthesizedMarkdown.includes("### Skill: Skill Gamma"));
  // Skill C receives summary fallback card
  assert.ok(result.synthesizedMarkdown.includes("SUMMARY ONLY"));
  assert.ok(result.metrics.truncatedSkillCount >= 1);
});

test("ecc-skill-injector: Assertion 4 - metadata tag formatting", () => {
  const injector = new EccSkillContextInjector();

  const skill: EccSkillInput = {
    id: "skill:quick",
    name: "Quick Skill",
    content: "Fast optimization checklist."
  };

  const result = injector.injectAndOptimizeSkills([skill]);
  const markdown = result.synthesizedMarkdown;

  assert.ok(markdown.includes("<!-- ECC_SKILL_OPTIMIZATION:"));
  assert.ok(markdown.includes("included=1"));
  assert.ok(markdown.includes("truncated=0"));
  assert.ok(markdown.includes("savings="));
});

test("ecc-skill-injector: Assertion 5 - zero skills handling", () => {
  const injector = new EccSkillContextInjector();
  const result = injector.injectAndOptimizeSkills([]);

  assert.equal(result.synthesizedMarkdown, "");
  assert.equal(result.metrics.includedSkillCount, 0);
  assert.equal(result.metrics.truncatedSkillCount, 0);
  assert.equal(result.metrics.originalBytes, 0);
  assert.equal(result.metrics.compactedBytes, 0);
  assert.equal(result.metrics.savingsRatio, 0);
});
