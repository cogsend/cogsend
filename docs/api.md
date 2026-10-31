# API

The browser UI uses the `cog_session` cookie after TOTP. Scripts, Shortcuts and cron use a personal API key instead — no login, no cookies. Manage it in **Settings → API access** (generate, rotate, revoke). Only one key is active at a time: the raw key is shown once, only its hash is stored, and generating a replacement revokes the old one at once. If a key ever touches a log or screenshot, rotate it. AI agents connect through the [MCP server](mcp.md).

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

## Errors

A failed request answers a JSON object with an `error` property.

## Endpoints

### With any key

- `GET /api/connections`: account ids, platforms, statuses, and which platforms this deployment can connect.
- `GET /api/drafts`: list drafts with their variants, media and targets.
- `GET /api/drafts/:id`: one draft.
- `GET /api/drafts/:id/share`: the draft's preview link, see [Preview links](#preview-links).
- `GET /api/queue`: upcoming and recent deliveries.
- `POST /api/validate`: check a post against each platform's rules.
- `GET /api/insights`: delivery stats. `?days=` and `?tz=` are optional.
- `GET /api/settings`: read settings.

### With a Read + write key

- `POST /api/drafts`: `{"title?", "baseBody?", "selectedConnectionIds?"}` answers `201` with `{draft}`.
- `PATCH /api/drafts/:id`: edit the title, body or `selectedConnectionIds`. **409** while publishing.
- `DELETE /api/drafts/:id`: delete a draft.
- `PUT /api/drafts/:id/variants`: `{"platform", "body?", "options?"}` sets one platform's copy.
- `DELETE /api/drafts/:id/variants?platform=`: remove that copy.
- `POST /api/drafts/:id/media`: upload files, see [Media](#media).
- `PATCH /api/drafts/:id/media`: `{"mediaId", "altText?", "segmentIndex?"}` changes an attachment.
- `DELETE /api/drafts/:id/media?mediaId=`: remove an attachment.
- `POST /api/drafts/:id/duplicate`: copy a draft, media included, into a new draft.
- `POST` and `DELETE /api/drafts/:id/share`: make or turn off a preview link.
- `POST /api/drafts/:id/publish`: `{"connectionIds": []}` answers `{results, draft}`, with one result per account.
- `POST /api/drafts/:id/schedule`: `{"connectionIds": [], "runAt": "<ISO date>"}` answers `{targets}`.
- `POST /api/targets/:id/cancel`: cancel one delivery.
- `POST /api/targets/:id/retry`: retry one delivery.
- `POST /api/targets/:id/reschedule`: `{"runAt": "<ISO date>"}` moves one delivery.
- `POST /api/targets/bulk`: `{"op", "ids", "runAt?"}` acts on up to 10 deliveries at once. `op` is `cancel`, `retry` or `reschedule`.
- `PATCH /api/settings`: change settings.

## MCP server

The MCP server has its own page: [MCP server](mcp.md).

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

## Media

`POST /api/drafts/:id/media` takes a `multipart/form-data` body with one or more `files`, the card's `segmentIndex` (0 for the first) and an optional `altText`. Images go up to 16 MB, an MP4 to 95 MB. An optional `preview-<n>`, a JPEG of at most 1 MB, is shown in place of the n-th file in the app; the original is what gets published. An optional `jpeg-<n>`, a JPEG at the n-th file's full size of at most 8 MB, is what Instagram gets for a PNG or WebP; without one, such an image cannot go to Instagram unless the deployment has the Images binding, which makes the copy when the draft is scheduled or published to Instagram. If one request cannot make every copy within its call budget, it answers 503 and the next try picks up the rest.

A larger video goes up in parts, up to 300 MB:

1. `POST /api/drafts/:id/media/uploads` with `{"size": <bytes>, "mime": "video/mp4", "segmentIndex": 0}`. Every check that can refuse the video runs here, before any bytes move. The answer carries `key`, `uploadId`, `size`, `segmentIndex` and `token`, which the next calls send back unchanged, plus `partSize` and `parts`.
2. `PUT /api/drafts/:id/media/uploads/part` for each part `n` from 1 to `parts`, with those five values and `n` in the query string and the bytes as the body. Every part is exactly `partSize` bytes except the last. Each answers `{ "partNumber": n, "etag": "…" }`.
3. `POST /api/drafts/:id/media/uploads/complete` with the five values, `parts` (every answer from step 2, in order) and an optional `altText`. It answers `201` with the stored `media`.

`DELETE /api/drafts/:id/media/uploads` with the five values abandons an upload. The server converts nothing: it takes an MP4 it can read and refuses anything else, and a video must be the only media on its card.

A video's `meta` holds what the server read from it (`durationMs`, `videoCodec`, `audioCodec`, `fps`, and `faststart`, whether its index comes first) and its `cover` once one is set. `PUT /api/drafts/:id/media/cover?mediaId=…` with a JPEG body of at most 8 MB sets the cover, and `DELETE` with the same query removes it.

## Preview links

`POST /api/drafts/:id/share` makes a read-only link to the draft that works without signing in, answering `201` with `{"share": {"url", "expiresAt"}}`. An optional `{"expiresInDays": n}` sets how long it lasts, from 1 to 30 days, 14 by default. A draft has one link, so a second `POST` replaces the first. `GET` answers the current link, or `{"share": null}` when there is none or it has expired, and `DELETE` turns it off. A draft that has published to any account answers **409**, and its link stops working. Reading needs the `read` scope; making or turning off a link needs `write`. [Preview links](posts.md#preview-links) covers what the page shows.

## Limits

- A body is capped at 100,000 characters, and a variant may carry at most 100 explicit `threadSegments`.
- Each platform's own text and media limits are checked again at publish, so what the API accepts is not necessarily what a platform will take.

## Publishing behaviour

- Publishing the same draft and account twice reuses the row. Already-published accounts come back `skipped: true`.
- A publish that is still running on that account answers **409** with `inFlight` (the connection ids) — wait, then try again.
- A retried segment carries the same platform-side id as its first attempt, so a thread that failed half-way does not double-post what already went out (Mastodon remembers the id for an hour, Bluesky refuses to overwrite the record).
- X, LinkedIn, Threads and Instagram take no such id. When one of them gets the request that creates a post but no answer comes back, or it answers with a server error, the target fails with an error saying the post "may have been published" and is never retried automatically: check the platform first, and only then retry.
- Sending several connection ids in one request publishes them in order. The first always runs; each further one runs only if it fits in what is left of the request's Cloudflare call budget (50 on Workers Free, see `SUBREQUEST_LIMIT` in [Configuration](configuration.md#secrets)). The ones that don't fit come back with `status: "pending"` and `deferred: true`. They are already due and go out on the next scheduler tick, so don't send them again. For the fastest results, send one connection id per request. If a request still runs out, it answers `200` with `stopped: true`, `stoppedError`, and the results it did get — the accounts after the last entry were not completed and are still due (a target the failure interrupted is left retryable, never `publishing`), so send those ids again. A `500` means nothing was recorded; check the draft before retrying.
- Do not call `/api/targets/:id/retry` unless the row is `failed` (or a stuck `publishing` older than 7 minutes).
- Publish and schedule answer **400** with `platform: "instagram"` and `issues` when the request includes an Instagram account and the post cannot go there, such as one with no photo or video. Nothing is scheduled or sent for any account; drop the Instagram account or fix the media and send it again.
- Schedule returns **409** if that account is already published or still publishing. Check `error`, `alreadyPublished`, and `inFlight` instead of treating HTTP 200 as "it was scheduled".
- Schedule adds the accounts it is sent and leaves the draft's other accounts as they are. Send `"cancelOthers": true` to make the list the whole set: the draft's other accounts that are still waiting (`scheduled` or `pending`, not yet being sent) are cancelled, and the response lists their connection ids in `cancelled`.
- Once every account of a draft is published (cancelled ones aside), changing its text, variants or media answers **409** with `Already published — duplicate it to post again`. `POST /api/drafts/:id/duplicate` copies it into a new draft. A draft that failed on some accounts stays editable.
