import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { serializeConnection } from '#lib/server/serialize.js';
import { listAccounts } from '#lib/server/zernio.js';
import {
	resolveZernioKey,
	toImportable,
	upsertZernioConnection,
	zernioKeyProblem
} from '#lib/server/zernio-import.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => ({}))) as {
			apiKey?: unknown;
			accountIds?: unknown;
		};
		const ids = Array.isArray(body.accountIds)
			? body.accountIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
			: [];
		if (!ids.length) return fail('Pick at least one account to import');
		const apiKey = await resolveZernioKey({
			db: locals.db,
			env: locals.env,
			userId: user.id,
			apiKey: body.apiKey
		});
		// Fetched again rather than trusted from the browser: the row stores
		// what Zernio says the account is.
		const accounts = await listAccounts({ apiKey });
		const byId = new Map(accounts.map((account) => [account._id, account]));
		const missing = ids.filter((id) => !byId.has(id));
		if (missing.length) return fail(`Zernio has no account ${missing.join(', ')} on this key`);
		const unsupported = ids.filter((id) => toImportable(byId.get(id)!, new Set()) === null);
		if (unsupported.length) {
			return fail(
				`CogSend cannot post to ${unsupported.map((id) => byId.get(id)!.platform).join(', ')}`
			);
		}
		const rows = [];
		for (const id of ids) {
			rows.push(
				await upsertZernioConnection({
					db: locals.db,
					env: locals.env,
					userId: user.id,
					apiKey,
					account: byId.get(id)!
				})
			);
		}
		return ok({ connections: rows.map(serializeConnection) });
	} catch (err) {
		return zernioKeyProblem(err) ?? handleError(err);
	}
};
