import type { AppDb } from '#lib/server/db/client.js';
import type { AppEnv } from '#lib/server/env.js';
import type { SessionUser } from '#lib/server/auth.js';
import type { MediaStore } from '#lib/server/media.js';
import type { QueueLike } from '#lib/server/scheduler.js';
import type { SubrequestBudget } from '#lib/server/budget.js';

declare global {
	/** Injected by vite.config.ts from package.json — the running version. */
	const __APP_VERSION__: string;

	namespace App {
		interface Locals {
			db: AppDb;
			env: AppEnv;
			media: MediaStore;
			queue: QueueLike | null;
			user: SessionUser | null;
			// How locals.user was established: interactive cookie session vs
			// a bearer credential (API_TOKEN machine user or API key).
			authMethod: 'session' | 'bearer' | null;
			// More precise source for endpoints that must accept personal keys only.
			authCredential: 'session' | 'personal_api_key' | 'api_token' | null;
			// API-key scopes (null for sessions and the env API_TOKEN operator
			// key, which stay unrestricted). Null = no scope check.
			apiKeyScopes: string[] | null;
			// This request's subrequest count (D1, R2, queue, provider fetches).
			budget: SubrequestBudget;
			// The Worker's bindings as Cloudflare passes them; `env` above is the
			// validated configuration read from them.
			bindings: Env;
			// Keeps the Worker running for work that outlives the response.
			waitUntil: (promise: Promise<unknown>) => void;
		}
	}
}

export {};
