# Posts and Insights

**Posts** is everything you have written, and what happened to it. **Insights** is
how publishing has gone over time.

## Posts

The tabs filter by state — **All Posts**, **Scheduled**, **Published**, **Failed**
and **Drafts** — each with its count. **All accounts** narrows the list to one
account, and the search box matches the post text. The tab and account stay in
the address, so reloading or sharing the link keeps them, and coming back from
editing a post returns you to the same tab, account and search. Every card shows
the accounts it goes to, the text, its images or video, and when: **Will publish** with the time in
your own timezone and how far away it is, **Due** once that time has passed, **Started** while it is being sent, or **Published**, or when a draft was
last edited. A video shows its cover and loads only when you press play.

A post being sent right now is marked **Sending** and offers nothing to press until it is done; the list refreshes on its own every few seconds while anything is sending, and every half minute while a platform is processing a video. A send that stops answering — Cloudflare cut it off — is given up on after 7 minutes: the card leaves **Sending** with **Reschedule** and **Cancel** again, and the next tick retries it.

What a card offers depends on its state:

| State     | Actions                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Scheduled | **Edit Post**, **Reschedule** (an offset or a specific time), **Cancel**                                    |
| Failed    | **Edit & re-draft**, **Post again**, **Retry** (or **Retry N failed** for many)                             |
| Published | **Post again**, which copies it into a new draft; on X, **Quote on X**, which starts a new draft quoting it |
| Draft     | **Edit Post**, **Duplicate**, **Remove**                                                                    |

**Edit Post** on a scheduled card opens it in the composer, which shows when and where it goes out and offers **Change time** and **Unschedule** there too; see [Publish now, or schedule](composer.md#publish-now-or-schedule).

A post that went to several accounts is one card, with a result per account, so a
post that published on four and failed on one shows exactly that. Retrying a card
retries only the accounts that failed.

A post that published to every account can't be edited, since changing it would no longer match what went out. Opening it shows it read-only, with **Duplicate to post again** to start a copy, which is what **Post again** does from its card. A post that failed on some accounts stays editable, so it can be fixed and retried.

A scheduled post that fails with something retryable — a rate limit, a platform
timeout — is not failed yet: it backs off and tries again on its own, up to five
attempts, and only then lands in **Failed**. A post whose video a platform is still processing is marked **Processing** instead: it publishes on its own once the platform is done, without spending any of the five attempts ([Video](composer.md#video)). **Retry** and **Reschedule** start the five attempts afresh; publishing or scheduling the same post to the same account again does not. The dashboard shows a banner when
something has failed, and [failure emails](scheduling.md#failure-alerts-optional)
can tell you the next morning.

### Preview links

To get feedback on a draft without handing out your login, press **Share** above the composer and then **Create link**. Anyone with the link can read the draft without signing in: its text as the cards it will post, its images and video, and a version for each platform whose text you changed. They don't see which accounts it goes to, or anything else on the instance.

The link shows the latest save, so a reviewer who refreshes sees your newest edits. Each draft has one link: opening **Share** again shows the same one, **New link** replaces it (the old one stops working), and **Turn off** ends it. A link also stops working after 14 days, when the draft is deleted, and as soon as the post publishes to any account. Search engines are told not to index preview pages.

## Insights

Insights counts what was published and what failed over the last **7**, **30** or
**90** days, bucketed by your local days (weeks for 90), with the period before it
alongside. Local means your browser's time zone: the app records it when you open
it, so the days follow you if you move or travel.

- **Published**, with the change against the previous period as a signed count.
- **Scheduled**, with how long until the next one goes out.
- **Last post**, so a week where nothing went out is obvious.
- A chart of posts per day, as **Bars** or **Cumulative** against the previous
  period. Hover, tap or use the arrow keys to read any day; red dots mark days
  with failures.
- The failures, grouped by reason — a platform-wide problem reads differently from
  one bad post — with a link to review them in Posts.
- A row per account, including disconnected ones, which are kept and marked
  **Archived** so their history still counts.
