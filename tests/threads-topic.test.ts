import { describe, expect, it } from 'vitest';
import {
	normalizeThreadsTopic,
	parseThreadsTopic,
	THREADS_TOPIC_MAX_CHARS,
	validateThreadsTopic
} from '#lib/domain/threads-topic.js';

describe('validateThreadsTopic', () => {
	it('treats nothing at all as no topic', () => {
		for (const input of [undefined, null, '', '   ', '#', ' # ', '\n\t']) {
			expect(validateThreadsTopic(input)).toEqual({ ok: true, topic: null });
		}
	});

	it('takes a topic the way people type a hashtag', () => {
		expect(validateThreadsTopic('#AI')).toEqual({ ok: true, topic: 'AI' });
		expect(validateThreadsTopic('  # AI Tools ')).toEqual({ ok: true, topic: 'AI Tools' });
		expect(validateThreadsTopic('AI\n  Tools')).toEqual({ ok: true, topic: 'AI Tools' });
	});

	it('removes only the leading hash', () => {
		expect(validateThreadsTopic('##AI')).toEqual({ ok: true, topic: '#AI' });
		expect(validateThreadsTopic('C#')).toEqual({ ok: true, topic: 'C#' });
	});

	it('refuses the two characters Meta bans', () => {
		for (const input of ['a.b', 'a&b', '.', '&']) {
			expect(validateThreadsTopic(input).ok).toBe(false);
		}
	});

	it('allows the rest, spaces and emoji included', () => {
		for (const input of ['AI Tools', 'Café', '🧵 threads', 'मराठी', 'a-b_c', 'rock!']) {
			expect(validateThreadsTopic(input)).toEqual({ ok: true, topic: input });
		}
	});

	it('stops at the limit, counting an emoji as one', () => {
		const max = 'a'.repeat(THREADS_TOPIC_MAX_CHARS);
		expect(validateThreadsTopic(max)).toEqual({ ok: true, topic: max });
		expect(validateThreadsTopic(`${max}a`).ok).toBe(false);
		const family = '👨‍👩‍👧'.repeat(THREADS_TOPIC_MAX_CHARS);
		expect(validateThreadsTopic(family).ok).toBe(true);
		expect(validateThreadsTopic(`${family}a`).ok).toBe(false);
	});

	it('does not count the hash or surrounding space', () => {
		const max = 'a'.repeat(THREADS_TOPIC_MAX_CHARS);
		expect(validateThreadsTopic(`  #${max} `)).toEqual({ ok: true, topic: max });
	});

	it('refuses anything but text', () => {
		for (const input of [42, true, {}, ['a']]) {
			expect(validateThreadsTopic(input).ok).toBe(false);
		}
	});
});

describe('parseThreadsTopic', () => {
	it('returns the normalized topic', () => {
		expect(parseThreadsTopic(' #AI  Tools ')).toBe('AI Tools');
	});

	it('turns anything invalid into no topic', () => {
		for (const input of ['a.b', 'a&b', 'x'.repeat(51), 42, {}, '', null, undefined]) {
			expect(parseThreadsTopic(input)).toBeNull();
		}
	});
});

describe('normalizeThreadsTopic', () => {
	it('leaves a clean topic alone', () => {
		expect(normalizeThreadsTopic('AI Tools')).toBe('AI Tools');
	});
});
