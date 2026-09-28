import { describe, expect, it } from 'vitest';
import {
	addSegment,
	buildPreviewModel,
	joinThreadSegments,
	maxThreadSegmentLength,
	removeSegment,
	resolvePublishSegments,
	splitThreadSegments,
	updateSegment,
	flattenThreadBody,
	joinThreadTexts,
	remapSegmentIndexAfterInsert,
	splitAtMarkers
} from '$lib/domain/thread-segments';

describe('splitThreadSegments', () => {
	it('returns single segment without delimiter', () => {
		expect(splitThreadSegments('hello world')).toEqual(['hello world']);
	});

	it('splits on \\n---\\n into ordered cards', () => {
		expect(splitThreadSegments('one post\n---\nanother post\n---\nthird')).toEqual([
			'one post',
			'another post',
			'third'
		]);
	});

	it('empty body yields one empty card', () => {
		expect(splitThreadSegments('')).toEqual(['']);
	});

	it('preserves trailing empty segment after delimiter (new card)', () => {
		expect(splitThreadSegments('hello\n---\n')).toEqual(['hello', '']);
	});

	it('preserves empty middle segments (intentional empty cards)', () => {
		expect(splitThreadSegments('a\n---\n\n---\nb')).toEqual(['a', '', 'b']);
	});
});

describe('join → split round-trip', () => {
	it('addSegment from [""] produces 2 cards after join/split', () => {
		const afterAdd = addSegment(['']);
		expect(splitThreadSegments(joinThreadSegments(afterAdd))).toEqual(['', '']);
	});

	it('second Add from [hello, ""] produces 3 cards', () => {
		const segs = addSegment(['hello', '']);
		expect(splitThreadSegments(joinThreadSegments(segs))).toEqual(['hello', '', '']);
	});

	it('N empty trailing cards increase length', () => {
		let segs = [''];
		for (let n = 1; n <= 4; n++) {
			segs = addSegment(segs);
			expect(splitThreadSegments(joinThreadSegments(segs))).toHaveLength(n + 1);
		}
	});

	it('round-trips multi non-empty segments', () => {
		const segs = ['one', 'two', 'three'];
		expect(splitThreadSegments(joinThreadSegments(segs))).toEqual(segs);
	});
});

describe('resolvePublishSegments', () => {
	it('keeps empty-text segment when it has media', () => {
		const resolved = resolvePublishSegments('hello\n---\n\n---\nworld', (i) => i === 1);
		expect(resolved).toEqual([
			{ text: 'hello', segmentIndex: 0 },
			{ text: '', segmentIndex: 1 },
			{ text: 'world', segmentIndex: 2 }
		]);
	});

	it('drops empty-text segment without media', () => {
		expect(resolvePublishSegments('hello\n---\n\n---\nworld', () => false)).toEqual([
			{ text: 'hello', segmentIndex: 0 },
			{ text: 'world', segmentIndex: 2 }
		]);
	});

	it('does not renumber later indices when middle empty text is kept', () => {
		const resolved = resolvePublishSegments('a\n---\n\n---\nb', (i) => i === 1 || i === 2);
		expect(resolved.map((r) => r.segmentIndex)).toEqual([0, 1, 2]);
	});

	it('single image-only card', () => {
		expect(resolvePublishSegments('', (i) => i === 0)).toEqual([{ text: '', segmentIndex: 0 }]);
	});
});

describe('maxThreadSegmentLength', () => {
	const len = (s: string) => s.length;
	it('uses max of individual posts not joined body', () => {
		const body = joinThreadSegments(['a'.repeat(200), 'b'.repeat(200)]);
		expect(body.length).toBeGreaterThan(300);
		expect(maxThreadSegmentLength(body, len)).toBe(200);
	});
	it('single post', () => {
		expect(maxThreadSegmentLength('hello', len)).toBe(5);
	});
	it('empty body is 0', () => {
		expect(maxThreadSegmentLength('', len)).toBe(0);
	});
	it('matches the preview cards: keeps trailing and whitespace-only segments', () => {
		expect(maxThreadSegmentLength('hello\n---\n', len)).toBe(5);
		expect(maxThreadSegmentLength('   ', len)).toBe(3);
	});
});

