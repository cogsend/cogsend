import { countGraphemes } from './validation/text';

export const THREADS_TOPIC_MAX_CHARS = 50;

/** People type a topic the way they would a hashtag, but Meta wants it without the #. */
export function normalizeThreadsTopic(text: string): string {
	return text.trim().replace(/\s+/g, ' ').replace(/^#\s*/, '');
}

/** Null means the post has no topic. */
export function validateThreadsTopic(
	input: unknown
): { ok: true; topic: string | null } | { ok: false; error: string } {
	if (input === undefined || input === null) return { ok: true, topic: null };
	if (typeof input !== 'string') return { ok: false, error: 'Topic tag must be text' };
	const topic = normalizeThreadsTopic(input);
	if (!topic) return { ok: true, topic: null };
	if (/[.&]/.test(topic)) return { ok: false, error: 'Topic tags cannot contain . or &' };
	if (countGraphemes(topic) > THREADS_TOPIC_MAX_CHARS) {
		return { ok: false, error: `Topic tags allow max ${THREADS_TOPIC_MAX_CHARS} characters` };
	}
	return { ok: true, topic };
}

/** Lenient parse for stored options: an invalid value is no topic. */
export function parseThreadsTopic(input: unknown): string | null {
	const v = validateThreadsTopic(input);
	return v.ok ? v.topic : null;
}
