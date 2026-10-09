# Configuration

Everything here is optional except `APP_ENCRYPTION_KEY`: an instance works out of
the box with one secret. These pages cover the settings you may want to pin down
once it is running.

## Secrets

**`APP_ENCRYPTION_KEY` — required.** It encrypts the provider tokens and the TOTP
secret stored in D1, so it cannot be generated at runtime and kept there, and
there is no "set a temporary one now, change it later" either: rotating it means
reconnecting every account. Generate it once with `openssl rand -hex 32`.

**Derived from it.** `AUTH_SECRET` (signs sessions and OAuth state) and
`SCHEDULER_SECRET` (the tick bearer) are computed from it with HMAC-SHA256, so
there is nothing else to invent or keep in sync. Set either one explicitly to
override the derivation; delete it to go back. Changing `AUTH_SECRET` signs
everybody out. You need `SCHEDULER_SECRET` only when something outside the Worker
already holds the tick bearer — for a new external pinger the token from
**Settings → Scheduled publishing** is the better choice: no redeploy, and it
cannot reach anything except the tick (see [Scheduling](scheduling.md)).

**Optional.**

| Secret                                          | What it enables                                               |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `API_TOKEN`                                     | a machine bearer for the API — prefer a personal key instead  |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn ([OAuth apps](oauth-apps.md))                        |
| `THREADS_APP_ID` / `THREADS_APP_SECRET`         | Threads                                                       |
| `X_CLIENT_ID` / `X_CLIENT_SECRET`               | X                                                             |
| `RESEND_API_KEY`, `NOTIFY_EMAIL`, `NOTIFY_FROM` | failure digests by email                                      |
| `MEDIA_PUBLIC_BASE_URL`                         | serving Meta's crawler from a public media origin (see below) |
| `ENABLE_VIDEO_UPLOAD`                           | LinkedIn video, wired but unverified                          |
| `SUBREQUEST_LIMIT`                              | publishing more per tick on a paid Workers plan (see below)   |

The OAuth client ids and secrets can also be entered in the accounts dialog instead, where they are stored in D1, encrypted with `APP_ENCRYPTION_KEY`; a Worker secret, when set, takes precedence over the dialog's value ([OAuth apps](oauth-apps.md)).

`MEDIA_PUBLIC_BASE_URL` is a trade-off: it serves media from a public origin
with no signature and no expiry, protected only by the randomness in the object
key. Keep the origin unlisted and treat a leaked URL as permanent; leave the
variable unset to keep the short-lived signed route.

`SUBREQUEST_LIMIT` is the number of calls one request may make: D1 statements,
R2 operations and requests to the platforms all count. Cloudflare allows 50 on
Workers Free and 10,000 on Paid, and the app cannot tell which plan it runs on,
so it assumes Free. Leave it unset on Free. On Paid, set it to `10000` so a tick
or a multi-account publish sends everything at once instead of a post or two per
request. Setting it higher than your plan allows brings back the risk it exists
to prevent: a request that runs out after a platform accepted a post, and a
second copy of that post later.

Upload them with `npm run secrets:put` (or `npm run secrets:put NAME` for one),
which reads `.dev.vars` and then reads the Worker's own secret list back to
confirm what landed — it exits non-zero and names anything still missing. A name
it skips is a name it could not find locally, and the message says which line it
looked at. Worker secrets take effect immediately: there is no redeploy step
after `secrets:put`, so a connect button that stays disabled is missing a
credential, not a deploy.
Without a checkout on the machine you are working from, the dashboard does the
same job: Workers & Pages → your Worker → Settings → Variables and Secrets →
Add → **Secret**, then **Deploy** to apply it.