describe('join / update / add / remove', () => {
	it('updateSegment changes one card', () => {
		expect(updateSegment(['a', 'b'], 1, 'B')).toEqual(['a', 'B']);
	});
	it('addSegment appends empty', () => {
		expect(addSegment(['a'])).toEqual(['a', '']);
	});
	it('removeSegment keeps at least one', () => {
		expect(removeSegment(['a'], 0)).toEqual(['']);
		expect(removeSegment(['a', 'b'], 0)).toEqual(['b']);
	});
});

describe('buildPreviewModel', () => {
	it('builds multi-segment mastodon model from connections', () => {
		const model = buildPreviewModel({
			platform: 'mastodon',
			body: 'one\n---\ntwo',
			connections: [
				{
					platform: 'mastodon',
					displayName: 'Test User',
					handle: 'test@mastodon.social',
					avatarUrl: 'https://example.com/a.png'
				}
			],
			mastodonMax: 500
		});
		expect(model.segments).toEqual(['one', 'two']);
		expect(model.platform).toBe('mastodon');
		expect(model.identity.handle).toContain('mastodon');
		expect(model.charLimits.max).toBe(500);
	});

	it('main tab picks connected platform for chrome', () => {
		const model = buildPreviewModel({
			platform: 'main',
			body: 'hi',
			connections: [{ platform: 'bluesky', handle: 'x.bsky.social', displayName: 'X' }]
		});
		expect(model.platform).toBe('bluesky');
		expect(model.charLimits.max).toBe(300);
	});
});

describe('windows line endings', () => {
	it('splits \\r\\n threads like \\n threads', async () => {
		const { resolvePublishSegments, splitThreadSegments } =
			await import('$lib/domain/thread-segments');
		expect(splitThreadSegments('a\r\n---\r\nb')).toEqual(['a', 'b']);
		expect(resolvePublishSegments('a\r\n---\r\nb', () => false)).toEqual([
			{ text: 'a', segmentIndex: 0 },
			{ text: 'b', segmentIndex: 1 }
		]);
	});
});

describe('single-post flattening', () => {
	it('joins trimmed non-empty texts with a blank line', () => {
		expect(joinThreadTexts(['  first ', '', null, 'second\n'])).toBe('first\n\nsecond');
	});

	it('flattens a thread body and normalizes CRLF', () => {
		expect(flattenThreadBody('a\r\n---\r\nb\n---\nc')).toBe('a\n\nb\n\nc');
		expect(flattenThreadBody('single post')).toBe('single post');
	});
});

describe('splitAtMarkers', () => {
	it('is null when the text has no marker', () => {
		expect(splitAtMarkers('plain text')).toBeNull();
	});

	it('splits a typed marker into the text before and after it', () => {
		expect(splitAtMarkers('first part ---second')).toEqual(['first part', 'second']);
		expect(splitAtMarkers('hello ---')).toEqual(['hello', '']);
	});

	it('keeps every piece when the text carries several markers', () => {
		expect(splitAtMarkers('one --- two --- three---four')).toEqual(['one', 'two', 'three', 'four']);
	});
});

describe('remapSegmentIndexAfterInsert', () => {
	it('moves only the cards after the split point', () => {
		expect(remapSegmentIndexAfterInsert(0, 1, 2)).toBe(0);
		expect(remapSegmentIndexAfterInsert(1, 1, 2)).toBe(1);
		expect(remapSegmentIndexAfterInsert(2, 1, 2)).toBe(4);
		expect(remapSegmentIndexAfterInsert(3, 1, 0)).toBe(3);
	});
});
