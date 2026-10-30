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

To start another post mid-thought, press **Write** at the top right. It saves the post you are on and opens a blank one; a draft lands in **Posts → Drafts**, and a scheduled post keeps its time. On an empty composer **Write** is hidden, since there is nothing to put away.

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

LinkedIn and Instagram have no threads: a thread sent there is flattened into one post. The
limits for every platform are in [OAuth apps → Platforms](oauth-apps.md#platforms).

An X account on a paid plan can post up to 25,000 characters in one post ([how CogSend knows](accounts.md#long-posts-on-x)). The counter still follows the strictest account you picked, so adding a free X account holds the whole post to 280. X shows about the first 280 characters of a long post and folds the rest behind **Show more**, and the card says so once the text passes that point. If X refuses a long post, it fails without a retry and that account drops back to 280; the message says how to turn long posts on again.

## Images and alt text

Each card takes up to four images, shown large in the card the way they will be laid out: one image at its own shape, two to four in a grid. Its buttons sit in the top corner, on hover or always on a phone: **ALT** (amber until it has a description) opens the alt-text field ("Describe
this image…"); fill it in and it goes out with the image on platforms that
support it. The × removes the image. Size and format limits differ per platform — Bluesky takes 2 MB, X 5
MB, and LinkedIn rejects WebP — and are checked again when the post is published.

A larger image is shown from a lighter 1280 px copy your browser makes when you attach it, in the composer and in **Posts**; the original is what gets published.

An image over 2 MB is shrunk in your browser before it uploads, so a pasted
screenshot fits every platform: it is scaled down to 2560 px on the long edge,
kept as PNG when that is enough and re-encoded as JPEG when it is not. GIFs and
animated WebP are left as they are, since shrinking them would drop the
animation. If an attached image is still over a selected platform's limit,
a line under the image names the platform, with a button to uncheck it, and
Publish and Schedule stop until it is resolved.

## Instagram

Every Instagram post needs a photo or a video, so with an Instagram account selected a text-only post shows **Instagram needs a photo or video** on the first card, with **Uncheck Instagram**, and Publish and Schedule stop until you attach something or uncheck it. The other accounts are not held to it.

One photo goes out as a photo post, two to ten as a carousel, and a video on its own as a Reel. Instagram takes JPEG photos from 4:5 tall to 1.91:1 wide; a PNG or WebP is sent through a full-size JPEG copy your browser makes when you attach it, and an image without one, attached before Instagram support or too large to copy within Instagram's 8 MB, asks to be attached again or as a JPEG. With the [Images binding](configuration.md#faster-post-thumbnails), the server makes a missing copy itself when the post is scheduled or published. GIFs, a video beside photos, and more than ten photos are refused for Instagram the same way, with a line naming the problem. A thread is flattened into one caption of up to 2,200 characters and 30 hashtags.

A URL in a card shows the link preview it will produce, while you write.

## Video

A card takes one video (MP4, MOV or WebM) and nothing else beside it; a thread can have a video on each card. Your browser prepares it before it uploads: a file every platform already takes goes up as it is, and anything else, such as a phone's HEVC video, a 4K clip or a frame rate over 60, is converted to MP4 (H.264 with AAC sound) at most 1920 pixels on the long edge. The card shows the video at its own shape, with **Reading**, **Converting** and **Uploading** and the progress along its bottom edge, and **Cancel** stops it. Once it is up, the video shows its cover with a play button and its length, and loads only when you press play. Videos up to 300 MB go up in parts, so a slow connection only resends the part that failed. Leave the page while a video is still uploading and the browser asks first, since the upload stops with it. A browser that can't convert the file says so; export it as MP4 (H.264) and attach it again.

When every selected platform takes the video, nothing more is shown. When one doesn't, a line under the video says why, one line per platform: X takes 2:20 unless the account has X Premium, Threads 5 minutes, Bluesky 10, Instagram 15, LinkedIn 30. **Uncheck** on the line drops that platform's accounts, and the accounts button in the dock and the account itself carry a red dot until it is resolved. Publish and Schedule stop on the first platform that would refuse it; trim the video or uncheck that account. A Mastodon account is held to the limits its server reports, which CogSend reads when you connect the account and again every day, so a server that raises its limits is followed within a day.

**COVER**, among the buttons on the video, picks the frame shown before it plays: scrub to a moment and **Use this frame**, or **Upload image**. Mastodon, LinkedIn and Instagram show it; X, Threads and Bluesky choose their own frame. Until you pick one, the frame one second in is the cover, and it is also what **Posts** shows. **ALT** describes the video, as for an image.

Platforms process a video before it can be posted, which can take minutes. CogSend uploads and waits for up to 20 seconds of the publish, then hands the rest to the next [tick](scheduling.md): the result says the platform "is processing the video" and that it publishes on its own, and **Posts** marks it **Processing**. A large video to X or LinkedIn is sent over several ticks the same way, carrying on from the last part sent. So closing or reloading the tab right after **Publish** loses nothing. Waiting uses none of the five attempts. A video still not ready after 45 minutes fails, and **Retry** starts it again.

## Quote posts on X

X shows a post as a quote when its text ends with a link to another X post. With an X account selected, paste such a link at the end of a card and it turns into a quote card: the author and text of the quoted post, the way X will show it. The link leaves the text box but stays saved at the end of the text, which is what X needs. A link you type by hand moves into the card once you click away from the box, and the × on the card removes the quote.

- X quotes only a link at the very end. A link to an X post anywhere else in the text stays a plain link, and the card says so, with a button to quote that post instead.
- A card quotes one post. Another X link pasted into it stays in the text as a plain link, so nothing is lost; its button swaps the two. To quote several posts, give each its own card with **+ Thread**.
- The quote button in a card's tools lists your recent published X posts, so you can quote one without copying its link.
- On **Global**, the other selected platforms get the same text, link included, and the card names them. **Only on X** keeps the quote for X alone: X gets its own tab with the quote, and the others get the text without the link. On the X tab, **Share with all** gives them the link again. A card holding only the quote can't be split this way.
- On Bluesky and LinkedIn, a link to an X post gets a card with the post's author and text.
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

**Publish** hands the draft to every selected account and empties the composer at once, so you can start the next post while it goes out. The result arrives as a message wherever you are in the app, updated as each account answers ("Published to Mastodon · still sending to Threads") and ending with **Published to 3 destinations**, or which account failed and why, with a link to the post in **Posts**. A failure also puts a red dot on the menu at the top left, beside **Posts**, until you open it. By default Publish asks first, with a **Confirm Post** step; tick **Publish
without asking next time** to skip it in this browser, and turn the question back
on under **Settings → Preferences → Ask for confirmation before publishing**.
**Cmd/Ctrl + Enter** publishes from the keyboard.

The calendar button next to it schedules instead: either **Publish in** an offset
of minutes, hours or days (one hour by default), or a **Specific Date** and time in
your own timezone. Opening a scheduled post again with **Edit Post** starts on the time it is already set for, so confirming without a change keeps it. A scheduled post waits in **Posts → Scheduled** until a
[tick](scheduling.md) publishes it. Scheduling goes to exactly the accounts ticked: untick one and schedule again, and its earlier time is cancelled.

Opening a scheduled post shows, above the text, when and where it goes out. Edits save as you type, and what is saved when the time comes is what gets posted. Ticking or unticking accounts doesn't change the schedule by itself: the post says which accounts differ, and **Update schedule** applies them. **Change time** opens the schedule at its current time, and **Unschedule** turns the post back into a draft. **Publish now** sends it straight away instead of at its time, and any account you unticked is unscheduled, so it doesn't post later either. Deleting it with the bin means it won't be published. A few minutes before the time, the post says so; while it is being sent, editing pauses until the result is in. A post that went out on some accounts, failed on others or is retrying says so in one line, with a link to the details in **Posts**.

Once a post is scheduled or handed off to publish, the composer empties for the next one and the message links to it in **Posts**. A post you opened from **Posts** takes you back there instead. Publishing again to an account that already has the post sends nothing, and the message says so.

If some accounts fail, the message says which and why, and **Posts → Failed** has a **Retry** for each. A scheduled post that hits a
retryable failure (a rate limit, a platform timeout) tries again on its own,
backing off from one minute up to thirty — five attempts, then it stops in
Failed. See [Posts and Insights](posts.md).
