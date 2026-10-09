import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  evaluatePreToolUseHook
} from "../src/cli/preToolUseHook.js";
import {
  PreToolUseHookService
} from "../src/main/services/preToolUseHookService.js";
import {
  authorizeMutation,
  signMutationAuthorization,
  createBlueprintApproval,
  canonicalizePath,
  type ActiveSessionAuthority
} from "../src/main/services/blueprintApprovalAuthenticator.js";
import type { MutationAuthorization } from "../src/cli/preToolUseHookHelpers.js";
import { parseSha256Hex } from "../src/checksum.js";
import type { LoopState } from "../src/engine.js";

function createMockLoopState(overrides: Partial<LoopState> = {}): LoopState {
  const dummyHash = parseSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  return {
    schemaVersion: 1,
    revision: 1,
    runId: "run-active-test",
    currentPhase: "EXECUTE",
    status: "running",
    goldenSha256: dummyHash,
    budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
    usage: { transitions: 5, retries: 0, operations: 1 },
    history: [],
    resourceBudget: {
      maxCostMicroUsd: 1000000,
      maxTokens: 120000,
      maxOracleCalls: 2,
      maxGlobalCycles: 2,
      maxVerificationRetries: 1,
      maxQualityRemediations: 1
    },
    resourceUsage: {
      costMicroUsd: 0,
      promptTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      oracleCalls: 0,
      globalCycles: 0,
      verificationRetries: 0,
      qualityRemediations: 0
    },
    blueprint: {
      status: "ready",
      invocationKey: parseSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      invocationCount: 1,
      artifactPath: ".ai/blueprint.md",
      artifactSha256: parseSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      assertionsSha256: parseSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      plannedTreeHash: parseSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      protectedEvalHash: parseSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      goldenAssertions: [
        { in: "in1", out: "out1" },
        { in: "in2", out: "out2" },
        { in: "in3", out: "out3" }
      ]
    },
    ...overrides
  };
}

