"""Native messaging host for the GitHub Merge Helper Firefox extension.

Firefox starts this for each request (only for the extension ID listed in the
host manifest). It reads the Claude API key from the OS keychain, sends the
request to the Claude Messages API, and returns the model's text.

The request comes from the extension, which builds it from untrusted PR data,
so it is checked against a strict allowlist: no tools, a single user message,
a fixed endpoint, size caps. The key is never sent back to the extension.
"""

import json
import os
import re
import struct
import subprocess
import sys

# Don't let the browser's environment redirect requests or add credentials.
for _name in [n for n in os.environ if n.startswith("ANTHROPIC_")]:
    del os.environ[_name]

import anthropic  # noqa: E402

KEYCHAIN_SERVICE = "github-merge-helper"
KEYCHAIN_ACCOUNT = "anthropic-api-key"
BASE_URL = "https://api.anthropic.com"

MAX_SYSTEM_CHARS = 200_000
MAX_USER_CHARS = 1_000_000
MAX_OUTPUT_TOKENS = 16_000
ALLOWED_EFFORTS = {"low", "medium", "high", "xhigh", "max"}
ALLOWED_BETAS = {"server-side-fallback-2026-07-01"}
MODEL_PATTERN = re.compile(r"^claude-[a-z0-9-]{1,60}$")


class InvalidRequest(Exception):
    pass


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    if length > 8 * 1024 * 1024:
        raise InvalidRequest("Message too large.")
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(message):
    data = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_api_key():
    if sys.platform == "darwin":
        command = ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]
    elif sys.platform.startswith("linux"):
        command = ["/usr/bin/secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]
    else:
        raise InvalidRequest("Only macOS and Linux are supported.")
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    key = result.stdout.strip()
    if result.returncode != 0 or not key:
        raise InvalidRequest("No Claude API key in the keychain. Run `python3 native/install.py --set-key`.")
    return key


def validated_params(params):
    """Rebuild the request from allowed fields only; reject anything else."""
    if not isinstance(params, dict):
        raise InvalidRequest("Invalid request.")
    allowed = {"model", "max_tokens", "system", "messages", "output_config", "betas", "fallbacks"}
    extra = set(params) - allowed
    if extra:
        raise InvalidRequest(f"Unexpected request fields: {', '.join(sorted(extra))}.")

    model = params.get("model")
    if not isinstance(model, str) or not MODEL_PATTERN.match(model):
        raise InvalidRequest("Invalid model.")
    max_tokens = params.get("max_tokens")
    if type(max_tokens) is not int or not 1 <= max_tokens <= MAX_OUTPUT_TOKENS:
        raise InvalidRequest("Invalid max_tokens.")
    system = params.get("system")
    if not isinstance(system, str) or len(system) > MAX_SYSTEM_CHARS:
        raise InvalidRequest("Invalid system prompt.")

    messages = params.get("messages")
    if (
        not isinstance(messages, list)
        or len(messages) != 1
        or not isinstance(messages[0], dict)
        or set(messages[0]) != {"role", "content"}
        or messages[0]["role"] != "user"
        or not isinstance(messages[0]["content"], str)
        or len(messages[0]["content"]) > MAX_USER_CHARS
    ):
        raise InvalidRequest("Invalid messages: expected one user message with text content.")

    output_config = params.get("output_config")
    if not isinstance(output_config, dict) or set(output_config) - {"effort", "format"}:
        raise InvalidRequest("Invalid output_config.")
    if "effort" in output_config and output_config["effort"] not in ALLOWED_EFFORTS:
        raise InvalidRequest("Invalid effort.")
    fmt = output_config.get("format")
    if not isinstance(fmt, dict) or set(fmt) != {"type", "schema"} or fmt["type"] != "json_schema" or not isinstance(fmt["schema"], dict):
        raise InvalidRequest("Invalid output format.")

    betas = params.get("betas", [])
    if not isinstance(betas, list) or not set(betas) <= ALLOWED_BETAS:
        raise InvalidRequest("Invalid betas.")
    fallbacks = params.get("fallbacks")
    if fallbacks not in (None, "default"):
        raise InvalidRequest("Invalid fallbacks.")

    clean = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": messages[0]["content"]}],
        "output_config": output_config,
    }
    if betas:
        clean["betas"] = betas
    if fallbacks:
        clean["fallbacks"] = fallbacks
    return clean


def client():
    return anthropic.Anthropic(api_key=read_api_key(), base_url=BASE_URL, max_retries=2, timeout=300)


def handle(message):
    if not isinstance(message, dict):
        raise InvalidRequest("Invalid request.")
    kind = message.get("type")
    if kind == "ping":
        # Free request to check the key works.
        client().models.list(limit=1)
        return {"ok": True}
    if kind == "messages":
        params = validated_params(message.get("params"))
        response = client().beta.messages.create(**params)
        text = "".join(block.text for block in response.content if block.type == "text")
        stop_details = getattr(response, "stop_details", None)
        return {
            "ok": True,
            "response": {
                "model": response.model,
                "stop_reason": response.stop_reason,
                "stop_category": getattr(stop_details, "category", None) if stop_details else None,
                "text": text,
            },
        }
    raise InvalidRequest("Unknown request type.")


def error_reply(e):
    if isinstance(e, anthropic.APIStatusError):
        body = e.body if isinstance(e.body, dict) else {}
        detail = (body.get("error") or {}).get("message") or str(e)
        return {"ok": False, "error": {"status": e.status_code, "type": getattr(e, "type", None), "message": detail, "request_id": e.request_id}}
    if isinstance(e, anthropic.APIConnectionError):
        return {"ok": False, "error": {"message": "Couldn't reach the Claude API."}}
    if isinstance(e, InvalidRequest):
        return {"ok": False, "error": {"message": str(e)}}
    print(f"github-merge-helper host: {type(e).__name__}", file=sys.stderr)
    return {"ok": False, "error": {"message": f"Native host error ({type(e).__name__})."}}


def main():
    while True:
        try:
            message = read_message()
        except Exception as e:  # malformed framing or JSON
            send_message(error_reply(e if isinstance(e, InvalidRequest) else InvalidRequest("Malformed message.")))
            return
        if message is None:
            return
        try:
            send_message(handle(message))
        except Exception as e:
            send_message(error_reply(e))


if __name__ == "__main__":
    main()
