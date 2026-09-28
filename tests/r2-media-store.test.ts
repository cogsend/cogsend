import { describe, expect, it } from 'vitest';
import { r2MediaStore, serveMediaBytes } from '$lib/server/media';

/**
 * `r2MediaStore` is the production store — every upload, media serve and
 * provider hand-off goes through it — and no test executed a line of it; the
 * suite only ever used the in-memory stand-in. These exercise it against a
 * minimal R2 stand-in so the two stores cannot drift.
 */
function fakeBucket() {
	const objects = new Map<string, { bytes: Uint8Array; mime?: string }>();
	const bucket = {
		async get(key: string, opts?: { range?: { offset: number; length: number } }) {
			const entry = objects.get(key);
			if (!entry) return null;
			const bytes = opts?.range
				? entry.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length)
				: entry.bytes;
			return {
				// R2 reports the whole object's size, whatever range was read.
				size: entry.bytes.length,
				body: new Blob([bytes as BlobPart]).stream(),
				arrayBuffer: async () =>
					bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			};
		},
		async head(key: string) {
			const entry = objects.get(key);
			return entry ? { size: entry.bytes.length } : null;
		},
		async put(key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
			objects.set(key, { bytes, mime: opts?.httpMetadata?.contentType });
		},
		async delete(key: string) {
			objects.delete(key);
		}
	};
	return { bucket, objects };
}

describe('r2MediaStore', () => {
	it('round-trips bytes and records the content type', async () => {
		const { bucket, objects } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);

		await store.put('media/one.png', bytes, 'image/png');

		expect(await store.size!('media/one.png')).toBe(5);
		expect(await store.get('media/one.png')).toEqual(bytes);
		expect(objects.get('media/one.png')?.mime).toBe('image/png');
	});

	it('serves a byte range without the whole object', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		await store.put('media/video.mp4', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), 'video/mp4');

		expect(await store.getRange!('media/video.mp4', 2, 4)).toEqual(new Uint8Array([2, 3, 4]));
	});

	it('returns null for a missing key on every read path', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);

		expect(await store.get('nope')).toBeNull();
		expect(await store.getRange!('nope', 0, 10)).toBeNull();
		expect(await store.size!('nope')).toBeNull();
	});

	it('deletes', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		await store.put('media/two.png', new Uint8Array([9]), 'image/png');

		await store.delete('media/two.png');

		expect(await store.get('media/two.png')).toBeNull();
		// Deleting a missing key is a no-op, not an error.
		await expect(store.delete('media/two.png')).resolves.toBeUndefined();
	});
});

describe('streaming from R2', () => {
	const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	const read = async (body: ReadableStream) =>
		new Uint8Array(await new Response(body).arrayBuffer());

	it('opens the whole object or one range, with the total size', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		await store.put('media/clip.mp4', bytes, 'video/mp4');

		const whole = await store.open!('media/clip.mp4');
		expect(whole?.size).toBe(10);
		expect(await read(whole!.body)).toEqual(bytes);

		const part = await store.open!('media/clip.mp4', { start: 7, end: 9 });
		expect(part?.size).toBe(10);
		expect(await read(part!.body)).toEqual(new Uint8Array([7, 8, 9]));

		expect(await store.open!('nope')).toBeNull();
	});

	it('serves a file and a range as streams', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		await store.put('media/clip.mp4', bytes, 'video/mp4');
		const opts = { mime: 'video/mp4', cacheControl: 'private, max-age=60' };

		const full = await serveMediaBytes(store, 'media/clip.mp4', undefined, opts);
		expect(full.status).toBe(200);
		expect(full.headers.get('Content-Length')).toBe('10');
		expect(full.headers.get('Content-Type')).toBe('video/mp4');
		expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

		const tail = await serveMediaBytes(
			store,
			'media/clip.mp4',
			new Request('https://x.test/', { headers: { Range: 'bytes=-3' } }),
			opts
		);
		expect(tail.status).toBe(206);
		expect(tail.headers.get('Content-Range')).toBe('bytes 7-9/10');
		expect(tail.headers.get('Content-Length')).toBe('3');
		expect(new Uint8Array(await tail.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));

		const missing = await serveMediaBytes(store, 'media/none.mp4', undefined, opts);
		expect(missing.status).toBe(404);
	});
});
