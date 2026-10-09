import test from "node:test";
import assert from "node:assert/strict";
import {
  EccSkillContextInjector,
  type EccSkillInput
} from "../src/main/services/EccSkillContextInjector.js";

test("the complete emitted skill context stays within the total byte budget", () => {
  const totalBudget = 1024;
  const injector = new EccSkillContextInjector({
    maxTotalSkillBytes: totalBudget,
    maxPerSkillBytes: 256
  });

  const skills: EccSkillInput[] = Array.from(
    { length: 12 },
    (_, index) => ({
      id: `skill-${index}`,
      name: `Capability ${index}`,
      description: "A concise description of this capability.",
      content: "x".repeat(240)
    })
  );

  const result = injector.injectAndOptimizeSkills(skills);

  assert.match(
    result.synthesizedMarkdown,
    /SUMMARY ONLY/,
    "budget exhaustion should produce a bounded summary reference card"
  );

  const emittedBytes = Buffer.byteLength(
    result.synthesizedMarkdown,
    "utf8"
  );

  assert.ok(
    emittedBytes <= totalBudget,
    `emitted ${emittedBytes} bytes under a ${totalBudget}-byte cap`
  );
});

test("truncation respects small byte limits without corrupting UTF-8", async (t) => {
  const injector = new EccSkillContextInjector({
    maxPerSkillBytes: 4096
  });

  await t.test("an oversized skill fits a 64-byte allocation with a notice", () => {
    const result = injector.compactSkill(
      {
        id: "small-budget",
        name: "Small budget",
        content: "a".repeat(1000)
      },
      64
    );

    assert.equal(result.truncated, true);
    assert.match(result.text, /\[TRUNCATED: SKILL_BUDGET_REACHED\]/);
    assert.ok(
      Buffer.byteLength(result.text, "utf8") <= 64,
      "body plus truncation notice must fit the allocation"
    );
  });

  await t.test("cutting a multibyte line never introduces replacement characters", () => {
    const result = injector.compactSkill(
      {
        id: "unicode",
        name: "Unicode",
        content: "😀".repeat(1000)
      },
      128
    );

    assert.equal(result.truncated, true);
    assert.equal(
      result.text.includes("\uFFFD"),
      false,
      "truncation must not split a UTF-8 character"
    );
    assert.match(result.text, /\[TRUNCATED: SKILL_BUDGET_REACHED\]/);
    assert.ok(Buffer.byteLength(result.text, "utf8") <= 128);
  });
});

test("injection honors overrides and strips reference-style images", async (t) => {
  await t.test("an upward per-call override supersedes the constructor default", () => {
    const injector = new EccSkillContextInjector();
    const content = "a".repeat(6000);

    const result = injector.injectAndOptimizeSkills(
      [{ id: "large", name: "Large", content }],
      {
        maxTotalSkillBytes: 32 * 1024,
        maxPerSkillBytes: 8 * 1024
      }
    );

    assert.equal(result.metrics.truncatedSkillCount, 0);
    assert.ok(
      result.synthesizedMarkdown.includes(content),
      "a 6000-byte skill should fit an 8192-byte per-call limit"
    );
    assert.doesNotMatch(result.synthesizedMarkdown, /TRUNCATED/);
  });

  await t.test("reference images and reference badges are stripped, not text links", () => {
    const injector = new EccSkillContextInjector();
    const result = injector.compactSkill(
      {
        id: "references",
        name: "References",
        content: [
          "Keep these instructions.",
          "",
          "![diagram][architecture]",
          "![logo][]",
          "![icon]",
          "[![build][status]][ci]",
          "",
          "[documentation][docs]",
          "",
          "[architecture]: https://example.com/architecture.png",
          "[logo]: https://example.com/logo.png",
          "[icon]: https://example.com/icon.png",
          "[status]: https://example.com/status.svg",
          "[ci]: https://example.com/ci",
          "[docs]: https://example.com/docs"
        ].join("\n")
      },
      4096
    );

    assert.ok(result.text.includes("Keep these instructions."));
    assert.ok(result.text.includes("[documentation][docs]"));
    assert.doesNotMatch(
      result.text,
      /!\[/,
      "reference-style image syntax must not survive compaction"
    );
    assert.equal(result.truncated, false);
  });
});
