# Running a multi-user instance

CogSend is a single-user app unless you opt in. With `REGISTRATION` unset, nothing on this page exists: there is no sign-up page, no Users page, and the instance behaves exactly as described everywhere else in these docs.

Opting in lets other people create accounts on your instance. Each account gets its own posts, connected accounts, API key and MCP access, and nobody sees anybody else's. The instance itself (its name, the platform OAuth apps, the scheduler, updates and the accounts on it) stays with you, the admin.

Read [Costs and limits](#costs-and-limits) and [What you take on](#what-you-take-on) before you open it to people you do not know.

## Turning it on

Set two Worker secrets and the instance starts taking sign-ups at `/signup`:

| Secret             | Values                       | What it does                                                                                                       |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `REGISTRATION`     | `off`, `waitlist` or `open`  | `off` (or unset) keeps the instance single-user. Anything unrecognised counts as `off`.                            |
| `MAX_ACTIVE_USERS` | a whole number, default `10` | How many accounts may be active at once, yours included, before `open` sign-up sends new accounts to the waitlist. |

```sh
npm run secrets:put REGISTRATION
npm run secrets:put MAX_ACTIVE_USERS
```

Put them in `.dev.vars` first; `secrets:put` reads them from there. Use secrets rather than `vars` in a Wrangler config: a deploy overwrites `vars` with whatever the config says. Like every Worker secret, they take effect without a redeploy.

The environment is the master switch. Once it is on, **Users → Sign-up** lets you change the mode and the cap day to day without touching secrets, including pausing sign-up entirely (invite links keep working while it is paused). What you save there wins over the secrets; clearing it hands control back to them. Nothing in the app can turn sign-up on while `REGISTRATION` is off.

Turning it off again closes sign-up at once. Accounts that already exist keep working, and the Users page stays visible to you while there is more than one account, so you can approve, suspend or delete them.

## The modes

- **`waitlist`**: every new account waits until you approve it on the Users page. It cannot sign in before then; the sign-in form tells its owner it is on the waitlist, but only once they have typed the right password.
- **`open`**: new accounts are active straight away while fewer than `MAX_ACTIVE_USERS` accounts are active, and wait for approval after that. The check happens in the same database statement that writes the account, so two people signing up at the same moment cannot both take the last place.

Approving an account on the Users page is your decision, so it is not held to the cap.

## Invite links

**Users → Invite links** creates a link that lets one person skip the waitlist and the cap. Each link works once, expires after the number of days you pick (seven by default, ninety at most) and is shown only when you create it: the database keeps a hash of it, like an API key. Revoke a link you no longer want used. Links work in every mode, including while sign-up is paused, but not while `REGISTRATION` is off.

## Signing up

The sign-up form takes an email and a password, with the same rules as your own login. Every account then sets up an authenticator app, exactly like yours: two-factor sign-in is required for everybody.

**Email confirmation.** When `RESEND_API_KEY` and `NOTIFY_FROM` are both set, a new account is sent a link to confirm its address before anything else happens, and whether it becomes active or waits is decided when the link is used. `NOTIFY_FROM` has to be an address on a domain you verified with Resend: Resend's shared `onboarding@resend.dev` sender only delivers to your own Resend account. An address nobody confirms within a day is released, so nobody can hold somebody else's email by signing up with it first.

Without those two secrets there is no confirmation, and the email address is only an identifier. In that case keep `REGISTRATION=waitlist` and approve accounts you recognise.

**What a stranger can learn.** With email confirmation on, every accepted sign-up gets the same "check your inbox" answer, whether the address already had an account or not. Without it, a taken address gets the waitlist answer; in `open` mode a new address goes straight to authenticator setup instead, so the two can be told apart. The sign-in form never says whether an address exists, and wrong passwords are counted per client address across every account, so being locked out on one address and not on another says nothing either.

**Bots.** The form carries a signed timestamp (a script that posts without loading the page is refused, and so is one that submits within two seconds) and a hidden field people never fill in. Sign-up requests also have their own edge rate-limit bucket, twenty a minute per address, separate from sign-in. None of this needs a third-party service; it slows a bot down rather than stopping a determined one, which is what the waitlist and the cap are for.

## Roles

There are two roles. The account `npm run setup` (or the claim form) created is the admin.

| Who    | Can                                                                                                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member | write, schedule and publish their own posts; connect their own accounts; use their own API key and MCP; their own profile, time zone and login; delete their own account                                                                                                        |
| Admin  | everything a member can, plus: the instance name, the platform OAuth app credentials, **Settings → Scheduled publishing** (the tick token and "Tick now", which publishes everybody's due posts), **Settings → Instance** (updates, the saved Cloudflare token), the Users page |

Members use your platform OAuth apps: a member who opens a platform you have not set up is told to ask you. Their tokens for those platforms are their own and stored per account, encrypted like yours.

On the Users page you can make another account an admin, or a member again. The instance never ends up with members and no active admin: the last one cannot be demoted, suspended or deleted, and cannot delete their own account, until another account is an admin. The `API_TOKEN` secret, if you use one, acts as the oldest admin.

## Managing accounts

**Users** in the workspace menu lists every account with its role, state, when it joined and was last seen, and how many posts and connected accounts it has.

- **Approve** a waiting account to make it active.
- **Suspend** signs an account out everywhere at once. Its API key stops working without being revoked, so **Reinstate** brings everything back.
- **Delete** removes the account and everything it owns: posts, schedules, uploaded media in R2 (and the previews and covers made from it), connected accounts, preview links, its API key, sessions and backup codes. It asks for your password. A very large media library is removed over several requests; the page keeps going until it is done.

Members delete their own account from **Settings → Delete my account**, with their password and a current authenticator code, and the same cleanup runs. Posts already published on the platforms stay there: deleting an account in CogSend does not delete posts from Mastodon, LinkedIn or anywhere else.

**Forgotten passwords.** There is no emailed reset. `npm run admin:reset -- --email someone@example.com` gives that account a new password (add `--all` if they lost their authenticator too) and touches no other account; without `--email` it resets the oldest account, which is yours. See [The login](configuration.md#the-login).

## Costs and limits

Every account shares one Worker, one D1 database, one R2 bucket and your platform OAuth apps, so their usage adds up against your plans and your apps' limits. The numbers below are Cloudflare's and the providers' at the time of writing; check their pricing pages before you rely on them.

- **Workers Free**: 100,000 requests a day for the whole account, 10 ms of CPU and 50 subrequests (D1 statements, R2 operations, platform requests) per request. The scheduler publishes what fits in each tick and leaves the rest for the next one, so a busy instance on Free falls behind before it fails; a paid Workers plan with `SUBREQUEST_LIMIT=10000` ([Configuration](configuration.md)) publishes everything due at once.
- **D1 Free**: 5 GB of storage, 5 million rows read and 100,000 rows written a day.
- **R2**: 10 GB of storage and a monthly allowance of operations free, then billed. Media is the part that grows with every member, and there is no per-account storage quota: decide how many members your bucket can afford before you raise the cap.
- **Platform apps**: rate limits on your LinkedIn, Threads, Instagram and X apps are per app, so every member's posts count against the same daily allowances. X in particular bills or caps by app tier. Mastodon and Bluesky limits are per user account and not shared.
- **Resend**: the free plan sends a limited number of emails a day and a month; confirmation emails come out of the same allowance as your failure digests.

The failure digest (`NOTIFY_EMAIL`) goes to you and covers the admins' posts only. Members see their failures in the app; they get no email.

## What you take on

Running an instance for other people makes you responsible for their data, the same way any other service operator is.

- **You can see their data.** Whoever controls the Cloudflare account can read D1 and R2, and holds `APP_ENCRYPTION_KEY`, which decrypts the tokens of every connected account. Tell your members so.
- **Publish a privacy policy and terms** that say what you store (email, password hash, authenticator secret, posts, media, platform tokens), where (Cloudflare), for how long, and how to get it deleted. The providers' developer programmes require one before they approve an app that acts for other people.
- **Honour deletion.** Self-service deletion and the Users page delete everything CogSend holds about an account. Backups you take yourself ([Backups](backups.md)) are yours to expire.
- **Your apps, your review.** The OAuth apps members connect through are registered to you, so you answer to each platform's developer policies for what members post with them. Suspend accounts that abuse them.
- **Updates.** Members cannot update the instance; keep it current from **Settings → Instance** ([Updating](updates.md)), since a security fix only reaches them through you.

If you put the instance behind [Cloudflare Access](access.md), remember that people signing up have no Access login: either bypass `/signup*` and `/api/auth/signup*` as well as the paths listed there, or invite people into Access first.
