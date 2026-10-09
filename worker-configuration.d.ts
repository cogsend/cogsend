/**
 * Hand-maintained declarations for the bindings and variables this app reads.
 *
 * Deliberately not generated: `wrangler types` produces a much larger file that
 * does not know about the Worker *secrets* (APP_ENCRYPTION_KEY, AUTH_SECRET,
 * the OAuth client secrets, ...) — it only sees what `wrangler.jsonc` declares,
 * so its output would be less accurate than this. It also refuses to overwrite
 * this file unless you rename it first.
 *
 * When you add a binding or a variable, declare it here too.
 */
interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<unknown>;
}

interface D1Database {
	prepare(query: string): D1PreparedStatement;
	exec(query: string): Promise<unknown>;
	batch<T>(statements: D1PreparedStatement[]): Promise<T[]>;
}

interface R2Bucket {
	get(
		key: string,
		options?: { range?: { offset?: number; length?: number } }
	): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; body: ReadableStream; size: number } | null>;
	head(key: string): Promise<{ size: number } | null>;
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string | Blob,
		options?: { httpMetadata?: { contentType?: string } }
	): Promise<unknown>;
	/** One key, or up to 1,000 at once — the bulk form is one subrequest. */
	delete(key: string | string[]): Promise<void>;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

interface IncomingRequestCfProperties {
	[key: string]: unknown;
}

interface Env {
	DB: D1Database;
	MEDIA: R2Bucket;
	/** Optional Cloudflare Queue: with it bound, the tick hands publishes to the
	 *  consumer instead of publishing inline. Off by default (see wrangler.jsonc). */
	PUBLISH_QUEUE?: Queue;
	/** Guards /api/auth/login, /api/auth/claim and /api/auth/totp/verify (see wrangler.jsonc). */
	AUTH_RATE_LIMITER?: RateLimitBinding;
	ASSETS: { fetch: typeof fetch };
	/** Which version of this Worker is answering, so the in-app updater can
	 *  find itself among the account's Workers (see wrangler.jsonc). Absent on a
	 *  config that predates it. */
	CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
	/** "button" on an instance deployed from the Deploy to Cloudflare button's
	 *  repository: Settings then offers updating through that repository. */
	COGSEND_INSTALL?: string;
	/** The button install's GitHub repository (owner/repo) and branch, recorded
	 *  by its deploy script; Settings links to its "Update CogSend" Action. */
	COGSEND_REPO?: string;
	COGSEND_BRANCH?: string;
	/** Optional public origin. Left unset (or left at localhost), the app adopts
	 *  the origin of each request and remembers the first authenticated one;
	 *  set it to pin a custom domain. See $lib/domain/app-url. */
	APP_URL?: string;
	/** Instance display name shown in the UI, when not overridden in
	 *  Settings → Instance (which is stored in D1). Defaults to "CogSend". */
	APP_NAME?: string;
	/** The only secret a deployment must bring: it encrypts the stored provider
	 *  tokens, and AUTH_SECRET/SCHEDULER_SECRET are derived from it. */
	APP_ENCRYPTION_KEY: string;
	/** Derived from APP_ENCRYPTION_KEY when unset (see derived-secrets.ts). */
	AUTH_SECRET?: string;
	/** Derived from APP_ENCRYPTION_KEY when unset. Set it when something outside
	 *  the Worker has to hold it, such as an external tick pinger. */
	SCHEDULER_SECRET?: string;
	API_TOKEN?: string;
	RESEND_API_KEY?: string;
	NOTIFY_EMAIL?: string;
	NOTIFY_FROM?: string;
	MEDIA_PUBLIC_BASE_URL?: string;
	LINKEDIN_CLIENT_ID?: string;
	LINKEDIN_CLIENT_SECRET?: string;
	THREADS_APP_ID?: string;
	THREADS_APP_SECRET?: string;
	X_CLIENT_ID?: string;
	X_CLIENT_SECRET?: string;
	/** Local-dev only: skips 2FA. Honored only while the resolved URL is a
	 *  localhost one, so it cannot weaken a real deployment. */
	SKIP_TOTP?: string;
	/** Set to "1" to enable video uploads (LinkedIn). The path is wired but not
	 *  verified against the live API yet, so it is off by default: the editor
	 *  hides the affordance and the API refuses video files without it. */
	ENABLE_VIDEO_UPLOAD?: string;
}

/** Cloudflare's Rate Limiting binding: `limit()` costs no network round trip and
 *  is per location. Optional so a Worker without the binding still serves. */
interface RateLimitBinding {
	limit(input: { key: string }): Promise<{ success: boolean }>;
}

interface Queue<Body = unknown> {
	send(body: Body): Promise<void>;
}

interface Message<Body = unknown> {
	body: Body;
	ack(): void;
	retry(): void;
}

interface MessageBatch<Body = unknown> {
	messages: Message<Body>[];
	queue: string;
}
