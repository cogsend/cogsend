# Troubleshooting

Start with `npm run doctor -- --app-url <url>`: it is read-only, and every failure it
finds prints the command that fixes it. The cases below are the ones it cannot fix
for you.

## The R2 step says the bucket name already exists

R2 bucket names are unique across all Cloudflare accounts, so `cogsend-media`
is only a starting point. Set `bucket_name` in `wrangler.personal.jsonc` (or pass
`--bucket my-cogsend-media` to `setup`) and deploy again. With the Deploy to Cloudflare button, change the bucket's name in the form instead. R2 also refuses to create anything until the account has a payment
method on file, even for free-tier usage.

## The deploy complains about cron triggers (10072)

```
✘ [ERROR] Trigger configuration for "…" was only partially updated:
    - This account has reached the Workers Free limit of 5 cron triggers per account … [code: 10072]
Failed: error occurred while running deploy command
```

The Worker and its assets were uploaded — only the schedule was refused. This is
an **account** limit, not a per-Worker one: five cron triggers in total on the
free plan, across every Worker you run, and a fresh project cannot get a sixth
slot.

`npm run deploy` handles this for you: it retries once with the trigger removed
(`"crons": []`) and exits 0, printing the same explanation, so the build is not
marked failed and the app is live. Publishing now works; only scheduled posts
need a tick. Set `COGSEND_STRICT_CRON=1` to get the plain failure instead.

Pick one of these:

1. **Free a slot.** Cloudflare → **Workers & Pages** → the _other_ Worker →
   **Settings → Trigger events → Cron triggers** → delete a schedule you no
   longer need.
2. **Upgrade** the account to Workers Paid (hundreds of triggers).
3. **Use an external cron** and leave the Worker without a trigger. Settings →
   **Scheduled publishing** shows the tick URL and can generate a token; paste
   both into any cron service:

   ```sh
   curl -X POST https://your-worker.workers.dev/api/internal/tick \
     -H "Authorization: Bearer <tick token>" \
     -H "Content-Type: application/json"
   ```

   cron-job.org runs a job once a minute on its free plan, UptimeRobot's free
   plan every five minutes, and the repository ships a GitHub Actions workflow
   (`.github/workflows/scheduler-tick.yml`) that needs repository secrets
   `APP_URL` and `SCHEDULER_SECRET`. Ticks are idempotent, so a duplicated or
   delayed caller is harmless. To go trigger-less by choice, delete the
   `triggers` block from your config (or set `"crons": []`).

   Using the env secret instead of the generated token works too: set
   `SCHEDULER_SECRET` and keep the Worker secret and the caller in sync.

`npm run doctor -- --app-url https://your-worker.workers.dev` reports which of
these you are in: ticks arriving, no trigger configured, or a refused trigger.

## The app answers 503: "must not be an example value"

The deployment is running on the example secrets from `.dev.vars.example`. Set a
real one — `openssl rand -hex 32` generates a key — and redeploy:

```sh
node scripts/wrangler.mjs secret put APP_ENCRYPTION_KEY
npm run deploy
```

`npm run doctor -- --app-url <url>` reports this case directly.

## Scheduled posts never fire

Open **Settings → Scheduled publishing** in the app: it says whether a tick has
ever arrived, why one is missing when the last deploy could not attach the
trigger, and offers both a token and a "Tick now" button.

Behind it: the tick runs every minute from the cron trigger in `wrangler.jsonc`
(Cloudflare → **Settings → Trigger events**), or from an external cron calling
`POST /api/internal/tick` with a bearer credential. The built-in cron derives
its own credential from `APP_ENCRYPTION_KEY`; external callers use the token
from that Settings card, or the env `SCHEDULER_SECRET` / `API_TOKEN`. A read-only
check reports the scheduler line:

```sh
npm run doctor -- --app-url <url>
```

## Missing migrations

After pulling new code:

```sh
npm run db:migrate:remote
npm run deploy
```

or `npm run deploy:release`, which runs tests, migrations, build and deploy in
one go.

## Two instances in one Cloudflare account

