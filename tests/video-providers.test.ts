import { describe, expect, it } from 'vitest';
import { createTestMedia } from '#lib/server/db/test.js';
import { blueskyProvider } from '#lib/server/providers/bluesky.js';
import { linkedinProvider } from '#lib/server/providers/linkedin.js';
import { mastodonInstanceLimits, mastodonProvider } from '#lib/server/providers/mastodon.js';
import { threadsProvider } from '#lib/server/providers/threads.js';
import { xProvider } from '#lib/server/providers/x.js';
import { pollVideo } from '#lib/server/providers/video.js';
import {
	ProviderError,
	PROCESSING_MARK,
	type FetchLike,
	type MediaAttachment,
	type PlatformProvider,
	type PublishPending
} from '#lib/server/providers/types.js';

type Opts = NonNullable<Parameters<PlatformProvider['publish']>[4]>;
type Handler = (req: Request) => Response | Promise<Response>;

/** Routes by substring, first match wins; counts calls against `left`. */
function fakeNetwork(handlers: Record<string, Handler>) {
	const net = { left: Infinity, calls: [] as string[] };
	const fetchImpl: FetchLike = async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		net.left -= 1;
		net.calls.push(url);
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(new Request(url, init));
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
	return { net, fetchImpl, callsLeft: () => net.left };
}

function patterned(size: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = i % 251;
	return bytes;
}

async function storedVideo(size: number, cover?: Uint8Array<ArrayBuffer>) {
	const store = createTestMedia();
	const bytes = patterned(size);
	await store.put('v.mp4', bytes, 'video/mp4');
	if (cover) await store.put('cover/v.mp4', cover, 'image/jpeg');
	const video: MediaAttachment = {
		storageKey: 'v.mp4',
		mime: 'video/mp4',
		size,
		width: 1280,
		height: 720,
		alt: 'a clip',
		video: { durationMs: 10_000, videoCodec: 'avc', fps: 30, faststart: true },
		...(cover ? { coverKey: 'cover/v.mp4' } : {})
	};
	return { store, bytes, video };
}

async function parked(run: Promise<unknown>): Promise<ProviderError> {
	const err = await run.then(
		() => null,
		(e: unknown) => e
	);
	expect(err).toBeInstanceOf(ProviderError);
	const provider = err as ProviderError;
	expect(provider.code).toBe('processing');
	expect(provider.message).toContain(PROCESSING_MARK);
	return provider;
}

