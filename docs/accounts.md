# Connecting accounts

**Accounts** lists every connected account and how to add another. **Connect account**
opens the platform picker. An account that is working shows no badge; one that needs attention is marked, as described in [When an account needs reconnecting](#when-an-account-needs-reconnecting).

## Mastodon and Bluesky

These two connect with what you already have:

- **Mastodon** — enter your instance's address and approve CogSend on your
  instance. The app registers itself there; there is nothing to create first.
- **Bluesky** — enter your handle and an **app password**, which you create in
  Bluesky under Settings → Privacy and security → App passwords. Never use your
  main password.

## LinkedIn, Threads, Instagram and X

These four need a developer app of your own before they can connect, because the
platform issues the client id and secret the Worker uses. Until one is set up, the
picker shows the platform with a **Needs setup** badge, and choosing it shows that
platform's steps — the redirect URI to register and a form for the app's
credentials — instead of a connect attempt that cannot succeed. The full steps
are in [OAuth apps](oauth-apps.md).

Paste the credentials into that form and press **Save and connect**: nothing to
deploy and no checkout needed, which suits an instance installed with the
Deploy button. Worker secrets work too, set from a checkout or in the Cloudflare
dashboard; reload the page once they are on the Worker.

Instagram connects only a Business or Creator account; a personal account is refused with a note on switching its type in Instagram's settings.

If you would rather not set up an app, you can connect these through
[Zernio](zernio.md) instead.

## Long posts on X

An X account connected directly has a **Long posts** switch, showing whether it can post long (up to 25,000 characters, or 280) and where that came from. CogSend asks X for the account's plan when you connect it and when you press **Check plan**, and any paid plan (Basic, Premium or Premium+) turns long posts on.

Some accounts that can post long, such as Verified Organizations, report no plan, so the switch lets you decide. **Use what X reports** goes back to the plan. A reconnect keeps your choice. If X refuses a long post, CogSend turns long posts off for that account; turn them back on if it does have a paid plan.

X accounts connected through [Zernio](zernio.md) stay at 280, since Zernio's X route stops there.

## Compact links on Bluesky

A Bluesky account connected directly posts a long link the way Bluesky's app does, as the site and the start of the address: `marktisdaleart.etsy.com/listing/1234...`. Switch on **Compact links** to show only the site instead, `marktisdaleart.etsy.com/...`, which gives back 12 characters per long link. The link still opens the full address, the preview card is unchanged, and a short link such as `linktr.ee/markonart` stays as it is. The site is always kept, so readers can see where a link goes. The counter follows the switch, and a reconnect keeps it.

Accounts connected through [Zernio](zernio.md) post links as typed, so they have no switch.

## When an account needs reconnecting

A token that stops working marks the account as needing a reconnect, both here and
in the composer's account list. Here it shows its state, such as **Expired**, and **Reconnect** starts the same flow again and keeps
the account's history; **Check** asks the platform again whether the token still works. The usual cause is LinkedIn: a self-created LinkedIn app
gets a 60-day token and nothing to renew it with, so it has to be reconnected every
60 days ([why](oauth-apps.md#linkedin)).

Posts already scheduled for the account still go out at their time, and the first one that succeeds clears the reconnect flag on its own; you can't publish, schedule, retry or reschedule anything new to it until then.

## Disconnecting

**Disconnect** on an account's row asks first. Disconnecting removes its scheduled posts, returns drafts that were
still waiting, and keeps what it already published — the confirmation says how many
of each. A disconnected account's history stays in [Insights](posts.md#insights),
marked **Archived**.
