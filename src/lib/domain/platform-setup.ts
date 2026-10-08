import { platformName } from '$lib/domain/platforms';

/**
 * The three platforms whose client credentials belong to whoever runs the
 * deployment: LinkedIn issues them to an app owner, Meta to a Threads app, X to
 * a developer project. Only that person can create them, so a deployment
 * without them cannot connect the account at all.
 *
 * Mastodon is absent on purpose — it registers its app on the instance itself —
 * and Bluesky takes an app password, so both are self-serve.
 */
export type OAuthPlatformId = 'linkedin' | 'threads' | 'x';

export type PlatformSetup = {
	/** Worker secrets the connect route requires: it answers "not enabled"
	 * while any of them is missing. */
	secrets: readonly string[];
	/** Secrets the route reads only when present, with a working fallback. */
	optionalSecrets?: readonly string[];
	/** Callback path to register with the provider; the origin is the deployment's. */
	callbackPath: string;
	/** Where the app is created, linked from the dialog so nobody has to guess
	 * which of a provider's several consoles is the right one. */
	consoleUrl: string;
	/** That console's name, for the link's label. */
	consoleName: string;
	/** What the console insists on before it issues credentials: a product, a
	 * use case, an app type. The step people skip, and then wonder why the
	 * client id is missing. */
	consoleRequirement: string;
	/** The console field that takes the redirect URI, named the way the page
	 * names it — providers word this differently and the URI is compared
	 * character by character. */
	redirectField: string;
	/** This platform's section of the setup guide in docs/oauth-apps.md. */
	docsAnchor: string;
	/** What the provider charges or requires beyond setup. */
	note?: string;
};

export const PLATFORM_SETUP: Record<OAuthPlatformId, PlatformSetup> = {
	linkedin: {
		secrets: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
		callbackPath: '/api/connections/linkedin/callback',
		consoleUrl: 'https://www.linkedin.com/developers/apps',
		consoleName: 'LinkedIn Developer Portal',
		consoleRequirement:
			'Create the app, then add the Share on LinkedIn and Sign In with LinkedIn using OpenID Connect products: the first allows posting, the second returns the profile the account list shows.',
		redirectField: 'the Auth tab → Authorized redirect URLs for your app',
		docsAnchor: 'linkedin'
	},
	threads: {
		secrets: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
		callbackPath: '/api/connections/threads/callback',
		consoleUrl: 'https://developers.facebook.com/apps/',
		consoleName: 'Meta for Developers',
		consoleRequirement:
			'Create the app with the Access the Threads API use case, and while it is still in development add the account you connect as a Threads tester and accept the invite.',
		redirectField: 'the Threads use case → Redirect Callback URLs',
		docsAnchor: 'threads'
	},
	x: {
		// PKCE alone completes the exchange, so the secret is read (as HTTP
		// Basic auth) only for a confidential "Web App" client.
		secrets: ['X_CLIENT_ID'],
		optionalSecrets: ['X_CLIENT_SECRET'],
		callbackPath: '/api/connections/x/callback',
		consoleUrl: 'https://developer.x.com/en/portal/dashboard',
		consoleName: 'X Developer Portal',
		consoleRequirement:
			'Create a Project and an App, then set up User authentication with OAuth 2.0 and the app type Web App.',
		redirectField: 'User authentication settings → Callback URI / Redirect URL',
		docsAnchor: 'x',
		note: 'Posting uses pay-per-use API credits. X_CLIENT_SECRET is only needed for a confidential Web App client.'
	}
};

export type PlatformConfigured = Record<OAuthPlatformId, boolean>;

const SETUP_GUIDE_BASE = 'https://github.com/cogsend/cogsend/blob/main/docs/oauth-apps.md';

/** Setup guide for the three platforms above, in the repository's docs. */
export const SETUP_GUIDE_URL = `${SETUP_GUIDE_BASE}#oauth-app-setup`;

/** That platform's own section of the guide: what the dialog links to, so a
 *  reader lands on its steps instead of the whole page. */
export function setupGuideUrl(id: OAuthPlatformId): string {
	return `${SETUP_GUIDE_BASE}#${PLATFORM_SETUP[id].docsAnchor}`;
}

export function isOAuthPlatform(id: string): id is OAuthPlatformId {
	return Object.hasOwn(PLATFORM_SETUP, id);
}

export function setupFor(id: string): PlatformSetup | null {
	return isOAuthPlatform(id) ? PLATFORM_SETUP[id] : null;
}

/**
 * True when the platform exists but this deployment cannot connect it yet.
 * `configured` reports presence, not validity: a wrong id still counts as
 * configured, and the provider rejects it during the connect attempt.
 */
export function needsSetup(id: string, configured: PlatformConfigured): boolean {
	return isOAuthPlatform(id) && !configured[id];
}

/** Every secret name the platform reads: the required ones, plus the optional
 *  ones the dialog still offers. */
export function platformSecretNames(id: OAuthPlatformId): readonly string[] {
	const { secrets, optionalSecrets = [] } = PLATFORM_SETUP[id];
	return [...secrets, ...optionalSecrets];
}

/** Every secret name any platform reads. The accounts API reports presence for
 *  these; a test keeps the list it sends in step with this one. */
export const PLATFORM_SECRET_NAMES: readonly string[] = (
	Object.keys(PLATFORM_SETUP) as OAuthPlatformId[]
).flatMap((id) => platformSecretNames(id));

/**
 * What this deployment is missing for the platform, in the order the platform
 * lists it. A fresh deployment gets the whole set; a half-configured one gets
 * only the missing half, which is the case that used to read "no credentials"
 * while one credential was already uploaded.
 */
export function missingSecrets(
	id: OAuthPlatformId,
	present: Record<string, boolean>
): readonly string[] {
	return platformSecretNames(id).filter((name) => !present[name]);
}

/** The required secrets all present. Derived from the same presence map the
 *  dialog reads, so a "Needs setup" chip and the missing-secret list cannot
 *  disagree about a platform. */
export function platformConfigured(id: OAuthPlatformId, present: Record<string, boolean>): boolean {
	return PLATFORM_SETUP[id].secrets.every((name) => present[name] === true);
}

/** The command for exactly these secret names, in the order given. */
export function secretsPutCommandFor(names: readonly string[]): string {
	return `npm run secrets:put ${names.join(' ')}`;
}

/** The whole set for a platform: what the docs and tests quote. */
export function secretsPutCommand(id: OAuthPlatformId): string {
	return secretsPutCommandFor(platformSecretNames(id));
}

/** Must equal what the connect route sends the provider, so it takes the
 * deployment's APP_URL rather than the browser's current origin. */
export function callbackUri(id: OAuthPlatformId, appUrl: string): string {
	return `${appUrl.replace(/\/+$/, '')}${PLATFORM_SETUP[id].callbackPath}`;
}

/**
 * Self-serve platforms first, then the ones that may need server setup — the
 * order the accounts empty state lists them in.
 */
const CONNECT_ORDER = ['bluesky', 'mastodon', 'linkedin', 'threads', 'x'] as const;

/** "Bluesky", "Bluesky or Mastodon", "Bluesky, Mastodon, or LinkedIn". */
export function joinPlatformNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

export function connectableNames(configured: PlatformConfigured): string[] {
	return CONNECT_ORDER.filter((id) => !needsSetup(id, configured)).map((id) => platformName(id));
}

/** Promises only what the visitor can actually do from here. */
export function emptyStateSentence(configured: PlatformConfigured): string {
	const names = connectableNames(configured);
	if (!names.length) return 'No accounts yet.';
	return `No accounts yet. Connect ${joinPlatformNames(names)} to start posting.`;
}