function resumeFrom(err: ProviderError): Opts['resume'] {
	const pending: PublishPending = { ...err.pending!, startedAt: Date.now() };
	return { segmentIds: [], pending };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

describe('Threads video', () => {
	const creds = { accessToken: 'tok', threadsUserId: '123', threadsUsername: 'someone' };

	function threadsNetwork(statuses: string[]) {
		const created: URLSearchParams[] = [];
		const net = fakeNetwork({
			'fields=status': () => Response.json({ status: statuses.shift() ?? 'FINISHED' }),
			'fields=permalink': () =>
				Response.json({ permalink: 'https://www.threads.com/@someone/post/Abc' }),
			'/threads_publish': () => Response.json({ id: 'post-1' }),
			'/123/threads': async (req) => {
				created.push(new URLSearchParams(await req.text()));
				return Response.json({ id: `c-${created.length}` });
			}
		});
		return { ...net, created };
	}

	const opts = (extra: Partial<Opts> = {}): Opts => ({
		mediaUrlFor: (key) => `https://media.test/${key}`,
		...extra
	});

	it('parks a container still in progress and publishes it on the next run', async () => {
		const { video } = await storedVideo(1000);
		const n = threadsNetwork(['FINISHED']);
		const err = await parked(
			threadsProvider.publish(
				{ text: 'watch', media: [video] },
				creds,
				undefined,
				n.fetchImpl,
				opts({ callsLeft: () => 0 })
			)
		);
		expect(err.pending).toEqual({ segment: 0, storageKey: 'v.mp4', state: { containerId: 'c-1' } });
		expect(n.created).toHaveLength(1);
		expect(Object.fromEntries(n.created[0])).toMatchObject({
			media_type: 'VIDEO',
			video_url: 'https://media.test/v.mp4',
			text: 'watch',
			alt_text: 'a clip'
		});

		const result = await threadsProvider.publish(
			{ text: 'watch', media: [video] },
			creds,
			undefined,
			n.fetchImpl,
			opts({ resume: resumeFrom(err) })
		);
		expect(result.remotePostId).toBe('post-1');
		expect(n.created).toHaveLength(1);
	});

	it('parks instead of waiting when the run is out of time', async () => {
		const { video } = await storedVideo(1000);
		const n = threadsNetwork(['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS']);
		const started = Date.now();
		const err = await parked(
			threadsProvider.publish(
				{ text: 'watch', media: [video] },
				creds,
				undefined,
				n.fetchImpl,
				opts({ timeLeft: () => 1000 })
			)
		);
		expect(err.pending?.state).toEqual({ containerId: 'c-1' });
		expect(n.net.calls.filter((url) => url.includes('fields=status'))).toHaveLength(1);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('makes a fresh container when the parked one expired', async () => {
		const { video } = await storedVideo(1000);
		const n = threadsNetwork(['EXPIRED', 'FINISHED']);
		const result = await threadsProvider.publish(
			{ text: 'watch', media: [video] },
			creds,
			undefined,
			n.fetchImpl,
			opts({
				resume: {
					segmentIds: [],
					pending: { segment: 0, storageKey: 'v.mp4', state: { containerId: 'old' }, startedAt: 0 }
				}
			})
		);
		expect(result.remotePostId).toBe('post-1');
		expect(n.created).toHaveLength(1);
	});

	it('sends a topic with the video, and none without one', async () => {
		const { video } = await storedVideo(1000);
		const tagged = threadsNetwork(['FINISHED']);
		await threadsProvider.publish(
			{ text: 'watch', media: [video], options: { topicTag: 'Clips' } },
			creds,
			undefined,
			tagged.fetchImpl,
			opts()
		);
		expect(tagged.created[0].get('topic_tag')).toBe('Clips');

		const untagged = threadsNetwork(['FINISHED']);
		await threadsProvider.publish(
			{ text: 'watch', media: [video] },
			creds,
			undefined,
			untagged.fetchImpl,
			opts()
		);
		expect(untagged.created[0].has('topic_tag')).toBe(false);
	});

	it('keeps the topic on the container made again after one expired', async () => {
		const { video } = await storedVideo(1000);
		const n = threadsNetwork(['EXPIRED', 'FINISHED']);
		await threadsProvider.publish(
			{ text: 'watch', media: [video], options: { topicTag: 'Clips' } },
			creds,
			undefined,
			n.fetchImpl,
			opts({
				resume: {
					segmentIds: [],
					pending: { segment: 0, storageKey: 'v.mp4', state: { containerId: 'old' }, startedAt: 0 }
				}
			})
		);
		expect(n.created).toHaveLength(1);
		expect(n.created[0].get('topic_tag')).toBe('Clips');
	});

	it('stops for good when Meta could not process the video', async () => {
		const { video } = await storedVideo(1000);
		const n = threadsNetwork(['ERROR']);
		const err = await threadsProvider
			.publish({ text: 'watch', media: [video] }, creds, undefined, n.fetchImpl, opts())
			.catch((e: unknown) => e as ProviderError);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).code).toBe('forbidden');
	});

	it('checks the video against what Threads takes', () => {
		const long = {
			mime: 'video/mp4',
			size: 1000,
			width: 1080,
			height: 1920,
			video: { durationMs: 432_000, videoCodec: 'avc', fps: 30, faststart: true }
		};
		expect(threadsProvider.validate({ text: 'x', media: [long] }).map((i) => i.message)).toEqual([
			'Threads takes videos up to 5:00 — this one is 7:12'
		]);
	});
});

describe('LinkedIn video', () => {
	const creds = { accessToken: 'tok', personUrn: 'urn:li:person:abc' };

	function linkedinNetwork(statuses: string[], withThumbnail = false) {
		const parts: { url: string; bytes: Uint8Array }[] = [];
		const record = { inits: 0, finalized: null as unknown, thumbnail: null as Uint8Array | null };
		const net = fakeNetwork({
			'action=initializeUpload': async (req) => {
				record.inits += 1;
				const body = await req.json();
				expect(body.initializeUploadRequest.uploadThumbnail).toBe(withThumbnail);
				return Response.json({
					value: {
						uploadInstructions: [
							{ uploadUrl: 'https://upload.test/p1', firstByte: 0, lastByte: 5_999 },
							{ uploadUrl: 'https://upload.test/p2', firstByte: 6_000, lastByte: 9_999 }
						],
						uploadToken: 'up-tok',
						video: 'urn:li:video:V1',
						...(withThumbnail ? { thumbnailUploadUrl: 'https://upload.test/thumb' } : {})
					}
				});
			},
			'upload.test/thumb': async (req) => {
				record.thumbnail = new Uint8Array(await req.arrayBuffer());
				return new Response('', { status: 201 });
			},
			'upload.test/p': async (req) => {
				parts.push({ url: req.url, bytes: new Uint8Array(await req.arrayBuffer()) });
				return new Response('', { status: 201, headers: { ETag: `"etag-${parts.length}"` } });
			},
			'action=finalizeUpload': async (req) => {
				record.finalized = (await req.json()).finalizeUploadRequest;
				return new Response('', { status: 200 });
			},
			'/rest/videos/': () => Response.json({ status: statuses.shift() ?? 'AVAILABLE' }),
			'/rest/posts': () =>
				new Response('{}', { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } })
		});
		return { ...net, parts, record };
	}

	it('sends the parts across runs, reading each from storage, then posts', async () => {
		const { store, bytes, video } = await storedVideo(10_000);
		const n = linkedinNetwork([]);
		n.net.left = 11;
		const err = await parked(
			linkedinProvider.publish({ text: 'clip', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never,
				callsLeft: n.callsLeft
			})
		);
		expect(n.parts.map((p) => p.url)).toEqual(['https://upload.test/p1']);

		n.net.left = Infinity;
		const result = await linkedinProvider.publish(
			{ text: 'clip', media: [video] },
			creds,
			undefined,
			n.fetchImpl,
			{ mediaReader: store as never, callsLeft: n.callsLeft, resume: resumeFrom(err) }
		);
		expect(result.remotePostId).toBe('urn:li:share:1');
		expect(n.record.inits).toBe(1);
		expect(n.parts.map((p) => p.url)).toEqual(['https://upload.test/p1', 'https://upload.test/p2']);
		expect(Buffer.from(n.parts[0].bytes).equals(Buffer.from(bytes.slice(0, 6_000)))).toBe(true);
		expect(Buffer.from(n.parts[1].bytes).equals(Buffer.from(bytes.slice(6_000)))).toBe(true);
		expect(n.record.finalized).toEqual({
			video: 'urn:li:video:V1',
			uploadToken: 'up-tok',
			uploadedPartIds: ['etag-1', 'etag-2']
		});
	});

	it('waits for AVAILABLE, parking while LinkedIn processes', async () => {
		const { store, video } = await storedVideo(10_000);
		const n = linkedinNetwork(['PROCESSING', 'AVAILABLE']);
		n.net.left = 12;
		const err = await parked(
			linkedinProvider.publish({ text: 'clip', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never,
				callsLeft: n.callsLeft
			})
		);
		expect(err.pending?.state).toMatchObject({ finalized: true });
		n.net.left = Infinity;
		const result = await linkedinProvider.publish(
			{ text: 'clip', media: [video] },
			creds,
			undefined,
			n.fetchImpl,
			{ mediaReader: store as never, resume: resumeFrom(err) }
		);
		expect(result.remotePostId).toBe('urn:li:share:1');
		expect(n.parts).toHaveLength(2);
		expect(n.record.inits).toBe(1);
	});

	it('sends the chosen cover before finalizing, parking for it rather than going without', async () => {
		const { store, video } = await storedVideo(10_000, JPEG);
		const n = linkedinNetwork([], true);
		n.net.left = 13;
		const err = await parked(
			linkedinProvider.publish({ text: 'clip', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never,
				callsLeft: n.callsLeft
			})
		);
		expect(n.record.thumbnail).toBeNull();
		expect(n.record.finalized).toBeNull();
		expect(err.pending?.state).not.toHaveProperty('finalized');
		n.net.left = Infinity;
		const result = await linkedinProvider.publish(
			{ text: 'clip', media: [video] },
			creds,
			undefined,
			n.fetchImpl,
			{ mediaReader: store as never, resume: resumeFrom(err) }
		);
		expect(result.remotePostId).toBe('urn:li:share:1');
		expect(Buffer.from(n.record.thumbnail!).equals(Buffer.from(JPEG))).toBe(true);
		const thumbAt = n.net.calls.findIndex((u) => u.includes('upload.test/thumb'));
		const finalizeAt = n.net.calls.findIndex((u) => u.includes('action=finalizeUpload'));
		expect(thumbAt).toBeGreaterThan(-1);
		expect(thumbAt).toBeLessThan(finalizeAt);
		expect(n.parts).toHaveLength(2);
	});

	it('stops when LinkedIn could not process the video', async () => {
		const { store, video } = await storedVideo(10_000);
		const n = linkedinNetwork(['PROCESSING_FAILED']);
		const err = await linkedinProvider
			.publish({ text: 'clip', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never
			})
			.catch((e: unknown) => e as ProviderError);
		expect((err as ProviderError).code).toBe('forbidden');
		expect((err as ProviderError).message).toBe(
			'LinkedIn could not process the video — attach it again'
		);
	});
});

