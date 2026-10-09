# CogSend

> Self-hosted social scheduler for Mastodon, Bluesky, LinkedIn, Threads and X. SvelteKit 2 and Svelte 5 on Cloudflare Workers, D1 via Drizzle, R2 for media.

CogSend is single-tenant: one admin account on the operator's own Cloudflare account, with their own provider credentials. Every instance is somebody's personal deployment, so nothing may assume the maintainer's account, domain or data.

## Commands

```bash
npm install
npm run dev
npm run check
npm run lint
npm test
npm run test:e2e
npm run build
```

`check`, `lint`, `test` and `build` must all pass before a change is done. `npm audit --audit-level=high` runs in CI and can fail on a newly published advisory that passes locally.

Local setup, the seeded account and `SKIP_TOTP` live in [docs/development.md](docs/development.md). That file is the single source of truth for running the app, so do not duplicate its content.

## Conventions

- Comment the why, never the what. A comment earns its place only by explaining what the code cannot show: a protocol quirk, a retry rule, a failure mode. Never add a restatement of the line below, a section banner (`// --- Helpers ---`), historical narration or commented-out code. A stale comment is worse than none: when you change code a comment describes, fix or delete it in the same change.
- `src/lib/domain/` is pure logic shared by client and server; `src/lib/server/` and every `+server.ts` are Worker-only, with no DOM. Take what you need from `event.locals`.
- No new runtime dependencies without a reason.
- Tests assert what the app does, not that a spy was called.
- Operator scripts print one line per step through `scripts/lib/cli.mjs`, with detail only on `--verbose` or a failure.
- Nothing personal in code or docs: no hardcoded Worker name, D1 `database_id`, R2 bucket or `APP_URL`. Instances override those in the gitignored `wrangler.personal.jsonc`.
- The old names are gone: `socialsent`, `SocialSent`, `social-sent` and `panda-social` must not appear anywhere, and Typefully is never to be referenced.

## Testing

`tests/schema-bootstrap.test.ts` and `tests/migration-sync.test.ts` fail when `drizzle/*.sql` and the bootstrap DDL in `src/lib/server/db/init-sql.ts` disagree, so a migration that creates a table or index must be reflected in `INIT_SQL` in the same change.

The e2e suite is one serial journey, not independent tests, so a single spec run with `-g` proves nothing about that spec. The other specs reuse one saved session (`tests/e2e/sign-in.setup.ts`); a spec that signs in itself revokes it and spends the login rate limit, so don't.

## The docs are also the website

`docs/` is published at https://cogsend.com/docs/ by the website repo (github.com/cogsend/website), which copies these files at build time. The words stay here; the website owns the sidebar, page titles and site-only additions such as screenshots.

- A new file in `docs/` needs an entry in the website's `src/docs/nav.mjs`, or the website build fails. Say so when you add one.
- The website pins additions to these headings, so renaming one breaks its build: `One command` (deploy.md), `Secrets` (configuration.md), `How a tick works` (scheduling.md), `Examples` (api.md), `Insights` (posts.md). Renaming a doc file or any other heading is fine, as long as links inside `docs/` still resolve.
- Keep links between docs relative (`scheduling.md#cadence`); the website rewrites them into its own URLs.

## Releases and the in-app updater

Instances update themselves from **Settings → Instance** by installing a signed bundle that `.github/workflows/release.yml` attaches to each published release; the same workflow regenerates `github.com/cogsend/deploy`, the prebuilt copy the Deploy to Cloudflare button points at (stable releases on `main`, which the button copies; pre-releases on `next`). Button installs update through their own repository's **Update CogSend** Action instead, with no Cloudflare token. [docs/updates.md](docs/updates.md) is the operator's view.

- An in-place update cannot run migrations or add bindings. Keep the schema self-repairing (`INIT_SQL` and the repairs in `src/lib/server/db/`), and when a release needs something an update cannot do, such as a new binding, set `manualOnly` and a `notes` reason in `release.json` before tagging it. `minFromVersion` there is the oldest release that may update straight to this one.
- `package.json`'s version must equal the tag, or the release workflow stops.
- The bundle is signed with the `RELEASE_SIGNING_KEY` Actions secret; instances trust only the keys in `src/lib/domain/release-keys.json`. Rotating means adding the new public key in one release and signing with it from the next. Never put a private key in the repository.
- `scripts/check-release-parity.mjs` compares each bundle with what `wrangler deploy` would upload. If it fails after a wrangler upgrade, fix `scripts/lib/release-bundle.mjs`, never the check.
- Every deploy from a checkout is tagged `v<version>` and refuses to replace a newer one (`scripts/lib/deployed-version.mjs`).
- The manifest also signs every file of the generated deploy repository (`deployRepo.files`), and the Update CogSend Action (`src/lib/domain/github-update-workflow.yml`, `scripts/lib/update-from-release.mjs`) refuses any file it does not cover: Workers Builds runs that repository's deploy script with a token for the operator's account. `scripts/lib/github-update.mjs` and the scripts next to it ship inside the deploy repository, so they stay self-contained, Node built-ins only.

## Commits and pull requests

- Before finishing a change, check whether `README.md`, `docs/` or `AGENTS.md` has gone stale because of it, and ask whether to update them. Do not update the docs silently, and do not skip the check.
- One-line conventional commits: `fix(media): …`, `feat(accounts): …`. Add a body only when the change genuinely needs one.
- Do not hard-wrap prose. Release notes, PR descriptions and long messages wrap in the reader's view, so inserting line breaks by hand is a defect.
- Do not commit or push unless asked. When asked, commit to the current branch; do not create a new one unless asked.

## Do not

- Add a `CLAUDE.md`, `CLAUDE.local.md` or `AGENTS.override.md`. Agents read `AGENTS.md` on their own, and each of those takes precedence over it: Claude Code ignores `AGENTS.md` when a `CLAUDE.md` or `CLAUDE.local.md` exists, and pi reads `AGENTS.override.md` first.
- Hand-edit a shipped migration or a deployed schema. Add a migration.
- Put secrets in tracked files. Worker secrets go through `npm run secrets:put`.
- Deploy, publish a release, push a tag, run a remote migration or change credentials unless asked. These act on a real Cloudflare account.
- Write comments inside copyable command blocks in the docs. The copy button copies them too.
