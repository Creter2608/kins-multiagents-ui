import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LoopError } from "../errors.js";
import { sha256Bytes, type Sha256Hex } from "../checksum.js";
import type { LoopState, BlueprintRecord } from "../engine.js";
import type { LoopStateStore } from "./LoopStateStore.js";
import { parseBlueprintGoldenAssertions, canonicalizeGoldenAssertions } from "./BlueprintArtifactVerifier.js";

export interface BlueprintOracleResult {
  readonly markdown: string;
  readonly providerReceipt: string;
  readonly completedAt: number;
}

export interface BlueprintOracleClient {
  craftTechnicalPrompt(
    invocationKey: string,
    context: string
  ): Promise<BlueprintOracleResult>;
}

export class BlueprintOracleService {
  constructor(
    private readonly store: LoopStateStore,
    private readonly client: BlueprintOracleClient,
    private readonly workspaceRoot: string = process.cwd()
  ) {}

  async invokeOnce(runId: string, context: string): Promise<LoopState> {
    const deterministicKey = sha256Bytes(Buffer.from(`${runId}:PLAN_ORACLE:v1`, "utf-8"));

    // Step 1: Reserve invocation atomically (0 -> 1)
    const reservedState = await this.store.update((current) => {
      if (current.runId !== runId) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          `Run ID mismatch: expected '${current.runId}', received '${runId}'`
        );
      }

      if (current.currentPhase !== "PLAN") {
        throw new LoopError(
          "TRANSITION_INVALID",
          "transition",
          `Cannot invoke Stage 2 Plan Oracle outside of PLAN phase (current: '${current.currentPhase}')`
        );
      }

      const bp = current.blueprint;
      if (bp && bp.invocationCount >= 1) {
        throw new LoopError(
          "BUDGET_EXHAUSTED",
          "budget",
          `Stage 2 Plan Oracle invocation count already reached maximum of 1 for run '${runId}'`
        );
      }

      const runningRecord: BlueprintRecord = {
        status: "running",
        invocationKey: deterministicKey,
        invocationCount: 1,
        artifactPath: ".ai/blueprint.md",
        plannedTreeHash: current.goldenSha256,
        protectedEvalHash: current.goldenSha256
      };

      return {
        ...current,
        blueprint: runningRecord
      };
    });

    // Step 2: Call trusted oracle client
    let result: BlueprintOracleResult;
    try {
      result = await this.client.craftTechnicalPrompt(deterministicKey, context);
    } catch (err: unknown) {
      // Record failure durably
      await this.store.update((current) => {
        if (!current.blueprint) return current;
        return {
          ...current,
          blueprint: {
            ...current.blueprint,
            status: "failed",
            failureCode: "ORACLE_INVOCATION_FAILED"
          }
        };
      });
      throw new LoopError(
        "EXECUTION_FAILED",
        "execution",
        `Stage 2 Oracle invocation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Step 3: Validate assertions and compute hashes
    let parsedAssertions;
    try {
      parsedAssertions = parseBlueprintGoldenAssertions(result.markdown);
    } catch (err: unknown) {
      await this.store.update((current) => {
        if (!current.blueprint) return current;
        return {
          ...current,
          blueprint: {
            ...current.blueprint,
            status: "failed",
            failureCode: "ASSERTION_SCHEMA_INVALID"
          }
        };
      });
      throw err;
    }

    const artifactSha256 = sha256Bytes(Buffer.from(result.markdown, "utf-8"));
    const assertionsCanonical = canonicalizeGoldenAssertions(parsedAssertions);
    const assertionsSha256 = sha256Bytes(Buffer.from(assertionsCanonical, "utf-8"));
    const receiptSha256 = sha256Bytes(Buffer.from(result.providerReceipt, "utf-8"));

    // Step 4: Atomically write artifact to disk
    const targetPath = path.resolve(this.workspaceRoot, ".ai/blueprint.md");
    const targetDir = path.dirname(targetPath);
    await fs.mkdir(targetDir, { recursive: true });

    const tmpPath = path.join(targetDir, `blueprint.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tmpPath, result.markdown, "utf-8");
    await fs.rename(tmpPath, targetPath);

    // Step 5: Commit ready status to state
    return this.store.update((current) => {
      const readyRecord: BlueprintRecord = {
        status: "ready",
        invocationKey: deterministicKey,
        invocationCount: 1,
        artifactPath: ".ai/blueprint.md",
        plannedTreeHash: current.goldenSha256,
        protectedEvalHash: current.goldenSha256,
        artifactSha256,
        assertionsSha256,
        goldenAssertions: parsedAssertions,
        oracleReceiptSha256: receiptSha256,
        completedAt: result.completedAt || Date.now()
      };

      return {
        ...current,
        blueprint: readyRecord
      };
    });
  }
}