Give the second instance its own names, or it will adopt the first one's
resources: D1 provisioning matches on `database_name`, and R2 bucket names are
global. `npm run setup -- --name my-cogsend --db my-cogsend --bucket my-cogsend-media`
writes them into `wrangler.personal.jsonc` (gitignored) — the Worker name, the
database's name _and_ its id, and the bucket — so the deploy output, `wrangler
d1 …` and `npm run doctor` all name the instance you think they do.

## A command refuses: "this checkout deployed … to account …"

The command would reach a different Cloudflare account than the last deploy from this checkout, usually because `WRANGLER_PROFILE` was left off or the checkout moved out of a folder with a bound Wrangler profile. Nothing was changed. Run it again with the profile the instance uses, or bind the checkout to that profile once with `npx wrangler auth activate <profile>`, so no command needs `WRANGLER_PROFILE`; see [More than one Cloudflare account](configuration.md#more-than-one-cloudflare-account).

Moving the instance on purpose? `COGSEND_ALLOW_ACCOUNT_CHANGE=1 npm run deploy` deploys to the new account and records it.

## The deploy asks you to register a workers.dev subdomain

```
▲ [WARNING] You need to register a workers.dev subdomain before publishing to workers.dev
```

The Cloudflare account is new and has never picked its workers.dev subdomain; adding a card or enabling R2 does not set one. `npm run setup` asks for it before it creates anything, and `npm run setup -- --subdomain <name>` answers without a prompt. You can also pick it under **Workers & Pages** in the dashboard. Either way, re-run `npm run setup` afterwards: it reuses everything it already created.

## A post failed with "may have been published"

CogSend sent the post to X, LinkedIn or Threads, but no answer came back in time,
so it cannot tell whether the platform published it. Those platforms take no id
that would let a second attempt be recognised as the same post, so CogSend does
not retry on its own: a blind retry could post it twice. Open the account on the
platform. If the post is there, press **Discard** next to that account in
**Posts → Failed**; if it is not, press **Retry**.

## The update from Settings stops

The old version keeps serving whatever step fails; **Abort the unfinished update** tidies up, and you can start again.

- **"…not signed by a CogSend release key"** or **"did not download intact"**: the bundle is not the one the release published. Try again; if it repeats, report it, and update from a checkout meanwhile.
- **"…does not exist: the release has no update bundle (yet)"**: bundles are attached a few minutes after a release is published.
- **Cloudflare: Authentication error**, or a 403: the token lacks a permission, or belongs to another account. Create it from the link next to the field, which fills in Workers Scripts (edit) and Account Settings (read). If it cannot list accounts, enter the account ID under **More options**; it is in the dashboard URL.
- **"Your password is incorrect"**, or **"Too many attempts"**: the password that locks the saved token is your CogSend password, and it shares the login's lockout. Wait a few minutes after the lockout.
- **"The saved token was locked with an earlier password"**: the password changed from the terminal (`npm run admin:reset`), so the saved copy could not be opened and is gone. Paste the token once more.
- **"Enter your password again to continue the update"**: an update left open for most of an hour lost its one-update key. Press the button again; it continues where it stopped.
- **"…is splitting traffic between versions"**: a gradual deployment is in progress. Finish it or roll it back under Workers & Pages → your Worker → Deployments.
- **"The … step did not finish"**: Cloudflare cut the request short, usually for CPU time, three times running. Press the button again: every step continues where it stopped.
- **"The new version did not answer its health check"**: nothing changed. Report it with the version you tried, and stay on the current one.
- **"…needs a deploy from a checkout"**: that release changes something an in-place update cannot, such as a new binding. Follow the release notes, usually `git pull && npm ci && npm run deploy:release` once.

## A deploy refuses: "the Worker runs vX, newer than …"

The instance was updated from Settings, and this checkout (or the Deploy-button copy Workers Builds deploys) holds an older release. Deploying it would roll the instance back, so the deploy stops before changing anything. Pull the newer release first; or, if going back is what you want, pass `--allow-downgrade` (or set `COGSEND_ALLOW_DOWNGRADE=1`, which is also how a Workers Builds variable allows it). For a Deploy-button install, update through its repository's **Update CogSend** action instead, which moves the copy forward ([Updating](updates.md#installed-with-the-deploy-to-cloudflare-button)).

## The Update CogSend action fails

Nothing is committed when it fails, so your instance keeps running what it ran.

- **"…is older than…, which this repository holds"**: run it again with **Roll back** ticked if going back is what you want.
- **"…does not sign its deploy repository"**: releases before 1.14.0 cannot be installed through GitHub. Install that one from Settings with a token.
- **"…does not match the signed release"**, **"…is not part of…"**, **"…is missing"** or **"…is not a plain file"**: what was downloaded is not what the release signed. Run it again; if it repeats, report it with the tag.
- **"…has no commit for vX"**: the release was published moments ago and its files are not in `cogsend/deploy` yet. Try again in a few minutes.
- **No Run workflow button**: Actions are turned off for the repository. Turn them on under the repository's Settings → Actions → General.

The action succeeded but CogSend still shows the old version? Its commit starts a Workers Builds run: Workers & Pages → your Worker → Deployments shows the build and its log.

## `wrangler login` fails on Cloudflare's approval page

The browser shows **Application authorization failed**, with "Unable to authenticate request" or "Something went wrong!". The login asks for every permission wrangler knows about, and Cloudflare can refuse that list for some accounts. Ask only for what CogSend needs, one `--scopes` per permission:

```sh
npx wrangler login --scopes account:read --scopes user:read --scopes workers:write --scopes workers_scripts:write --scopes workers_routes:write --scopes workers_kv:write --scopes workers_tail:read --scopes d1:write --scopes zone:read
```

If wrangler says a profile is active in this directory, `wrangler login` signs in the default profile, not that one. Sign that profile in instead: `npx wrangler auth create <profile>` with the same `--scopes`.

## Still stuck?

[Open an issue](https://github.com/cogsend/cogsend/issues) with the output of `npm run doctor` and the version shown in
**Settings → Instance**.
