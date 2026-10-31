# MCP server

`<your instance>/api/mcp` is a Model Context Protocol server, so agents such as Claude Code and Codex can work with drafts and the publish queue using your personal API key. Generate one in **Settings → API access**, where you will also find the setup below with your own URL filled in.

## Connect a client

Give an agent a Read-only key unless it needs to change drafts or publish, and keep the key in an environment variable. Never commit a real key.

### Claude Code

Add this to `.mcp.json` and set `COGSEND_API_KEY` in your environment before starting Claude Code:

```json
{
	"mcpServers": {
		"cogsend": {
			"type": "http",
			"url": "https://cogsend.example.com/api/mcp",
			"headers": { "Authorization": "Bearer ${COGSEND_API_KEY}" }
		}
	}
}
```

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.cogsend]
url = "https://cogsend.example.com/api/mcp"
bearer_token_env_var = "COGSEND_API_KEY"
default_tools_approval_mode = "prompt"
```

### Other clients

Point the client at the same URL over Streamable HTTP and send the key as `Authorization: Bearer <key>`. Whether a client expands an environment variable in its config varies, so check its documentation.

To try the connection, list the tools with MCP Inspector:

```sh
npx @modelcontextprotocol/inspector --cli "https://cogsend.example.com/api/mcp" \
  --transport http \
  --protocol-era modern \
  --method tools/list \
  --header "Authorization: Bearer $COGSEND_API_KEY"
```

## Tools

| Tools                                                                                                                                                                                                         | Key needed   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `list_connections`, `list_drafts`, `get_draft`, `list_queue`, `validate_post`                                                                                                                                 | Read-only    |
| `create_draft`, `update_draft`, `duplicate_draft`, `delete_draft`, `set_draft_variant`, `delete_draft_variant`, `schedule_draft`, `reschedule_delivery`, `cancel_delivery`, `publish_draft`, `retry_delivery` | Read + write |

Media, settings, insights, account and provider management, key management, scheduler administration and the internal publish endpoint are not exposed, and neither are prompts, resources or sampling.

## Before an agent publishes

`publish_draft` and `retry_delivery` post to real accounts. Set your client to ask before it runs tools that write or publish, and check the content, the accounts and the timing before you approve one.

CogSend marks `update_draft`, `set_draft_variant`, `delete_draft`, `delete_draft_variant`, `publish_draft`, `schedule_draft`, `cancel_delivery`, `retry_delivery` and `reschedule_delivery` as destructive, and `publish_draft` and `retry_delivery` as reaching outside CogSend. Those marks are hints: only the client can stop and ask, and CogSend has no preview step of its own before a tool runs.

## How requests work

- The server is stateless Streamable HTTP over `POST`, and answers JSON. `GET` and `DELETE` answer **405**.
- It accepts only a personal key as `Authorization: Bearer`. Cookies, `X-API-Key`, `API_TOKEN`, scheduler credentials and keys in the URL are refused.
- Tool results carry a text summary and structured data.
- `ping` is not implemented, so a client that sends one can get JSON-RPC `-32601` or an HTTP 404.

If Cloudflare Access protects the instance, also send `CF-Access-Client-Id` and `CF-Access-Client-Secret` from your environment. [Cloudflare Access](access.md#the-paths-it-has-to-let-through) covers clients that cannot send them.
