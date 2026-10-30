import { randomHex } from '#lib/domain/bytes.js';
import { decodeImageDimensions } from './image-dimensions';
import { validateImageUpload, validateVideoUpload } from '#lib/domain/media-limits.js';
import { probeMp4, probeMp4Bytes, type Mp4Facts } from '#lib/domain/mp4-probe.js';
import type { MediaStore } from './providers/types';

export type { MediaStore };

async function streamBytes(body: ReadableStream | Uint8Array): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	return new Uint8Array(await new Response(body).arrayBuffer());
}

export function memoryMediaStore(
	map = new Map<string, { bytes: Uint8Array; mime: string }>()
): MediaStore {
	const uploads = new Map<string, { key: string; mime: string; parts: Map<number, Uint8Array> }>();
	return {
		multipart: {
			async create(key, mime) {
				const uploadId = randomHex(8);
				uploads.set(uploadId, { key, mime, parts: new Map() });
				return uploadId;
			},
			async uploadPart(key, uploadId, partNumber, body) {
				const upload = uploads.get(uploadId);
				if (!upload || upload.key !== key) throw new Error('No such upload');
				upload.parts.set(partNumber, await streamBytes(body));
				return { partNumber, etag: `etag-${partNumber}` };
			},
			async complete(key, uploadId, parts) {
				const upload = uploads.get(uploadId);
				if (!upload || upload.key !== key) throw new Error('No such upload');
				const chunks = parts.map((p) => {
					const chunk = upload.parts.get(p.partNumber);
					if (!chunk || p.etag !== `etag-${p.partNumber}`) throw new Error('Bad part');
					return chunk;
				});
				const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
				let at = 0;
				for (const c of chunks) {
					bytes.set(c, at);
					at += c.length;
				}
				map.set(key, { bytes, mime: upload.mime });
				uploads.delete(uploadId);
				return bytes.length;
			},
			async abort(_key, uploadId) {
				uploads.delete(uploadId);
			}
		},
		async copy(from, to) {
			const found = map.get(from);
			if (!found) return false;
			map.set(to, { bytes: found.bytes.slice(), mime: found.mime });
			return true;
		},
		async get(key) {
			return map.get(key)?.bytes ?? null;
		},
		async getRange(key, start, end) {
			const bytes = map.get(key)?.bytes;
			if (!bytes) return null;
			return bytes.slice(start, end + 1);
		},
		async size(key) {
			return map.get(key)?.bytes.length ?? null;
		},
		async open(key, range) {
			const bytes = map.get(key)?.bytes;
			if (!bytes) return null;
			const slice = range ? bytes.slice(range.start, range.end + 1) : bytes.slice();
			return { body: new Blob([slice]).stream(), size: bytes.length };
		},
		async put(key, bytes, mime) {
			map.set(key, { bytes, mime });
		},
		async delete(key) {
			map.delete(key);
		},
		async deleteMany(keys) {
			for (const key of keys) map.delete(key);
		}
	};
}

export function r2MediaStore(bucket: R2Bucket): MediaStore {
	return {
		multipart: {
			async create(key, mime) {
				const upload = await bucket.createMultipartUpload(key, {
					httpMetadata: { contentType: mime }
				});
				return upload.uploadId;
			},
			async uploadPart(key, uploadId, partNumber, body) {
				const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
				return { partNumber: part.partNumber, etag: part.etag };
			},
			async complete(key, uploadId, parts) {
				const done = await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
				return done.size;
			},
			async abort(key, uploadId) {
				await bucket.resumeMultipartUpload(key, uploadId).abort();
			}
		},
		// An R2 body knows its length, so put() streams it without buffering.
		async copy(from, to) {
			const obj = await bucket.get(from);
			if (!obj) return false;
			await bucket.put(to, obj.body, { httpMetadata: obj.httpMetadata });
			return true;
		},
		async get(key) {
			const obj = await bucket.get(key);
			if (!obj) return null;
			return new Uint8Array(await obj.arrayBuffer());
		},
		// Range read: serves video seeks + large files without loading the
		// whole object into Worker memory (128MB limit vs 95MB videos).
		async getRange(key, start, end) {
			const obj = await bucket.get(key, {
				range: { offset: start, length: end - start + 1 }
			});
			if (!obj) return null;
			return new Uint8Array(await obj.arrayBuffer());
		},
		async size(key) {
			const obj = await bucket.head(key);
			return obj?.size ?? null;
		},
		async open(key, range) {
			const obj = await bucket.get(
				key,
				range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined
			);
			if (!obj) return null;
			// `size` is the whole object's, whatever range was read.
			return { body: obj.body, size: obj.size };
		},
		async put(key, bytes, mime) {
			await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
		},
		async delete(key) {
			await bucket.delete(key);
		},
		// One subrequest per 1,000 keys instead of one per key.
		async deleteMany(keys) {
			if (!keys.length) return;
			await bucket.delete(keys);
		}
	};
}

