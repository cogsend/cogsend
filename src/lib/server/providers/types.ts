import type { PlatformId } from '$lib/domain/platforms';
export type { PlatformId } from '$lib/domain/platforms';
export { PLATFORM_IDS, isPlatformId } from '$lib/domain/platforms';

export interface MediaAttachment {
	storageKey?: string;
	bytes?: Uint8Array;
	size?: number;
	mime: string;
	alt?: string;
	width?: number;
	height?: number;
}

export function mediaByteLength(media: MediaAttachment): number {
	if (typeof media.size === 'number' && media.size >= 0) return media.size;
	if (media.bytes) return media.bytes.length;
	return 0;
}

export interface NormalizedPost {
	text: string;
	media?: MediaAttachment[];
	thread?: NormalizedPost[];
	options?: {
		visibility?: 'public' | 'unlisted' | 'private' | 'direct';
		spoilerText?: string;
		langs?: string[];
		poll?: {
			options: string[];
			expiresIn: number;
			multiple?: boolean;
			hideTotals?: boolean;
		};
	};
}

export interface ValidationIssue {
	field?: string;
	message: string;
	code?: string;
}

export interface PublishResult {
	/** The provider's id for the first segment. Optional on purpose: a 200 whose
	 *  body carries no id is still a published post, and the pipeline records it
	 *  by status rather than by this value. */
	remotePostId?: string;
	remoteUrl?: string;
	segmentIds?: string[];
	segmentCids?: string[];
}

export interface ConnectionCredentials {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	tokenType?: string;
	scopes?: string[];
	clientId?: string;
	clientSecret?: string;
	instanceUrl?: string;
	handle?: string;
	appPassword?: string;
	accessJwt?: string;
	refreshJwt?: string;
	did?: string;
	pdsHost?: string;
	/** LinkedIn OpenID sub; author is urn:li:person:{sub} */
	personUrn?: string;
	openIdSub?: string;
	/** Threads numeric user id (also the publish target) */
	threadsUserId?: string;
	threadsUsername?: string;
	/** X numeric user id */
	xUserId?: string;
	/** X handle without @ (for permalinks) */
	xUsername?: string;
	/** Zernio-backed accounts: the API key and the Zernio SocialAccount id. */
	zernioApiKey?: string;
	zernioAccountId?: string;
}

export interface ConnectionMeta {
	maxCharacters?: number;
	handle?: string;
	displayName?: string;
	avatarUrl?: string;
	did?: string;
	pdsHost?: string;
	personUrn?: string;
	threadsUserId?: string;
	xUserId?: string;
	provider?: 'zernio';
	zernioAccountId?: string;
	zernioProfileId?: string;
}

export type FetchLike = typeof fetch;

export interface PublishResume {
	segmentIds: string[];
	segmentCids?: string[];
	remoteUrl?: string | null;
}

/**
 * Progress callback for publishes spanning several remote posts. Providers
 * report each segment as it lands so publish.ts can persist the ids; without
 * it a Worker abort mid-thread leaves no record, and the stale-claim reclaim
 * would publish from segment 0 again (duplicate live posts). Implementations
 * must never throw — a checkpoint is best effort by definition.
 */
export interface PublishCheckpoint {
	segmentIds: string[];
	segmentCids?: string[];
	remoteUrl?: string | null;
}

/**
 * Structured provider failure. `code` drives two decisions in publish.ts
 * that string-matching alone gets wrong:
 * - `auth` → the credential is dead: mark the connection expired.
 * - `forbidden` (HTTP 403) → the platform refused this action but the
 *   credential was accepted: do NOT expire the connection. Retrying
 *   unchanged content is pointless, so it is also non-retryable.
 * - `unconfirmed` → the post request went out and no answer came back, so it
 *   may be live. Non-retryable: see unconfirmedPostError.
 * Unknown/legacy errors fall back to the previous regex classification.
 */