describe('Bluesky video', () => {
	const creds = () => ({
		accessJwt: 'jwt',
		refreshJwt: 'r',
		did: 'did:plc:abc',
		handle: 'me.bsky.social',
		pdsHost: 'https://bsky.social'
	});
	const blob = { $type: 'blob', ref: { $link: 'bafy' }, mimeType: 'video/mp4', size: 2000 };

	function blueskyNetwork(opts: { canUpload?: boolean; jobs?: unknown[]; upload?: Handler } = {}) {
		const auds: string[] = [];
		const uploads: { url: URL; length: string | null; bytes: number }[] = [];
		const records: Record<string, unknown>[] = [];
		const jobs = opts.jobs ?? [];
		const net = fakeNetwork({
			'plc.directory/did%3Aplc%3Aabc': () =>
				Response.json({
					service: [
						{
							id: '#atproto_pds',
							type: 'AtprotoPersonalDataServer',
							serviceEndpoint: 'https://morel.us-east.host.bsky.network'
						}
					]
				}),
			getServiceAuth: (req) => {
				auds.push(new URL(req.url).searchParams.get('aud')!);
				return Response.json({ token: `svc-${auds.length}` });
			},
			getUploadLimits: () =>
				Response.json(
					opts.canUpload === false
						? { canUpload: false, message: 'Please verify your email' }
						: { canUpload: true }
				),
			uploadVideo:
				opts.upload ??
				(async (req) => {
					uploads.push({
						url: new URL(req.url),
						length: req.headers.get('content-length'),
						bytes: (await req.arrayBuffer()).byteLength
					});
					return Response.json({ jobId: 'job-1', state: 'JOB_STATE_CREATED' });
				}),
			getJobStatus: () =>
				Response.json({ jobStatus: jobs.shift() ?? { state: 'JOB_STATE_ENCODING' } }),
			createRecord: async (req) => {
				records.push((await req.json()).record);
				return Response.json({ uri: 'at://did:plc:abc/app.bsky.feed.post/1', cid: 'cid1' });
			}
		});
		return { ...net, auds, uploads, records };
	}

	it('uploads through the video service, parks the job, then embeds the blob', async () => {
		const { store, video } = await storedVideo(2000);
		const n = blueskyNetwork({ jobs: [{ state: 'JOB_STATE_ENCODING' }] });
		n.net.left = 11;
		const err = await parked(
			blueskyProvider.publish({ text: 'clip', media: [video] }, creds(), undefined, n.fetchImpl, {
				mediaReader: store as never,
				callsLeft: n.callsLeft
			})
		);
		expect(err.pending?.state).toEqual({ jobId: 'job-1' });
		expect(n.auds).toEqual(['did:web:video.bsky.app', 'did:web:morel.us-east.host.bsky.network']);
		expect(n.uploads).toHaveLength(1);
		expect(n.uploads[0].url.searchParams.get('did')).toBe('did:plc:abc');
		expect(n.uploads[0].length).toBe('2000');
		expect(n.uploads[0].bytes).toBe(2000);

		n.net.left = Infinity;
		const later = blueskyNetwork({ jobs: [{ state: 'JOB_STATE_COMPLETED', blob }] });
		const result = await blueskyProvider.publish(
			{ text: 'clip', media: [video] },
			creds(),
			undefined,
			later.fetchImpl,
			{ mediaReader: store as never, resume: resumeFrom(err) }
		);
		expect(result.remotePostId).toBe('at://did:plc:abc/app.bsky.feed.post/1');
		expect(later.uploads).toHaveLength(0);
		expect(later.records[0].embed).toEqual({
			$type: 'app.bsky.embed.video',
			video: blob,
			alt: 'a clip',
			aspectRatio: { width: 1280, height: 720 }
		});
	});

	it("says why Bluesky will not take a video, in Bluesky's words", async () => {
		const { store, video } = await storedVideo(2000);
		const n = blueskyNetwork({ canUpload: false });
		const err = await blueskyProvider
			.publish({ text: 'clip', media: [video] }, creds(), undefined, n.fetchImpl, {
				mediaReader: store as never
			})
			.catch((e: unknown) => e as ProviderError);
		expect((err as ProviderError).code).toBe('forbidden');
		expect((err as ProviderError).message).toBe(
			'Bluesky will not take a video from this account right now: Please verify your email'
		);
	});

	it('takes the job of a video the service already has', async () => {
		const { store, video } = await storedVideo(2000);
		const n = blueskyNetwork({
			jobs: [{ state: 'JOB_STATE_COMPLETED', blob }],
			upload: () => Response.json({ error: 'already_exists', jobId: 'job-9' }, { status: 409 })
		});
		const result = await blueskyProvider.publish(
			{ text: 'clip', media: [video] },
			creds(),
			undefined,
			n.fetchImpl,
			{ mediaReader: store as never }
		);
		expect(result.remotePostId).toBeTruthy();
		expect(n.net.calls.some((u) => u.includes('jobId=job-9'))).toBe(true);
	});
});

