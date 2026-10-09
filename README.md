<p align="center">
  <img width="96" alt="CogSend" src="https://github.com/user-attachments/assets/42c2579f-b1f2-4345-980a-01e24c9e027c" />
</p>

<h1 align="center">CogSend</h1>

<p align="center">
  Self-hosted social scheduler for Mastodon, Bluesky, LinkedIn, Threads and X.<br />
  Write a draft, customize it per platform, then publish it now or schedule it.
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/cogsend/deploy"><img alt="Deploy to Cloudflare" src="https://deploy.workers.cloudflare.com/button" /></a>
</p>

<p align="center">
  <a href="#install">Install</a>
  ·
  <a href="#documentation">Documentation</a>
  ·
  <a href="docs/api.md">API</a>
  ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/cogsend/cogsend/actions/workflows/ci.yml"><img alt="Checks" src="https://img.shields.io/github/actions/workflow/status/cogsend/cogsend/ci.yml?branch=main&label=checks&style=flat-square"></a>
  <a href="https://github.com/cogsend/cogsend/releases"><img alt="Release" src="https://img.shields.io/github/v/release/cogsend/cogsend?style=flat-square"></a>
  <img alt="Node 22.13+, 24 or 26+" src="https://img.shields.io/badge/Node-22.13%2B%20%7C%2024%20%7C%2026%2B-339933?style=flat-square" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square" />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square"></a>
</p>

https://github.com/user-attachments/assets/4e1e623b-e862-4f70-8b48-b764590834f5

<p align="center"><strong>Supported by <a href="https://zernio.link/cogsend?utm_source=cogsend&utm_medium=sponsorship&utm_campaign=cogsend-integration&utm_content=readme-sponsor">Zernio</a></strong>, which lets you connect X, Threads, LinkedIn and Bluesky <a href="docs/zernio.md">without your own developer apps</a>.</p>

## Why CogSend

Hosted schedulers usually charge per channel and keep your posts and tokens on their servers. CogSend runs on your own Cloudflare account instead: your data stays in your own D1 database and R2 bucket, posts go out through your own API credentials, and there is no subscription to keep paying.

## Features

- **Thread editor**: one card per post, images with alt text, and a tab per platform for tailored versions
- **Auto-split**: paste a long draft and it becomes a thread that fits every platform you picked
- **Publish or schedule**: see results per account, then cancel, reschedule or retry from Posts
- **Automatic retries**: temporary failures retry on their own, up to five attempts
- **Insights**: published against failed over 7, 30 or 90 days, and why posts failed
- **Link previews**: cards for URLs in a post
- **Secure by default**: encrypted credentials and 2FA on the admin account
- **AI agents (MCP)**: connect Claude Code, Codex or any MCP client to draft, schedule and publish with your API key
- **API access**: a personal key for scripts and Shortcuts, read-only or read-write

## What it costs

A single-admin instance normally stays within Cloudflare's free plans, though R2 needs a payment method on file. The Workers free plan allows five cron triggers per account, shared with every Worker you run; if none are left, an external pinger drives the schedule instead ([Scheduling](docs/scheduling.md#pick-one-tick)). On the free plan a backlog of due posts drains a post or two a minute, and a paid Workers plan publishes everything due at once.

## Install

### One click (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cogsend/deploy)

The easiest way, and the one to pick unless you want to change the code: no terminal and no Node. Cloudflare copies a prebuilt release into a GitHub or GitLab repository of yours, creates the database and the bucket, and deploys it.

