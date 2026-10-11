import { describe, expect, it } from 'vitest';
import {
	MAX_VIDEO_BYTES,
	mediaSizeProblem,
	validateVideoUpload
} from '#lib/domain/media-limits.js';

/** `ftyp` at offset 4 is what `looksLikeMp4` sniffs. */
function mp4(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
	return bytes;
}

describe('validateVideoUpload', () => {
	it('accepts a real mp4 within the size cap', () => {
		expect(validateVideoUpload({ mime: 'video/mp4', size: 10, bytes: mp4(16) })).toEqual({
			ok: true,
			mime: 'video/mp4'
		});
	});

	it('accepts a declared mp4 when no bytes are inspected', () => {
		expect(validateVideoUpload({ mime: 'video/mp4; charset=binary', size: 1024 }).ok).toBe(true);
	});

	it('rejects other containers and codecs', () => {
		for (const mime of ['video/quicktime', 'video/webm', 'video/x-msvideo', '']) {
			const result = validateVideoUpload({ mime, size: 1024 });
			expect(result.ok).toBe(false);
		}
	});

	it('rejects bytes that are not an mp4 even when the mime says so', () => {
		const mov = new Uint8Array(16);
		mov.set([0x6d, 0x6f, 0x6f, 0x76], 4);
		const result = validateVideoUpload({ mime: 'video/mp4', size: 16, bytes: mov });
		expect(result).toEqual({ ok: false, message: 'File does not look like an MP4 video' });
	});

	it('rejects empty and oversized files', () => {
		expect(validateVideoUpload({ mime: 'video/mp4', size: 0 }).ok).toBe(false);
		const big = validateVideoUpload({ mime: 'video/mp4', size: MAX_VIDEO_BYTES + 1 });
		expect(big).toEqual({ ok: false, message: 'Video too large (max 95MB)' });
		expect(validateVideoUpload({ mime: 'video/mp4', size: MAX_VIDEO_BYTES }).ok).toBe(true);
	});

	it('does not sniff a truncated header into a false positive', () => {
		// Fewer than 8 bytes cannot carry `ftyp` at offset 4.
		const tiny = new Uint8Array([0x66, 0x74, 0x79, 0x70]);
		expect(validateVideoUpload({ mime: 'video/mp4', size: 4, bytes: tiny }).ok).toBe(false);
	});
});

describe('mediaSizeProblem', () => {
	const png = (size: number) => ({ mime: 'image/png', size });

	it('blocks an image over a selected platform cap', () => {
		expect(mediaSizeProblem(['bluesky'], [png(2_000_001)])).toBe(
			"An image is over Bluesky's 2MB limit — remove it or uncheck Bluesky"
		);
		expect(mediaSizeProblem(['x'], [png(5_000_001)])).toContain("X's 5MB");
	});

	it('ignores platforms that are not selected', () => {
		expect(mediaSizeProblem(['mastodon', 'linkedin'], [png(3_000_000)])).toBeNull();
	});

	it('gives GIFs on X their larger cap', () => {
		expect(mediaSizeProblem(['x'], [{ mime: 'image/gif', size: 10_000_000 }])).toBeNull();
		expect(mediaSizeProblem(['x'], [{ mime: 'image/gif', size: 15_000_001 }])).toContain('15MB');
	});

	it('leaves video and unknown sizes to the providers', () => {
		expect(mediaSizeProblem(['bluesky'], [{ mime: 'video/mp4', size: 50_000_000 }])).toBeNull();
		expect(mediaSizeProblem(['bluesky'], [{ mime: 'image/png' }])).toBeNull();
	});
});
