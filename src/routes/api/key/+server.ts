import type { RequestHandler } from './$types';
import { parseApiScopes } from '#lib/domain/api-scopes.js';
import { getActiveApiKey, revokeApiKeys, rotateApiKey } from '#lib/server/api-keys.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';

function metadataOf(
	active: {
		prefix: string;
		createdAt: Date;
		lastUsedAt: Date | null;
		scopes?: string | string[] | null;
	} | null
) {
	if (!active) return null;
	return {
		prefix: active.prefix,
		createdAt: active.createdAt,
		lastUsedAt: active.lastUsedAt,
		scopes: parseApiScopes(
			Array.isArray(active.scopes) ? JSON.stringify(active.scopes) : active.scopes
		)
	};
}

// Session-only key management: a leaked API key authenticates as the user but
// must never mint its own replacement or lock the owner out, so these
// endpoints reject bearer auth outright (see requireSession).
export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const active = await getActiveApiKey(locals.db, user.id);
		return ok({ active: metadataOf(active) });
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		// No body means "the default key" (all scopes), which is what the browser
		// sends when it does not pick a scope. A body that *is* there has to
		// parse: `normalizeApiScopes` reads a missing list as all scopes, so a
		// truncated request meant to mint a read-only key used to return 201 with
		// a write key.
		const text = (await request?.text().catch(() => '')) ?? '';
		let body: unknown = {};
		if (text.trim()) {
			try {
				body = JSON.parse(text);
			} catch {
				return fail('Invalid JSON body', 400);
			}
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return fail('Invalid JSON body', 400);
		}
		if ('scopes' in body && !Array.isArray((body as { scopes?: unknown }).scopes)) {
			return fail('scopes must be an array', 400);
		}
		const requestedScopes = (body as { scopes?: unknown }).scopes;
		const { raw, prefix, createdAt, scopes } = await rotateApiKey(
			locals.db,
			user.id,
			requestedScopes
		);
		// The raw key is returned exactly once; only its hash is stored.
		return ok({ key: raw, prefix, createdAt, scopes, rotated: true }, 201);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const revoked = await revokeApiKeys(locals.db, user.id);
		if (revoked === 0) return fail('No active API key', 404);
		return ok({ ok: true, revoked });
	} catch (err) {
		return handleError(err);
	}
};
