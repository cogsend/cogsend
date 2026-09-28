# API

The browser UI uses the `cog_session` cookie after TOTP. Scripts, Shortcuts, cron
and [MCP clients](#mcp-server) use a personal API key instead — no login, no cookies. Manage it in
**Settings → API access** (generate, rotate, revoke); the raw key is shown once
and only its hash is stored. Worked examples for the common calls live in-app at
`/api`.

## Authentication

Export your instance URL and a key from **Settings → API access**:

```sh
export APP_URL=https://cogsend.<account>.workers.dev
export COGSEND_API_KEY=cog_...

curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $COGSEND_API_KEY"
```

`X-API-Key` works as an alternative header; never put the key in the URL. The key
acts as you on drafts, variants, media, publish, schedule, queue, settings, and
reads — but it can never connect, re-verify or disconnect accounts, or create,
rotate, or revoke keys (those stay in the browser session). The global
`API_TOKEN` Worker secret still works as a bearer for backwards compatibility, on
exactly the same routes as a personal key — it cannot reach the session-only ones
either — but prefer the personal key for scripts: it is revocable without
touching the scheduler.

A key is either **Read-only** or **Read + write**, chosen when you generate it. Read-only can list and fetch connections, drafts and the queue and validate text; anything that creates, changes, deletes, schedules or publishes needs Read + write.

## MCP server

`<your instance>/api/mcp` is a Model Context Protocol server, so agents such as Claude Code and Codex can work with drafts and the publish queue. It is stateless Streamable HTTP over `POST`. It accepts only a personal key as `Authorization: Bearer`: no cookies, no `X-API-Key` and no `API_TOKEN`.

For Claude Code, add this to `.mcp.json` and set `COGSEND_API_KEY` in your environment:

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

**Settings → API access** shows this with your own URL, plus the Codex version.

| Tools                                                                                                                                                                                                         | Key needed   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `list_connections`, `list_drafts`, `get_draft`, `list_queue`, `validate_post`                                                                                                                                 | Read-only    |
| `create_draft`, `update_draft`, `duplicate_draft`, `delete_draft`, `set_draft_variant`, `delete_draft_variant`, `schedule_draft`, `reschedule_delivery`, `cancel_delivery`, `publish_draft`, `retry_delivery` | Read + write |

`publish_draft` and `retry_delivery` post to real accounts. Set your client to ask before it runs tools that write or publish; CogSend marks them, but only the client can stop and ask. Media, settings, insights and account management are not exposed. If Cloudflare Access protects the instance, see [Cloudflare Access](access.md#the-paths-it-has-to-let-through).

## Examples

Create a draft, then publish it to one account:

```sh
curl -s -X POST "$APP_URL/api/drafts" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","baseBody":"from a script"}'

curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/publish" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionIds":["CONN_ID"]}'
```

## Limits

- A body is capped at 100,000 characters, and a variant may carry at most 100 explicit `threadSegments`.
- Each platform's own text and media limits are checked again at publish, so what the API accepts is not necessarily what a platform will take.

## Publishing behaviour

- Publishing the same draft and account twice reuses the row. Already-published accounts come back `skipped: true`.
- A publish that is still running on that account answers **409** with `inFlight` (the connection ids) — wait, then try again.
- A retried segment carries the same platform-side id as its first attempt, so a thread that failed half-way does not double-post what already went out (Mastodon remembers the id for an hour, Bluesky refuses to overwrite the record).
- X, LinkedIn and Threads take no such id. When one of them gets the request that creates a post but no answer comes back, the target fails with an error saying the post "may have been published" and is never retried automatically: check the platform first, and only then retry.
- Sending several connection ids in one request publishes them in order. The first always runs; each further one runs only if it fits in what is left of the request's Cloudflare call budget (50 on Workers Free, see `SUBREQUEST_LIMIT` in [Configuration](configuration.md#secrets)). The ones that don't fit come back with `status: "pending"` and `deferred: true`. They are already due and go out on the next scheduler tick, so don't send them again. For the fastest results, send one connection id per request. If a request still runs out, it answers `200` with `stopped: true`, `stoppedError`, and the results it did get — the accounts after the last entry were not completed and are still due (a target the failure interrupted is left retryable, never `publishing`), so send those ids again. A `500` means nothing was recorded; check the draft before retrying.
- Do not call `/api/targets/:id/retry` unless the row is `failed` (or a stuck `publishing` older than 15 minutes).
- Schedule returns **409** if that account is already published or still publishing. Check `error`, `alreadyPublished`, and `inFlight` instead of treating HTTP 200 as "it was scheduled".