test("Golden Assertion 1: old run-1789013475251 envelope; EXECUTE -> deny; zero mutations", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ga1-test-"));
  const workspace = path.join(tmpDir, "workspace");
  const userData = path.join(tmpDir, "user-data");
  const sidecarStatePath = path.join(tmpDir, "sidecar", "state.json");
  const targetFile = path.join(workspace, "src", "index.ts");

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.mkdirSync(path.dirname(sidecarStatePath), { recursive: true });
  fs.writeFileSync(targetFile, "original content", "utf-8");

  try {
    const signingKey = PreToolUseHookService.getOrCreateSigningKeySync(userData);
    const canonWorkspace = canonicalizePath(workspace);

    // Active session has a new run ID
    const activeRunId = "run-active-session-new";
    const activeSession: ActiveSessionAuthority = {
      sessionId: "session-active-1",
      runId: activeRunId,
      workspaceId: canonWorkspace,
      revision: 1,
      blueprintDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      leaseExpiresAtMs: Date.now() + 60000
    };

    // Old envelope signed for run-1789013475251 with phase: "EXECUTE"
    const oldEnvelope = signMutationAuthorization(
      {
        version: 1,
        sessionId: "session-old-stale",
        runId: "run-1789013475251",
        workspaceId: canonWorkspace,
        revision: 1,
        phase: "EXECUTE",
        blueprintDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        issuedAtMs: Date.now() - 5000,
        expiresAtMs: Date.now() + 50000
      },
      signingKey
    );

    // 1. Direct unit assertion on authorizeMutation
    const decision = authorizeMutation(
      oldEnvelope,
      { canonicalPath: targetFile },
      activeSession,
      signingKey
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "SESSION_MISMATCH");

    // 2. Full CLI hook execution test
    const hookService = new PreToolUseHookService();
    PreToolUseHookService.setActiveSession(workspace, activeSession);

    const state = createMockLoopState({
      runId: activeRunId,
      blueprintApproval: createBlueprintApproval(
        {
          runId: activeRunId,
          canonicalWorkspacePath: workspace,
          blueprintSha256: activeSession.blueprintDigest
        },
        signingKey
      )
    });
    fs.writeFileSync(sidecarStatePath, JSON.stringify(state), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspace,
      sidecarStatePath,
      userDataPath: userData
    });

    const hookResult = await evaluatePreToolUseHook(
      {
        toolCall: {
          name: "replace_file_content",
          args: {
            TargetFile: targetFile,
            ReplacementContent: "mutated content"
          }
        },
        workspacePaths: [workspace],
        runId: activeRunId,
        authorization: oldEnvelope
      },
      { userDataPath: userData }
    );

    assert.equal(hookResult.decision, "deny");
    assert.match(hookResult.reason, /SESSION_MISMATCH/);

    // Zero mutations: file on disk was not modified
    assert.equal(fs.readFileSync(targetFile, "utf-8"), "original content");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 2: valid envelope after expiry or revocation -> deny; zero mutations", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ga2-test-"));
  const workspace = path.join(tmpDir, "workspace");
  const userData = path.join(tmpDir, "user-data");
  const targetFile = path.join(workspace, "src", "app.ts");

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, "unmutated base", "utf-8");

  try {
    const signingKey = PreToolUseHookService.getOrCreateSigningKeySync(userData);
    const canonWorkspace = canonicalizePath(workspace);

    // Subtest A: Expired envelope
    const activeSession: ActiveSessionAuthority = {
      sessionId: "session-exp-1",
      runId: "run-exp-1",
      workspaceId: canonWorkspace,
      revision: 1,
      blueprintDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      leaseExpiresAtMs: Date.now() - 1000 // already expired
    };

    const expiredEnvelope = signMutationAuthorization(
      {
        version: 1,
        sessionId: "session-exp-1",
        runId: "run-exp-1",
        workspaceId: canonWorkspace,
        revision: 1,
        phase: "EXECUTE",
        blueprintDigest: activeSession.blueprintDigest,
        issuedAtMs: Date.now() - 10000,
        expiresAtMs: Date.now() - 1000
      },
      signingKey
    );

    const expDecision = authorizeMutation(
      expiredEnvelope,
      { canonicalPath: targetFile },
      activeSession,
      signingKey
    );
    assert.equal(expDecision.allowed, false);
    assert.equal(expDecision.reason, "EXPIRED");

    // Subtest B: Revocation / Invalidation
    PreToolUseHookService.setActiveSession(workspace, {
      ...activeSession,
      leaseExpiresAtMs: Date.now() + 60000
    });

    const activeEnvelope = signMutationAuthorization(
      {
        version: 1,
        sessionId: "session-exp-1",
        runId: "run-exp-1",
        workspaceId: canonWorkspace,
        revision: 1,
        phase: "EXECUTE",
        blueprintDigest: activeSession.blueprintDigest,
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60000
      },
      signingKey
    );

    // Invalidate session (advances revision and zeros lease)
    PreToolUseHookService.invalidateSession(workspace);

    const revokedSession = PreToolUseHookService.getActiveSession(workspace);
    assert.ok(revokedSession);
    assert.equal(revokedSession.revision, 2);

    const revDecision = authorizeMutation(
      activeEnvelope,
      { canonicalPath: targetFile },
      revokedSession,
      signingKey
    );
    assert.equal(revDecision.allowed, false);
    assert.ok(revDecision.reason === "STALE_REVISION" || revDecision.reason === "EXPIRED");

    // Zero mutations
    assert.equal(fs.readFileSync(targetFile, "utf-8"), "unmutated base");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 3: approval digest differs from active blueprint -> APPROVAL_MISMATCH", () => {
  const signingKey = crypto.randomBytes(32);
  const canonWorkspace = "/workspace";

  const activeSession: ActiveSessionAuthority = {
    sessionId: "sess-diff-digest",
    runId: "run-diff-digest",
    workspaceId: canonWorkspace,
    revision: 1,
    blueprintDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    leaseExpiresAtMs: Date.now() + 60000
  };

  // Envelope signed with a differing blueprint digest
  const envelopeWithOldDigest = signMutationAuthorization(
    {
      version: 1,
      sessionId: "sess-diff-digest",
      runId: "run-diff-digest",
      workspaceId: canonWorkspace,
      revision: 1,
      phase: "EXECUTE",
      blueprintDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000
    },
    signingKey
  );

  const decision = authorizeMutation(
    envelopeWithOldDigest,
    { canonicalPath: "/workspace/src/code.ts" },
    activeSession,
    signingKey
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "APPROVAL_MISMATCH");
});

function createAuditFixture() {
  const workspacePath = path.resolve(
    os.tmpdir(),
    `mutation-auth-audit-${crypto.randomUUID()}`
  );
  const signingKey = Buffer.alloc(32, 0x61);

  const authorization =
    PreToolUseHookService.createSessionAuthorization({
      workspacePath,
      runId: "run-1789013475251",
      blueprintDigest: "a".repeat(64),
      leaseMs: 60_000,
      signingKey
    });

  const authority =
    PreToolUseHookService.getActiveSession(workspacePath);
  assert.ok(authority);

  return {
    workspacePath,
    signingKey,
    authorization,
    authority,
    target: {
      canonicalPath: path.join(workspacePath, "src", "audit-target.ts")
    }
  };
}

test("AUTH-03: authorization fails closed when no signing key is available", () => {
  const fixture = createAuditFixture();

  try {
    const forgedAuthorization = {
      ...fixture.authorization,
      signature:
        fixture.authorization.signature === "0".repeat(64)
          ? "1".repeat(64)
          : "0".repeat(64)
    };

    const decision: unknown = Reflect.apply(
      authorizeMutation,
      undefined,
      [
        forgedAuthorization,
        fixture.target,
        fixture.authority,
        undefined
      ]
    );

    assert.ok(
      decision !== null &&
      typeof decision === "object" &&
      "allowed" in decision
    );
    assert.equal(
      (decision as { allowed: boolean }).allowed,
      false,
      "A missing signing key must never disable HMAC verification"
    );
  } finally {
    PreToolUseHookService.invalidateSession(fixture.workspacePath);
  }
});