/** What `draft_media.meta_json` holds for a video. */
export interface StoredVideoMeta {
	durationMs: number;
	videoCodec: string | null;
	audioCodec: string | null;
	fps: number | null;
	faststart: boolean;
	/** Set once a cover is stored at coverKey(): `v` versions its URL, `atMs`
	 *  is the frame it came from when it is one. */
	cover?: { v: number; atMs?: number };
}

export function videoMetaFrom(facts: Mp4Facts): StoredVideoMeta {
	return {
		durationMs: facts.durationMs,
		videoCodec: facts.videoCodec,
		audioCodec: facts.audioCodec,
		fps: facts.fps,
		faststart: facts.faststart
	};
}

const UNREADABLE_VIDEO =
	'Could not read this video. Attach it from the composer, which converts it to MP4';

/** 400 unless the facts describe a playable video. */
export function requirePlayableVideo(facts: Mp4Facts | null): Mp4Facts {
	if (!facts || !facts.videoCodec || facts.durationMs <= 0) {
		throw Object.assign(new Error(UNREADABLE_VIDEO), { status: 400 });
	}
	return facts;
}

/** Probe an object already in storage, reading only its index. */
export async function probeStoredVideo(
	store: MediaStore,
	key: string,
	size: number
): Promise<Mp4Facts | null> {
	const read = store.getRange
		? (start: number, end: number) => store.getRange!(key, start, end)
		: async (start: number, end: number) => (await store.get(key))?.slice(start, end + 1) ?? null;
	return probeMp4(read, size);
}

export async function saveMediaBytes(
	store: MediaStore,
	file: { bytes: Uint8Array; mime: string }
): Promise<{
	storageKey: string;
	size: number;
	mime: string;
	width: number | null;
	height: number | null;
	video: StoredVideoMeta | null;
}> {
	const isVideo = (file.mime || '').toLowerCase().split(';')[0].trim().startsWith('video/');
	const check = isVideo
		? validateVideoUpload({ mime: file.mime, size: file.bytes.length, bytes: file.bytes })
		: validateImageUpload({
				mime: file.mime,
				size: file.bytes.length,
				bytes: file.bytes
			});
	// 400, not 500: validation failure is a client error. Plain Error would
	// mis-classify as a server error and pollute 500 alerting.
	if (!check.ok) throw Object.assign(new Error(check.message), { status: 400 });
	const facts = isVideo ? requirePlayableVideo(await probeMp4Bytes(file.bytes)) : null;
	const ext =
		check.mime === 'video/mp4'
			? 'mp4'
			: check.mime === 'image/png'
				? 'png'
				: check.mime === 'image/webp'
					? 'webp'
					: check.mime === 'image/gif'
						? 'gif'
						: 'jpg';
	const storageKey = `${Date.now()}-${randomHex(8)}.${ext}`;
	await store.put(storageKey, file.bytes, check.mime);
	// Decode dims for Bluesky aspectRatio (layout hint). Null when unknown —
	// callers omit aspectRatio instead of guessing (per Bluesky docs).
	let width: number | null = facts?.width ?? null;
	let height: number | null = facts?.height ?? null;
	if (!isVideo) {
		try {
			const dims = decodeImageDimensions(file.bytes);
			if (dims) {
				width = dims.width;
				height = dims.height;
			}
		} catch {
			/* omit on failure */
		}
	}
	return {
		storageKey,
		size: file.bytes.length,
		mime: check.mime,
		width,
		height,
		video: facts ? videoMetaFrom(facts) : null
	};
}

// Keys are always minted by saveMediaBytes (`<ms>-<16 hex>.<ext>`): enforce
// that shape exactly. Blocks traversal, NUL/control chars, overlong keys and
// `%2F`-decoded slashes (SvelteKit decodes params before this check).
const STORAGE_KEY_RE = /^[0-9]{1,20}-[0-9a-f]{16}\.(jpg|png|webp|gif|mp4)$/;

export function assertSafeStorageKey(key: string): string {
	if (!key || key.length > 128 || !STORAGE_KEY_RE.test(key)) {
		throw Object.assign(new Error('Invalid key'), { status: 400 });
	}
	return key;
}

/** Private media keys never change, so the browser can keep them. */
export const PRIVATE_MEDIA_CACHE = 'private, max-age=31536000, immutable';
/** Longest edge of a posts-grid thumbnail. CSS shows 80px; this covers 2x. */
export const THUMB_EDGE = 160;

