# Putting it behind Cloudflare Access

Optional. The app has its own login, so Access is an extra gate for an instance only you (or a small team) reach — it does not replace the login, and it does not replace the secrets: `APP_ENCRYPTION_KEY` still encrypts your provider tokens and derives the key that signs the publish-time media URLs, and `AUTH_SECRET` still signs sessions and OAuth state.

## Turning it on

Workers → your Worker → **Access**, or the `workers.dev` one-click. On `workers.dev` it is set up through that Workers dashboard flow, because the Zero Trust domain picker only lists domains from a zone.

Access requires Zero Trust to be enabled, which asks for payment details even on the free plan (50 users; service tokens do not consume seats). An account-wide "Protect all Workers" setting applies to new deployments too, and needs the same exemptions as below.

## The paths it has to let through

Five things need exemptions or they break:

- **Media for Meta's crawler.** `/api/media/public/*` must stay reachable without a login, or Threads and Mastodon cannot fetch images. Add a separate Access application for that path with a **Bypass / Include Everyone** policy.
- **Draft preview links.** `/p/*` is what you send to people who have no login, so Access must not stop them either. Add a **Bypass / Include Everyone** application for that path too, or a reviewer meets the Access login before the preview ([Preview links](posts.md#preview-links)).
- **Scripts and pingers.** Anything calling the API with a bearer key, or the tick endpoint, needs a **Service Auth** policy and a service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) alongside the app's own key. A bypass policy would also work, but it is neither authenticated nor logged.
- **MCP clients.** `/api/mcp` needs the same Service Auth headers as scripts, alongside the CogSend key. Claude Code and Codex can send extra headers from environment variables; a client that cannot send them needs a bypass for `/api/mcp` alone, which leaves the personal key as the only check.
- **OAuth callbacks.** If a provider redirects back while your Access session has expired, Access intercepts it before the app sees the code. Bypass `/api/connections/*/callback` if that happens.

## What keeps working

The cron trigger is unaffected: the scheduled handler calls the Worker in-process, never over HTTP.
