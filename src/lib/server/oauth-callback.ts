import { isRedirect, redirect } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { PlatformId } from '#lib/domain/platforms.js';
import { SESSION_COOKIE } from './auth';
import { encryptJson } from './crypto';
import { first, newId, parseJson, type AppDb } from './db/client';
import { connections, oauthPending } from './db/schema';
import type { AppEnv } from './env';
import { splitOAuthState, verifyOAuthState } from './oauth-state';

type PendingRow = typeof oauthPending.$inferSelect;

/**
 * Lets a callback's redirect send the browser to the instance's own origin.
 * The provider can call back on another host than APP_URL (an app registered
 * with the workers.dev address on an instance since pinned to a custom
 * domain), and SvelteKit refuses an absolute redirect off the request's
 * origin unless that origin is allowed by name.
 */
export const toAppOrigin = (appUrl: string) => ({ external: [appUrl] });

export interface CallbackExchange {
	/** Stored encrypted; decrypted by verify/publish, so the shape is the provider's. */
	credentials: Record<string, unknown>;
	displayName?: string | null;
	handle?: string | null;
	avatarUrl?: string | null;
	instanceUrl?: string | null;
	meta: Record<string, unknown>;
}

export interface OAuthCallbackOptions {
	platform: PlatformId;
	/**
	 * Marker the connect route stored in `oauth_pending.instance_url`, used to
	 * tell this provider's pending rows apart. Mastodon stores the real
	 * instance URL there instead, so it passes none.
	 */
	pendingMarker?: string;
	/** Also match an existing row on its instance URL (one row per instance). */
	matchInstanceUrl?: boolean;
	/**
	 * The `meta` key holding the platform's own account id. Reconnecting
	 * matches on it first, so an account whose handle changed revives its row
	 * (and history) instead of gaining a duplicate. Rows stored before the id
	 * was kept still match on the handle.
	 */
	accountIdKey?: string;
	/**
	 * The meta stored on a reconnect, given what the exchange returned and what
	 * the row held. Without it the exchange's meta replaces the old one, which
	 * would drop a setting the operator chose on the Accounts page.
	 */
	reconcileMeta?(
		incoming: Record<string, unknown>,
		existing: Record<string, unknown>
	): Record<string, unknown>;
	complete(input: {
		pending: PendingRow;
		code: string;
		db: AppDb;
		env: AppEnv;
	}): Promise<CallbackExchange>;
}

/**
 * The stored row for this account: by the platform's account id when both
 * sides have one, otherwise by handle, as it always matched.
 */
export function findExistingConnection<
	T extends { handle: string | null; metaJson: string | null }
>(candidates: T[], handle: string, accountId: unknown, accountIdKey: string | undefined) {
	if (accountIdKey && typeof accountId === 'string' && accountId) {
		const byId = candidates.find(
			(c) => parseJson<Record<string, unknown>>(c.metaJson, {})[accountIdKey] === accountId
		);
		if (byId) return byId;
	}
	return candidates.find((c) => (c.handle ?? '') === handle);
}

/**
 * Every connect flow shares everything but the token exchange and the
 * credential payload: parameter handling and error redirects, CSRF state
 * verification against the pending row, the upsert that keeps one connection
 * per account, and the pending-row cleanup. Keeping that in one place means a
 * fix to the state check cannot land in only some of the routes.
 */
export function createOAuthCallback(opts: OAuthCallbackOptions): RequestHandler {
	return async ({ url, locals, cookies }) => {
		const appUrl = locals.env.APP_URL.replace(/\/$/, '');
		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');
		const error = url.searchParams.get('error');
		if (error)
			redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(error)}`, toAppOrigin(appUrl));
		if (!code || !state)
			redirect(302, `${appUrl}/accounts?error=missing_code`, toAppOrigin(appUrl));

		const candidate = splitOAuthState(state);
		const pending = candidate
			? await first(locals.db.select().from(oauthPending).where(eq(oauthPending.id, candidate)))
			: null;
		const sessionId = cookies.get(SESSION_COOKIE) ?? (pending ? `machine:${pending.userId}` : null);
		const pendingId = await verifyOAuthState({
			secret: locals.env.AUTH_SECRET,
			state,
			sessionId
		});
		const wrongProvider =
			opts.pendingMarker !== undefined && pending?.instanceUrl !== opts.pendingMarker;
		if (
			!pending ||
			!pendingId ||
			pending.id !== pendingId ||
			pending.expiresAt < new Date() ||
			wrongProvider
		) {
			if (pending) await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
			redirect(302, `${appUrl}/accounts?error=oauth_expired`, toAppOrigin(appUrl));
		}

		try {
			const exchanged = await opts.complete({ pending, code, db: locals.db, env: locals.env });
			const encrypted = await encryptJson(exchanged.credentials, locals.env.APP_ENCRYPTION_KEY);
			const now = new Date();
			const data = {
				displayName: exchanged.displayName || exchanged.handle || null,
				handle: exchanged.handle || null,
				avatarUrl: exchanged.avatarUrl || null,
				...(exchanged.instanceUrl !== undefined ? { instanceUrl: exchanged.instanceUrl } : {}),
				credentialsEncrypted: encrypted,
				metaJson: JSON.stringify(exchanged.meta),
				status: 'active' as const,
				updatedAt: now
			};
			const candidates = await locals.db
				.select()
				.from(connections)
				.where(
					and(
						eq(connections.userId, pending.userId),
						eq(connections.platform, opts.platform),
						...(opts.matchInstanceUrl
							? [eq(connections.instanceUrl, exchanged.instanceUrl || '')]
							: [])
					)
				);
			const existing = findExistingConnection(
				candidates,
				exchanged.handle || '',
				opts.accountIdKey ? exchanged.meta[opts.accountIdKey] : undefined,
				opts.accountIdKey
			);
			if (existing) {
				const meta = opts.reconcileMeta
					? opts.reconcileMeta(exchanged.meta, parseJson(existing.metaJson, {}))
					: exchanged.meta;
				await locals.db
					.update(connections)
					.set({ ...data, metaJson: JSON.stringify(meta) })
					.where(eq(connections.id, existing.id));
			} else {
				await locals.db.insert(connections).values({
					id: newId(),
					userId: pending.userId,
					platform: opts.platform,
					...data,
					createdAt: now
				});
			}
			await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
			redirect(302, `${appUrl}/accounts?connected=${opts.platform}`, toAppOrigin(appUrl));
		} catch (e) {
			if (isRedirect(e)) throw e;
			const message = e instanceof Error ? e.message : 'oauth_failed';
			redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(message)}`, toAppOrigin(appUrl));
		}
	};
}
