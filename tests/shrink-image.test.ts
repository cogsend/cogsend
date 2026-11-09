import { describe, expect, it } from 'vitest';
import {
	JPEG_COPY_MAX_BYTES,
	makeImageCopies,
	PREVIEW_EDGE,
	shrinkSteps,
	shrinkToFit,
	THUMB_EDGE,
	type ImageCodec
} from '#lib/components/shrink-image.js';

function fakeCodec(
	sizeOf: (step: { width: number; type: string; quality?: number }) => number,
	size = { width: 4000, height: 3000 }
) {
	const tried: string[] = [];
	let closed = false;
	let decodes = 0;
	const codec: ImageCodec = {
		async decode() {
			decodes++;
			return { ...size, close: () => (closed = true) };
		},
		async encode(_image, step) {
			tried.push(`${step.type}@${step.width}${step.quality ? `:${step.quality}` : ''}`);
			return new Blob([new Uint8Array(sizeOf(step))], { type: step.type });
		}
	};
	return { codec, tried, closed: () => closed, decodes: () => decodes };
}

const file = (size: number, type: string, name = 'shot.png') =>
	new File([new Uint8Array(size)], name, { type });

describe('shrinkSteps', () => {
	it('never upscales and skips repeated sizes', () => {
		const steps = shrinkSteps(1200, 800, 'image/jpeg');
		expect(new Set(steps.map((s) => s.width))).toEqual(new Set([1200]));
		expect(steps.every((s) => s.type === 'image/jpeg')).toBe(true);
	});

	it('tries a smaller PNG before falling back to JPEG', () => {
		const steps = shrinkSteps(4000, 3000, 'image/png');
		expect(steps[0]).toEqual({ width: 2560, height: 1920, type: 'image/png' });
		expect(steps[1]).toMatchObject({ width: 2560, type: 'image/jpeg', quality: 0.9 });
	});
});

describe('shrinkToFit', () => {
	it('leaves files under the cap alone', async () => {
		const { codec, tried } = fakeCodec(() => 1);
		const f = file(1_000, 'image/png');
		expect(await shrinkToFit(f, 2_000, codec)).toBe(f);
		expect(tried).toEqual([]);
	});

	it('leaves GIFs alone so they keep their animation', async () => {
		const { codec } = fakeCodec(() => 1);
		const f = file(5_000, 'image/gif', 'a.gif');
		expect(await shrinkToFit(f, 2_000, codec)).toBe(f);
	});

	it('keeps a screenshot as PNG when downscaling is enough', async () => {
		const { codec, tried, closed } = fakeCodec(() => 1_500);
		const out = await shrinkToFit(file(5_000, 'image/png'), 2_000, codec);
		expect(out.type).toBe('image/png');
		expect(out.name).toBe('shot.png');
		expect(out.size).toBe(1_500);
		expect(tried).toEqual(['image/png@2560']);
		expect(closed()).toBe(true);
	});

	it('falls back to JPEG and stops at the first encoding that fits', async () => {
		const { codec, tried } = fakeCodec((s) =>
			s.type === 'image/png' ? 4_000 : s.quality === 0.8 ? 1_900 : 2_500
		);
		const out = await shrinkToFit(file(5_000, 'image/png'), 2_000, codec);
		expect(out.type).toBe('image/jpeg');
		expect(out.name).toBe('shot.jpg');
		expect(out.size).toBe(1_900);
		expect(tried).toEqual(['image/png@2560', 'image/jpeg@2560:0.9', 'image/jpeg@2560:0.8']);
	});

	it('keeps the smallest result when nothing fits but it still helps', async () => {
		const { codec } = fakeCodec((s) => 3_000 + s.width);
		const out = await shrinkToFit(file(10_000, 'image/jpeg', 'p.jpeg'), 2_000, codec);
		expect(out.size).toBe(3_000 + 1600);
		expect(out.name).toBe('p.jpg');
	});

	it('uploads the original when the browser cannot decode it', async () => {
		const f = file(5_000, 'image/png');
		const codec: ImageCodec = {
			decode: async () => {
				throw new Error('bad image');
			},
			encode: async () => null
		};
		expect(await shrinkToFit(f, 2_000, codec)).toBe(f);
	});
});

