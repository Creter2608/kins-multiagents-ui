import test from "node:test";
import * as assert from "node:assert/strict";
import { buildSanitizedPtyEnv, ALLOWED_ENV_VARS } from "../src/main/services/PtyService.js";

test("SEC-1: buildSanitizedPtyEnv removes secret keys and tokens", () => {
  const mockEnv: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows\\system32;C:\\Windows",
    USERPROFILE: "C:\\Users\\TestUser",
    SHELL: "powershell.exe",
    OPENAI_API_KEY: "sk-proj-secret123456789",
    ANTHROPIC_API_KEY: "sk-ant-secret987654321",
    AWS_SECRET_ACCESS_KEY: "supersecretawskey",
    GITHUB_TOKEN: "ghp_tokentokentoken",
    DB_PASSWORD: "mypassword123",
    CUSTOM_SECRET: "mysecretvalue"
  };

  const sanitized = buildSanitizedPtyEnv(mockEnv);

  // Sensitive keys must be filtered out
  assert.equal(sanitized["OPENAI_API_KEY"], undefined);
  assert.equal(sanitized["ANTHROPIC_API_KEY"], undefined);
  assert.equal(sanitized["AWS_SECRET_ACCESS_KEY"], undefined);
  assert.equal(sanitized["GITHUB_TOKEN"], undefined);
  assert.equal(sanitized["DB_PASSWORD"], undefined);
  assert.equal(sanitized["CUSTOM_SECRET"], undefined);

  // Allowlisted keys must be preserved
  assert.equal(sanitized["PATH"], mockEnv["PATH"]);
  assert.equal(sanitized["USERPROFILE"], mockEnv["USERPROFILE"]);
  assert.equal(sanitized["SHELL"], mockEnv["SHELL"]);

  // Terminal indicators must be present
  assert.equal(sanitized["COLORTERM"], "truecolor");
  assert.equal(sanitized["TERM"], "xterm-256color");
});

test("SEC-1: buildSanitizedPtyEnv only retains allowlisted keys", () => {
  const mockEnv: NodeJS.ProcessEnv = {
    RANDOM_UNKNOWN_VAR: "some_value",
    ANOTHER_APP_VAR: "12345",
    PATH: "C:\\bin",
    TMP: "C:\\temp"
  };

  const sanitized = buildSanitizedPtyEnv(mockEnv);
  assert.equal(sanitized["RANDOM_UNKNOWN_VAR"], undefined);
  assert.equal(sanitized["ANOTHER_APP_VAR"], undefined);
  assert.equal(sanitized["PATH"], "C:\\bin");
  assert.equal(sanitized["TMP"], "C:\\temp");
});
