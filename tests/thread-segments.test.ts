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
	splitAtMarkers,
	threadPosts
} from '#lib/domain/thread-segments.js';

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
			await import('#lib/domain/thread-segments.js');
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

describe('threadPosts', () => {
	const m = (id: string, segmentIndex?: number | null) => ({ id, segmentIndex });

	it('keeps a single post whole, with all its media', () => {
		expect(threadPosts(' hello ', [m('a', 0), m('b')])).toEqual([
			{ segmentIndex: 0, text: 'hello', media: [m('a', 0), m('b')] }
		]);
	});

	it('gives one empty post for an empty body', () => {
		expect(threadPosts('', [])).toEqual([{ segmentIndex: 0, text: '', media: [] }]);
		expect(threadPosts(null, [])).toEqual([{ segmentIndex: 0, text: '', media: [] }]);
		expect(threadPosts('\n---\n\n---\n', [])).toEqual([{ segmentIndex: 0, text: '', media: [] }]);
	});

	it('splits Windows line endings like the composer does', () => {
		expect(threadPosts('one\r\n---\r\ntwo', []).map((p) => p.text)).toEqual(['one', 'two']);
	});

	it('gives each post its own media, in the order given', () => {
		const media = [m('a', 0), m('b', 2), m('c', 2), m('d', 0)];
		expect(threadPosts('one\n---\ntwo\n---\nthree', media)).toEqual([
			{ segmentIndex: 0, text: 'one', media: [m('a', 0), m('d', 0)] },
			{ segmentIndex: 1, text: 'two', media: [] },
			{ segmentIndex: 2, text: 'three', media: [m('b', 2), m('c', 2)] }
		]);
	});

	it('skips an empty post as publishing does, unless it has media', () => {
		expect(threadPosts('one\n---\n  \n---\nthree', []).map((p) => p.segmentIndex)).toEqual([0, 2]);
		expect(threadPosts('one\n---\n\n---\nthree', [m('a', 1)])).toEqual([
			{ segmentIndex: 0, text: 'one', media: [] },
			{ segmentIndex: 1, text: '', media: [m('a', 1)] },
			{ segmentIndex: 2, text: 'three', media: [] }
		]);
	});

	it('keeps media on a card past the body as a post without text', () => {
		expect(threadPosts('one', [m('x', 3), m('a', 0)])).toEqual([
			{ segmentIndex: 0, text: 'one', media: [m('a', 0)] },
			{ segmentIndex: 3, text: '', media: [m('x', 3)] }
		]);
		expect(threadPosts('', [m('x', 2)])).toEqual([
			{ segmentIndex: 2, text: '', media: [m('x', 2)] }
		]);
	});
});
