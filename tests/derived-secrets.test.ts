import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { hmacHex } from '#lib/server/crypto.js';
import {
	AUTH_SECRET_LABEL,
	SCHEDULER_SECRET_LABEL,
	deriveSecrets
} from '#lib/server/derived-secrets.js';

/**
 * AUTH_SECRET and SCHEDULER_SECRET are derived from APP_ENCRYPTION_KEY, so a
 * deployment only has to bring one real secret. These tests pin the contract:
 * changing a label, the hash, or the encoding silently signs every session out
 * (or breaks the cron trigger), so each of those has to fail here first.
 */
const MASTER = 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';

describe('deriveSecrets', () => {
	it('matches the pinned vectors (label + algorithm + encoding)', async () => {
		const secrets = await deriveSecrets(MASTER);
		expect(secrets.authSecret).toBe(
			'dba6749a87be4ffe4e6d4f255e4148237f7fcffb852a016a9cca9d4cb8b620eb'
		);
		expect(secrets.schedulerSecret).toBe(
			'98c8335d4c5ffd148d442df20e4ff481364d70103f8306a1b1d8bd5d936b2ff0'
		);
	});

	it('is deterministic, and differs per master key and per label', async () => {
		const again = await deriveSecrets(MASTER);
		const other = await deriveSecrets(`${MASTER}a`);
		expect(other.authSecret).not.toBe(again.authSecret);
		expect(again.authSecret).not.toBe(again.schedulerSecret);
	});

	it('clears the schema minimums with room to spare', async () => {
		const { authSecret, schedulerSecret } = await deriveSecrets(MASTER);
		// AUTH_SECRET: min 16, SCHEDULER_SECRET: min 32.
		expect(authSecret).toMatch(/^[0-9a-f]{64}$/);
		expect(schedulerSecret).toMatch(/^[0-9a-f]{64}$/);
	});
});

/**
 * scripts/wrap-worker.mjs derives the scheduler secret itself: the scheduled
 * handler runs outside the app's modules, so it cannot import this file. The two
 * implementations have to agree byte for byte, or the tick 401s silently.
 */
describe('wrap-worker scheduler derivation', () => {
	const source = readFileSync('scripts/wrap-worker.mjs', 'utf8');

	it('uses the app\u2019s label and no other', () => {
		expect(source).toContain(`'${SCHEDULER_SECRET_LABEL}'`);
		expect(source).not.toContain(`'${AUTH_SECRET_LABEL}'`);
	});

	it('computes the same value as the app, with the same precedence', async () => {
		const fnSource = source.match(/async function cogsendSchedulerSecret[\s\S]*?\n}/)?.[0];
		expect(fnSource, 'cogsendSchedulerSecret not found in wrap-worker.mjs').toBeTruthy();
		// The generated handler runs in Workers, where TextEncoder and crypto.subtle
		// are globals; hand it the same surface.
		const schedulerSecret = runInNewContext(`(${fnSource})`, { crypto, TextEncoder }) as (
			env: Record<string, string>
		) => Promise<string | null>;

		const expected = (await deriveSecrets(MASTER)).schedulerSecret;
		expect(await schedulerSecret({ APP_ENCRYPTION_KEY: MASTER })).toBe(expected);
		expect(await hmacHex(MASTER, SCHEDULER_SECRET_LABEL)).toBe(expected);

		// An explicit secret or API token wins, and nothing configured is null.
		expect(
			await schedulerSecret({ APP_ENCRYPTION_KEY: MASTER, SCHEDULER_SECRET: 'explicit' })
		).toBe('explicit');
		expect(await schedulerSecret({ APP_ENCRYPTION_KEY: MASTER, API_TOKEN: 'token' })).toBe('token');
		expect(await schedulerSecret({})).toBeNull();
	});

	it('reports a tick that was rejected instead of swallowing it', () => {
		// The scheduled handler is the one place a self-hoster cannot debug from
		// the app: the only visible symptom of a rejected internal call is
		// "no tick yet" in Settings. The handler has to say why, in a form
		// `wrangler tail` shows.
		const handler = source.match(/scheduled\(controller, env, ctx\)[\s\S]*?\n\t\},/)?.[0];
		expect(handler, 'scheduled handler not found in wrap-worker.mjs').toBeTruthy();
		expect(handler).toContain("console.error('[scheduler] tick rejected with HTTP '");
		expect(handler).toContain("console.error('[scheduler] tick failed:'");
	});
});
