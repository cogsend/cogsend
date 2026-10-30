export const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const MAX_IMAGE_BYTES = 16_000_000;
// app.bsky.embed.images raised the blob cap from 1MB to 2MB. The link-card
// thumb (app.bsky.embed.external) is still 1MB, so it keeps its own limit.
export const BLUESKY_MAX_IMAGE_BYTES = 2_000_000;
export const LINKEDIN_MAX_IMAGE_BYTES = 8_000_000;
// LinkedIn combines a flattened thread into one post, so this is a per-post
// cap. The provider imports this, so the two cannot drift.
export const LINKEDIN_MAX_IMAGES = 4;
export const X_MAX_IMAGE_BYTES = 5_000_000;
export const X_MAX_GIF_BYTES = 15_000_000;
export const THREADS_MAX_IMAGE_BYTES = 8_000_000;
export const INSTAGRAM_MAX_IMAGE_BYTES = 8_000_000;
// Instagram takes 20 in a carousel, but each item costs a create and a status
// read, and 20 would not fit one run's 50 calls on the Workers Free plan. A
// flattened thread is one post there, as on LinkedIn, so this counts the
// whole thread's media.
export const INSTAGRAM_MAX_ITEMS = 10;
export const MAX_IMAGES_PER_SEGMENT = 4;

// The largest video any route stores. Bluesky's 300 MB is the smallest cap
// among the platforms that take long videos; larger files go up in parts
// (api/drafts/[id]/media/uploads), so the 100 MB request limit does not apply.
export const MAX_VIDEO_BYTES = 300_000_000;

function looksLikeMp4(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 12 &&
		bytes[4] === 0x66 &&
		bytes[5] === 0x74 &&
		bytes[6] === 0x79 &&
		bytes[7] === 0x70
	);
}

/** Video validation (mp4 only). Sniffs ftyp when bytes are present. */
export function validateVideoUpload(input: {
	mime: string;
	size: number;
	bytes?: Uint8Array;
}): MediaValidationResult {
	const declared = (input.mime || '').toLowerCase().split(';')[0].trim();
	if (declared !== 'video/mp4') {
		return {
			ok: false,
			message: `Unsupported video type: ${input.mime || 'unknown'} (use MP4)`
		};
	}
	if (input.bytes && input.bytes.length > 0 && !looksLikeMp4(input.bytes)) {
		return { ok: false, message: 'File does not look like an MP4 video' };
	}
	if (input.size <= 0) return { ok: false, message: 'Empty file' };
	if (input.size > MAX_VIDEO_BYTES) {
		return { ok: false, message: 'Video too large (max 300MB)' };
	}
	return { ok: true, mime: 'video/mp4' };
}

export type MediaValidationOk = { ok: true; mime: string };
export type MediaValidationErr = { ok: false; message: string };
export type MediaValidationResult = MediaValidationOk | MediaValidationErr;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
	if (bytes.length < sig.length) return false;
	return sig.every((b, i) => bytes[i] === b);
}

export function detectImageMime(bytes: Uint8Array): string | null {
	if (startsWith(bytes, PNG)) return 'image/png';
	if (startsWith(bytes, JPEG)) return 'image/jpeg';
	if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif';
	if (
		bytes.length >= 12 &&
		startsWith(bytes, WEBP_RIFF) &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return 'image/webp';
	}
	return null;
}

export function validateImageUpload(input: {
	mime: string;
	size: number;
	maxBytes?: number;
	bytes?: Uint8Array;
}): MediaValidationResult {
	const declared = (input.mime || '').toLowerCase().split(';')[0].trim();
	let mime = declared;

	if (input.bytes && input.bytes.length > 0) {
		const sniffed = detectImageMime(input.bytes);
		if (!sniffed) {
			return {
				ok: false,
				message: `Unsupported media type: ${input.mime || 'unknown'} (use PNG, JPEG, WebP, or GIF)`
			};
		}
		mime = sniffed;
	}

	if (!ALLOWED_IMAGE_MIMES.has(mime)) {
		return {
			ok: false,
			message: `Unsupported media type: ${input.mime || 'unknown'} (use PNG, JPEG, WebP, or GIF)`
		};
	}

	const max = input.maxBytes ?? MAX_IMAGE_BYTES;
	if (input.size <= 0) return { ok: false, message: 'Empty file' };
	if (input.size > max) {
		const mb = Math.round(max / 1_000_000);
		return { ok: false, message: `File too large (max ${mb}MB)` };
	}
	return { ok: true, mime };
}

const PLATFORM_LABEL = {
	bluesky: 'Bluesky',
	linkedin: 'LinkedIn',
	threads: 'Threads',
	instagram: 'Instagram',
	x: 'X'
};

