import * as crypto from "node:crypto";
import type {
  EccDispatchRequest,
  EccDispatchResult,
  EccCatalogSnapshot
} from "../../shared/eccContracts.js";
import type { EccCatalogService } from "./EccCatalogService.js";
import type { SubagentService } from "./SubagentService.js";
import {
  EccSkillContextInjector,
  type EccSkillInjectorOptions
} from "./EccSkillContextInjector.js";

export const DEFAULT_MAX_CONTEXT_BYTES = 32 * 1024; // 32 KiB (~8,000 tokens)

export interface EccDispatcherOptions {
  readonly maxContextBytes?: number;
  readonly skillInjectorOptions?: EccSkillInjectorOptions;
  readonly skillInjector?: EccSkillContextInjector;
  readonly now?: () => number;
}

/**
 * Service that validates and dispatches ECC agent and skill capability requests into SubagentService.
 * Enforces stale catalog rejection, quarantine barriers, context limits, and zero target repository pollution.
 */
export class EccDispatcherService {
  private readonly catalogService: EccCatalogService;
  private readonly subagentService: SubagentService;
  private readonly skillInjector: EccSkillContextInjector;
  private readonly maxContextBytes: number;
  private readonly now: () => number;

  constructor(
    catalogService: EccCatalogService,
    subagentService: SubagentService,
    options?: EccDispatcherOptions
  ) {
    this.catalogService = catalogService;
    this.subagentService = subagentService;
    this.skillInjector = options?.skillInjector ?? new EccSkillContextInjector(options?.skillInjectorOptions);
    this.maxContextBytes = options?.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
    this.now = options?.now ?? (() => Date.now());
  }

  /**
   * Dispatches an ECC capability request into a concrete subagent activity.
   */
  async dispatch(request: EccDispatchRequest): Promise<EccDispatchResult> {
    // 1. Validate request shape
    if (!request || typeof request !== "object") {
      return {
        accepted: false,
        reason: "INVALID_SELECTION",
        message: "Invalid dispatch request object"
      };
    }

    const { catalogRevision, agentId, skillIds = [], task } = request;

    if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
      return {
        accepted: false,
        reason: "INVALID_SELECTION",
        message: "Missing or invalid agentId"
      };
    }

    if (!task || typeof task !== "string" || !task.trim()) {
      return {
        accepted: false,
        reason: "INVALID_SELECTION",
        message: "Task description cannot be empty"
      };
    }

    // 2. Fetch current catalog snapshot and verify revision freshness
    const snapshot: EccCatalogSnapshot = await this.catalogService.getSnapshot();

    if (!catalogRevision || snapshot.revision !== catalogRevision) {
      return {
        accepted: false,
        reason: "STALE_CATALOG",
        message: `Catalog revision stale (current: ${snapshot.revision}, requested: ${catalogRevision})`
      };
    }

    // 3. Verify Agent exists and is not quarantined
    const agentSummary = snapshot.assets.find((a) => a.id === agentId);
    if (!agentSummary) {
      return {
        accepted: false,
        reason: "INVALID_SELECTION",
        message: `Agent '${agentId}' not found in catalog`
      };
    }

    if (agentSummary.kind !== "agent") {
      return {
        accepted: false,
        reason: "INVALID_SELECTION",
        message: `Asset '${agentId}' is a ${agentSummary.kind}, not an agent`
      };
    }

    if (agentSummary.status === "quarantined") {
      return {
        accepted: false,
        reason: "QUARANTINED",
        message: `Agent '${agentSummary.name}' is quarantined: ${agentSummary.reasons.join(", ")}`
      };
    }

    // 4. Verify Skills exist and are not quarantined
    const uniqueSkillIds = Array.from(new Set(skillIds));
    for (const sId of uniqueSkillIds) {
      const skillSummary = snapshot.assets.find((a) => a.id === sId);
      if (!skillSummary) {
        return {
          accepted: false,
          reason: "INVALID_SELECTION",
          message: `Skill '${sId}' not found in catalog`
        };
      }

      if (skillSummary.kind !== "skill") {
        return {
          accepted: false,
          reason: "INVALID_SELECTION",
          message: `Asset '${sId}' is a ${skillSummary.kind}, not a skill`
        };
      }

      if (skillSummary.status === "quarantined") {
        return {
          accepted: false,
          reason: "QUARANTINED",
          message: `Skill '${skillSummary.name}' is quarantined: ${skillSummary.reasons.join(", ")}`
        };
      }
    }

    // 5. Load verified content (real-time content hash check and path containment)
    let loadedAssets;
    try {
      loadedAssets = await this.catalogService.loadSelected(
        snapshot.revision,
        agentId,
        uniqueSkillIds
      );
    } catch (err) {
      return {
        accepted: false,
        reason: "INVALID_SELECTION",
        message: `Failed to load selected assets: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    const agentAsset = loadedAssets.find((a) => a.summary.id === agentId);
    if (!agentAsset) {
      return {
        accepted: false,
        reason: "INVALID_SELECTION",
        message: `Loaded agent asset '${agentId}' missing from loaded set`
      };
    }

    const skillAssets = loadedAssets.filter((a) => a.summary.kind === "skill");

    // 6. Compact and inject skills via EccSkillContextInjector
    const skillInjection = this.skillInjector.injectAndOptimizeSkills(
      skillAssets.map((s) => ({
        id: s.summary.id,
        name: s.summary.name,
        description: s.summary.description,
        content: s.content
      }))
    );

    // 7. Synthesize runner prompt and check context limits
    const synthesizedPrompt = this.synthesizePrompt(
      agentAsset.summary.name,
      agentAsset.content,
      skillInjection.synthesizedMarkdown,
      task.trim()
    );

    const promptBytes = Buffer.byteLength(synthesizedPrompt, "utf8");
    if (promptBytes > this.maxContextBytes) {
      return {
        accepted: false,
        reason: "CONTEXT_LIMIT",
        message: `Combined prompt size (${promptBytes} bytes) exceeds context ceiling (${this.maxContextBytes} bytes)`
      };
    }

    // 8. Dispatch to SubagentService (ephemeral, zero target repository pollution)
    const sanitizedAgentName = agentSummary.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const invocationId = `ecc-${sanitizedAgentName}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

    const activity = this.subagentService.recordInvocation({
      id: invocationId,
      role: `ecc:${agentSummary.name}`,
      model: agentSummary.model || "inherit",
      prompt: synthesizedPrompt,
      startedAt: this.now(),
      eccMetadata: {
        source: "ecc",
        agentId: request.agentId,
        skillIds: [...request.skillIds],
        optimization: skillInjection.metrics
      }
    });

    return {
      accepted: true,
      invocationId: activity.id,
      optimization: skillInjection.metrics
    };
  }

  /**
   * Deterministically synthesizes agent instructions, injected skills, and active task.
   */
  private synthesizePrompt(
    agentName: string,
    agentContent: string,
    skillsMarkdown: string,
    task: string
  ): string {
    const sections: string[] = [];

    sections.push(`# ECC Agent: ${agentName}\n\n${agentContent.trim()}`);

    if (skillsMarkdown.trim()) {
      sections.push(skillsMarkdown.trim());
    }

    sections.push(`## Active Mission Task:\n\n${task.trim()}`);

    return sections.join("\n\n---\n\n");
  }
}
