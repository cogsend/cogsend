import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import {
	anySecretMatches,
	extractBearerToken,
	hasAllowedMutationOrigin,
	isInternalApiPath,
	secretMatches
} from '$lib/domain/bearer';
import { isApiKeyFormat, touchApiKey, verifyApiKey } from '$lib/server/api-keys';
import {
	SESSION_COOKIE,
	asMachineUser,
	cookieSecureFlag,
	getAdminUser,
	getSessionUser,
	isFullyVerified,
	needsTotpEnroll
} from '$lib/server/auth';
import { createD1Db, first } from '$lib/server/db/client';
import { ensureSchemaOnce } from '$lib/server/db/init-sql';
import { users } from '$lib/server/db/schema';
import { envFromPlatform } from '$lib/server/env';
import type { AppEnv } from '$lib/server/env';
import { memoryMediaStore, r2MediaStore } from '$lib/server/media';
import {
	countingD1,
	countingMediaStore,
	parseSubrequestLimit,
	SubrequestBudget
} from '$lib/server/budget';
import { runSchedulerTick } from '$lib/server/scheduler';
import { securityHeadersFor } from '$lib/server/security-headers';
import { isPinnedAppUrl } from '$lib/domain/app-url';
import { readStoredAppUrl, rememberAppUrl } from '$lib/server/app-settings';
import { verifyTickToken } from '$lib/server/tick-token';
import { authorizeMcpRequest } from '$lib/server/mcp-auth';
import {
	isRateLimitedPath,
	rateLimitKey,
	rateLimitProblem,
	type RateLimiter
} from '$lib/server/rate-limit';

export function isPublicPath(path: string): boolean {
	if (path === '/login' || path === '/login/setup-2fa' || path === '/login/verify') return true;
	if (
		path === '/api/health' ||
		path.startsWith('/api/media/public/') ||
		path.startsWith('/api/connections/mastodon/callback') ||
		path.startsWith('/api/connections/linkedin/callback') ||
		path.startsWith('/api/connections/threads/callback') ||
		path.startsWith('/api/connections/x/callback') ||
		path.startsWith('/api/connections/zernio/callback')
	)
		return true;
	if (
		path === '/api/auth/login' ||
		path === '/api/auth/claim' ||
		path === '/api/auth/logout' ||
		path === '/api/auth/me'
	)
		return true;
	if (path.startsWith('/api/auth/totp/enroll') || path.startsWith('/api/auth/totp/verify'))
		return true;
	return false;
}

function withPageSecurity(path: string, response: Response, secure: boolean): Response {
	// No Access-Control-Allow-Origin, deliberately: the UI is same-origin, and API
	// consumers are non-browser scripts. A wildcard would let any page read a
	// response once a bearer token leaked into it.
	const next = response;
	for (const [name, value] of Object.entries(securityHeadersFor(path, secure))) {
		next.headers.set(name, value);
	}
	return next;
}

function deny(path: string, status: number, body: unknown, secure: boolean, location?: string) {
	if (location && !path.startsWith('/api/')) {
		return withPageSecurity(path, new Response(null, { status, headers: { location } }), secure);
	}
	return withPageSecurity(path, json(body, { status }), secure);
}

let lastLocalTickAt = 0;