describe('Mastodon video', () => {
	const creds = { accessToken: 'tok', instanceUrl: 'https://example.social' };

	function mastodonNetwork(polls: number[]) {
		const uploads: FormData[] = [];
		const statuses: Record<string, unknown>[] = [];
		const net = fakeNetwork({
			'/api/v2/media': async (req) => {
				expect(req.headers.get('content-length')).toBeTruthy();
				uploads.push(await req.formData());
				return Response.json({ id: 'm1' }, { status: 202 });
			},
			'/api/v1/media/m1': () => new Response('{}', { status: polls.shift() ?? 200 }),
			'/api/v1/statuses': async (req) => {
				statuses.push(await req.json());
				return Response.json({ id: 's1', url: 'https://example.social/@me/1' });
			}
		});
		return { ...net, uploads, statuses };
	}

	it('streams the video with its cover, parks while it transcodes, then posts', async () => {
		const { store, bytes, video } = await storedVideo(5000, JPEG);
		const n = mastodonNetwork([206, 200]);
		n.net.left = 7;
		const err = await parked(
			mastodonProvider.publish({ text: 'clip', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never,
				callsLeft: n.callsLeft
			})
		);
		expect(err.pending?.state).toEqual({ mediaId: 'm1' });
		const form = n.uploads[0];
		const file = form.get('file') as File;
		expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
		expect(form.get('description')).toBe('a clip');
		const thumb = form.get('thumbnail') as File;
		expect(Buffer.from(await thumb.arrayBuffer()).equals(Buffer.from(JPEG))).toBe(true);

		n.net.left = Infinity;
		const result = await mastodonProvider.publish(
			{ text: 'clip', media: [video] },
			creds,
			undefined,
			n.fetchImpl,
			{ mediaReader: store as never, resume: resumeFrom(err) }
		);
		expect(result.remotePostId).toBe('s1');
		expect(n.uploads).toHaveLength(1);
		expect(n.statuses[0].media_ids).toEqual(['m1']);
	});

	it("checks a video against the instance's own limits", () => {
		const video = {
			mime: 'video/mp4',
			size: 60_000_000,
			width: 1920,
			height: 1080,
			video: { durationMs: 10_000, videoCodec: 'avc', fps: 30 }
		};
		expect(mastodonProvider.validate({ text: 'x', media: [video] })).toEqual([]);
		expect(
			mastodonProvider
				.validate({ text: 'x', media: [video] }, { videoSizeLimit: 40_000_000 })
				.map((i) => i.message)
		).toEqual(['Mastodon takes videos up to 40 MB — this one is 60 MB']);
	});

	it('reads the video limits the instance reports', async () => {
		const { fetchImpl } = fakeNetwork({
			'/api/v2/instance': () =>
				Response.json({
					configuration: {
						statuses: { max_characters: 1000 },
						media_attachments: {
							video_size_limit: 103_809_024,
							video_matrix_limit: 8_294_400,
							video_frame_rate_limit: 120
						}
					}
				})
		});
		expect(await mastodonInstanceLimits('https://example.social', fetchImpl)).toEqual({
			maxCharacters: 1000,
			videoSizeLimit: 103_809_024,
			videoMatrixLimit: 8_294_400,
			videoFrameRateLimit: 120
		});
	});

	it('says nothing rather than guess when the instance does not answer, or leaves a limit out', async () => {
		const down = fakeNetwork({ '/api/v2/instance': () => new Response('', { status: 503 }) });
		expect(await mastodonInstanceLimits('https://example.social', down.fetchImpl)).toBeNull();
		const older = fakeNetwork({
			'/api/v2/instance': () =>
				Response.json({ configuration: { statuses: { max_characters: 5000 } } })
		});
		expect(await mastodonInstanceLimits('https://example.social', older.fetchImpl)).toEqual({
			maxCharacters: 5000
		});
	});
});

