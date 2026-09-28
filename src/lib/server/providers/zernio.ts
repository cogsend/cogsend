import { toZernioPlatform, zernioRequestId } from '$lib/domain/zernio';
import { platformName } from '$lib/domain/platforms';
import {
	createPost,
	getPost,
	zernioEntryAccountId,
	type ZernioPlatformEntry,
	type ZernioPost
} from '../zernio';
import { getProvider } from './index';
import { providerFetch } from './timed-fetch';
import {
	ProviderError,
	PublishPartialError,
	type FetchLike,
	type MediaAttachment,
	type NormalizedPost,
	type PlatformId,
	type PlatformProvider,
	type PublishResult
} from './types';

function existingPostIdFrom(err: ProviderError): string | null {
	try {
		const body = JSON.parse(err.detail ?? '') as { details?: { existingPostId?: unknown } };
		const id = body.details?.existingPostId;
		return typeof id === 'string' && id ? id : null;
	} catch {
		return null;
	}
}

/**
 * A create can outlive the request timeout (a Threads thread publishes inside
 * the call) while Zernio carries on and posts it. Zernio's duplicate check runs
 * before its x-request-id replay, so the retry gets a 409 naming the post it
 * already made. The request id in the post's metadata proves which 409s are
 * ours to adopt; any other is a real duplicate.
 */
async function createOrAdopt(opts: {
	apiKey: string;
	body: Record<string, unknown>;
	requestId: string;
	fetchImpl: FetchLike;
}): Promise<string> {
	try {
		return (await createPost(opts))._id;
	} catch (err) {
		if (!(err instanceof ProviderError) || err.status !== 409) throw err;
		const existingId = existingPostIdFrom(err);
		if (!existingId) throw err;
		const existing = await getPost({
			apiKey: opts.apiKey,
			postId: existingId,
			fetchImpl: opts.fetchImpl
		});
		if (existing.metadata?.cogsendRequestId !== opts.requestId) throw err;
		return existingId;
	}
}

export const ZERNIO_POLL_INTERVAL_MS = 3_000;
export const ZERNIO_MAX_POLLS = 8;

type MediaUrlFor = (storageKey: string) => Promise<string> | string;

async function mediaItemFor(media: MediaAttachment, mediaUrlFor: MediaUrlFor) {
	if (!media.storageKey) throw new Error('Zernio posts need stored media');
	const mime = (media.mime || '').toLowerCase();
	const type = mime.startsWith('video/') ? 'video' : mime === 'image/gif' ? 'gif' : 'image';
	return {
		type,
		url: await mediaUrlFor(media.storageKey),
		mimeType: media.mime,
		...(media.alt ? { altText: media.alt } : {})
	};
}

export async function buildZernioPostBody(opts: {
	platform: PlatformId | string;
	accountId: string;
	content: NormalizedPost;
	mediaUrlFor?: MediaUrlFor;
}): Promise<Record<string, unknown>> {
	const zernioPlatform = toZernioPlatform(opts.platform);
	if (!zernioPlatform) throw new Error(`Zernio does not support ${platformName(opts.platform)}`);
	const segments =
		opts.content.thread && opts.content.thread.length > 0 ? opts.content.thread : [opts.content];
	const hasMedia = segments.some((s) => (s.media?.length ?? 0) > 0);
	if (hasMedia && !opts.mediaUrlFor) throw new Error('Zernio posts need a media signer');
	const items = async (media: MediaAttachment[] | undefined) =>
		Promise.all((media ?? []).map((m) => mediaItemFor(m, opts.mediaUrlFor!)));
	const target: Record<string, unknown> = { platform: zernioPlatform, accountId: opts.accountId };

	// LinkedIn has no threads (the direct provider joins the segments too), and
	// a single segment goes out flat everywhere.
	if (segments.length === 1 || opts.platform === 'linkedin') {
		const text = segments
			.map((s) => s.text || '')
			.filter(Boolean)
			.join('\n\n');
		const mediaItems = await items(segments.flatMap((s) => s.media ?? []));
		return {
			content: text,
			...(mediaItems.length ? { mediaItems } : {}),
			platforms: [target],
			publishNow: true
		};
	}

	const threadItems = [];
	for (const segment of segments) {
		threadItems.push({ content: segment.text || '', mediaItems: await items(segment.media) });
	}
	return {
		content: segments[0].text || '',
		platforms: [{ ...target, platformSpecificData: { threadItems } }],
		publishNow: true
	};
}

