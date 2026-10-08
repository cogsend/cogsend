import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		await locals.db.run(sql`SELECT 1`);
		// The version is public on purpose: `npm run doctor` compares what is
		// actually deployed with the latest release, and it is already shown in
		// Settings.
		//
		// `account` tells doctor "deployed and ready" apart from "deployed, but
		// nobody has created the account yet", which is otherwise invisible from
		// outside. It discloses nothing a visitor cannot see on the login page:
		// the sign-in form, or the form that claims the instance. Whether 2FA
		// is set up is deliberately absent: it would point a scanner at a fresh
		// instance whose authenticator anyone holding the password could enroll.
		// Doctor reads it from D1 instead.
		const account = await first(locals.db.select({ id: users.id }).from(users).limit(1));
		return json({
			ok: true,
			service: 'cogsend',
			version: __APP_VERSION__,
			time: new Date().toISOString(),
			account: { created: Boolean(account) }
		});
	} catch (err) {
		// Never leak driver internals on a public endpoint.
		console.error('[health] db probe failed', err);
		return json({ ok: false, error: 'unavailable' }, { status: 503 });
	}
};
