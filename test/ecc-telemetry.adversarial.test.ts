import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import ts from "typescript";

test("contracts exposes the ECC metadata type imported by SubagentService", () => {
  const contractsPath = path.resolve("src/shared/contracts.ts");
  const program = ts.createProgram([contractsPath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
  });

  const source = program.getSourceFile(contractsPath);
  assert.ok(source, "contracts.ts must be available");

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.ok(moduleSymbol, "contracts.ts must be an external module");

  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.name === "EccDispatchedMetadata");

  assert.ok(
    exported,
    "Importing EccDispatchedMetadata internally does not re-export it",
  );

  const resolved =
    exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported;

  assert.ok(
    Boolean(resolved.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Interface)),
    "EccDispatchedMetadata must resolve to an exported type or interface",
  );
});

test("AQI satisfies the architecture quality index compliance", async () => {
  const judgeModuleUrl = pathToFileURL(path.resolve(process.cwd(), "scripts/harness/judge.mjs")).href;
  const { evaluateArchitecturalCompliance } = await import(judgeModuleUrl);
  const diff = execSync("git diff HEAD", { encoding: "utf8" });
  const result = evaluateArchitecturalCompliance(diff, { taskType: "bootstrap" });
  assert.equal(result.passed, true);
  assert.ok(result.aqi >= 4.5, `AQI score must be >= 4.5, got ${result.aqi}`);
  assert.equal(result.feedback.length, 0);
});
