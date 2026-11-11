import { describe, expect, it } from 'vitest';
import {
	ALL_HISTORY,
	afterHistoryPage,
	afterWaitingPage,
	firstQueueCursors
} from '#lib/domain/queue-cursor.js';

describe('Posts keeps its place in the waiting posts and in history apart', () => {
	it('starts history from its newest when the first page ends among the waiting posts', () => {
		expect(firstQueueCursors('u:5:4:id')).toEqual({ waiting: 'u:5:4:id', history: ALL_HISTORY });
		expect(firstQueueCursors('9:id')).toEqual({ waiting: null, history: '9:id' });
		expect(firstQueueCursors(null)).toEqual({ waiting: null, history: null });
	});

	it('moves on through the waiting posts without touching history', () => {
		expect(afterWaitingPage({ waiting: 'u:1:1:a', history: '7:x' }, 'u:2:2:b')).toEqual({
			waiting: 'u:2:2:b',
			history: '7:x'
		});
	});

	it('takes up history where the last waiting page left it, unless history went further', () => {
		const fresh = { waiting: 'u:1:1:a', history: ALL_HISTORY };
		expect(afterWaitingPage(fresh, '8:y')).toEqual({ waiting: null, history: '8:y' });
		expect(afterWaitingPage(fresh, null)).toEqual({ waiting: null, history: null });
		expect(afterWaitingPage({ waiting: 'u:1:1:a', history: '3:z' }, '8:y')).toEqual({
			waiting: null,
			history: '3:z'
		});
	});

	it('pages history on its own', () => {
		expect(afterHistoryPage({ waiting: 'u:1:1:a', history: ALL_HISTORY }, '6:q')).toEqual({
			waiting: 'u:1:1:a',
			history: '6:q'
		});
		expect(afterHistoryPage({ waiting: null, history: '6:q' }, null)).toEqual({
			waiting: null,
			history: null
		});
	});
});