describe('X video', () => {
	const creds = { accessToken: 'tok', xUserId: '42' };
	const CHUNK = 5_000_000;

	function xNetwork(opts: { finalize?: unknown; tweet?: Handler } = {}) {
		const appends: { index: string; size: number }[] = [];
		const record = { inits: 0, init: null as unknown, tweet: null as unknown };
		const net = fakeNetwork({
			'/2/media/upload/initialize': async (req) => {
				record.inits += 1;
				record.init = await req.json();
				return Response.json({ data: { id: 'x-media' } });
			},
			'/append': async (req) => {
				const form = await req.formData();
				appends.push({
					index: String(form.get('segment_index')),
					size: (form.get('media') as File).size
				});
				return new Response(null, { status: 204 });
			},
			'/finalize': () =>
				Response.json(
					opts.finalize ?? {
						data: { id: 'x-media', processing_info: { state: 'pending', check_after_secs: 0 } }
					}
				),
			'command=STATUS': () => Response.json({ data: { processing_info: { state: 'succeeded' } } }),
			'/2/media/metadata': () => Response.json({}),
			'/2/tweets':
				opts.tweet ??
				(async (req) => {
					record.tweet = await req.json();
					return Response.json({ data: { id: 't1' } }, { status: 201 });
				})
		});
		return { ...net, appends, record };
	}

	it('appends 5 MB segments across runs, then posts the video', async () => {
		const size = 2 * CHUNK + 1234;
		const { store, video } = await storedVideo(size);
		const n = xNetwork();
		n.net.left = 12;
		const err = await parked(
			xProvider.publish({ text: 'clip', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never,
				callsLeft: n.callsLeft
			})
		);
		expect(err.pending?.state).toEqual({ mediaId: 'x-media', size, next: 2 });
		expect(n.record.init).toEqual({
			media_type: 'video/mp4',
			total_bytes: size,
			media_category: 'tweet_video'
		});

		n.net.left = Infinity;
		const result = await xProvider.publish(
			{ text: 'clip', media: [video] },
			creds,
			undefined,
			n.fetchImpl,
			{ mediaReader: store as never, resume: resumeFrom(err) }
		);
		expect(result.remotePostId).toBe('t1');
		expect(n.record.inits).toBe(1);
		expect(n.appends).toEqual([
			{ index: '0', size: CHUNK },
			{ index: '1', size: CHUNK },
			{ index: '2', size: 1234 }
		]);
		expect(n.record.tweet).toMatchObject({ text: 'clip', media: { media_ids: ['x-media'] } });
	});

	it('says plainly when X refuses a video as too long', async () => {
		const { store, video } = await storedVideo(1000);
		const n = xNetwork({
			finalize: { data: { id: 'x-media' } },
			tweet: () =>
				new Response('{"detail":"You are not allowed to post a video longer than 140 seconds"}', {
					status: 403
				})
		});
		const err = await xProvider
			.publish({ text: 'clip', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never
			})
			.catch((e: unknown) => e as ProviderError);
		expect((err as ProviderError).code).toBe('forbidden');
		expect((err as ProviderError).message).toBe(
			'X refused the video as too long for this account. Videos over 2:20 need X Premium.'
		);
	});
});

describe('pollVideo', () => {
	it('asks once more only while there is time for another wait', async () => {
		let asked = 0;
		let left = 250;
		const result = await pollVideo(
			{ polls: 10, delayMs: 100, reserve: 0, timeLeft: () => left },
			async () => {
				asked += 1;
				left -= 100;
				return null;
			}
		);
		expect(result).toBeNull();
		expect(asked).toBe(2);
	});

	it('keeps asking until it answers when time is not limited', async () => {
		let asked = 0;
		const result = await pollVideo({ polls: 5, delayMs: 0, reserve: 0 }, async () =>
			++asked === 3 ? 'ready' : null
		);
		expect(result).toBe('ready');
		expect(asked).toBe(3);
	});
});
