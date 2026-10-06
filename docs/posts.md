# Posts and Insights

**Posts** is everything you have written, and what happened to it. **Insights** is
how publishing has gone over time.

## Posts

The tabs filter by state — **All Posts**, **Scheduled**, **Published**, **Failed**
and **Drafts** — each with its count. **All accounts** narrows the list to one
account, and the search box matches the post text. Every card shows the accounts
it goes to, the text, and when: **Will publish** with the time in your own
timezone and how far away it is, or **Published**, or when a draft was last edited.

What a card offers depends on its state:

| State     | Actions                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Scheduled | **Edit Post**, **Reschedule** (an offset or a specific time), **Cancel**                                    |
| Failed    | **Edit & re-draft**, **Post again**, **Retry** (or **Retry N failed** for many)                             |
| Published | **Post again**, which copies it into a new draft; on X, **Quote on X**, which starts a new draft quoting it |
| Draft     | **Edit Post**, **Duplicate**, **Remove**                                                                    |

A post that went to several accounts is one card, with a result per account, so a
post that published on four and failed on one shows exactly that. Retrying a card
retries only the accounts that failed.

A scheduled post that fails with something retryable — a rate limit, a platform
timeout — is not failed yet: it backs off and tries again on its own, up to five
attempts, and only then lands in **Failed**. The dashboard shows a banner when
something has failed, and [failure emails](scheduling.md#failure-alerts-optional)
can tell you the next morning.

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