1. Generate an encryption key at [cogsend.com/key](https://cogsend.com/key/) and keep a copy: the next two steps ask for it, and losing it later means reconnecting every account.
2. Press the button, sign in to Cloudflare and GitHub, and paste the key when the form asks for `APP_ENCRYPTION_KEY`.
3. Open your new URL, enter the same key, an email and a password, then scan the QR with an authenticator app and save the backup codes.

Updates come through your repository's **Update CogSend** action, with no Cloudflare token, and can install patch releases by themselves. You need a Cloudflare account with Workers, D1 and R2 available; [docs/deploy.md](docs/deploy.md#deploy-with-one-click) walks through every screen.

### From a terminal

For changing the code, or deploying without a GitHub or GitLab account. Needs Node 22.13+, 24 or 26+ (odd-numbered releases such as 25 are not supported) and a Cloudflare account with Workers, D1 and R2 available.

```sh
git clone --depth 1 https://github.com/cogsend/cogsend.git cogsend
cd cogsend && npm install && npm run setup
```

`setup` creates the Cloudflare resources, your admin account and the secrets, deploys, and prints your URL. Sign in there, scan the QR with an authenticator app and save the backup codes. It is safe to re-run; [docs/deploy.md](docs/deploy.md#one-command) lists every step and flag.

Next, [connect your accounts](docs/accounts.md). Mastodon and Bluesky work straight away; LinkedIn, Threads and X need an [OAuth app](docs/oauth-apps.md) first, which the accounts dialog walks you through (or hands to a browser agent), or you can connect them through [Zernio](docs/zernio.md).

## Updating

Settings → Instance and a dot on your avatar say when a newer release is out.

- **Installed with the button:** Settings links to your repository's **Update CogSend** action. Run it, and Workers Builds deploys the release it commits; set the repository variable `AUTO_UPDATE` to `true` and it installs patch releases by itself. No Cloudflare token involved.
- **Any install, from Settings:** paste a Cloudflare API token (it can remember it, locked with your password), and CogSend uploads the signed release, checks the new version answers, then switches to it, with a Roll back button afterwards.
- **From a checkout,** one command:

```sh
git pull && npm ci && npm run deploy:release
```

Your data is in D1 and R2, not in the checkout, so no path can touch it. [docs/updates.md](docs/updates.md) covers all three, release tags and rolling back.

## Documentation

Also published, with search, at [cogsend.com/docs](https://cogsend.com/docs/).

**Get started**

- [Deploying](docs/deploy.md): the one-click button, the terminal install and its flags, checking it worked
- [Updating](docs/updates.md): updating from Settings, through GitHub or from a checkout, rolling back, and why each is safe
- [OAuth apps](docs/oauth-apps.md): LinkedIn, Threads and X app setup, and what each platform allows
- [Zernio](docs/zernio.md): connecting through Zernio instead of registering your own apps
- [Connecting accounts](docs/accounts.md): connecting, reconnecting and disconnecting accounts

**Use it**

- [Writing and publishing](docs/composer.md): threads, per-platform overrides, images and alt text, scheduling
- [Posts and Insights](docs/posts.md): the queue, what each post can do, and the delivery stats
- [API](docs/api.md): personal API keys, the MCP server, and worked examples (the full reference is in-app at `/api`)

**Run it**

- [Configuration](docs/configuration.md): secrets, the instance name, `APP_URL`, the login and recovery
- [Scheduling](docs/scheduling.md): the cron trigger, the free-plan trigger limit, external pingers, failure emails
- [Domains and URLs](docs/domains.md): the workers.dev URL, a custom domain, changing the hostname
- [Cloudflare Access](docs/access.md): putting an extra gate in front of an instance
- [Backups](docs/backups.md): D1 Time Travel, exporting the database, copying the bucket
- [Troubleshooting](docs/troubleshooting.md): the errors people actually hit, and what fixes each
- [Development](docs/development.md): local setup, the checks that must pass, code expectations

## Stack

SvelteKit 2 and Svelte 5 on Cloudflare Workers with Static Assets, D1 (SQLite) via Drizzle, and R2 for media.

## Contributing

[docs/development.md](docs/development.md) has local setup and the checks that must pass; [CONTRIBUTING.md](CONTRIBUTING.md) has the pull-request rules. Report security issues privately, as [SECURITY.md](SECURITY.md) describes.

If CogSend is useful to you, [sponsoring](https://github.com/sponsors/deepakness) supports my time maintaining it.

## License

MIT, see [LICENSE](LICENSE). Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
