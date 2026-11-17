# Ask Gemini from any agent

`scripts/gemini-mcp.py` is a small MCP server that gives your agents one tool,
`gemini_ask`. Claude, Codex, or any other agent that supports MCP can send Gemini a
question, plus the files it should read, and get the full answer back. It's useful for a
second opinion or a cross-model review, and it works when Gemini is only reachable
through your own gateway, such as a company Databricks AI Gateway.

The script talks to one URL you configure, using the native Gemini API with streamed
answers. It needs Python 3.10 or newer and nothing else. Get it from a clone of this
repository.

## Configure it

Set these in the MCP server's environment:

| Variable                | What it is                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GEMINI_MCP_BASE_URL`   | The URL in front of `/v1beta`, for example `https://<workspace>.cloud.databricks.com/ai-gateway/gemini`     |
| `GEMINI_MCP_MODELS`     | `alias=model-id` pairs, separated by commas. The first one is the default.                                  |
| `GEMINI_MCP_TOKEN_FILE` | A file holding your token. Use this rather than `GEMINI_MCP_TOKEN`, so the token stays out of agent config. |
| `GEMINI_MCP_TOKEN`      | The token itself, if you don't use a file.                                                                  |
| `GEMINI_MCP_HEADERS`    | Optional. A JSON object of extra headers, such as gateway request tags.                                     |

The token is sent as `Authorization: Bearer <token>`.

## Add it to Claude

```sh
claude mcp add --scope user gemini \
  -e GEMINI_MCP_BASE_URL=https://<workspace>.cloud.databricks.com/ai-gateway/gemini \
  -e GEMINI_MCP_MODELS=pro=<model-id>,flash=<model-id> \
  -e GEMINI_MCP_TOKEN_FILE=~/.config/gemini-mcp-token \
  -- python /path/to/t3code/scripts/gemini-mcp.py
```

## Add it to Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.gemini]
command = "python"
args = ["/path/to/t3code/scripts/gemini-mcp.py"]
tool_timeout_sec = 900

[mcp_servers.gemini.env]
GEMINI_MCP_BASE_URL = "https://<workspace>.cloud.databricks.com/ai-gateway/gemini"
GEMINI_MCP_MODELS = "pro=<model-id>,flash=<model-id>"
GEMINI_MCP_TOKEN_FILE = "~/.config/gemini-mcp-token"
```

Raise `tool_timeout_sec` because a long review can take several minutes.

## Use it

Ask the agent to use `gemini_ask`, for example "Have Gemini review the files you
changed". Each file can be up to 400 KB and the total up to 2 MB. Every answer ends with
the model, its token use, and how long it took.
