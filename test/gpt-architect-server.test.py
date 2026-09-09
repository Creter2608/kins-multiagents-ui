import unittest
import json
import sys
import os
import subprocess
from pathlib import Path

# Point to server.py
sys.path.insert(0, r"C:\Users\Kin\.gemini\mcp_servers\gpt_architect")
import server

class TestGptArchitectServer(unittest.TestCase):
    def test_is_reasoning_model(self):
        self.assertTrue(server.is_reasoning_model("gpt-5"))
        self.assertTrue(server.is_reasoning_model("gpt-5.6-sol"))
        self.assertTrue(server.is_reasoning_model("o1"))
        self.assertTrue(server.is_reasoning_model("o1-preview"))
        self.assertTrue(server.is_reasoning_model("o3-mini"))
        self.assertTrue(server.is_reasoning_model("o4-medium"))
        self.assertFalse(server.is_reasoning_model("gpt-4o"))
        self.assertFalse(server.is_reasoning_model("gpt-4o-mini"))
        self.assertFalse(server.is_reasoning_model("claude-3-5-sonnet"))

    def test_extract_compact_test_assertions_valid(self):
        text = """
Some architectural description here.

```json
[
  {"in": "invalid json input", "out": "reject with error"},
  {"in": "empty array", "out": "return []"},
  {"in": "concurrent race", "out": "mutex lock acquired"}
]
```
"""
        assertions = server.extract_compact_test_assertions(text)
        self.assertEqual(len(assertions), 3)
        self.assertEqual(assertions[0]["in"], "invalid json input")
        self.assertEqual(assertions[0]["out"], "reject with error")

    def test_extract_compact_test_assertions_invalid(self):
        text = "No assertions here."
        assertions = server.extract_compact_test_assertions(text)
        self.assertEqual(assertions, [])

        malformed = "```json\n[{\"in\": \"only in\"}]\n```"
        self.assertEqual(server.extract_compact_test_assertions(malformed), [])

    def test_safe_truncate_boundaries(self):
        # Negative max_chars raises ValueError
        with self.assertRaises(ValueError):
            server.safe_truncate("hello", -1)

        # Zero max_chars returns empty string
        self.assertEqual(server.safe_truncate("hello", 0), "")

        # Under and exact limit returns exact unchanged string
        self.assertEqual(server.safe_truncate("hello world", 20), "hello world")
        self.assertEqual(server.safe_truncate("hello world", 11), "hello world")

        # Oversized text preserves head and tail with marker
        head_sentinel = "HEAD_START_12345"
        tail_sentinel = "TAIL_END_67890"
        large_text = head_sentinel + ("X" * 25000) + tail_sentinel
        truncated = server.safe_truncate(large_text, 24000)
        self.assertLessEqual(len(truncated), 24000)
        self.assertTrue(truncated.startswith(head_sentinel))
        self.assertTrue(truncated.endswith(tail_sentinel))
        self.assertIn("...<TRUNCATED: HEAD/TAIL PRESERVED>...", truncated)

        # Tiny budget without marker
        tiny = server.safe_truncate("ABCDEFGHIJ", 5)
        self.assertEqual(tiny, "ABCIJ")
        self.assertLessEqual(len(tiny), 5)

    def test_filter_git_diff_lockfiles_and_artifacts(self):
        sample_diff = (
            "diff --git a/src/app.ts b/src/app.ts\n"
            "--- a/src/app.ts\n"
            "+++ b/src/app.ts\n"
            "+// valid source diff\n"
            "diff --git a/package-lock.json b/package-lock.json\n"
            "--- a/package-lock.json\n"
            "+++ b/package-lock.json\n"
            "+// large lockfile\n"
            "diff --git a/dist/bundle.min.js b/dist/bundle.min.js\n"
            "--- a/dist/bundle.min.js\n"
            "+++ b/dist/bundle.min.js\n"
            "+// bundle artifact\n"
            "diff --git a/tests/app.test.ts b/tests/app.test.ts\n"
            "--- a/tests/app.test.ts\n"
            "+++ b/tests/app.test.ts\n"
            "+// test diff\n"
        )
        filtered = server._filter_git_diff(sample_diff)
        self.assertIn("[git diff filter: generated/lockfile sections omitted]", filtered)
        self.assertIn("b/src/app.ts", filtered)
        self.assertIn("b/tests/app.test.ts", filtered)
        self.assertNotIn("b/package-lock.json", filtered)
        self.assertNotIn("b/dist/bundle.min.js", filtered)

    def test_architect_and_auditor_message_boundaries_and_cache_invariance(self):
        # Cacheable context remains identical
        base_ctx = server.build_cacheable_context("TemplateA", "TechStackB")

        cg_oversized = "CG_HEAD_" + ("C" * 30000) + "_CG_TAIL"
        arch_msgs = server.build_architect_messages(
            task="Build feature",
            sp_template="TemplateA",
            tech_stack="TechStackB",
            cg_context=cg_oversized
        )

        # PITFALL-020: Unified Message 0 Prefix invariance across Stage 2 and Stage 4 (>= 1,024 tokens)
        self.assertEqual(arch_msgs[0]["role"], "system")
        self.assertEqual(arch_msgs[0]["content"], server.STATIC_COMMON_CORE_PROMPT)
        self.assertGreaterEqual(len(server.STATIC_COMMON_CORE_PROMPT), 4096)

        # Role-specific instruction at Message 1
        self.assertEqual(arch_msgs[1]["role"], "system")
        self.assertEqual(arch_msgs[1]["content"], server.STATIC_ARCHITECT_ROLE_PROMPT)

        # Cacheable context at Message 2
        self.assertEqual(arch_msgs[2]["role"], "user")
        self.assertEqual(arch_msgs[2]["content"], base_ctx)

        # Dynamic tail bounded at Message 3
        arch_tail = arch_msgs[3]["content"]
        self.assertIn("CG_HEAD_", arch_tail)
        self.assertIn("_CG_TAIL", arch_tail)
        self.assertIn("...<TRUNCATED: HEAD/TAIL PRESERVED>...", arch_tail)

        # Auditor message bounds and Token 0 match
        audit_msgs = server.build_auditor_messages(
            blueprint="Blueprint Contract",
            git_diff="clean diff",
            aqi_findings="A" * 7000,
            test_summary="T" * 7000,
            modified_files="M" * 60000,
            tech_stack="TypeScript"
        )
        self.assertEqual(audit_msgs[0]["role"], "system")
        self.assertEqual(audit_msgs[0]["content"], server.STATIC_COMMON_CORE_PROMPT)
        # Verify Token 0 identity between Stage 2 and Stage 4
        self.assertEqual(arch_msgs[0], audit_msgs[0])

        # Auditor role prompt at Message 1
        self.assertEqual(audit_msgs[1]["role"], "system")
        self.assertEqual(audit_msgs[1]["content"], server.STATIC_AUDITOR_ROLE_PROMPT)

        audit_tail = audit_msgs[3]["content"]
        self.assertIn("...<TRUNCATED: HEAD/TAIL PRESERVED>...", audit_tail)

    def test_normalize_cacheable_text(self):
        raw = "Line 1   \r\nLine 2 \r\n\r\nLine 4  \r\n"
        normalized = server.normalize_cacheable_text(raw)
        self.assertEqual(normalized, "Line 1\nLine 2\n\nLine 4")

    def test_normalize_opaque_payload(self):
        raw_diff = (
            "diff --git a/a.py b/a.py\r\n"
            "@@ -1 +1 @@\r\n"
            "-  old_value\t\r\n"
            "+    new_value  \r\n"
        )
        expected_diff = (
            "diff --git a/a.py b/a.py\n"
            "@@ -1 +1 @@\n"
            "-  old_value\t\n"
            "+    new_value  \n"
        )
        self.assertEqual(
            server.normalize_opaque_payload(raw_diff),
            expected_diff,
        )

