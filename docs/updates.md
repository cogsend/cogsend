# Updating

Settings → Instance and `npm run doctor` both say when a newer release is out, and so does a line in the profile menu, with a small dot on your avatar until you have seen it. There are three ways to install it: from Settings, with nothing but a Cloudflare API token; through your repository's GitHub Action, if you installed with the Deploy button; or from a checkout, the way you may have installed it.

## From Settings

When a release is available, Settings → Instance shows **Update to vX.Y.Z from here**.

1. Press **Create one** next to the token field. It opens Cloudflare's token page with the two permissions the update needs already chosen: Workers Scripts (edit) and Account Settings (read). Create the token and copy it.
2. Paste it into the field, enter your CogSend password, and press **Install**.
3. Leave the page open until it reloads on the new version, usually under a minute.

The password locks the token for next time: with **Remember it for later updates** ticked, CogSend keeps the token encrypted with a key made from your password, and the next update asks for the password alone, which your password manager fills. The key is not `APP_ENCRYPTION_KEY`, so someone holding your database and that key still cannot read the token. **Forget the saved token** removes it, and changing your password forgets it too: paste it once more on the next update. Untick the box and the token is used for that update only, and nothing is stored.

The same token works for every update; delete it in Cloudflare whenever you want to revoke it.

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

To be offered release candidates too, tick **Offer pre-releases too** under Settings → Instance; the update notice and the button then include them. Leave it off on an instance you rely on. To install any specific release tag, type it into the tag field: it shows next to the token when no release is on offer, and under **More options** otherwise. **More options** is also where you name the account if your token cannot list accounts.

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

The button created a repository in your GitHub account and connected it to Workers Builds, which deploys every push to it. Update through that repository, with no Cloudflare token: Settings → Instance shows **Update to vX.Y.Z on GitHub**.

1. The first time, press **Add the Update action to the repository**. GitHub opens a new file, `.github/workflows/update.yml`, already filled in: press **Commit changes**. The button cannot copy workflow files into the repository it creates, so this is once per install.
2. Press **Update to vX.Y.Z on GitHub**, then **Run workflow**. Leave the tag empty for the latest release.
3. The action checks the release and commits it, and Workers Builds deploys the commit within a couple of minutes. Reload CogSend to see the new version.

Keep Workers Builds connected: it is what deploys the update.

The action trusts the release's signature, not the place it downloads from. The signed manifest covers every file it commits, the deploy script and the config included, because Workers Builds runs them with a token for your account; a file that does not match stops the action before it commits anything. Releases before 1.14.0 do not sign their deploy repository, so the action refuses them.

To go back, run the action with the older release's tag and **Roll back** ticked. That release, and only that one, may then deploy past the downgrade check.

**Automatic updates.** Add the repository variable `AUTO_UPDATE` with the value `true` (the repository's Settings → Secrets and variables → Actions → Variables; Settings → Instance links there). A daily run then installs patch releases, 1.15.0 to 1.15.1 for example, with the same checks; a bigger release still waits for you to run the action. GitHub pauses scheduled runs in a repository with no activity for 60 days, which an install that gets no update for that long can be; running the action by hand starts them again.

The action's own file comes from Settings, and GitHub lets no action rewrite it. A copy added before 1.15.0 has no daily run: under **Added the action before 1.15? Update the action itself**, copy the latest version and paste it over `.github/workflows/update.yml` on GitHub. Until the repository has had one update to 1.15.0 or later, the daily run does nothing, because the updater it would run does not know to stop at patch releases.

Installed before 1.14.0, Settings does not offer GitHub yet, because those installs did not record their repository. Add the action by hand once: create `.github/workflows/update.yml` in your repository with the contents of [this file](https://github.com/cogsend/cogsend/blob/main/src/lib/domain/github-update-workflow.yml), then run it. From the deploy it starts, Settings links to it.

Installed from GitLab, which has no GitHub Actions? Update from Settings with a token, as above. That leaves the repository's copy older than your instance; its deploy script refuses to roll you back if anything pushes to it.

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
- **The token.** It can edit every Worker on the account, because Cloudflare cannot narrow a token to one Worker. That is why a remembered token is locked with your password rather than the app's encryption key, why the browser never gets it back (an update opens it once and passes a one-update key between steps), and why the endpoints that take the password share the login's lockout. If you run other important Workers, consider keeping CogSend on an account of its own.
