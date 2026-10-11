import { readFileSync, writeFileSync } from 'node:fs';

const dest = '.svelte-kit/cloudflare/_worker.js';
let src = readFileSync(dest, 'utf8');
if (src.includes('__COGSEND_HANDLERS__')) process.exit(0);

const handlers = `
/* __COGSEND_HANDLERS__ */
/**
 * Bearer for the internal tick/publish calls: an explicit secret, the API
 * token, or the value derived from APP_ENCRYPTION_KEY — the same derivation the
 * Worker itself uses (src/lib/server/derived-secrets.ts). The label below is
 * part of that contract and a unit test pins it to the app's constant.
 */
async function cogsendSchedulerSecret(env) {
	if (env.SCHEDULER_SECRET) return env.SCHEDULER_SECRET;
	if (env.API_TOKEN) return env.API_TOKEN;
	if (!env.APP_ENCRYPTION_KEY) return null;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(env.APP_ENCRYPTION_KEY),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode('subkey:scheduler-secret:v1')
	);
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function cogsendInternal(worker, env, ctx, path, body) {
	const secret = await cogsendSchedulerSecret(env);
	if (!secret) return null;
	const req = new Request('https://cogsend.internal' + path, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer ' + secret,
			'Content-Type': 'application/json'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	return worker.fetch(req, env, ctx);
}

export default {
	fetch: (...args) => worker_default.fetch(...args),
	scheduled(controller, env, ctx) {
		// The internal call authenticates as a pinger would; with nothing to
		// authenticate with it is a no-op rather than a 401 every minute.
		if (!env.SCHEDULER_SECRET && !env.API_TOKEN && !env.APP_ENCRYPTION_KEY) return;
		// A failed tick used to be swallowed whole, and the only symptom was
		// Settings saying "no tick yet" — with no way to tell a 401 from a 500
		// from a platform that never dispatched the trigger at all. These two
		// lines are what wrangler tail can show.
		ctx.waitUntil(
			cogsendInternal(worker_default, env, ctx, '/api/internal/tick').then(
				(res) => {
					if (!res || !res.ok) {
						console.error('[scheduler] tick rejected with HTTP ' + (res ? res.status : 'none'));
					}
				},
				(err) => console.error('[scheduler] tick failed:', (err && err.message) || err)
			)
		);
	},
	async queue(batch, env, ctx) {
		for (const msg of batch.messages) {
			const res = await cogsendInternal(worker_default, env, ctx, '/api/internal/publish', msg.body);
			// Only infrastructure failures land here (a platform failure is
			// rescheduled by the app and answers 200). Give the cause a moment
			// to clear instead of redelivering at once.
			if (!res || !res.ok) msg.retry({ delaySeconds: 30 });
			else msg.ack();
		}
	}
};
`;

// adapter-cloudflare writes its entry as one `export default { fetch }` object.
// It becomes `worker_default`, which the handlers above wrap; anything else
// means the adapter changed shape, and a Worker without its cron trigger must
// not ship.
const entry = /^export default \{$/gm;
if ((src.match(entry) ?? []).length !== 1) {
	console.error('wrap-worker: could not find default export to wrap');
	process.exit(1);
}
writeFileSync(dest, src.replace(entry, 'const worker_default = {') + handlers);
console.log('wrap-worker: attached scheduled + queue handlers');
