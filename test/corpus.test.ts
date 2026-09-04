import test from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const CORPUS_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "corpus.mjs")).href;
const {
  canonicalizeTaskManifest,
  hashTaskManifest,
  validateCandidateTask,
  ingestTask,
  verifyCorpus
} = await import(CORPUS_URL) as typeof import("../scripts/harness/corpus.d.mts");

test("corpus: canonicalizeTaskManifest sorts keys recursively and excludes manifestSha256", () => {
  const objA = {
    schemaVersion: 1,
    title: "Test Task",
    taskId: "001-fix-bug",
    manifestSha256: "some-old-sha",
    datasetId: "kins-benchmark",
    commands: [{ argv: ["node", "-v"], timeoutMs: 5000 }],
    hiddenAssertions: [
      { path: "b/file.txt", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { path: "a/file.txt", sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    ]
  };

  const objB = {
    datasetId: "kins-benchmark",
    taskId: "001-fix-bug",
    title: "Test Task",
    schemaVersion: 1,
    hiddenAssertions: [
      { path: "a/file.txt", sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { path: "b/file.txt", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    ],
    commands: [{ timeoutMs: 5000, argv: ["node", "-v"] }]
  };

  const canonA = canonicalizeTaskManifest(objA);
  const canonB = canonicalizeTaskManifest(objB);

  assert.equal(canonA, canonB, "Canonicalized outputs must be identical regardless of key order");
  assert.equal(canonA.includes("manifestSha256"), false, "manifestSha256 must be excluded from canonical payload");
});

test("corpus: hashTaskManifest is deterministic across identical contents", () => {
  const taskA = {
    schemaVersion: 1,
    taskId: "002-cache-hit",
    title: "Fix cache hit rate",
    datasetId: "kins-benchmark",
    datasetVersion: "1.0.0",
    commands: [{ argv: ["node", "test.js"], timeoutMs: 10000 }]
  };

  const taskB = {
    commands: [{ argv: ["node", "test.js"], timeoutMs: 10000 }],
    datasetVersion: "1.0.0",
    datasetId: "kins-benchmark",
    title: "Fix cache hit rate",
    taskId: "002-cache-hit",
    schemaVersion: 1
  };

  const hashA = hashTaskManifest(taskA);
  const hashB = hashTaskManifest(taskB);

  assert.match(hashA, /^[0-9a-f]{64}$/);
  assert.equal(hashA, hashB, "Hashes must match deterministically");
});

test("corpus: validateCandidateTask validates schema rules and rejects path traversals", () => {
  const validTask = {
    schemaVersion: 1,
    taskId: "003-login-flow",
    title: "Verify login flow",
    datasetId: "auth-suite",
    datasetVersion: "1.2.0",
    repositoryUrl: "https://github.com/example/repo",
    baseCommit: "1111111111111111111111111111111111111111",
    targetCommit: "2222222222222222222222222222222222222222",
    sourceType: "commit",
    sourceId: "22222222",
    license: "MIT",
    taskType: "f2p",
    weight: 1.5,
    commands: [{ argv: ["npm", "test"], timeoutMs: 30000 }],
    hiddenAssertions: [
      { path: "specs/hidden.test.ts", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
    ],
    publicFiles: ["src/index.ts", "package.json"]
  };

  const validResult = validateCandidateTask(validTask);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.errors.length, 0);

  // Invalid task ID format
  const invalidId = validateCandidateTask({ ...validTask, taskId: "INVALID_TASK_ID!" });
  assert.equal(invalidId.valid, false);
  assert.match(invalidId.errors[0]!, /taskId 'INVALID_TASK_ID!' invalid/);

  // Path traversal in hiddenAssertions
  const traversalAssertion = validateCandidateTask({
    ...validTask,
    hiddenAssertions: [{ path: "../secret.key", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }]
  });
  assert.equal(traversalAssertion.valid, false);
  assert.match(traversalAssertion.errors[0]!, /path must be a relative path without traversal/);

  // Path traversal in publicFiles
  const traversalPublic = validateCandidateTask({
    ...validTask,
    publicFiles: ["../../etc/passwd"]
  });
  assert.equal(traversalPublic.valid, false);
  assert.match(traversalPublic.errors[0]!, /publicFiles\[0\] must be a relative path without traversal/);

  // Invalid commit SHA
  const invalidCommit = validateCandidateTask({
    ...validTask,
    baseCommit: "not-a-40-char-sha"
  });
  assert.equal(invalidCommit.valid, false);
  assert.match(invalidCommit.errors[0]!, /baseCommit must be a 40-char commit SHA/);
});

test("corpus: ingestTask strictly forbids writing into .eval/ (STAGING_VIOLATION)", async () => {
  const evalStagingDir = path.join(REPO_ROOT, ".eval", "staging-test");

  await assert.rejects(
    async () => {
      await ingestTask({
        repoRoot: REPO_ROOT,
        taskId: "004-eval-leak",
        title: "Attempt to write to protected zone",
        taskType: "p2p",
        baseCommit: "HEAD",
        targetCommit: "HEAD",
        commands: [{ argv: ["node", "-v"] }],
        stagingDir: evalStagingDir,
        validateSemantics: false
      });
    },
    /STAGING_VIOLATION/
  );
});

test("corpus: ingestTask successfully creates staged candidate and manifest", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-corpus-staging-"));

  try {
    const headCommit = execFileSync("git", ["-c", "safe.directory=*", "rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf-8"
    }).trim();

    const result = await ingestTask({
      repoRoot: REPO_ROOT,
      taskId: "005-sample-task",
      title: "Sample verified task",
      taskType: "p2p",
      baseCommit: headCommit,
      targetCommit: headCommit,
      commands: [{ argv: ["node", "-v"] }],
      stagingDir: tempDir,
      validateSemantics: false,
      license: "Apache-2.0",
      datasetId: "unit-benchmark",
      datasetVersion: "2.0.0"
    });

    assert.equal(result.taskId, "005-sample-task");
    assert.equal(fs.existsSync(result.manifestPath), true);
    assert.equal(fs.existsSync(result.benchmarkTaskPath), true);
    assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);

    const manifestContent = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
    assert.equal(manifestContent.taskId, "005-sample-task");
    assert.equal(manifestContent.license, "Apache-2.0");
    assert.equal(manifestContent.datasetId, "unit-benchmark");
    assert.equal(manifestContent.datasetVersion, "2.0.0");
    assert.equal(manifestContent.manifestSha256, result.manifestSha256);

    // Verify corpus directory scan
    const corpusCheck = await verifyCorpus(tempDir);
    assert.equal(corpusCheck.valid, true);
    assert.equal(corpusCheck.count, 1);
    assert.equal(corpusCheck.issues.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus: verifyCorpus flags tampered manifests", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-corpus-tamper-"));

  try {
    const taskDir = path.join(tempDir, "006-tampered");
    fs.mkdirSync(taskDir, { recursive: true });

    const tamperedManifest = {
      schemaVersion: 1,
      taskId: "006-tampered",
      title: "Tampered manifest",
      datasetId: "unit-suite",
      datasetVersion: "1.0.0",
      repositoryUrl: "local",
      baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sourceType: "commit",
      sourceId: "bbbbbbbb",
      license: "MIT",
      taskType: "f2p",
      weight: 1,
      commands: [{ argv: ["node", "-v"], timeoutMs: 5000 }],
      hiddenAssertions: [],
      manifestSha256: "0000000000000000000000000000000000000000000000000000000000000000" // Wrong hash
    };

    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(tamperedManifest, null, 2), "utf-8");

    const check = await verifyCorpus(tempDir);
    assert.equal(check.valid, false);
    assert.equal(check.count, 1);
    assert.equal(check.issues.length, 1);
    assert.match(check.issues[0]!, /manifestSha256 mismatch/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
