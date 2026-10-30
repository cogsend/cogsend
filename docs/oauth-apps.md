# OAuth apps and platform limits

Mastodon and Bluesky connect with what you already have. LinkedIn, Threads,
Instagram and X need an app registered at the provider first, because they issue the client id
and secret the Worker uses. If you would rather not register apps, the optional
[Zernio provider](zernio.md) publishes to those platforms through Zernio's own.

## OAuth app setup

Each one is the same three steps: create the app, add the redirect URI, give CogSend the app's credentials. The accounts dialog walks through all three: pick a platform marked **Needs setup** and it shows this instance's exact redirect URI and a form for the credentials.

| Platform  | Where                                                                 | Redirect URI                                   | Worker secrets                                 |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| LinkedIn  | [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) | `{APP_URL}/api/connections/linkedin/callback`  | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| Threads   | [Meta for Developers](https://developers.facebook.com/apps/)          | `{APP_URL}/api/connections/threads/callback`   | `THREADS_APP_ID`, `THREADS_APP_SECRET`         |
| Instagram | [Meta for Developers](https://developers.facebook.com/apps/)          | `{APP_URL}/api/connections/instagram/callback` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`     |
| X         | [X Developer Portal](https://developer.x.com/en/portal/dashboard)     | `{APP_URL}/api/connections/x/callback`         | `X_CLIENT_ID`, `X_CLIENT_SECRET`               |

The last step works three ways:

- **In the accounts dialog.** Enter the values in the dialog's form and press **Save and connect**. They are stored in D1, encrypted with `APP_ENCRYPTION_KEY` like the account tokens, and never shown again; **App credentials saved here** under the platform list changes or removes them. Nothing to deploy, no checkout needed.

- **From a checkout.** Put the values in `.dev.vars` and run the platform's
  command below. The example file ships every optional key commented out:
  uncomment the line you fill in, or add it if it is not there. `secrets:put`
  reads that file, then reads the Worker's own secret list back to confirm what
  landed, and exits non-zero naming anything it did not find.
- **Without a checkout.** Add each one in the Cloudflare dashboard — Workers &
  Pages → your Worker → Settings → Variables and Secrets → Add → **Secret** —
  using the names in the table above. The dashboard applies the change when you
  press **Deploy** in the same flow.

From the CLI there is no redeploy step at all: the secrets are live as soon as
the command finishes. Either way, reload the accounts page when you are done. A Worker secret takes precedence over credentials entered in the dialog, and the dialog will not save over one.

### Let a browser agent do it

The dialog's first step has **Copy the agent prompt**: instructions for a browser-driving agent such as Claude in Chrome, with this instance's exact redirect URI and the console's requirements filled in. Paste it into the agent and it creates the app and types the credentials into CogSend's form itself, then stops before the provider's authorisation page, which is yours to approve. The prompt tells it never to repeat a secret in the chat, and to hand control back for anything that is yours to do: signing in, phone or identity verification, CAPTCHAs, accepting terms or paying.

### LinkedIn

1. Create an app in the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps).
   It has to be attached to a LinkedIn Page.
2. On **Products**, request **Share on LinkedIn** (grants `w_member_social`,
   which publishes) and **Sign In with LinkedIn using OpenID Connect** (grants
   `openid profile email`, which fills in the account name and avatar).
3. On **Auth**, add the redirect URI under **Authorized redirect URLs for your
   app**, and copy the client id and secret from **Application credentials**.
4. Set the secrets:

   ```sh
   npm run secrets:put LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET
   ```

LinkedIn issues refresh tokens only to approved Marketing Developer Platform
partners, so a self-created app gets a 60-day access token and nothing to renew
it with. Posts keep going out until that token expires; after that the account
shows as expired, and **Reconnect** on the Accounts page starts a new 60 days.

### Threads

1. Create an app in the [Meta for Developers](https://developers.facebook.com/apps/)
   dashboard with the **Access the Threads API** use case.
2. Add the redirect URI under that use case's **Redirect Callback URLs**, and
   copy the app id and secret.
3. While the app is still in development, add the Threads account you want to
   connect as a **Threads tester** and accept the invite from the Threads app.
4. Set the secrets:

   ```sh
   npm run secrets:put THREADS_APP_ID THREADS_APP_SECRET
   ```

### Instagram

Instagram only lets Business and Creator accounts post through its API. A personal account can switch for free in the Instagram app's settings, and no Facebook Page is needed.

1. Create an app in the [Meta for Developers](https://developers.facebook.com/apps/)
   dashboard with the **Manage messaging & content on Instagram** use case. An
   app you already use for Threads works too: **Use cases → Add use cases**.
2. Under that use case, open **Permissions and features** and add
   `instagram_business_basic` and `instagram_business_content_publish`. The
   messaging and comment permissions it suggests are not needed.
3. Open **API setup with Instagram login**. Under **Set up Instagram business
   login**, press **Set up** and enter the redirect URI as the **Redirect URL**.
4. Copy the **Instagram app ID** and **Instagram app secret** shown on the same
   page. They are not the Meta app's own id and secret under App settings.
5. While the app is still in development, add the Instagram account you want to
   connect under **App roles → Roles → Add People** as an **Instagram Tester**,
   and accept the invite in Instagram (Settings → Website permissions → Apps and
   websites → Tester invites).
6. Give CogSend the credentials in the accounts dialog, or set the secrets:

   ```sh
   npm run secrets:put INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET
   ```

Posting to an account you own needs no App Review. The token lasts 60 days and CogSend renews it when it publishes or when you press **Verify**; an account left untouched for longer shows as expired and needs **Reconnect**.

### X

1. Create a Project and an App in the [X Developer Portal](https://developer.x.com/en/portal/dashboard).
2. In the app's **User authentication settings**, turn on OAuth 2.0 with the app
   type **Web App**, and add the redirect URI as the **Callback URI / Redirect
   URL**.
3. Copy the client id, plus the client secret if the app is a confidential
   client (CogSend also completes the exchange with PKCE alone).
4. Set the secrets:

   ```sh
   npm run secrets:put X_CLIENT_ID X_CLIENT_SECRET
   ```

Posting on X uses pay-per-use API credits — fund a small balance in the console
first.

Moving your instance to another hostname means registering these redirect URIs
again; see [Domains and URLs](domains.md).

Without these, those platforms are listed in the accounts dialog with a
**Needs setup** badge. Picking one shows that platform's own steps — the redirect
URI to register and the Worker secrets to set — instead of a connect attempt that
cannot succeed. Mastodon and Bluesky keep working either way.

## Platforms

| Platform  | Auth                                                                     | Text                                         | Images                                                    | Video                                        | Threads                      |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- | ---------------------------- |
| Mastodon  | OAuth (per instance)                                                     | instance max (default 500)                   | 4, 16MB                                                   | instance max (default 99MB)                  | yes                          |
| Bluesky   | handle + app password                                                    | 300                                          | 4, 2MB                                                    | up to 10 min, 300MB                          | yes                          |
| LinkedIn  | OAuth (`openid profile email w_member_social`)                           | 3000                                         | 4, 8MB (no WebP)                                          | 3 s to 30 min, 500MB                         | no — flattened into one post |
| Threads   | OAuth (`threads_basic threads_content_publish` `threads_manage_replies`) | 500, max 5 links                             | 4 uploadable, 10 allowed, 8MB JPEG/PNG                    | up to 5 min, 1GB                             | yes                          |
| Instagram | OAuth (`instagram_business_basic instagram_business_content_publish`)    | 2200, max 30 hashtags                        | required: 1 to 10, 8MB JPEG (PNG and WebP sent as a copy) | a Reel on its own: 3 s to 15 min, 300MB      | no — flattened into one post |
| X         | OAuth 2.0 + PKCE                                                         | 280 (25,000 with a paid plan), max 1 cashtag | 4, 5MB (15MB GIF)                                         | 0.5 s to 2:20 (longer with X Premium), 512MB | yes                          |

LinkedIn rejects WebP at publish time — upload JPEG, PNG or GIF.

Instagram takes nothing but JPEG, and refuses a post with no photo or video. When you attach a PNG or WebP, the composer also stores a JPEG copy of it for Instagram; an image attached before 1.21, uploaded through the API without a copy, or too large for the copy to fit Instagram's 8 MB has to be attached again, or as a JPEG, before it can go there — unless the deployment has the [Images binding](configuration.md#faster-post-thumbnails), which makes the missing copy when the post is scheduled or published. GIFs cannot go to Instagram, and photos must be between 4:5 tall and 1.91:1 wide. Up to 10 photos go out as one carousel: Instagram allows 20, but more would not fit one run's calls on the Workers Free plan. A video goes out as a Reel, on its own. Posting is limited to 100 posts a day per account.

Threads and Instagram media are served to Meta through short-lived signed URLs (2h expiry,
never linked publicly). Meta's crawler intermittently fails to fetch a URL that
works moments later (subcode 2207052), so media containers retry with a freshly
signed URL and the failure stays retryable. A custom public media origin can be
configured with `MEDIA_PUBLIC_BASE_URL` (for example an R2 custom domain behind
Cloudflare's cache) to skip the Worker hop entirely; that path is a trade-off —
those URLs are not signed and never expire, protected only by the randomness in
the object key, so keep the origin unlisted and treat a leaked URL as permanent.
A Reel's cover always goes through the signed route, since a new cover replaces the old one in place. Remove the variable to go back to signed URLs.

Every platform takes one video per post, with no images beside it; on LinkedIn, which joins a thread into one post, that means one video for the whole thread. CogSend stores videos up to 300MB, whatever a platform allows. A Mastodon server reports its own video limits, which CogSend reads when you connect the account. Threads and Instagram fetch the video from the same signed URLs as images.
