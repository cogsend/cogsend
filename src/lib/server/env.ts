import { z } from 'zod';
import { isLocalAppUrl, resolveAppUrl, type AppUrlSource } from '#lib/domain/app-url.js';
import { deriveSecrets } from './derived-secrets';

const envSchema = z.object({
	// Optional, and deliberately with no default: the URL does not exist until
	// the Worker does, so a deploy cannot set it. envFromPlatform resolves it
	// per request from the request's own origin when this is unset (or still the
	// localhost value .dev.vars.example ships). Set it to pin a custom domain or
	// a deliberate public origin. See #lib/domain/app-url.
	APP_URL: z.string().optional(),
	// Instance display name: the UI title, header and login screen. Self-hosters
	// can rename their instance from config without touching code.
	APP_NAME: z.string().min(1).default('CogSend'),
	// 32+ chars (≈256-bit when random). TEST/dev use 64-hex; weak keys make the
	// DB-stored OAuth/TOTP ciphertexts trivially brute-forceable on DB leak.
	APP_ENCRYPTION_KEY: z.string().min(32),
	// Derived from APP_ENCRYPTION_KEY when unset (see derived-secrets.ts): set it
	// only to pin an independent value.
	AUTH_SECRET: z.string().min(16).optional(),
	// Derived from APP_ENCRYPTION_KEY when unset. Set it when something outside
	// the Worker has to hold it, such as an external tick pinger.
	SCHEDULER_SECRET: z.string().min(32).optional(),
	API_TOKEN: z.string().min(16).optional(),
	// Local-dev convenience: skip the 2FA enrollment/verify dance. Honored only
	// when the resolved URL is localhost (see readAppEnv) so it can never leak
	// to prod — a localhost APP_URL on a real host resolves to that host.
	SKIP_TOTP: z.string().optional(),
	// In-progress feature: the LinkedIn video upload path is wired but not yet
	// verified against the live API, so it stays off unless an instance opts in.
	ENABLE_VIDEO_UPLOAD: z.string().optional(),
	LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
	LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
	THREADS_APP_ID: z.string().min(1).optional(),
	THREADS_APP_SECRET: z.string().min(1).optional(),
	X_CLIENT_ID: z.string().min(1).optional(),
	X_CLIENT_SECRET: z.string().min(1).optional(),
	// Failure-digest email (Resend). All optional: when unset, the digest is
	// a no-op and failures only surface on the dashboard/posts tabs.
	RESEND_API_KEY: z.string().min(1).optional(),
	NOTIFY_EMAIL: z.string().min(3).optional(),
	NOTIFY_FROM: z.string().min(3).optional(),
	// Optional public media origin (for example an R2 custom domain with
	// Cloudflare cache). When set, Threads is handed direct URLs here instead
	// of the signed Worker route, which removes the Worker/R2 hop from Meta's
	// crawler fetch. Deliberately not schema-validated: a bad value degrades
	// to the signed route (publicMediaUrlFor) instead of 500ing every
	// request over an optional optimization.
	MEDIA_PUBLIC_BASE_URL: z.string().optional()
});

export type AppEnv = z.infer<typeof envSchema> & {
	/** An empty string means "no origin known yet"; only a scheduled or queue
	 *  invocation can still be in that state (see resolveAppUrl). */
	APP_URL: string;
	/** Where APP_URL came from: set, derived from the request, or remembered
	 *  from an earlier authenticated visit. */
	appUrlSource: AppUrlSource;
	/** Derived from APP_ENCRYPTION_KEY when not configured, so always present
	 *  by the time anything signs a session. */
	AUTH_SECRET: string;
	skipTotp: boolean;
	/** In-progress LinkedIn video uploads; off unless explicitly enabled. */
	videoUploadEnabled: boolean;
};

/** Example values that must never reach a real deployment. Exported so
 *  scripts/setup.mjs can be checked against it. */
export const PLACEHOLDER_SECRETS = new Set([
	'change-me',
	// Current .dev.vars.example values.
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	// Earlier example values: still listed so a stale .dev.vars, or a deploy
	// that copied one, keeps being rejected after the rename.
	'dev-auth-secret-change-me',
	'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
]);