export type ProviderErrorCode =
	'auth' | 'forbidden' | 'rate_limited' | 'network' | 'upstream' | 'unconfirmed';

export class ProviderError extends Error {
	readonly status?: number;
	readonly code?: ProviderErrorCode;
	readonly retryable: boolean;
	/**
	 * Capped upstream response body for diagnosis (never the user-facing
	 * message). publish.ts persists it on the attempt so support can see
	 * codes/subcodes the 300-char message slice cuts off.
	 */
	readonly detail?: string;

	constructor(
		message: string,
		opts: { status?: number; code?: ProviderErrorCode; detail?: string } = {}
	) {
		super(message);
		this.name = 'ProviderError';
		this.status = opts.status;
		this.code = opts.code;
		this.detail = opts.detail;
		this.retryable =
			opts.code === 'rate_limited' || opts.code === 'network' || opts.code === 'upstream';
	}
}

/** In every unconfirmed-post message; publish.ts reads it to keep the row from retrying. */
export const UNCONFIRMED_POST_MARK = 'may have been published';

/**
 * The request that creates a post failed without an answer (timeout, dropped
 * connection), so the platform may have published it. X, LinkedIn and Threads
 * take no idempotency key, so a retry cannot be recognised as the same post:
 * retrying on its own would risk a duplicate, and the person has to look first.
 * The wording avoids the words humanizedCause and the auth matchers react to,
 * so it reaches the reader as written.
 */
export function unconfirmedPostError(platformLabel: string, cause: unknown): ProviderError {
	return new ProviderError(
		`${platformLabel} did not confirm the post in time, so it ${UNCONFIRMED_POST_MARK}. Check ${platformLabel} before you retry.`,
		{ code: 'unconfirmed', detail: cause instanceof Error ? cause.message : String(cause) }
	);
}

/**
 * Classify an upstream HTTP failure. 401 means the credential was rejected
 * (auth). 403 means the credential was accepted but the action refused
 * (policy/permission — must not expire the connection). 429 is rate
 * limiting. Anything else stays unclassified so legacy handling applies.
 */
export function providerErrorForStatus(
	prefix: string,
	status: number,
	body: string
): ProviderError {
	const message = `${prefix} failed (${status}): ${body.slice(0, 300)}`;
	if (status === 401) return new ProviderError(message, { status, code: 'auth' });
	if (status === 403) return new ProviderError(message, { status, code: 'forbidden' });
	if (status === 429) return new ProviderError(message, { status, code: 'rate_limited' });
	return new ProviderError(message, { status });
}

/**
 * Read structured failure info off any thrown value. Legacy enriched errors
 * (`Object.assign(new Error(...), { status })`) classify by status; anything
 * else returns no code so callers fall back to message matching.
 */
export function classifyProviderError(err: unknown): {
	status?: number;
	code?: ProviderErrorCode;
	retryable?: boolean;
} {
	if (err instanceof ProviderError) {
		return { status: err.status, code: err.code, retryable: err.retryable };
	}
	const status =
		typeof err === 'object' && err !== null && 'status' in err
			? (err as { status?: unknown }).status
			: undefined;
	if (typeof status !== 'number') return {};
	if (status === 401) return { status, code: 'auth', retryable: false };
	if (status === 403) return { status, code: 'forbidden', retryable: false };
	if (status === 429) return { status, code: 'rate_limited', retryable: true };
	return { status };
}

export class PublishPartialError extends Error {
	readonly segmentIds: string[];
	readonly segmentCids?: string[];
	readonly remoteUrl?: string | null;

	constructor(
		message: string,
		opts: { segmentIds: string[]; segmentCids?: string[]; remoteUrl?: string | null }
	) {
		super(message);
		this.name = 'PublishPartialError';
		this.segmentIds = opts.segmentIds;
		this.segmentCids = opts.segmentCids;
		this.remoteUrl = opts.remoteUrl;
	}
}

