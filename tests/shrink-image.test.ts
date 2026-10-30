import { describe, expect, it } from 'vitest';
import {
	JPEG_COPY_MAX_BYTES,
	makeJpegCopy,
	makePreview,
	PREVIEW_EDGE,
	shrinkSteps,
	shrinkToFit,
	type ImageCodec
} from '#lib/components/shrink-image.js';

function fakeCodec(sizeOf: (step: { width: number; type: string; quality?: number }) => number) {
	const tried: string[] = [];
	let closed = false;
	const codec: ImageCodec = {
		async decode() {
			return { width: 4000, height: 3000, close: () => (closed = true) };
		},
		async encode(_image, step) {
			tried.push(`${step.type}@${step.width}${step.quality ? `:${step.quality}` : ''}`);
			return new Blob([new Uint8Array(sizeOf(step))], { type: step.type });
		}
	};
	return { codec, tried, closed: () => closed };
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

describe('makePreview', () => {
	it('makes a JPEG at most PREVIEW_EDGE on the long edge', async () => {
		const { codec, tried, closed } = fakeCodec(() => 100_000);
		const preview = await makePreview(file(1_500_000, 'image/png'), codec);
		expect(preview?.type).toBe('image/jpeg');
		expect(tried).toEqual([`image/jpeg@${PREVIEW_EDGE}:0.8`]);
		expect(closed()).toBe(true);
	});

	it('leaves light, animated and unknown images to show as they are', async () => {
		const { codec, tried } = fakeCodec(() => 1);
		expect(await makePreview(file(200_000, 'image/jpeg'), codec)).toBeNull();
		expect(await makePreview(file(2_000_000, 'image/gif'), codec)).toBeNull();
		expect(await makePreview(file(2_000_000, 'image/heic'), codec)).toBeNull();
		expect(tried).toEqual([]);
	});

	it('gives up when the copy would not be smaller or the browser cannot make one', async () => {
		const bigger = fakeCodec(() => 3_000_000);
		expect(await makePreview(file(1_500_000, 'image/jpeg'), bigger.codec)).toBeNull();
		const broken: ImageCodec = {
			decode: async () => {
				throw new Error('cannot decode');
			},
			encode: async () => null
		};
		expect(await makePreview(file(1_500_000, 'image/jpeg'), broken)).toBeNull();
	});
});

describe('makeJpegCopy', () => {
	it('makes a full-size JPEG of a PNG or WebP, for Instagram', async () => {
		for (const type of ['image/png', 'image/webp']) {
			const { codec, tried, closed } = fakeCodec(() => 900_000);
			const copy = await makeJpegCopy(file(1_200_000, type), codec);
			expect(copy?.type).toBe('image/jpeg');
			expect(tried).toEqual(['image/jpeg@4000:0.9']);
			expect(closed()).toBe(true);
		}
	});

	it('leaves JPEGs and GIFs alone: one is already a JPEG, the other cannot go', async () => {
		const { codec, tried } = fakeCodec(() => 1);
		expect(await makeJpegCopy(file(1_000_000, 'image/jpeg'), codec)).toBeNull();
		expect(await makeJpegCopy(file(1_000_000, 'image/gif'), codec)).toBeNull();
		expect(tried).toEqual([]);
	});

	it("steps down once, then gives up rather than send a copy over Instagram's cap", async () => {
		const smaller = fakeCodec((step) =>
			step.quality === 0.9 ? JPEG_COPY_MAX_BYTES + 1 : 7_000_000
		);
		expect((await makeJpegCopy(file(5_000_000, 'image/png'), smaller.codec))?.size).toBe(7_000_000);
		expect(smaller.tried).toEqual(['image/jpeg@4000:0.9', 'image/jpeg@4000:0.8']);
		const huge = fakeCodec(() => JPEG_COPY_MAX_BYTES + 1);
		expect(await makeJpegCopy(file(5_000_000, 'image/png'), huge.codec)).toBeNull();
	});
});