export function readAppEnv(
	source: Record<string, string | undefined>,
	appUrlSource: AppUrlSource = 'configured'
): AppEnv {
	const parsed = envSchema.safeParse(source);
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new Error(`Invalid environment: ${msg}`);
	}
	// Fail closed anywhere that is not a local instance: example values from
	// .dev.vars.example must never reach a public deployment, where a
	// publicly-known encryption key would mean total credential decryption.
	// APP_URL — not a build flag — decides what counts as local, because
	// `wrangler dev` serves a production build on a developer's machine; an
	// unset or unparseable value is not local either, which is what keeps
	// "deploy, then open it" safe.
	const localInstance = isLocalAppUrl(parsed.data.APP_URL);
	if (!localInstance) {
		for (const key of ['APP_ENCRYPTION_KEY', 'AUTH_SECRET'] as const) {
			if (PLACEHOLDER_SECRETS.has(source[key] ?? '')) {
				throw new Error(`Invalid environment: ${key} must not be an example value`);
			}
		}
	}
	// SKIP_TOTP is a local-dev convenience: without this guard a stray secret
	// (or a pasted .dev.vars into prod) would silently disable 2FA. Honored for
	// a local instance only.
	const skipTotp =
		Boolean(source.SKIP_TOTP) &&
		!['0', 'false', 'no', 'off'].includes((source.SKIP_TOTP ?? '').toLowerCase()) &&
		localInstance;
	// Same truthiness rule as SKIP_TOTP: any value except an explicit "off".
	// Deliberately not gated on a local instance — an operator may want to test
	// the path on a real deployment.
	const videoUploadEnabled =
		Boolean(source.ENABLE_VIDEO_UPLOAD) &&
		!['0', 'false', 'no', 'off'].includes((source.ENABLE_VIDEO_UPLOAD ?? '').toLowerCase());
	return {
		...parsed.data,
		APP_URL: parsed.data.APP_URL ?? '',
		AUTH_SECRET: parsed.data.AUTH_SECRET ?? '',
		appUrlSource,
		skipTotp,
		videoUploadEnabled
	};
}

function procEnv(): Record<string, string | undefined> {
	try {
		return (
			(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
		);
	} catch {
		return {};
	}
}

export interface EnvResolutionOptions {
	/** The full URL of the request being handled, when there is one. */
	requestUrl?: string;
	/** The origin remembered from an earlier authenticated visit. */
	storedAppUrl?: string | null;
}

export async function envFromPlatform(
	platformEnv: Record<string, unknown> | undefined,
	options: EnvResolutionOptions = {}
): Promise<AppEnv> {
	const fallback = procEnv();
	const resolved = resolveAppUrl({
		configured: asString(platformEnv?.APP_URL) ?? fallback.APP_URL,
		requestUrl: options.requestUrl,
		stored: options.storedAppUrl
	});
	const src: Record<string, string | undefined> = {
		APP_URL: resolved.url,
		APP_NAME: asString(platformEnv?.APP_NAME) ?? fallback.APP_NAME,
		APP_ENCRYPTION_KEY: asString(platformEnv?.APP_ENCRYPTION_KEY) ?? fallback.APP_ENCRYPTION_KEY,
		AUTH_SECRET: asString(platformEnv?.AUTH_SECRET) ?? fallback.AUTH_SECRET,
		SCHEDULER_SECRET: asString(platformEnv?.SCHEDULER_SECRET) ?? fallback.SCHEDULER_SECRET,
		API_TOKEN: asString(platformEnv?.API_TOKEN) ?? fallback.API_TOKEN,
		LINKEDIN_CLIENT_ID: asString(platformEnv?.LINKEDIN_CLIENT_ID) ?? fallback.LINKEDIN_CLIENT_ID,
		LINKEDIN_CLIENT_SECRET:
			asString(platformEnv?.LINKEDIN_CLIENT_SECRET) ?? fallback.LINKEDIN_CLIENT_SECRET,
		THREADS_APP_ID: asString(platformEnv?.THREADS_APP_ID) ?? fallback.THREADS_APP_ID,
		THREADS_APP_SECRET: asString(platformEnv?.THREADS_APP_SECRET) ?? fallback.THREADS_APP_SECRET,
		X_CLIENT_ID: asString(platformEnv?.X_CLIENT_ID) ?? fallback.X_CLIENT_ID,
		X_CLIENT_SECRET: asString(platformEnv?.X_CLIENT_SECRET) ?? fallback.X_CLIENT_SECRET,
		RESEND_API_KEY: asString(platformEnv?.RESEND_API_KEY) ?? fallback.RESEND_API_KEY,
		NOTIFY_EMAIL: asString(platformEnv?.NOTIFY_EMAIL) ?? fallback.NOTIFY_EMAIL,
		NOTIFY_FROM: asString(platformEnv?.NOTIFY_FROM) ?? fallback.NOTIFY_FROM,
		MEDIA_PUBLIC_BASE_URL:
			asString(platformEnv?.MEDIA_PUBLIC_BASE_URL) ?? fallback.MEDIA_PUBLIC_BASE_URL,
		SKIP_TOTP: asString(platformEnv?.SKIP_TOTP) ?? fallback.SKIP_TOTP,
		ENABLE_VIDEO_UPLOAD: asString(platformEnv?.ENABLE_VIDEO_UPLOAD) ?? fallback.ENABLE_VIDEO_UPLOAD
	};
	// AUTH_SECRET and SCHEDULER_SECRET come from the master key unless they were
	// provided: that leaves APP_ENCRYPTION_KEY as the only secret a deployment
	// must bring. Placeholders are still refused below — readAppEnv looks at the
	// value the operator supplied, not at a derived one.
	if (!src.AUTH_SECRET || !src.SCHEDULER_SECRET) {
		const master = src.APP_ENCRYPTION_KEY;
		if (master) {
			const derived = await deriveSecrets(master);
			src.AUTH_SECRET ??= derived.authSecret;
			src.SCHEDULER_SECRET ??= derived.schedulerSecret;
		}
	}
	return readAppEnv(src, resolved.source);
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}