class AuditGitHarvestingTests(unittest.TestCase):
    def _git(self, repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_harvest_includes_staged_and_untracked_content(self) -> None:
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)

            self._git(repo, "init")
            self._git(repo, "config", "user.name", "Audit Test")
            self._git(repo, "config", "user.email", "audit@example.invalid")

            tracked = repo / "tracked.ts"
            tracked.write_text("export const value = 'baseline';\n", encoding="utf-8")
            self._git(repo, "add", "tracked.ts")
            self._git(repo, "commit", "-m", "baseline")

            tracked.write_text(
                "export const value = 'staged-only-marker';\n",
                encoding="utf-8",
            )
            self._git(repo, "add", "tracked.ts")

            untracked = repo / "untracked.ts"
            untracked.write_text(
                "export const hidden = 'untracked-marker';\n",
                encoding="utf-8",
            )

            git_diff, modified_files_context = server._harvest_git_context(repo)

            self.assertIn(
                "staged-only-marker",
                git_diff,
                "The audit diff omitted a staged-only modification",
            )
            self.assertIn(
                "staged-only-marker",
                modified_files_context,
                "The modified-file context omitted the staged tracked file",
            )
            self.assertIn(
                "untracked-marker",
                modified_files_context,
                "The modified-file context omitted an untracked source file",
            )

    def test_harvest_fails_instead_of_returning_empty_payload_outside_git_repo(
        self,
    ) -> None:
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            non_repo = Path(directory)

            with self.assertRaises(Exception):
                server._harvest_git_context(non_repo)

    def test_handle_rpc_zero_payload_blueprint_fallback(self) -> None:
        # Test that audit_and_break_code_with_gpt uses LATEST_BLUEPRINT when blueprint param omitted
        server.LATEST_BLUEPRINT = "CACHED_STAGE2_BLUEPRINT_SPEC"
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self._git(repo, "init")
            self._git(repo, "config", "user.name", "Test User")
            self._git(repo, "config", "user.email", "test@example.invalid")
            
            # Create a file
            code_file = repo / "index.ts"
            code_file.write_text("console.log('hello');\n", encoding="utf-8")
            self._git(repo, "add", "index.ts")
            self._git(repo, "commit", "-m", "initial")
            
            # Make a change
            code_file.write_text("console.log('updated');\n", encoding="utf-8")

            # Call handle_rpc_request with empty blueprint and empty git_diff
            req = {
                "jsonrpc": "2.0",
                "id": "test-zero-payload",
                "method": "tools/call",
                "params": {
                    "name": "audit_and_break_code_with_gpt",
                    "arguments": {
                        "repo_path": str(repo)
                    }
                }
            }
            # Note: call_openai_chat will fail without valid mock or API key, but verification reaches call_openai_chat
            # which proves blueprint and git_diff were successfully auto-populated without -32602 error
            resp = server.handle_rpc_request(req)
            # Should NOT be -32602 (missing blueprint or missing diff)
            if "error" in resp:
                self.assertNotEqual(resp["error"].get("code"), -32602)

if __name__ == "__main__":
    unittest.main()