export function thumbCacheKey(storageKey: string): string {
	return `thumb/${storageKey}`;
}

/** A video's cover image, kept beside it so every cleanup path removes both. */
export function coverKey(storageKey: string): string {
	return `cover/${storageKey}`;
}

/**
 * A smaller copy of an image for the composer and Posts, which the browser
 * makes when it uploads one. Publishing always sends the original.
 */
export function previewKey(storageKey: string): string {
	return `preview/${storageKey}`;
}

/** A browser preview is a JPEG of at most 1280 px; anything larger is not one. */
export const MAX_PREVIEW_BYTES = 1_000_000;

/**
 * A JPEG of a PNG or WebP original, for Instagram, which takes nothing else.
 * The browser makes it at upload; the Images binding, when the deployment has
 * it, makes one later for an image that arrived without.
 */
export function jpegKey(storageKey: string): string {
	return `jpeg/${storageKey}`;
}

/** Instagram's own cap on a photo. */
export const MAX_JPEG_COPY_BYTES = 8_000_000;

/** What `draft_media.meta_json` holds for an image. */
export interface StoredImageMeta {
	/** Set once a preview is stored at previewKey(); `v` versions its URL. */
	preview?: { v: number };
	/** Set once a JPEG copy is stored at jpegKey(). */
	jpeg?: { v: number };
}

/**
 * Still images larger than the grid. GIF stays original so animation survives,
 * and an image that is already small is not worth a second encode.
 */
export function thumbCandidate(
	mime: string | null | undefined,
	width: number | null | undefined,
	height: number | null | undefined
): boolean {
	const type = (mime || '').toLowerCase().split(';')[0].trim();
	if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/webp') return false;
	if (width && height && width <= THUMB_EDGE && height <= THUMB_EDGE) return false;
	return true;
}

/**
 * Optional Cloudflare Images binding (`images.binding = "IMAGES"`). Absent on
 * a deployment that has not enabled it, in which case the original is served.
 */
export interface ImageResizer {
	input(source: ReadableStream | ArrayBuffer | Uint8Array): {
		transform(opts: { width: number; fit: 'scale-down'; background?: string }): {
			output(opts: { format: string; quality: number }): Promise<{ response(): Response }>;
		};
	};
}

export async function storedThumbnail(
	store: MediaStore,
	key: string,
	images: ImageResizer | null | undefined
): Promise<Uint8Array | null> {
	const cacheKey = thumbCacheKey(key);
	const cached = await store.get(cacheKey);
	if (cached) return cached;
	if (!images) return null;
	const original = await store.get(key);
	if (!original) return null;
	try {
		const copy = new Uint8Array(original.byteLength);
		copy.set(original);
		const rendered = await images
			.input(new Blob([copy]).stream())
			.transform({ width: THUMB_EDGE, fit: 'scale-down' })
			.output({ format: 'image/jpeg', quality: 75 });
		const response = await rendered.response();
		if (!response.ok) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!bytes.byteLength) return null;
		await store.put(cacheKey, bytes, 'image/jpeg');
		return bytes;
	} catch {
		return null;
	}
}

/** An animated WebP sets the animation flag in its VP8X header. */
export function isAnimatedWebpBytes(bytes: Uint8Array): boolean {
	if (bytes.length < 21) return false;
	return String.fromCharCode(...bytes.slice(12, 16)) === 'VP8X' && (bytes[20] & 0x02) !== 0;
}

/**
 * The Images binding's version of the JPEG copy the browser makes at upload,
 * for an image that arrived without one: attached before the copy existed, or
 * uploaded through the API. Full size, so the copy is the photo, not a preview.
 * An animated WebP is left alone, as the browser leaves it.
 */
export async function makeStoredJpegCopy(
	store: MediaStore,
	key: string,
	width: number | null | undefined,
	images: ImageResizer
): Promise<boolean> {
	const original = await store.get(key);
	if (!original || isAnimatedWebpBytes(original)) return false;
	try {
		const copy = new Uint8Array(original.byteLength);
		copy.set(original);
		const rendered = await images
			.input(new Blob([copy]).stream())
			// JPEG has no alpha: without a fill, transparent pixels turn black.
			.transform({ width: width || 8192, fit: 'scale-down', background: '#ffffff' })
			.output({ format: 'image/jpeg', quality: 90 });
		const response = await rendered.response();
		if (!response.ok) return false;
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!bytes.byteLength || bytes.byteLength > MAX_JPEG_COPY_BYTES) return false;
		await store.put(jpegKey(key), bytes, 'image/jpeg');
		return true;
	} catch {
		return false;
	}
}

