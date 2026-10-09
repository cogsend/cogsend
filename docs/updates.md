# Updating

Settings → Instance and `npm run doctor` both say when a newer release is out, and so does a line in the profile menu, with a small dot on your avatar until you have seen it. There are two ways to install it: from Settings, with nothing but a Cloudflare API token, or from a checkout, the way you may have installed it.

## From Settings

When a release is available, Settings → Instance shows **Update to vX.Y.Z from here**.

1. Press **Create one** next to the token field. It opens Cloudflare's token page with the two permissions the update needs already chosen: Workers Scripts (edit) and Account Settings (read). Create the token and copy it.
2. Paste it into the field and press **Install**.
3. Leave the page open until it reloads on the new version, usually under a minute.

Keep the token in your password manager: the same one works for every update, and the field accepts it from there. CogSend never stores it: it lives in the page while the update runs and is sent with each step, nowhere else. Delete it in Cloudflare whenever you want to revoke it.

What happens, in order:

| Step              | What it does                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Find this Worker  | Works out which Worker on your account is this instance, from its URL. If it cannot tell, it asks you to pick.                       |
| Download, verify  | Downloads the release's update bundle from GitHub and checks its signature and every hash. A bundle that fails either is refused.    |
| Upload the files  | Uploads the static files Cloudflare does not already have, a few batches per request.                                                |
| Upload the Worker | Uploads the new code as a new version that is **not serving yet**, with the same bindings and secrets the running version has.       |
| Check it          | Deploys it at 0% beside the current version and asks it for `/api/health` directly. It must answer, and with the new version number. |
| Switch            | Sends all traffic to the new version, and remembers the old one for **Roll back**.                                                   |

Nothing changes for visitors until the last step. If any step fails, the old version keeps serving; **Abort the unfinished update** tidies up whatever the update had staged. Each step is a short request of its own, sized to fit the Workers Free plan's limits, and picks up where it stopped: one Cloudflare cuts short is retried, and pressing the button again continues the update rather than starting over.

To install a specific release tag, a pre-release for example, type it into the tag field: it shows next to the token when no release is on offer, and under **More options** otherwise. **More options** is also where you name the account if your token cannot list accounts.

Some releases cannot be installed this way, for example one that needs a new binding. Settings then says so and why, and the release notes say what to do; usually it is one update from a checkout.

## From a checkout

```sh
git pull
npm ci
npm run deploy:release
```

That runs the test suite, the remote D1 migrations, the build and the deploy, one line per step; `npm run deploy:release -- --verbose` shows everything they said.

Every deploy from a checkout is tagged with the checkout's version, and it refuses to replace a Worker that already runs a newer release. That happens when you updated from Settings and then deploy from an old checkout: without the check, the deploy would quietly roll the instance back. Pull first, or pass `--allow-downgrade` (`COGSEND_ALLOW_DOWNGRADE=1`) if the older version is what you want.

Deploying with `wrangler.personal.jsonc`? It replaces the committed config, so a binding or setting a release adds to `wrangler.jsonc` does not reach you by itself; `npm run doctor` lists anything yours is missing.

Cloned `main`? Pull it, or move to a release tag (`git tag` lists them); those are the states the docs and the setup script are tested against.

## Installed with the Deploy to Cloudflare button

Update from Settings. The button also connected a copy of the `cogsend/deploy` repository to Workers Builds, which deploys it on every push. Once you have updated from Settings, that copy is older than your instance, so disconnect it: Workers & Pages → your Worker → Settings → Builds → **Disconnect**. Its deploy script refuses to roll you back anyway, but a disconnected copy cannot even try.

## Rolling back

After an update from Settings, **Roll back to vX.Y.Z** sends all traffic back to the version it replaced. It needs a token too.

Independently of how you updated, Workers & Pages → your Worker → **Deployments → Roll back** (or `npx wrangler rollback`) does the same from Cloudflare.

Rolling back reverts code only. Migrations stay applied, so rolling back across a schema change can break things; Settings warns when the release you are leaving changed the database. Take a [backup](backups.md) before an update you might want to undo.

## Your data

D1, R2, the Worker secrets and the app settings live in your Cloudflare account, so no update, from either path, touches them. The app adds missing tables and columns on the first request after an update. When a release ships a migration it cannot apply that way, `npm run db:migrate:remote` from a checkout applies it; `deploy:release` already does.

## Why the update is safe to run

- **Signed releases.** Every release's update bundle is signed in CI with a key that exists only as a GitHub Actions secret. Instances trust only the public keys committed in `src/lib/domain/release-keys.json`, and refuse a bundle that is unsigned, signed by anyone else, or altered after signing. A compromised GitHub account alone cannot push code to your instance this way.
- **The same upload as wrangler.** CI checks each bundle against what `wrangler deploy` itself would upload for that release, file by file, before attaching it.
- **Your bindings and secrets carry over.** The new version gets exactly the bindings the running one has; the update checks that before anything serves it, and stops if they differ.
- **A checked switch.** The new version answers a health check before it gets any traffic.
- **The token.** It can edit every Worker on the account, because Cloudflare cannot narrow a token to one Worker, which is why it is never stored. If you run other important Workers, consider keeping CogSend on an account of its own.
