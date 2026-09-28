import { randomHex } from '$lib/domain/bytes';
import { decodeImageDimensions } from './image-dimensions';
import { validateImageUpload, validateVideoUpload } from '$lib/domain/media-limits';
import type { MediaStore } from './providers/types';

export type { MediaStore };

export function memoryMediaStore(
	map = new Map<string, { bytes: Uint8Array; mime: string }>()
): MediaStore {
	return {
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

export async function saveMediaBytes(
	store: MediaStore,
	file: { bytes: Uint8Array; mime: string }
): Promise<{
	storageKey: string;
	size: number;
	mime: string;
	width: number | null;
	height: number | null;
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
	let width: number | null = null;
	let height: number | null = null;
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
	return { storageKey, size: file.bytes.length, mime: check.mime, width, height };
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
		transform(opts: { width: number; fit: 'scale-down' }): {
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

/** Drop an object and any cached thumbnail. Missing keys are fine. */
export async function deleteMediaObjects(store: MediaStore, keys: string[]): Promise<void> {
	const all = keys.flatMap((key) => [key, thumbCacheKey(key)]);
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