test("AUTH-04: zero authority lease is expired even for a current signed revision", () => {
  const fixture = createAuditFixture();

  try {
    PreToolUseHookService.invalidateSession(fixture.workspacePath);

    const revokedAuthority =
      PreToolUseHookService.getActiveSession(fixture.workspacePath);
    assert.ok(revokedAuthority);
    assert.equal(revokedAuthority.leaseExpiresAtMs, 0);

    const authorization = signMutationAuthorization(
      {
        version: 1,
        sessionId: revokedAuthority.sessionId,
        runId: revokedAuthority.runId,
        workspaceId: revokedAuthority.workspaceId,
        revision: revokedAuthority.revision,
        phase: "EXECUTE",
        blueprintDigest: revokedAuthority.blueprintDigest,
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000
      },
      fixture.signingKey
    );

    assert.deepEqual(
      authorizeMutation(
        authorization,
        fixture.target,
        revokedAuthority,
        fixture.signingKey
      ),
      { allowed: false, reason: "EXPIRED" }
    );
  } finally {
    PreToolUseHookService.invalidateSession(fixture.workspacePath);
  }
});

test("AUTH-02: a separate hook process cannot authorize from a revoked snapshot", () => {
  const fixture = createAuditFixture();

  try {
    const snapshot = fixture.authority;
    PreToolUseHookService.invalidateSession(fixture.workspacePath);

    const authenticatorUrl = new URL(
      "../src/main/services/blueprintApprovalAuthenticator.js",
      import.meta.url
    ).href;
    const serviceUrl = new URL(
      "../src/main/services/preToolUseHookService.js",
      import.meta.url
    ).href;

    const childSource = `
      import { authorizeMutation } from
        ${JSON.stringify(authenticatorUrl)};
      import { PreToolUseHookService } from
        ${JSON.stringify(serviceUrl)};

      const input = JSON.parse(process.argv[1]);
      const live =
        PreToolUseHookService.getActiveSession(input.workspacePath);

      const authority = live ?? input.snapshot ?? null;
      const decision = authorizeMutation(
        input.authorization,
        input.target,
        authority,
        Buffer.from(input.keyHex, "hex")
      );

      process.stdout.write(JSON.stringify({ live, decision }));
    `;

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        childSource,
        JSON.stringify({
          workspacePath: fixture.workspacePath,
          snapshot,
          authorization: fixture.authorization,
          target: fixture.target,
          keyHex: fixture.signingKey.toString("hex")
        })
      ],
      { encoding: "utf8", timeout: 180_000 }
    );

    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);

    const result = JSON.parse(child.stdout) as { live: unknown; decision: { allowed: boolean } };
    assert.ok(result !== null && typeof result === "object");
    assert.equal(result.live, null);

    assert.ok("decision" in result);
    assert.equal(
      result.decision.allowed,
      false,
      "A registry snapshot must not authorize after main-process revocation"
    );
  } finally {
    PreToolUseHookService.invalidateSession(fixture.workspacePath);
  }
});

test("AUTH-01: legacy blueprint approval without active session authority or envelope -> deny; zero mutations", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth01-test-"));
  const workspace = path.join(tmpDir, "workspace");
  const userData = path.join(tmpDir, "user-data");
  const sidecarStatePath = path.join(tmpDir, "sidecar", "state.json");
  const targetFile = path.join(workspace, "src", "index.ts");

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.mkdirSync(path.dirname(sidecarStatePath), { recursive: true });
  fs.writeFileSync(targetFile, "original unmutated content", "utf-8");

  try {
    const hookService = new PreToolUseHookService();
    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspace,
      sidecarStatePath,
      userDataPath: userData
    });

    // Valid legacy blueprint approval in state.json
    const state = createMockLoopState({
      runId: "run-legacy-001",
      blueprintApproval: createBlueprintApproval(
        {
          runId: "run-legacy-001",
          canonicalWorkspacePath: workspace,
          blueprintSha256: "a".repeat(64)
        },
        equipped.signingKey
      )
    });
    fs.writeFileSync(sidecarStatePath, JSON.stringify(state), "utf-8");

    // Ensure NO active session exists
    PreToolUseHookService.invalidateSession(workspace, userData);

    // Call hook with NO authorization envelope in payload
    const input = {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: targetFile, ReplacementContent: "tampered" }
      },
      workspacePaths: [workspace]
    };

    const res = await evaluatePreToolUseHook(input, { userDataPath: userData });
    assert.equal(res.decision, "deny");
    assert.match(res.reason, /NO_ACTIVE_SESSION/);

    // Zero mutations
    assert.equal(fs.readFileSync(targetFile, "utf-8"), "original unmutated content");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