export function jpegResponse(bytes: Uint8Array, cacheControl: string): Response {
	return new Response(bytes as unknown as BodyInit, {
		headers: {
			'Content-Type': 'image/jpeg',
			'Cache-Control': cacheControl,
			'X-Content-Type-Options': 'nosniff',
			'Content-Length': String(bytes.byteLength)
		}
	});
}

/** Drop an object and what is kept beside it. Missing keys are fine. */
export async function deleteMediaObjects(store: MediaStore, keys: string[]): Promise<void> {
	const all = keys.flatMap((key) =>
		key.endsWith('.mp4')
			? [key, thumbCacheKey(key), coverKey(key)]
			: [key, thumbCacheKey(key), previewKey(key), jpegKey(key)]
	);
	if (!all.length) return;
	if (store.deleteMany) {
		await store.deleteMany(all);
		return;
	}
	for (const key of all) await store.delete(key);
}

// MIME types the server will ever serve. Anything else in D1 (manual edit,
// future bug) falls back to octet-stream so attacker bytes never render as
// HTML in the app origin.
const SERVABLE_MIME_RE = /^(image\/(jpeg|png|webp|gif)|video\/mp4)$/;

export function servableMime(mime: string | null | undefined): string {
	const m = (mime || '').toLowerCase().split(';')[0].trim();
	return SERVABLE_MIME_RE.test(m) ? m : 'application/octet-stream';
}

// Serve with Range/206 support + hardening headers. Range requests read only
// the bytes they ask for. A store that can stream (R2) never holds the file in
// the isolate (128MB limit vs 95MB videos); one that cannot buffers it.
export async function serveMediaBytes(
	store: MediaStore,
	key: string,
	request: Request | undefined,
	opts: { mime: string | null | undefined; cacheControl: string }
): Promise<Response> {
	const baseHeaders = {
		'Content-Type': servableMime(opts.mime),
		'Accept-Ranges': 'bytes',
		'X-Content-Type-Options': 'nosniff',
		'Cache-Control': opts.cacheControl
	};
	const range = request?.headers.get('Range');
	if (!range && store.open) {
		// One read: the stream carries the size, so there is no HEAD first.
		const whole = await store.open(key);
		if (!whole) return new Response('Not found', { status: 404 });
		return new Response(whole.body, {
			headers: { ...baseHeaders, 'Content-Length': String(whole.size) }
		});
	}
	const total = (await store.size?.(key)) ?? (await store.get(key))?.length ?? null;
	if (total === null) return new Response('Not found', { status: 404 });
	if (!range) {
		const bytes = store.getRange ? await store.getRange(key, 0, total - 1) : await store.get(key);
		if (!bytes) return new Response('Not found', { status: 404 });
		return new Response(bytes as unknown as BodyInit, {
			headers: { ...baseHeaders, 'Content-Length': String(bytes.length) }
		});
	}
	const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
	if (!m) {
		return new Response('Range unsatisfiable', {
			status: 416,
			headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` }
		});
	}
	// RFC 7233: `bytes=-N` is a suffix range — the LAST N bytes — not a
	// prefix. Video players probe the tail of an mp4 (moov atom) this way;
	// reading it as 0-N hands them the wrong bytes. Suffix 0 is unsatisfiable.
	let start: number;
	let end: number;
	if (!m[1] && m[2]) {
		const n = Number(m[2]);
		if (!Number.isInteger(n) || n < 1) {
			return new Response('Range unsatisfiable', {
				status: 416,
				headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` }
			});
		}
		start = Math.max(0, total - n);
		end = total - 1;
	} else {
		start = m[1] ? Number(m[1]) : 0;
		end = m[2] ? Number(m[2]) : total - 1;
	}
	if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= total) {
		return new Response('Range unsatisfiable', {
			status: 416,
			headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` }
		});
	}
	const clamped = Math.min(end, total - 1);
	const partHeaders = {
		...baseHeaders,
		'Content-Range': `bytes ${start}-${clamped}/${total}`,
		'Content-Length': String(clamped - start + 1)
	};
	if (store.open) {
		const part = await store.open(key, { start, end: clamped });
		if (!part) return new Response('Not found', { status: 404 });
		return new Response(part.body, { status: 206, headers: partHeaders });
	}
	const bytes = store.getRange
		? await store.getRange(key, start, clamped)
		: ((await store.get(key))?.slice(start, clamped + 1) ?? null);
	if (!bytes) return new Response('Not found', { status: 404 });
	return new Response(bytes as unknown as BodyInit, {
		status: 206,
		headers: { ...partHeaders, 'Content-Length': String(bytes.length) }
	});
}