The login is not one of these secrets. `npm run setup` writes the account into D1
— see [The login](#the-login) below.

## Naming your instance

The instance name — shown in the page title, the header, and the login screen —
is set in **Settings → Instance** and stored in D1, so it needs no redeploy.
`APP_NAME` (a plain `[vars]` entry, default `CogSend`) is the fallback for
deployments that would rather keep it in config. The outbound `User-Agent`, the
Mastodon app name, cookies, and API-key prefixes stay fixed so upgrades keep
working.

`APP_URL` is the instance's public origin; `npm run setup` stores it as a Worker
secret, and a `[vars]` entry is read the same way. It is optional: left unset, the
app uses the origin each request arrives on and remembers the first authenticated
one, which is how a deployment works without knowing its URL in advance. Set it to
pin a deliberate origin — a custom domain, or the hostname OAuth redirect URIs and
signed media URLs must use. A pinned value does not follow a hostname change, so
update it if you move — [Domains and URLs](domains.md) has the
steps, and the redirect URIs that go with them.

## Faster post thumbnails

The Posts grid asks for small copies of its image attachments. A deployment with
the Cloudflare Images binding downscales each still image once to a 160px JPEG,
caches it in the media bucket, and serves it instead of the full-size original:

```jsonc
// wrangler.jsonc, or wrangler.personal.jsonc for a personal deployment
"images": { "binding": "IMAGES" }
```

The binding name must stay `IMAGES`. Transformations of images stored in R2 are
part of the Images Free plan (5,000 unique transformations a month, then $0.50
per 1,000); because the result is cached, each image is transformed once, not
once per view. Without the binding, and for GIFs, videos, or an encode that
fails, the original is served — this is a speed-up, not a requirement.

## Keeping your own deployment separate from upstream

If you run your own instance while pulling updates from this repo, keep your
instance-specific values in `wrangler.personal.jsonc` (gitignored) instead of
editing `wrangler.jsonc`. Copy the committed file and change `name`,
`database_id`, `database_name`, and `bucket_name`.

Every npm script goes through `scripts/wrangler.mjs`, which passes `--config
wrangler.personal.jsonc` automatically when that file exists.

Because your changes live in files upstream never touches, `git pull upstream
main` stays conflict-free. `npm run doctor` warns when the two configs disagree.

### More than one Cloudflare account

Every command needs two things: a login, and the account it acts on. With one login and one account there is nothing to choose. Otherwise, set both once instead of on every command.

**The login.** If you keep several Wrangler auth profiles, bind the one your instance uses to the checkout, from inside it:

```sh
npx wrangler auth activate my-account
```

Every command run from that folder then uses the profile. The binding belongs to the folder, so a moved or fresh checkout needs it again.

**The account.** Pin it in `wrangler.personal.jsonc`:

```jsonc
"account_id": "0123456789abcdef0123456789abcdef"
```

This picks the account when your login reaches several, and a command run with the wrong login fails with an authentication error instead of writing to whichever account that login reaches. It does not choose the login. The id is the first part of the dashboard URL (`dash.cloudflare.com/<account id>/…`), and `npm run doctor` prints the one your commands reach.

`WRANGLER_PROFILE` picks a profile for a single command instead, and the wrapper passes it on as `--profile`:

```sh
WRANGLER_PROFILE=my-account npm run deploy
```

A command without it uses the profile bound to the folder, or the default login.

Each deploy records the account it went to in `.wrangler/deployed-accounts.json`. Commands that write, which are deploys, secrets, remote migrations, `setup` and `admin:reset`, print the account they are about to use and refuse to run against a different one. To move an instance to another account on purpose, deploy once with `COGSEND_ALLOW_ACCOUNT_CHANGE=1 npm run deploy`, which records the new account.

## The login

There is one account, created one of two ways: `npm run setup` writes it into D1 from the terminal, before the deployment answers its first request, or, on an instance that has no account yet, the login page creates it once you enter the deployment's `APP_ENCRYPTION_KEY`. Only someone holding that key can do the second, so a fresh instance cannot be claimed by whoever finds its URL first, and once the account exists the form is gone. Only a PBKDF2-SHA256 hash is stored, and the password never becomes a Worker secret.

**Settings → Login** changes the email or the password. The current password is
required, and a new password signs every device out.

Forgot the password? `npm run admin:reset` from your checkout writes a new one and
revokes every session, leaving the account, its drafts, connections and keys
untouched. Add `--all` when the authenticator is gone too: that clears the
enrolled device, and the next sign-in walks through enrollment again with a fresh
QR and fresh backup codes. `npm run setup -- --reset-login` does the same thing as
the default case while it is re-checking the resources.

There is no emailed reset link and no reset route in the app. Recovery needs the
same thing installing needs: your Cloudflare account, which is also where the
database and the secrets live. That keeps the trust boundary honest and leaves
nothing for anyone to phish.
