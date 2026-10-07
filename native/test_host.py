"""Tests for the native host. Run: native/.venv/bin/python -I -m unittest discover -s native"""

import importlib.util
import json
import struct
import subprocess
import sys
import unittest
from pathlib import Path

HOST = Path(__file__).resolve().parent / "host.py"
spec = importlib.util.spec_from_file_location("host", HOST)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def good_params(**overrides):
    params = {
        "model": "claude-opus-5-5",
        "max_tokens": 16000,
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
        "output_config": {"effort": "medium", "format": {"type": "json_schema", "schema": {"type": "object"}}},
        "system": "rules",
        "messages": [{"role": "user", "content": "data"}],
    }
    params.update(overrides)
    return params


class ValidatedParams(unittest.TestCase):
    def test_accepts_extension_request(self):
        self.assertEqual(host.validated_params(good_params())["model"], "claude-opus-5-5")

    def test_rejects_tools_and_other_fields(self):
        for field in ["tools", "tool_choice", "mcp_servers", "container", "metadata", "stream"]:
            with self.subTest(field=field), self.assertRaises(host.InvalidRequest):
                host.validated_params(good_params(**{field: [{"type": "web_fetch_20260209", "name": "web_fetch"}]}))

    def test_rejects_bad_values(self):
        bad = [
            {"model": "gpt-5"},
            {"model": "claude-opus-5-5/../../v1/files"},
            {"max_tokens": 128000},
            {"max_tokens": "16000"},
            {"max_tokens": True},
            {"messages": []},
            {"messages": [{"role": "assistant", "content": "x"}]},
            {"messages": [{"role": "user", "content": [{"type": "document", "source": {"type": "url", "url": "https://x"}}]}]},
            {"messages": [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]},
            {"betas": ["code-execution-2025-08-25"]},
            {"fallbacks": [{"model": "claude-opus-4-8"}]},
            {"output_config": {"effort": "medium", "format": {"type": "json_schema", "schema": {}}, "task_budget": {}}},
            {"output_config": {"effort": "huge", "format": {"type": "json_schema", "schema": {}}}},
            {"system": "x" * 200_001},
        ]
        for override in bad:
            with self.subTest(override=list(override)), self.assertRaises(host.InvalidRequest):
                host.validated_params(good_params(**override))

    def test_environment_cannot_redirect(self):
        self.assertFalse(any(name.startswith("ANTHROPIC_") for name in host.os.environ))


class Framing(unittest.TestCase):
    def run_host(self, message):
        data = json.dumps(message).encode()
        result = subprocess.run(
            [sys.executable, "-I", str(HOST)],
            input=struct.pack("=I", len(data)) + data,
            capture_output=True,
            timeout=30,
        )
        (length,) = struct.unpack("=I", result.stdout[:4])
        return json.loads(result.stdout[4 : 4 + length])

    def test_unknown_type(self):
        self.assertEqual(self.run_host({"type": "exfiltrate"}), {"ok": False, "error": {"message": "Unknown request type."}})

    def test_invalid_request_is_rejected_before_reading_the_key(self):
        reply = self.run_host({"type": "messages", "params": good_params(tools=[])})
        self.assertFalse(reply["ok"])
        self.assertIn("Unexpected request fields: tools", reply["error"]["message"])


if __name__ == "__main__":
    unittest.main()
