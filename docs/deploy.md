# Deploying CogSend

One way to deploy: your terminal, `wrangler`, and `npm run setup`. It creates the
D1 database, the R2 bucket, the secrets and the account, applies the migrations,
deploys, and then signs in once against the live Worker to prove it works.

Everything here assumes a Cloudflare account with Workers, D1 and R2 available;
R2 asks for a payment method on file even on the free tier.

## One command

```sh
git clone --depth 1 https://github.com/cogsend/cogsend.git cogsend
cd cogsend && npm install && npm run setup
```

`setup` runs `wrangler login`, creates the D1 database and the R2 bucket if they
are missing, generates `APP_ENCRYPTION_KEY` (written to `.dev.vars` and to the
Worker), applies migrations, **creates the account** (email plus a password it
generates or you type; only the PBKDF2 hash is stored), deploys and sets
`APP_URL`. The account exists before the URL answers its first request, so there
is nothing to claim and no window in which someone else could get there first.

A brand-new Cloudflare account has no workers.dev subdomain yet, and the deploy needs one. `setup` checks before it creates anything and asks for the name, which becomes `<worker>.<subdomain>.workers.dev`. It is account-wide and can be changed later ([Custom domains](domains.md#the-workersdev-url)).

It is safe to re-run: resources that exist, secrets that are already set, and an
account that already exists are all left alone, because rotating
`APP_ENCRYPTION_KEY` orphans every stored credential and signs every session out.
`main` is the branch these docs are tested against, and release tags are cut
from it. See [Updating](#updating-and-rolling-back) for tags and rolling back.

Its flags, for the cases the defaults deliberately avoid:

| Flag                                | What it does                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| `--dry-run`                         | read-only: checks auth, prints the plan                       |
| `--yes`                             | no prompts; the secrets and the password are printed once     |
| `--admin-email`, `--admin-password` | answer the account questions without a prompt                 |
| `--subdomain`                       | a new account's workers.dev subdomain, without a prompt       |
| `--name`, `--db`, `--bucket`        | your own resource names, for a second instance on one account |
| `--skip-deploy`                     | everything except the deploy                                  |
| `--rotate-secrets`                  | also overwrite `APP_ENCRYPTION_KEY`                           |
| `--reset-login`                     | also give the account a new password and revoke every session |
| `--verbose`                         | print every command and its raw output                        |
| `--no-color`                        | plain text, for logs and bug reports                          |

A second instance, with names of its own:

```sh
npm run setup -- --name my-cogsend --db my-cogsend --bucket my-cogsend-media
```

Those names live in `wrangler.personal.jsonc`, so every later command uses them.
Forgot the password later? `npm run admin:reset`, described in
[Configuration](configuration.md#the-login).

Setup prints one line per step. The tools underneath are chatty — a first
`d1 migrations apply` alone is a few hundred lines of box drawing — so their
output is captured and shown only when a step fails. `--verbose` prints all of
it; colour turns itself off in a pipe or a CI log, and `--no-color` (or
`NO_COLOR=1`) does the same by hand.

No GitHub App, no Workers Builds, and nothing to configure in a browser beyond
the `wrangler login` that `setup` starts.

## After the first deploy

1. Open the Worker URL and sign in with the email and password `setup` created.
   The first sign-in asks for an authenticator app: scan the QR and save the
   backup codes it shows.
2. Connect accounts under **Accounts**. Mastodon and Bluesky work immediately;
   LinkedIn, Threads and X need an OAuth app each, with the redirect URI built
   from your deployed URL ([OAuth apps](oauth-apps.md)).
3. Scheduled posts publish themselves through the cron trigger in
   `wrangler.jsonc`. Nothing to set up — unless the account had no trigger slot
   left, in which case the deploy says so and **Settings → Scheduled publishing**
   has the tick URL and a token for an external cron.
4. Optional: `RESEND_API_KEY` + `NOTIFY_EMAIL` for failure digests, and the
   instance name under **Settings → Instance**.

## Check it worked

```sh
npm run doctor
npm run doctor -- --app-url https://your-worker.workers.dev
```

Read-only: it verifies your Cloudflare login, that your commands reach the account this checkout deployed to, that the D1 database and R2 bucket exist, that `APP_ENCRYPTION_KEY` is set, whether migrations are pending, and whether the Worker has a deployment. With `--app-url` it also asks the running app: that `/api/health` answers, whether an account exists yet (and, when you are signed in to Cloudflare, whether 2FA is set up, read from D1: the app does not tell anonymous callers), whether the scheduler is actually ticking (and why not, when it is not), and whether a newer release is out (with the update command for your install shape). Every failure prints the exact command that fixes it. It never changes anything.

Something failed? [Troubleshooting](troubleshooting.md) covers the errors people
actually hit.

## Updating, and rolling back

Settings → Instance and `npm run doctor` both tell you when a newer release is
out. One command updates everything — tests, remote D1 migrations, build, deploy:

```sh
git pull
npm ci
npm run deploy:release
```

That prints one line per step — the test suite, the migrations, the build, the
deploy. `npm run deploy:release -- --verbose` shows everything those steps said.

Cloned `main`? Pull it, or move to a release tag (`git tag` lists them) — those
are the states the docs and the setup script are tested against.

Your data is never in the repository: D1, R2, the Worker secrets and the app
settings live in your Cloudflare account, so a pull cannot touch them. The one
local file that matters is `wrangler.personal.jsonc`, which replaces the
committed config — a config change upstream therefore does not reach you, and
`npm run doctor` says so when the two disagree.

**Migrations.** The app repairs missing tables and columns on the first request
after an update, so most updates need nothing. When a release ships a real
migration, run `npm run db:migrate:remote` — `deploy:release` above already does
it.

**Rolling back.** Workers & Pages → your Worker → **Deployments → Roll back**
reverts code only (or `npx wrangler rollback`), and migrations stay applied, so
rolling back across a schema change can break things. Take a
[backup](backups.md) before an update you might want to undo.

## Deploying by hand

`setup` is the supported path. To run the steps yourself you need Node 22.13+, 24 or 26+, a Cloudflare account (`npx wrangler login`), and R2 enabled. Every
command goes through `scripts/wrangler.mjs`, which applies your
`wrangler.personal.jsonc` and `WRANGLER_PROFILE`; plain `npx wrangler …` would
use the generic config in the repo, and skip the check that a command reaches
the account you deployed to.

Two commands. The first sets the one required secret; generate it with
`openssl rand -hex 32` and keep it out of `vars`, because a deploy overwrites
those. The second builds and uploads — and the first deploy also creates the D1
database and the R2 bucket.

```sh
node scripts/wrangler.mjs secret put APP_ENCRYPTION_KEY

npm run build && npm run deploy
```

The account is the one thing a manual deploy cannot make for you: nothing at
runtime creates one, which is what keeps a fresh deployment from being claimable
by whoever finds its URL first. After that deploy, run `npm run setup` once — it
finds the database and bucket you just made, uploads the secrets and creates the
account. `npm run deploy:release` runs tests, migrations, build and deploy in one
go.

A fresh database needs no migration step — the schema bootstraps itself on the
first request; an older one gets new migrations with `npm run db:migrate:remote`.

To choose a location, or to reuse a database or bucket you already have, create
them first: `node scripts/wrangler.mjs d1 create cogsend` prints an id for
`wrangler.personal.jsonc`, and `node scripts/wrangler.mjs r2 bucket create
cogsend-media` makes the bucket. Otherwise the deploy creates both.

Optional secrets — `API_TOKEN` for scripts, `SCHEDULER_SECRET` for an external
pinger, the OAuth client ids, Resend for failure emails, `MEDIA_PUBLIC_BASE_URL`
for Meta's crawler — are listed under [Configuration](configuration.md#secrets).
Upload them in one go with `npm run secrets:put`, which reads them from
`.dev.vars` and then reads the Worker's own secret list back to confirm what
landed. Secrets take effect immediately from the CLI, so a deploy is not what
makes them live; in the dashboard (Workers & Pages → your Worker → Settings →
Variables and Secrets → Add → **Secret**) press **Deploy** to apply them.

### Push-to-deploy, without Workers Builds

Optional, and for updates only: the account has to exist first (run `npm run
setup` once locally). Copy `.github/workflows/deploy.yml.example` to
`.github/workflows/deploy.yml` and add two repository secrets —
`CLOUDFLARE_API_TOKEN` (Workers Scripts, D1 and R2 edit permissions) and
`CLOUDFLARE_ACCOUNT_ID`. Pushes to `main` then build, migrate and deploy from
GitHub's runners. The workflow skips itself when the secrets are missing, so a
fork that has not set them up stays green.

## Starting over

Worker, D1 database and R2 bucket can be deleted from the dashboard; the
`wrangler.personal.jsonc` and `.dev.vars` files hold the only local state. A
fresh clone plus `npm run setup` then rebuilds everything. Take a
[backup](backups.md) first if you might want the data.
