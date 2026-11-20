"""MCP server (stdio) that gives coding agents one tool, `gemini_ask`.

It sends the prompt, plus any files the agent names, to a Gemini model behind a
gateway that speaks the native Gemini API, and reads the answer as a server-sent
event stream (streamGenerateContent?alt=sse). Standard library only, Python 3.10+.
A personal helper for agents, not part of the T3 Code app.

Configuration (environment):
  GEMINI_MCP_BASE_URL    required. The URL in front of /v1beta, for example
                         https://<workspace>.cloud.databricks.com/ai-gateway/gemini
  GEMINI_MCP_MODELS      required. Comma-separated alias=model pairs. The first one is
                         the default, for example pro=<model-id>,flash=<model-id>
  GEMINI_MCP_TOKEN_FILE  file holding the token ("Bearer <token>" or the bare token).
                         Prefer this to GEMINI_MCP_TOKEN so the token stays out of agent config.
  GEMINI_MCP_TOKEN       the token itself, used when no token file is set
  GEMINI_MCP_HEADERS     optional JSON object of extra request headers, such as gateway tags

Add it to Claude:
  claude mcp add --scope user gemini     -e GEMINI_MCP_BASE_URL=... -e GEMINI_MCP_MODELS=... -e GEMINI_MCP_TOKEN_FILE=...     -- python /path/to/t3code/scripts/gemini-mcp.py

Add it to Codex, in ~/.codex/config.toml (a long review can take minutes):
  [mcp_servers.gemini]
  command = "python"
  args = ["/path/to/t3code/scripts/gemini-mcp.py"]
  tool_timeout_sec = 900
  [mcp_servers.gemini.env]
  GEMINI_MCP_BASE_URL = "..."
  GEMINI_MCP_MODELS = "..."
  GEMINI_MCP_TOKEN_FILE = "..."
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

MAX_FILE_BYTES = 400_000
MAX_TOTAL_BYTES = 2_000_000
READ_TIMEOUT_S = 300  # per read; a streaming answer keeps the connection alive
RETRY_STATUSES = (429, 500, 502, 503, 504)


def env(name):
    return os.environ.get(name, "").strip()


def load_models():
    models = {}
    for pair in env("GEMINI_MCP_MODELS").split(","):
        alias, _, model = pair.partition("=")
        if alias.strip() and model.strip():
            models[alias.strip()] = model.strip()
    return models


BASE_URL = env("GEMINI_MCP_BASE_URL").rstrip("/")
MODELS = load_models()


def tool_definition():
    aliases = list(MODELS) or ["default"]
    return {
        "name": "gemini_ask",
        "description": (
            "Ask a Gemini model. Gemini cannot read files itself: pass the paths it should "
            "see in `files` and they are sent with the prompt. Returns Gemini's full answer "
            "and token usage."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "The question or review instructions."},
                "files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Absolute paths of text files to include (max 400 KB each, 2 MB total).",
                },
                "model": {
                    "type": "string",
                    "enum": aliases,
                    "description": f"Model alias. Defaults to {aliases[0]}.",
                },
                "system": {"type": "string", "description": "Optional system instruction."},
                "max_output_tokens": {"type": "integer", "description": "Optional cap on answer length."},
            },
            "required": ["prompt"],
        },
    }


def read_token():
    token_file = env("GEMINI_MCP_TOKEN_FILE")
    if token_file:
        with open(os.path.expanduser(token_file), encoding="utf-8") as handle:
            token = handle.read().strip()
    else:
        token = env("GEMINI_MCP_TOKEN")
    if not token:
        raise ValueError("set GEMINI_MCP_TOKEN_FILE or GEMINI_MCP_TOKEN")
    return token if token.lower().startswith("bearer ") else f"Bearer {token}"


def request_headers():
    headers = json.loads(env("GEMINI_MCP_HEADERS") or "{}")
    if not isinstance(headers, dict):
        raise ValueError("GEMINI_MCP_HEADERS must be a JSON object")
    headers.update({
        "Authorization": read_token(),
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    })
    return headers


def build_prompt(prompt, files):
    parts, total = [], 0
    for path in files or []:
        with open(path, "rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"{path} is larger than {MAX_FILE_BYTES} bytes")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValueError(f"files exceed {MAX_TOTAL_BYTES} bytes in total")
        parts.append(f"=== FILE: {path} ===\n{data.decode('utf-8', errors='replace')}\n=== END FILE ===")
    parts.append(prompt)
    return "\n\n".join(parts)


def stream_gemini(args):
    alias = args.get("model") or next(iter(MODELS))
    if alias not in MODELS:
        raise ValueError(f"unknown model {alias}; configured: {', '.join(MODELS)}")
    model = MODELS[alias]
    body = {"contents": [{"role": "user", "parts": [{"text": build_prompt(args["prompt"], args.get("files"))}]}]}
    if args.get("system"):
        body["systemInstruction"] = {"parts": [{"text": args["system"]}]}
    if args.get("max_output_tokens"):
        body["generationConfig"] = {"maxOutputTokens": int(args["max_output_tokens"])}
    request = urllib.request.Request(
        f"{BASE_URL}/v1beta/models/{model}:streamGenerateContent?alt=sse",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers=request_headers(),
    )
    text, usage, finish = [], {}, None
    with urllib.request.urlopen(request, timeout=READ_TIMEOUT_S) as response:
        for raw in response:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            event = json.loads(payload)
            if "error" in event:
                raise RuntimeError(json.dumps(event["error"])[:500])
            for candidate in event.get("candidates", []):
                finish = candidate.get("finishReason") or finish
                for part in candidate.get("content", {}).get("parts", []):
                    if part.get("text") and not part.get("thought"):
                        text.append(part["text"])
            usage = event.get("usageMetadata", usage)
    return "".join(text), usage, finish, model


def call_tool(args):
    if not BASE_URL or not MODELS:
        return "gemini_ask is not configured: set GEMINI_MCP_BASE_URL and GEMINI_MCP_MODELS", True
    started = time.monotonic()
    for attempt in range(2):
        try:
            answer, usage, finish, model = stream_gemini(args)
            break
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            if attempt == 0 and error.code in RETRY_STATUSES:
                time.sleep(5)
                continue
            return f"Gateway returned HTTP {error.code}: {detail}", True
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == 0:
                time.sleep(5)
                continue
            return f"Could not reach the gateway: {error}", True
    footer = (
        f"\n\n---\nmodel: {model} | finish: {finish} | "
        f"input tokens: {usage.get('promptTokenCount')} | output tokens: {usage.get('candidatesTokenCount')} | "
        f"thinking tokens: {usage.get('thoughtsTokenCount', 0)} | {time.monotonic() - started:.1f}s"
    )
    return (answer or "(Gemini returned no text)") + footer, not answer


def reply(message_id, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": message_id}
    message.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    # MCP speaks UTF-8; Windows would otherwise read and write the console code page.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except ValueError as error:
            reply(None, error={"code": -32700, "message": f"parse error: {error}"})
            continue
        if not isinstance(message, dict):
            reply(None, error={"code": -32600, "message": "invalid request"})
            continue
        method, message_id = message.get("method"), message.get("id")
        if message_id is None:
            continue  # notifications such as notifications/initialized
        if method == "initialize":
            reply(message_id, {
                "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "gemini-mcp", "version": "1.0.0"},
            })
        elif method == "tools/list":
            reply(message_id, {"tools": [tool_definition()]})
        elif method == "tools/call":
            params = message.get("params", {})
            if params.get("name") != "gemini_ask":
                reply(message_id, error={"code": -32602, "message": f"unknown tool {params.get('name')}"})
                continue
            try:
                text, is_error = call_tool(params.get("arguments") or {})
            except Exception as error:  # report every failure to the calling agent
                text, is_error = f"gemini_ask failed: {error}", True
            reply(message_id, {"content": [{"type": "text", "text": text}], "isError": is_error})
        elif method == "ping":
            reply(message_id, {})
        else:
            reply(message_id, error={"code": -32601, "message": f"method not found: {method}"})


if __name__ == "__main__":
    main()
