# Connect through Zernio

LinkedIn, Threads and X normally need a developer app of your own before CogSend can post to them ([OAuth apps](oauth-apps.md)). [Zernio](https://zernio.link/cogsend?utm_source=cogsend&utm_medium=sponsorship&utm_campaign=cogsend-integration&utm_content=provider-guide) is a way around that: it already has approved apps for X, Threads, LinkedIn and Bluesky, and CogSend can publish through them instead.

Nothing else changes. You still write, schedule and retry in CogSend, and your posts and history stay on your Cloudflare account; Zernio only carries the publish. Zernio has a free plan, though connecting X needs a card on your Zernio account ([pricing](https://zernio.link/cogsend-pricing?utm_source=cogsend&utm_medium=sponsorship&utm_campaign=cogsend-integration&utm_content=provider-guide-pricing)). Zernio also sponsors CogSend.

It is optional. Direct connections stay the default, accounts you connected with your own apps are not touched, and both kinds can sit side by side on **Accounts**, where the Zernio ones are marked **via Zernio**. Mastodon is not available through Zernio.

## What you need

- A Zernio account and an API key from **zernio.com → API keys**. The key must be read-write, and needs at least the **publishing** and **accounts** groups. A key limited to certain Zernio profiles only sees the accounts in those profiles.
- A deployed instance if you want to post images or video. Zernio fetches media from your instance's public URL, so a local instance can connect accounts and post text, but not media.

## Import accounts you already have in Zernio

1. Open **Accounts → Connect new** and choose **Connect through Zernio**, below the platforms.
2. Paste your API key and press **Show my Zernio accounts**.
3. Tick the accounts you want and press **Import**.

Each imported account behaves like any other: it gets its platform's tab in the composer, with the same limits. The key is stored encrypted, so next time you open the Zernio panel you can leave the field blank. Paste a new key to replace it.

## Connect a new account through Zernio

In the same panel, under **Connect a new account through Zernio**, pick the platform and the Zernio profile and press **Connect**. You approve CogSend on the platform, and come back to **Accounts** with the account added.

The same option appears when you pick LinkedIn, Threads or X on an instance that has no app set up for it: the setup steps end with a link to connect through Zernio instead.

Bluesky can only be imported for now. Connect it in Zernio's own dashboard first, then import it here.

## Reconnecting and checking

On a Zernio account, **Reconnect** goes through Zernio, and **Check** asks Zernio whether the account still works. A Bluesky account is reconnected in Zernio's dashboard; press **Check** here afterwards.

Disconnecting an account in CogSend does not remove it from Zernio. Remove it there if you no longer need it.

## What is different through Zernio

| Area              | Through Zernio                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Scheduling        | The same. At the scheduled minute, CogSend asks Zernio to publish immediately.                                                      |
| Threads           | X, Threads and Bluesky threads post as threads. LinkedIn gets a single post with the parts joined, the same as a direct connection. |
| Images and video  | Zernio fetches them from your instance when the post goes out. Each platform's size and format limits still apply.                  |
| Posts and retries | The same. A post is only marked published once Zernio confirms it, and a failure shows Zernio's reason.                             |
| Duplicates        | Zernio refuses the same text to the same account within 24 hours. The post fails with that reason and is not retried.               |
| Tokens            | Zernio keeps and refreshes them. If a platform revokes one, the account shows as expired here.                                      |

## Troubleshooting

- **"Zernio rejected this API key"**: the key is wrong, revoked or expired. Create a new one and paste it in the Zernio panel.
- **"This Zernio API key cannot be used here"**: the key is read-only, or lacks the publishing or accounts group.
- **A post fails with a Zernio reason**: the reason is shown in **Posts**. Content limits and platform refusals are the same as with a direct connection.
- **Images fail on a local instance**: Zernio cannot reach `localhost`. Deploy the instance, or set `MEDIA_PUBLIC_BASE_URL` to a public address.