function entryFor(post: ZernioPost, accountId: string): ZernioPlatformEntry | undefined {
	const entries = post.platforms ?? [];
	return entries.find((e) => zernioEntryAccountId(e) === accountId) ?? entries[0];
}

/**
 * Zernio already retried the platform before reporting `failed`, and it says
 * why in `errorCategory`. A dead token expires the connection; a platform
 * rate limit or outage is worth another attempt (the caller empties the
 * checkpoint first, so that attempt creates a fresh post); anything else is
 * the content or the account, which a retry cannot fix.
 */
function failureError(platform: string, entry: ZernioPlatformEntry): ProviderError {
	const reason = entry.errorMessage || 'no reason given';
	const message = `Zernio could not publish to ${platformName(platform)}: ${reason}`;
	if (entry.errorCategory === 'auth_expired') return new ProviderError(message, { code: 'auth' });
	if (entry.errorCategory === 'platform_rate_limit') {
		return new ProviderError(message, { code: 'rate_limited' });
	}
	if (entry.errorCategory === 'platform_error' || entry.errorCategory === 'system_error') {
		return new ProviderError(message, { code: 'upstream' });
	}
	return new ProviderError(message, { code: 'forbidden' });
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

const providers = new Map<PlatformId, PlatformProvider>();

export function zernioProviderFor(
	platform: PlatformId,
	opts: { pollIntervalMs?: number; maxPolls?: number } = {}
): PlatformProvider {
	const cached = opts.pollIntervalMs === undefined && opts.maxPolls === undefined;
	if (cached && providers.has(platform)) return providers.get(platform)!;
	const direct = getProvider(platform);
	const pollIntervalMs = opts.pollIntervalMs ?? ZERNIO_POLL_INTERVAL_MS;
	const maxPolls = opts.maxPolls ?? ZERNIO_MAX_POLLS;

	const provider: PlatformProvider = {
		id: platform,
		// Zernio is sent media URLs (mediaItemFor), never bytes.
		mediaByUrl: true,
		capabilities: direct.capabilities,
		validate: (content, meta) => direct.validate(content, meta),

		async publish(
			content,
			creds,
			_meta,
			fetchImpl = providerFetch,
			publishOpts
		): Promise<PublishResult> {
			const { zernioApiKey: apiKey, zernioAccountId: accountId } = creds;
			if (!apiKey || !accountId) {
				throw new ProviderError('Zernio credentials require zernioApiKey and zernioAccountId', {
					code: 'auth'
				});
			}
			let postId = publishOpts?.resume?.segmentIds?.[0];
			if (!postId) {
				const body = await buildZernioPostBody({
					platform,
					accountId,
					content,
					mediaUrlFor: publishOpts?.mediaUrlFor
				});
				const requestId = zernioRequestId(publishOpts?.idempotencyKey?.(0) ?? crypto.randomUUID());
				postId = await createOrAdopt({
					apiKey,
					body: { ...body, metadata: { cogsendRequestId: requestId } },
					requestId,
					fetchImpl
				});
				await publishOpts?.checkpoint?.({ segmentIds: [postId], remoteUrl: null });
			}

			// The checkpoint is what a retry resumes from. Once the Zernio post is
			// dead (failed, cancelled, gone), leaving its id there would make every
			// later attempt poll the same corpse; an empty checkpoint tells
			// publish.ts to forget it, so the next attempt creates a fresh post.
			const forgetPost = () => publishOpts?.checkpoint?.({ segmentIds: [], remoteUrl: null });
			for (let poll = 0; poll < maxPolls; poll++) {
				if (poll > 0) await sleep(pollIntervalMs);
				let post: ZernioPost;
				try {
					post = await getPost({ apiKey, postId, fetchImpl });
				} catch (err) {
					if (err instanceof ProviderError && !err.retryable) await forgetPost();
					throw err;
				}
				const entry = entryFor(post, accountId);
				const status = entry?.status ?? post.status;
				if (status === 'published') {
					return {
						remotePostId: entry?.platformPostId || postId,
						remoteUrl: entry?.platformPostUrl,
						segmentIds: [postId]
					};
				}
				if (status === 'failed') {
					await forgetPost();
					throw failureError(platform, entry ?? { platform, accountId });
				}
				if (status === 'cancelled') {
					await forgetPost();
					throw new ProviderError(
						`Zernio cancelled this post before it reached ${platformName(platform)}`,
						{ code: 'forbidden' }
					);
				}
			}
			throw new PublishPartialError('Zernio is still publishing this post', {
				segmentIds: [postId],
				remoteUrl: null
			});
		}
	};
	if (cached) providers.set(platform, provider);
	return provider;
}
