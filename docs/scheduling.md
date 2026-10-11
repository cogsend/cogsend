# Scheduling

Scheduled posts live in D1 and are published by a _tick_: either the Worker's own
cron trigger, which needs no setup, or anything that can POST to the tick
endpoint.

## How a tick works

- The cron trigger ships enabled in `wrangler.jsonc` (`"triggers"`) and runs every minute.
- A tick always publishes the oldest due post, then starts each further one only if its estimated calls still fit in the request's Cloudflare budget. That budget covers every D1 statement, R2 read and call to a platform, and is 50 on the Workers Free plan. Anything that doesn't fit stays due for the next tick, so on Free a backlog drains a post or two a minute. This stops a request from running out half-way through a post the platform already accepted, which would publish it twice. On a paid plan, set `SUBREQUEST_LIMIT` (see [Configuration](configuration.md#secrets)) and a tick publishes everything due at once.
- Ticks are idempotent: a duplicated or delayed caller is harmless.
- A tick that runs out of the plan's CPU budget also leaves the rest due for the next minute.

The trigger is registered the moment the Worker is deployed, but the first tick
can take a few minutes — Cloudflare runs a Worker's cron on machines that have
spare capacity. Until one arrives, **Settings → Scheduled publishing** says "no
tick yet"; that is the normal state for the first few minutes of a fresh install,
not a failure. If it still says that an hour later,
`npm run doctor -- --app-url <url>` says which of the cases you are in: ticks
arriving, no trigger configured, or a refused trigger. A heartbeat older than six
hours counts as delayed, and the app says so wherever the scheduler is shown.

## Pick one tick

The built-in cron needs nothing from you, but the Workers free plan allows only
**five cron triggers per account** — shared with every other Worker you run. If
your account has none left, `npm run deploy` says so, retries without the trigger,
and still ships the app; scheduled posts then wait until something calls the tick
endpoint.

**Settings → Scheduled publishing** covers both paths: it shows whether ticks are
arriving, and can generate a token for an external cron (cron-job.org,
UptimeRobot, the bundled GitHub Actions workflow). Keep one primary tick — there
is no reason to run a per-minute pinger alongside the cron.

To drive the tick from something else — cron-job.org, a Raspberry Pi, a systemd
timer, the bundled GitHub Actions workflow, a different cadence on a paid plan —
POST to it:

```sh
curl -X POST "$APP_URL/api/internal/tick" \
  -H "Authorization: Bearer $SCHEDULER_SECRET" \
  -H "Content-Type: application/json"
```

The endpoint takes `SCHEDULER_SECRET` (`API_TOKEN` still works as a fallback; `AUTH_SECRET` never does — it signs sessions and is rejected on the wire). Any `Content-Type`, or none, is fine: the cross-site check refuses a body-less or form-type POST only when it carries no credential of its own, and a tick always carries its bearer token.

An external caller needs a bearer it can read. Easiest is the token from
**Settings → Scheduled publishing**, which needs no redeploy and cannot reach
anything except the tick. The alternative is `SCHEDULER_SECRET`
(`openssl rand -hex 32`), which then lives in two places — the Worker secret and
the pinger's config — so rotate both together. Without one of those (or
`API_TOKEN`) an external caller cannot authenticate at all; the built-in cron
keeps working either way, because the Worker derives the same value.

The bundled GitHub workflow (`.github/workflows/scheduler-tick.yml`) stays off
until you set repository secrets `APP_URL` and `SCHEDULER_SECRET` — the token
from **Settings → Scheduled publishing** works as that `SCHEDULER_SECRET` value. With the
built-in cron running, treat it as a backup rather than the primary tick: it is
scheduled every five minutes (GitHub's shortest interval) but GitHub throttles it
to roughly one run every two hours. You can also run it by hand from
**Actions → Scheduler tick → Run workflow**.

## Cadence

Edit `triggers.crons` in `wrangler.jsonc` — `*/5 * * * *` and friends are fine on
the free plan too. To use no trigger at all, set `"crons": []` and point a pinger
at the endpoint instead; `npm run doctor -- --app-url <url>` confirms which of the
two is actually running.

## Failure alerts (optional)

The dashboard shows a "failed to publish" banner linking to the Failed tab. To
also get a morning-after email, set `RESEND_API_KEY` and `NOTIFY_EMAIL` as Worker
secrets (the app no-ops without them), plus an optional `NOTIFY_FROM` sender on a
domain verified in Resend. At most one digest is sent per 24h window, covering
failures newer than the last digest. Posts that are still retrying are not
emailed.