function imageCap(platform: string, mime: string): number | null {
	if (platform === 'bluesky') return BLUESKY_MAX_IMAGE_BYTES;
	if (platform === 'linkedin') return LINKEDIN_MAX_IMAGE_BYTES;
	if (platform === 'threads') return THREADS_MAX_IMAGE_BYTES;
	// Anything else goes to Instagram as its JPEG copy, capped when it is made.
	if (platform === 'instagram') return mime === 'image/jpeg' ? INSTAGRAM_MAX_IMAGE_BYTES : null;
	if (platform === 'x') return mime === 'image/gif' ? X_MAX_GIF_BYTES : X_MAX_IMAGE_BYTES;
	return null;
}

/**
 * The first attached image a selected platform would refuse for its size, as
 * a message to show before publishing, or null. The providers refuse the same
 * image at publish time; checking here stops a guaranteed failure from being
 * scheduled. Video has its own rules in `video-rules`.
 */
export function mediaSizeProblem(
	platforms: Iterable<string>,
	media: { mime: string; size?: number }[]
): string | null {
	for (const platform of platforms) {
		const over = imageOverCap(platform, media);
		if (over) {
			const label = PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL];
			return `${over} — remove it or uncheck ${label}`;
		}
	}
	return null;
}

/** The first image `platform` would refuse for its size, said plainly. */
export function imageOverCap(
	platform: string,
	media: { mime: string; size?: number }[]
): string | null {
	for (const m of media) {
		const mime = (m.mime || '').toLowerCase();
		if (mime.startsWith('video/') || m.size === undefined) continue;
		const cap = imageCap(platform, mime);
		if (cap !== null && m.size > cap) {
			const label = PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL];
			return `An image is over ${label}'s ${cap / 1_000_000}MB limit`;
		}
	}
	return null;
}

/** An attachment as far as Instagram's rules care. */
export interface InstagramMediaFacts {
	mime: string;
	width?: number | null;
	height?: number | null;
	/** A JPEG copy was stored beside a PNG or WebP original. */
	hasJpegCopy?: boolean;
}

// Feed photos run from 4:5 portrait to 1.91:1 landscape; a hair of slack so a
// 1080×1350 crop rounded by an editor still counts as 4:5.
const INSTAGRAM_MIN_ASPECT = 0.8 - 0.005;
const INSTAGRAM_MAX_ASPECT = 1.91 + 0.005;

/**
 * What stops a post from going to Instagram, worst first, given the whole
 * flattened post's media. One rule for the composer, the API and the provider:
 * Instagram is the one platform that refuses a post without a photo or video.
 */
export function instagramMediaProblems(media: InstagramMediaFacts[]): string[] {
	if (media.length === 0) return ['Instagram needs a photo or video'];
	const problems: string[] = [];
	const videos = media.filter((m) => (m.mime || '').toLowerCase().startsWith('video/'));
	const images = media.length - videos.length;
	if (videos.length > 1 || (videos.length && images)) {
		problems.push('Instagram posts a video on its own, as a Reel');
	}
	if (images > INSTAGRAM_MAX_ITEMS) {
		problems.push(`Instagram takes up to ${INSTAGRAM_MAX_ITEMS} photos (${images} attached)`);
	}
	for (const m of media) {
		const mime = (m.mime || '').toLowerCase();
		if (mime.startsWith('video/')) continue;
		if (mime === 'image/gif') {
			problems.push("Instagram doesn't take GIFs");
			break;
		}
		if (mime !== 'image/jpeg' && !m.hasJpegCopy) {
			problems.push('Instagram takes JPEG only — attach this image again, or as a JPEG');
			break;
		}
	}
	const offShape = media.some((m) => {
		if ((m.mime || '').toLowerCase().startsWith('video/') || !m.width || !m.height) return false;
		const aspect = m.width / m.height;
		return aspect < INSTAGRAM_MIN_ASPECT || aspect > INSTAGRAM_MAX_ASPECT;
	});
	if (offShape) problems.push('Instagram takes photos from 4:5 tall to 1.91:1 wide');
	return problems;
}

/**
 * Every platform takes one video per post, on its own: the upload routes
 * refuse anything else on a card so it cannot fail later at publish.
 */
export function videoMixProblem(videos: number, images: number): string | null {
	if (videos > 1) return 'Only one video per post';
	if (videos > 0 && images > 0) return 'Videos cannot mix with images on the same post';
	return null;
}

export function canAttachMoreImages(currentCount: number, max = MAX_IMAGES_PER_SEGMENT): boolean {
	return currentCount < max;
}

export function remapSegmentIndexAfterRemoval(
	segmentIndex: number,
	removedIndex: number
): number | null {
	if (segmentIndex === removedIndex) return null;
	if (segmentIndex > removedIndex) return segmentIndex - 1;
	return segmentIndex;
}

export function groupMediaBySegment<T extends { segmentIndex?: number | null }>(
	items: T[]
): Map<number, T[]> {
	const map = new Map<number, T[]>();
	for (const item of items) {
		const idx = item.segmentIndex ?? 0;
		const list = map.get(idx) ?? [];
		list.push(item);
		map.set(idx, list);
	}
	return map;
}
