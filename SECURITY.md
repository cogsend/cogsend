# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue:

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security → Report a vulnerability), or
- email **me@deepakness.com**

Include what you did, what you expected, and what happened. A proof of concept or a copy of the request helps a lot. You will get an acknowledgement, and credit in the fix's commit or advisory if you want it.

## What this app stores

Worth knowing before you report something:

- **Third-party OAuth credentials** (Mastodon, Bluesky, LinkedIn, Threads, X) in D1, encrypted with AES-256-GCM under `APP_ENCRYPTION_KEY`.
- **The account**: an email and a PBKDF2-SHA256 hash, written into D1 by `npm run setup`. No password is stored anywhere in plaintext.
- **A TOTP secret and backup codes** for that account, encrypted the same way.
- **Draft content and uploaded media** (R2). Media handed to Meta is served through short-lived signed URLs.

Anything that exposes those — a key leak, a way to read another tenant's row, an SSRF, a signature bypass — is a real finding. Note that this is a **single-tenant, self-hosted** app: "another user's data" generally means another _deployment_, not another account on one instance.

## Not vulnerabilities

- Missing hardening headers on a self-hosted instance where you control the config.
- Anything requiring an already-compromised `APP_ENCRYPTION_KEY` or `AUTH_SECRET`.
- The deliberately permissive local-dev escape hatches (`SKIP_TOTP`, localhost Mastodon hosts). Both are gated on `APP_URL` pointing at localhost.

## Supported versions

Only the latest release is supported. Fixes ship as a new release, which an instance installs from Settings → Instance ([docs/updates.md](docs/updates.md)), and are not backported.

## What the app does by itself

- **A flood guard on the endpoints that take a password or a key.** `/api/auth/login`, `/api/auth/totp/verify` and `/api/auth/claim`, and the updater's `/api/update/unlock` and `/api/update/remember`, consult Cloudflare's Rate Limiting binding: twenty requests a minute per client address, enforced at the edge by the same infrastructure as WAF rate-limiting rules. It is per Cloudflare location and eventually consistent, so it is a burst guard rather than accounting.
- **A lockout on guessing.** Eight wrong passwords in fifteen minutes lock out the client address that sent them (an IPv6 address counts by its /64), and forty from any mix of addresses lock the account, so a guesser can lock out themselves but not the owner. The updater's password prompts count toward the same lockout. Authenticator codes lock the account after eight failures, counted across attempts rather than per challenge. This, not the edge limit, is what makes guessing impractical.
- **Re-authentication for destructive actions.** Deleting the account requires the password and a current code, so a stolen session alone cannot wipe an instance.
- **Sessions** are HMAC-hashed in D1, bound to the stored password hash, idle out after 24 hours (seven days for a browser signed in with "Remember this browser"), and die on a password change.

## Recommended hardening for your own instance

- **Rate-limit the remaining public routes at the edge** (Cloudflare → Security → WAF → Rate limiting rules): `/api/internal/tick` and `/api/health` are reachable without a session. Both do little work per hit; a rule is still the right place to absorb a flood.
- Keep `SKIP_TOTP` and localhost Mastodon hosts off outside local development — both are gated on `APP_URL` pointing at localhost, so a real deployment never enables them by accident.
