# Domains and URLs

`setup` deploys to `<worker>.<account-subdomain>.workers.dev` and stores that URL
as `APP_URL`.

## The workers.dev URL

- **The account subdomain.** Dashboard → **Workers & Pages → Change** next to **Your subdomain**. This is account-wide: every Worker you run moves at once, so the hostname of this instance changes too.
- **The Worker name.** `npm run setup -- --name my-cogsend`, or `name` in `wrangler.personal.jsonc`, moves this app to `my-cogsend.<subdomain>.workers.dev`. Renaming deploys a _new_ Worker: the old one keeps its URL, its secrets and its cron trigger until you delete it (and both count against the five-trigger free-plan limit meanwhile).
- **Turn the URL off.** `"workers_dev": false` in the config removes it, so only a custom domain (or a route) can reach the app.

## A custom domain

The hostname's zone has to be in the same Cloudflare account. Add it under
**Workers & Pages → your Worker → Settings → Domains & Routes → Add → Custom
Domain** (newer dashboards have a **Domains** tab with the same flow) and enter
`cogsend.example.com`, or an apex like `cogsend.com`. Cloudflare writes the DNS
record and provisions the certificate; the workers.dev URL keeps answering
unless you turn it off.

Or keep the routing in config, in `wrangler.personal.jsonc` so upstream never
sees it:

```jsonc
"routes": [{ "pattern": "cogsend.example.com", "custom_domain": true }],
"workers_dev": false
```

`npm run deploy` then provisions the domain and drops the workers.dev URL. If the
hostname already serves something else, use a route instead of a custom domain —
`{ "pattern": "cogsend.example.com/*", "zone_name": "example.com" }` — which needs
a proxied DNS record.

## After the hostname changes

1. Pin `APP_URL` to the new origin. Left unset the app follows the host each request arrives on, but a pinned value does not follow a hostname change, and OAuth redirect URIs and signed media URLs are built from whatever it holds.

   ```sh
   node scripts/wrangler.mjs secret put APP_URL
   ```

   `npm run secrets:put APP_URL` uploads it from `.dev.vars` instead. Re-running `setup` leaves an existing `APP_URL` alone, but it will pin the workers.dev URL again if the secret is missing.

2. Re-register the redirect URI in every OAuth app you created — LinkedIn, Threads, Instagram, X — as `https://<new-host>/api/connections/<platform>/callback`; a provider whose registered URI no longer matches answers with a redirect error. Mastodon and Bluesky keep working: their tokens are stored, and the redirect URI is only used while connecting.
3. Point an external pinger at the new host. The Worker's own cron trigger calls the app in-process, so it is unaffected.
4. Confirm with `npm run doctor -- --app-url https://<new-host>`.