// Module scope, so the missing-binding notice is not repeated per request.
let warnedMissingMedia = false;

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const secureRequest = event.url.protocol === 'https:';
	if (event.request.method === 'OPTIONS' && path.startsWith('/api/') && path !== '/api/mcp') {
		// Same-origin app: no CORS preflight needed. Bare 204 (no
		// Access-Control-* headers) so browsers default-deny cross-origin reads.
		return new Response(null, { status: 204 });
	}

	const platformEnv = event.platform?.env as Env | undefined;
	if (!platformEnv?.DB) {
		throw new Error('D1 binding DB is missing. Run via vite (adapter-cloudflare) or wrangler.');
	}

	// Every D1, R2 and queue call below is counted against this request's
	// subrequest limit; see $lib/server/budget.
	const budget = new SubrequestBudget(
		parseSubrequestLimit((platformEnv as unknown as Record<string, unknown>).SUBREQUEST_LIMIT)
	);
	event.locals.budget = budget;
	const d1 = countingD1(platformEnv.DB, budget);
	await ensureSchemaOnce(d1);
	const db = createD1Db(d1);
	event.locals.db = db;
	// A deployment only learns its URL once it exists, so APP_URL is normally
	// derived from the request itself (see $lib/domain/app-url) — and recorded
	// below for the invocations that have no request: the cron tick and queue
	// consumers. A pinned APP_URL skips the read entirely.
	const configuredAppUrl =
		typeof platformEnv.APP_URL === 'string' ? platformEnv.APP_URL : undefined;
	const storedAppUrl = isPinnedAppUrl(configuredAppUrl) ? undefined : await readStoredAppUrl(db);
	let appEnv: AppEnv;
	try {
		// SAFETY: Cloudflare supplies platform env as bindings; envFromPlatform reads only its named fields.
		appEnv = await envFromPlatform(platformEnv as unknown as Record<string, unknown>, {
			requestUrl: event.url.href,
			storedAppUrl
		});
	} catch (err) {
		// Fail closed, with something an operator can act on: without this the
		// deployment that kept .dev.vars.example's values gets a bare 500 on
		// every request. The example-value guard is what catches a public
		// deployment that never replaced them.
		const detail = err instanceof Error ? err.message : String(err);
		console.error(`[env] ${detail}`);
		const action =
			'Set real Worker secrets (`npm run secrets:put`, or the Cloudflare dashboard) and redeploy.';
		return withPageSecurity(
			path,
			path.startsWith('/api/')
				? new Response(JSON.stringify({ error: `${detail}. ${action}` }), {
						status: 503,
						headers: { 'content-type': 'application/json' }
					})
				: new Response(`This deployment is not configured: ${detail}. ${action}`, {
						status: 503,
						headers: { 'content-type': 'text/plain; charset=utf-8' }
					}),
			secureRequest
		);
	}
	event.locals.env = appEnv;
	// Fail closed in prod when the R2 binding is missing: persisting draft_media
	// rows against a per-request in-memory Map silently loses bytes on next
	// request. DEV keeps the memory fallback for local runs without R2.
	if (platformEnv.MEDIA) {
		event.locals.media = countingMediaStore(r2MediaStore(platformEnv.MEDIA), budget);
	} else if (import.meta.env.DEV) {
		// Once per isolate, not once per request: the notice is about the
		// missing binding, and a local run (or a test file) makes dozens of
		// requests that would each repeat it.
		if (!warnedMissingMedia) {
			warnedMissingMedia = true;
			console.warn('[media] R2 MEDIA binding missing; using ephemeral memory store (DEV only)');
		}
		event.locals.media = memoryMediaStore();
	} else {
		throw new Error('R2 binding MEDIA is missing. Configure an R2 bucket for media storage.');
	}
	const queue = platformEnv.PUBLISH_QUEUE;
	event.locals.queue = queue
		? {
				send: (body) => {
					budget.count();
					return queue.send(body);
				}
			}
		: null;

	event.locals.authMethod = null;
	event.locals.authCredential = null;
	event.locals.apiKeyScopes = null;
	const raw = event.cookies.get(SESSION_COOKIE);
	const bearer = extractBearerToken(event.request.headers);
	// The admin row is only needed to mint the machine user for the env
	// API_TOKEN and to save a lookup when a personal key belongs to the admin
	// (the API-key path below falls back to a lookup by id). A fully anonymous
	// request needs neither, and skipping it here keeps unauthenticated traffic
	// — health probes, bots probing /login — from doing D1 work on every hit.
	// A bearer caller needs the account row to act as; without one (before
	// `npm run setup` created it) there is nothing to act as.
	const hasCredential =
		bearer !== null || (event.request.headers.get('x-api-key')?.trim() ?? '') !== '';
	const admin = hasCredential ? await getAdminUser(db) : null;

	const session = await getSessionUser(db, appEnv, raw);
	event.locals.user = session?.user ?? null;
	if (session?.user) {
		event.locals.authMethod = 'session';
		event.locals.authCredential = 'session';
	}
	if (session?.slideMaxAge && raw) {
		event.cookies.set(SESSION_COOKIE, raw, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: cookieSecureFlag(appEnv, event.url.host),
			maxAge: session.slideMaxAge
		});
	}

	if (secretMatches(bearer, appEnv.API_TOKEN)) {
		// Without an account row a machine token has nothing to act as.
		const row = admin ?? (await getAdminUser(db));
		if (row) {
			event.locals.user = asMachineUser(row);
			event.locals.authMethod = 'bearer';
			event.locals.authCredential = 'api_token';
		}
	} else if (!event.locals.user || path === '/api/mcp') {
		// Personal API key: `Authorization: Bearer cog_…` or the `X-API-Key`
		// header (never query strings — they leak into logs). Ordinary routes
		// preserve session precedence; MCP resolves its bearer key independently.
		// Format-gated before any hashing or D1 query; only active hashes verify.
		const apiKeyHeader = event.request.headers.get('x-api-key')?.trim() || null;
		const candidate =
			path === '/api/mcp'
				? isApiKeyFormat(bearer)
					? bearer
					: null
				: apiKeyHeader && apiKeyHeader.length > 0
					? apiKeyHeader
					: isApiKeyFormat(bearer)
						? bearer
						: null;
		if (isApiKeyFormat(candidate)) {
			const verified = await verifyApiKey(db, candidate);
			const userRow =
				verified && admin && admin.id === verified.userId
					? admin
					: verified
						? await first(db.select().from(users).where(eq(users.id, verified.userId)))
						: null;
			if (verified && userRow) {
				event.locals.user = asMachineUser(userRow);
				event.locals.authMethod = 'bearer';
				event.locals.authCredential = 'personal_api_key';
				event.locals.apiKeyScopes = verified.scopes;
				const touch = touchApiKey(db, verified.keyId);
				try {
					event.platform?.ctx?.waitUntil(touch);
				} catch {
					// waitUntil unavailable (tests, preview): the touch still
					// runs; last_used_at is best-effort metadata either way.
				}
			}
		}
	}

	// Remember the origin the instance is actually served from, once the request
	// is authenticated — the scheduler has no request of its own to read it from,
	// and only a signed-in visitor proves the hostname is the real one.
	// Cookies only: a browser visit is the authority on the human-facing URL, and
	// it keeps API clients (which may use a different host) from rewriting it.
	if (appEnv.appUrlSource === 'request' && event.locals.authMethod === 'session') {
		try {
			event.platform?.ctx?.waitUntil(rememberAppUrl(db, appEnv.APP_URL));
		} catch {
			// No execution context (tests): the next request derives it again.
		}
	}

	if (import.meta.env.DEV) {
		const nowMs = Date.now();
		if (nowMs - lastLocalTickAt > 30_000) {
			lastLocalTickAt = nowMs;
			void runSchedulerTick(db, appEnv, {
				store: event.locals.media,
				queue: event.locals.queue
			}).catch((err) => console.error('[scheduler] local tick failed', err));
		}
	}

	// Rate limiting for the endpoints anybody can call. Checked before the
	// route runs, because the point is to keep a burst from reaching PBKDF2 at
	// all. The in-app lockout is still what stops a determined attacker.
	if (isRateLimitedPath(path)) {
		// SAFETY: AUTH_RATE_LIMITER is an optional Worker binding, read by the rate-limit adapter.
		const problem = await rateLimitProblem(
			(platformEnv as unknown as Record<string, unknown>).AUTH_RATE_LIMITER as
				RateLimiter | undefined,
			rateLimitKey(event.request.headers)
		);
		if (problem) return deny(path, 429, { error: problem }, secureRequest);
	}

	// CSRF: cookie-session mutations must come from this origin. Bearer/API-key
	// clients (curl, GH Actions) send no Origin/Referer and skip this check.
	if (
		event.locals.authMethod === 'session' &&
		path.startsWith('/api/') &&
		!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) &&
		!hasAllowedMutationOrigin(event.request, event.url)
	) {
		return deny(path, 403, { error: 'Origin mismatch' }, secureRequest);
	}

	// Scheduler bypass: SCHEDULER_SECRET (preferred) or API_TOKEN. AUTH_SECRET
	// signs sessions/challenges and must never be accepted on the wire here.
	//
	// The tick also accepts the token minted in Settings, which exists so an
	// external cron needs no env secret at all. It is deliberately narrower
	// than the env secrets: only /api/internal/tick, never /api/internal/publish.
	if (isInternalApiPath(path)) {
		const tickPath = path === '/api/internal/tick' || path === '/api/internal/tick/';
		const authorized =
			anySecretMatches(bearer, [appEnv.SCHEDULER_SECRET, appEnv.API_TOKEN]) ||
			(tickPath && (await verifyTickToken(db, bearer)));
		if (authorized) return withPageSecurity(path, await resolve(event), secureRequest);
	}

	if (path === '/api/mcp') {
		const authorization = await authorizeMcpRequest(event.request, event.url, db, {
			authMethod: event.locals.authMethod,
			authCredential: event.locals.authCredential,
			user: event.locals.user
		});
		if (!authorization.ok) {
			const headers = new Headers({ 'content-type': 'application/json' });
			if (authorization.status === 401) headers.set('WWW-Authenticate', 'Bearer');
			return withPageSecurity(
				path,
				new Response(
					JSON.stringify({
						error: authorization.status === 401 ? 'Unauthorized' : 'Origin mismatch'
					}),
					{ status: authorization.status, headers }
				),
				secureRequest
			);
		}
	}

	// Dev convenience: SKIP_TOTP (honored for localhost APP_URLs only) treats
	// 2FA as satisfied so local runs skip the enroll/verify dance entirely.
	if (appEnv.skipTotp && event.locals.user) {
		event.locals.user = { ...event.locals.user, totpEnabled: true, mfaVerified: true };
	}

	if (event.locals.user?.totpEnabled && !event.locals.user.mfaVerified) {
		event.locals.user = null;
	}

	const user = event.locals.user;
	if (needsTotpEnroll(user)) {
		const allowed =
			path === '/login/setup-2fa' ||
			path === '/login' ||
			path.startsWith('/api/auth/totp/enroll') ||
			path === '/api/auth/logout' ||
			path === '/api/auth/me';
		if (!allowed) {
			if (path.startsWith('/api/'))
				return deny(path, 401, { error: 'Unauthorized' }, secureRequest);
			return deny(path, 303, { error: 'Unauthorized' }, secureRequest, '/login/setup-2fa');
		}
		return withPageSecurity(path, await resolve(event), secureRequest);
	}

	if (!isFullyVerified(user) && !isPublicPath(path)) {
		if (path.startsWith('/api/')) return deny(path, 401, { error: 'Unauthorized' }, secureRequest);
		return deny(path, 303, { error: 'Unauthorized' }, secureRequest, '/login');
	}

	return withPageSecurity(path, await resolve(event), secureRequest);
};