export interface PlatformProvider {
	id: PlatformId;
	/**
	 * The platform fetches attachments from `mediaUrlFor` URLs and is never
	 * handed the bytes, so publish does not read them from storage: on the
	 * Workers Free plan every read spends one of the request's 50 calls, and a
	 * carousel's images would otherwise all sit in isolate memory for nothing.
	 */
	mediaByUrl?: boolean;
	capabilities: {
		maxImages: number;
		maxImageBytes: number;
		supportsCW: boolean;
		supportsVisibility: boolean;
		supportsThreads: boolean;
	};
	validate(content: NormalizedPost, meta?: ConnectionMeta): ValidationIssue[];
	publish(
		content: NormalizedPost,
		creds: ConnectionCredentials,
		meta?: ConnectionMeta,
		fetchImpl?: FetchLike,
		opts?: {
			resume?: PublishResume;
			/** Allow localhost/private Mastodon hosts. True only for a local
			 *  instance — see $lib/domain/app-url. */
			allowLocalHosts?: boolean;
			mediaUrlFor?: (storageKey: string) => Promise<string> | string;
			checkpoint?: (state: PublishCheckpoint) => Promise<void> | void;
			/** A stable key for (target, segment), so a retry after a lost
			 *  response is recognised by the platform instead of posting twice.
			 *  Providers that support it use it; the rest ignore it. */
			idempotencyKey?: (segmentIndex: number) => string;
			/** The same guarantee for AT Protocol, where it has to be a record
			 *  key of the collection's declared type (a TID for posts). */
			recordKey?: (segmentIndex: number) => string;
		}
	): Promise<PublishResult>;
	/**
	 * Optional credential healing before publish: reconcile stored identity
	 * with the live credential (Threads: the id GET /me reports). Returning
	 * creds makes publish.ts persist them so the correction sticks; null
	 * means nothing needed changing or the lookup was unavailable.
	 */
	alignCredentials?(
		creds: ConnectionCredentials,
		meta: ConnectionMeta | undefined,
		fetchImpl: FetchLike
	): Promise<ConnectionCredentials | null>;
	refreshIfNeeded?(
		creds: ConnectionCredentials,
		fetchImpl?: FetchLike
	): Promise<ConnectionCredentials>;
	/**
	 * Pure check for tokens that cannot possibly work: the access token is
	 * known-expired AND no refresh path exists (missing refresh token or
	 * OAuth client). Returns a human reconnect reason, or null when a
	 * publish attempt is still worthwhile. Providers without refreshable
	 * short-lived tokens (Mastodon, Bluesky) omit this.
	 */
	refreshImpossibleReason?(creds: ConnectionCredentials): string | null;
}

export interface MediaStore {
	get(storageKey: string): Promise<Uint8Array | null>;
	// Inclusive byte range for Range/206 serving. Optional for forward
	// compatibility: callers fall back to full get() when absent.
	getRange?(storageKey: string, start: number, end: number): Promise<Uint8Array | null>;
	// Total object size for Content-Range validation. Optional; callers fall
	// back to get().length when absent.
	size?(storageKey: string): Promise<number | null>;
	put(storageKey: string, bytes: Uint8Array, mime: string): Promise<void>;
	delete(storageKey: string): Promise<void>;
	// The object (or one inclusive byte range) as a stream plus the object's
	// total size, so serving a large file never holds it in isolate memory
	// (128MB limit vs 95MB videos). Optional: callers fall back to get/getRange.
	open?(
		storageKey: string,
		range?: { start: number; end: number }
	): Promise<{ body: ReadableStream; size: number } | null>;
	// Bulk delete for the account wipe: R2 takes up to 1,000 keys in one call,
	// and each call is a subrequest (50 per invocation on Workers Free), so
	// deleting one at a time cannot finish a library of any size. Optional:
	// callers fall back to delete() per key.
	deleteMany?(storageKeys: string[]): Promise<void>;
}
