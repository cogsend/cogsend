# Writing and publishing

The composer is one draft: a thread of cards, the accounts it goes to, and a
Publish button with a schedule option next to it. Everything here happens in the
browser; the same actions are available to scripts through the [API](api.md), and to AI agents through its [MCP server](api.md#mcp-server).

## Drafts save themselves

A draft is saved as you type, and **Cmd/Ctrl + S** saves it on demand. Drafts are
listed under **Posts → Drafts**, where **Edit Post** reopens one and **Remove**
deletes it. The trash button in the composer discards the draft you are on, after
asking.

The top right of the composer says where the draft stands: **Saving…**, **Saved**, or **Not saved** with a **Retry** button. A failed save is retried on its own until it goes through. Switching to another tab or app saves at once, so a phone that closes the browser in the background does not cost you the last thing you typed.

## A thread is a list of cards

Each card is one post, with its own character counter and its own images. The
counter uses the strictest limit among the accounts you picked, counted the way
that platform counts: graphemes for most, while Mastodon and X count every link
as 23 characters, and X also counts CJK characters and each emoji as 2.

- **+ Thread** adds a card; the × on a card removes it.
- Type `---` in a card to split it there. The text after the marker moves into a
  new card below; several markers make several cards.
- Paste a long draft and it is split for you: into a thread that fits that same
  strictest limit. Paste text with `---` on lines of their own and it splits on
  those instead.
- **Alt + ↑ / ↓** moves the card you are typing in up or down the thread.

LinkedIn has no threads: a thread sent there is flattened into one post. The
limits for every platform are in [OAuth apps → Platforms](oauth-apps.md#platforms).

## Images and alt text

Each card takes up to four images. Every image has an alt-text field ("Describe
this image…"); fill it in and it goes out with the image on platforms that
support it. Size and format limits differ per platform — Bluesky takes 2 MB, X 5
MB, and LinkedIn rejects WebP — and are checked again when the post is published.

An image over 2 MB is shrunk in your browser before it uploads, so a pasted
screenshot fits every platform: it is scaled down to 2560 px on the long edge,
kept as PNG when that is enough and re-encoded as JPEG when it is not. GIFs and
animated WebP are left as they are, since shrinking them would drop the
animation. If an attached image is still over a selected platform's limit,
Publish and Schedule stop and say which platform to uncheck.

A URL in a card shows the link preview it will produce, while you write.

## Quote posts on X

X shows a post as a quote when its text ends with a link to another X post. With an X account selected, paste such a link at the end of a card and it turns into a quote card: the author and text of the quoted post, the way X will show it. The link leaves the text box but stays saved at the end of the text, which is what X needs. A link you type by hand moves into the card once you click away from the box, and the × on the card removes the quote.

- X quotes only a link at the very end. A link to an X post anywhere else in the text stays a plain link, and the card says so, with **Make it the quote** to move it to the end.
- A card quotes one post. Pasting a second link at the end replaces the first.
- The quote button in a card's tools lists your recent published X posts, so you can quote one without copying its link.
- On **Global**, the other selected platforms get the same text, link included; the card names them.
- X bills a post that contains a link at $0.20 instead of $0.015, and a quote is such a post.

## Global, and a tab per platform

The **Global** tab is the post every account gets. With more than one account
selected, **Add override…** adds a tab for one platform, where you can rewrite the
text for that platform alone — shorter for X, longer for LinkedIn — without
touching the others. An override tab is unlinked from Global from then on; its
reset button re-syncs it to the Global text.

With a Mastodon account selected, **Mastodon Options** sets the visibility
(Public, Unlisted, Followers, Direct) and an optional content warning.

## Choosing destinations

The accounts button in the dock (**N selected**) opens the list of connected
accounts. Tick the ones this draft goes to; **Clear all** empties the list. An
account that needs reconnecting is marked, and [Accounts](accounts.md) is where
you fix it.

## Publish now, or schedule

**Publish** sends the draft to every selected account and shows the result per
account. By default it asks first, with a **Confirm Post** step; tick **Publish
without asking next time** to skip it in this browser, and turn the question back
on under **Settings → Preferences → Ask for confirmation before publishing**.
**Cmd/Ctrl + Enter** publishes from the keyboard.

The calendar button next to it schedules instead: either **Publish in** an offset
of minutes, hours or days (one hour by default), or a **Specific Date** and time in
your own timezone. Opening a scheduled post again with **Edit Post** starts on the time it is already set for, so confirming without a change keeps it. A scheduled post waits in **Posts → Scheduled** until a
[tick](scheduling.md) publishes it.

If some accounts fail, the composer says **Couldn't publish everywhere** and lists
why; **Posts → Failed** has a **Retry** for each. A scheduled post that hits a
retryable failure (a rate limit, a platform timeout) tries again on its own,
backing off from one minute up to thirty — five attempts, then it stops in
Failed. See [Posts and Insights](posts.md).
