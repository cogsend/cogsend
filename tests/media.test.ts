import { describe, expect, it } from 'vitest';
import {
	canAttachMoreImages,
	detectImageMime,
	groupMediaBySegment,
	MAX_IMAGES_PER_SEGMENT,
	remapSegmentIndexAfterRemoval,
	validateImageUpload
} from '#lib/domain/media-limits.js';

describe('validateImageUpload', () => {
	it('accepts png/jpeg/webp/gif under size limit', () => {
		for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
			const r = validateImageUpload({ mime, size: 1024 });
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.mime).toBe(mime);
		}
	});
	it('rejects unsupported mime', () => {
		const r = validateImageUpload({ mime: 'application/pdf', size: 100 });
		expect(r.ok).toBe(false);
	});
	it('rejects oversized files', () => {
		const r = validateImageUpload({ mime: 'image/png', size: 20_000_000 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/too large/i);
	});
	it('rejects empty', () => {
		expect(validateImageUpload({ mime: 'image/png', size: 0 }).ok).toBe(false);
	});
	it('strips mime parameters', () => {
		expect(validateImageUpload({ mime: 'image/png; charset=binary', size: 10 }).ok).toBe(true);
	});
	it('sniffs png magic and rejects spoofed jpeg', () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(detectImageMime(png)).toBe('image/png');
		const r = validateImageUpload({ mime: 'image/jpeg', size: png.length, bytes: png });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.mime).toBe('image/png');
	});
	it('rejects non-image bytes even if mime says png', () => {
		const r = validateImageUpload({
			mime: 'image/png',
			size: 8,
			bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
		});
		expect(r.ok).toBe(false);
	});
});

describe('canAttachMoreImages', () => {
	it('allows under cap', () => {
		expect(canAttachMoreImages(0)).toBe(true);
		expect(canAttachMoreImages(3)).toBe(true);
	});
	it('blocks at 4', () => {
		expect(canAttachMoreImages(MAX_IMAGES_PER_SEGMENT)).toBe(false);
	});
});

describe('remapSegmentIndexAfterRemoval', () => {
	it('deletes media on removed segment', () => {
		expect(remapSegmentIndexAfterRemoval(1, 1)).toBeNull();
	});
	it('shifts later segments down', () => {
		expect(remapSegmentIndexAfterRemoval(2, 1)).toBe(1);
		expect(remapSegmentIndexAfterRemoval(0, 1)).toBe(0);
	});
});

describe('groupMediaBySegment', () => {
	it('groups by segmentIndex', () => {
		const map = groupMediaBySegment([
			{ id: 'a', segmentIndex: 0 },
			{ id: 'b', segmentIndex: 1 },
			{ id: 'c', segmentIndex: 0 }
		]);
		expect(map.get(0)?.map((x) => x.id)).toEqual(['a', 'c']);
		expect(map.get(1)?.map((x) => x.id)).toEqual(['b']);
	});
});

describe('media serve hardening', () => {
	it('rejects validation failures with 400, not 500', async () => {
		const { saveMediaBytes } = await import('#lib/server/media.js');
		const { createTestMedia } = await import('#lib/server/db/test.js');
		const store = createTestMedia();
		const err = await saveMediaBytes(store, {
			bytes: new Uint8Array([1, 2, 3]),
			mime: 'image/unsupported-xyz'
		}).then(
			() => null,
			(e: unknown) => e
		);
		expect(err).toBeTruthy();
		expect((err as { status?: number }).status).toBe(400);
	});

	it('strict storage keys block traversal and legacy fakes', async () => {
		const { assertSafeStorageKey, saveMediaBytes } = await import('#lib/server/media.js');
		const { createTestMedia } = await import('#lib/server/db/test.js');
		const store = createTestMedia();
		const saved = await saveMediaBytes(store, {
			bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
			mime: 'image/png'
		});
		expect(() => assertSafeStorageKey(saved.storageKey)).not.toThrow();
		for (const bad of ['../x', 'a/b', 'pub-key-1', '..', '', '1-abc.png', 'x'.repeat(200)]) {
			expect(() => assertSafeStorageKey(bad)).toThrow(/Invalid key/);
		}
	});

	it('serves byte ranges with 206', async () => {
		const { serveMediaBytes } = await import('#lib/server/media.js');
		const { createTestMedia } = await import('#lib/server/db/test.js');
		const store = createTestMedia();
		await store.put('k', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'image/png');
		const full = await serveMediaBytes(store, 'k', undefined, {
			mime: 'image/png',
			cacheControl: 'private, max-age=60'
		});
		expect(full.status).toBe(200);
		expect(full.headers.get('X-Content-Type-Options')).toBe('nosniff');
		const part = await serveMediaBytes(
			store,
			'k',
			new Request('https://x.test/', { headers: { Range: 'bytes=2-5' } }),
			{ mime: 'image/png', cacheControl: 'private, max-age=60' }
		);
		expect(part.status).toBe(206);
		expect(part.headers.get('Content-Range')).toBe('bytes 2-5/10');
		expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]));
		const bad = await serveMediaBytes(
			store,
			'k',
			new Request('https://x.test/', { headers: { Range: 'bytes=99-100' } }),
			{ mime: 'image/png', cacheControl: 'private, max-age=60' }
		);
		expect(bad.status).toBe(416);
		// RFC 7233 suffix range: bytes=-3 means the LAST 3 bytes.
		const suffix = await serveMediaBytes(
			store,
			'k',
			new Request('https://x.test/', { headers: { Range: 'bytes=-3' } }),
			{ mime: 'image/png', cacheControl: 'private, max-age=60' }
		);
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get('Content-Range')).toBe('bytes 7-9/10');
		expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
	});
});
