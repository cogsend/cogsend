import { describe, expect, it } from 'vitest';
import { decodeImageDimensions } from '#lib/server/image-dimensions.js';

function pngBytes(width: number, height: number): Uint8Array {
	const b = new Uint8Array(33);
	b[0] = 0x89;
	b[1] = 0x50;
	b[2] = 0x4e;
	b[3] = 0x47;
	b[4] = 0x0d;
	b[5] = 0x0a;
	b[6] = 0x1a;
	b[7] = 0x0a;
	// len=13
	b[8] = 0;
	b[9] = 0;
	b[10] = 0;
	b[11] = 13;
	b[12] = 0x49;
	b[13] = 0x48;
	b[14] = 0x44;
	b[15] = 0x52;
	b[16] = (width >>> 24) & 255;
	b[17] = (width >>> 16) & 255;
	b[18] = (width >>> 8) & 255;
	b[19] = width & 255;
	b[20] = (height >>> 24) & 255;
	b[21] = (height >>> 16) & 255;
	b[22] = (height >>> 8) & 255;
	b[23] = height & 255;
	return b;
}

function gifBytes(width: number, height: number): Uint8Array {
	const b = new Uint8Array(10);
	b[0] = 0x47;
	b[1] = 0x49;
	b[2] = 0x46;
	b[3] = 0x38;
	b[4] = 0x39;
	b[5] = 0x61;
	b[6] = width & 255;
	b[7] = (width >> 8) & 255;
	b[8] = height & 255;
	b[9] = (height >> 8) & 255;
	return b;
}

function jpegBytes(width: number, height: number): Uint8Array {
	// SOI + APP0 + SOF0 with dims
	const b = new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x10,
		0x4a,
		0x46,
		0x49,
		0x46,
		0x00,
		0x01,
		0x01,
		0x00,
		0x00,
		0x01,
		0x00,
		0x01,
		0x00,
		0x00,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		(height >> 8) & 255,
		height & 255,
		(width >> 8) & 255,
		width & 255,
		0x03,
		0x01,
		0x11,
		0x00,
		0x02,
		0x11,
		0x01,
		0x03,
		0x11,
		0x01,
		0xff,
		0xd9
	]);
	return b;
}

describe('decodeImageDimensions', () => {
	it('decodes PNG', () => {
		expect(decodeImageDimensions(pngBytes(800, 600))).toEqual({ width: 800, height: 600 });
	});

	it('decodes GIF', () => {
		expect(decodeImageDimensions(gifBytes(320, 200))).toEqual({ width: 320, height: 200 });
	});

	it('decodes JPEG SOF0', () => {
		expect(decodeImageDimensions(jpegBytes(640, 480))).toEqual({ width: 640, height: 480 });
	});

	it('returns null for truncated/unknown', () => {
		expect(decodeImageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(decodeImageDimensions(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
		// Truncated PNG
		expect(decodeImageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
	});
});

describe('decodeImageDimensions webp', () => {
	function riff(chunk: string, payload: Uint8Array): Uint8Array {
		const b = new Uint8Array(20 + payload.length);
		b[0] = 0x52;
		b[1] = 0x49;
		b[2] = 0x46;
		b[3] = 0x46;
		b[8] = 0x57;
		b[9] = 0x45;
		b[10] = 0x42;
		b[11] = 0x50;
		b[12] = chunk.charCodeAt(0);
		b[13] = chunk.charCodeAt(1);
		b[14] = chunk.charCodeAt(2);
		b[15] = chunk.charCodeAt(3);
		b.set(payload, 20);
		return b;
	}

	it('decodes VP8 lossy and rejects bad start code', () => {
		// 10-byte VP8 frame header: 3 tag bytes + 0x9d012a start code,
		// width 320 / height 200 (14-bit LE).
		const payload = new Uint8Array([0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xc8, 0x00]);
		expect(decodeImageDimensions(riff('VP8 ', payload))).toEqual({ width: 320, height: 200 });
		const bad = new Uint8Array([0, 0, 0, 0x00, 0x00, 0x00, 0x40, 0x01, 0xc8, 0x00]);
		expect(decodeImageDimensions(riff('VP8 ', bad))).toBeNull();
	});

	it('decodes VP8L lossless', () => {
		// sig 0x2f + 14-bit w-1=122 + 14-bit h-1=44 (123x45).
		const w = 123 - 1;
		const h = 45 - 1;
		const b0 = w & 0xff;
		const b1 = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
		const b2 = (h >> 2) & 0xff;
		const b3 = (h >> 10) & 0x0f;
		const payload = new Uint8Array([0x2f, b0, b1, b2, b3]);
		expect(decodeImageDimensions(riff('VP8L', payload))).toEqual({ width: 123, height: 45 });
	});

	it('decodes VP8X extended', () => {
		const payload = new Uint8Array(10);
		// w-1 = 499 (500), h-1 = 299 (300), 24-bit LE at 4/7.
		payload[4] = 499 & 0xff;
		payload[5] = (499 >> 8) & 0xff;
		payload[6] = (499 >> 16) & 0xff;
		payload[7] = 299 & 0xff;
		payload[8] = (299 >> 8) & 0xff;
		payload[9] = (299 >> 16) & 0xff;
		expect(decodeImageDimensions(riff('VP8X', payload))).toEqual({ width: 500, height: 300 });
	});
});