/** A WebP whose VP8X header says it is animated. */
function animatedWebp(size: number): File {
	const bytes = new Uint8Array(size);
	bytes.set(
		[...'RIFF'].map((c) => c.charCodeAt(0)),
		0
	);
	bytes.set(
		[...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
		8
	);
	bytes[20] = 0x02;
	return new File([bytes], 'a.webp', { type: 'image/webp' });
}

describe('makeImageCopies', () => {
	it('makes every copy of a large PNG from one decode', async () => {
		const { codec, tried, closed, decodes } = fakeCodec(() => 100_000);
		const copies = await makeImageCopies(file(1_500_000, 'image/png'), codec);
		expect(copies.preview?.type).toBe('image/jpeg');
		expect(copies.jpeg?.type).toBe('image/jpeg');
		expect(copies.thumb?.type).toBe('image/jpeg');
		expect(tried).toEqual([
			`image/jpeg@${PREVIEW_EDGE}:0.8`,
			'image/jpeg@4000:0.9',
			`image/jpeg@${THUMB_EDGE}:0.75`
		]);
		expect(decodes()).toBe(1);
		expect(closed()).toBe(true);
	});

	describe('preview', () => {
		it('is left out for a light, animated or unknown image', async () => {
			const { codec, tried } = fakeCodec(() => 1);
			expect((await makeImageCopies(file(200_000, 'image/jpeg'), codec)).preview).toBeNull();
			expect((await makeImageCopies(file(2_000_000, 'image/gif'), codec)).preview).toBeNull();
			expect((await makeImageCopies(animatedWebp(2_000_000), codec)).preview).toBeNull();
			expect(await makeImageCopies(file(2_000_000, 'image/heic'), codec)).toEqual({
				preview: null,
				jpeg: null,
				thumb: null
			});
			expect(tried.some((t) => t.includes(`@${PREVIEW_EDGE}:`))).toBe(false);
		});

		it('is left out when it would not be smaller or the browser cannot make one', async () => {
			const bigger = fakeCodec(() => 3_000_000);
			expect(await makeImageCopies(file(1_500_000, 'image/jpeg'), bigger.codec)).toEqual({
				preview: null,
				jpeg: null,
				thumb: null
			});
			const broken: ImageCodec = {
				decode: async () => {
					throw new Error('cannot decode');
				},
				encode: async () => null
			};
			expect(await makeImageCopies(file(1_500_000, 'image/jpeg'), broken)).toEqual({
				preview: null,
				jpeg: null,
				thumb: null
			});
		});
	});

	describe('JPEG copy', () => {
		it('is made at full size for a PNG or WebP, for Instagram', async () => {
			for (const type of ['image/png', 'image/webp']) {
				const { codec, tried } = fakeCodec(() => 900_000);
				expect((await makeImageCopies(file(1_200_000, type), codec)).jpeg?.type).toBe('image/jpeg');
				expect(tried).toContain('image/jpeg@4000:0.9');
			}
		});

		it('is left out for a JPEG or a GIF: one is already a JPEG, the other cannot go', async () => {
			const { codec, tried } = fakeCodec(() => 1);
			expect((await makeImageCopies(file(1_000_000, 'image/jpeg'), codec)).jpeg).toBeNull();
			expect((await makeImageCopies(file(1_000_000, 'image/gif'), codec)).jpeg).toBeNull();
			expect(tried.some((t) => t.startsWith('image/jpeg@4000'))).toBe(false);
		});

		it("steps down once, then gives up rather than go over Instagram's cap", async () => {
			const smaller = fakeCodec((step) =>
				step.width !== 4000 ? 1 : step.quality === 0.9 ? JPEG_COPY_MAX_BYTES + 1 : 7_000_000
			);
			const copies = await makeImageCopies(file(5_000_000, 'image/png'), smaller.codec);
			expect(copies.jpeg?.size).toBe(7_000_000);
			expect(smaller.tried.filter((t) => t.startsWith('image/jpeg@4000'))).toEqual([
				'image/jpeg@4000:0.9',
				'image/jpeg@4000:0.8'
			]);
			const huge = fakeCodec((step) => (step.width === 4000 ? JPEG_COPY_MAX_BYTES + 1 : 1));
			expect((await makeImageCopies(file(5_000_000, 'image/png'), huge.codec)).jpeg).toBeNull();
		});

		it("is an animated WebP's first frame", async () => {
			const { codec } = fakeCodec(() => 900_000);
			expect((await makeImageCopies(animatedWebp(1_200_000), codec)).jpeg).not.toBeNull();
		});
	});

	describe('thumbnail', () => {
		it('fits THUMB_EDGE, even for an image too light for a preview', async () => {
			const { codec, tried } = fakeCodec(() => 20_000);
			const copies = await makeImageCopies(file(250_000, 'image/jpeg'), codec);
			expect(copies.thumb?.size).toBe(20_000);
			expect(tried).toEqual([`image/jpeg@${THUMB_EDGE}:0.75`]);
		});

		it('is a still of a GIF or an animated WebP, the only copy a GIF gets', async () => {
			const gif = fakeCodec(() => 20_000);
			const copies = await makeImageCopies(file(3_000_000, 'image/gif', 'a.gif'), gif.codec);
			expect(copies).toEqual({ preview: null, jpeg: null, thumb: expect.any(Blob) });
			expect(gif.tried).toEqual([`image/jpeg@${THUMB_EDGE}:0.75`]);
			const small = fakeCodec(() => 20_000, { width: 200, height: 200 });
			const tiny = await makeImageCopies(file(3_000_000, 'image/gif', 'a.gif'), small.codec);
			expect(tiny.thumb).not.toBeNull();
			const webp = fakeCodec(() => 20_000);
			expect((await makeImageCopies(animatedWebp(3_000_000), webp.codec)).thumb).not.toBeNull();
		});

		it('is left out for a still image already that small', async () => {
			const { codec, tried } = fakeCodec(() => 1, { width: THUMB_EDGE, height: 300 });
			expect((await makeImageCopies(file(250_000, 'image/png'), codec)).thumb).toBeNull();
			expect(tried.some((t) => t.endsWith(':0.75'))).toBe(false);
		});

		it('is still made when another copy fails to encode', async () => {
			const { codec } = fakeCodec(() => 20_000);
			const flaky: ImageCodec = {
				decode: codec.decode,
				encode: async (image, step) => {
					if (step.width !== THUMB_EDGE) throw new Error('out of memory');
					return codec.encode(image, step);
				}
			};
			const copies = await makeImageCopies(file(1_500_000, 'image/png'), flaky);
			expect(copies.preview).toBeNull();
			expect(copies.jpeg).toBeNull();
			expect(copies.thumb).not.toBeNull();
		});
	});
});
