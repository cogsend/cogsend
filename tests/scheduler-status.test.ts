import { describe, expect, it } from 'vitest';
import { schedulerMessage, tickAdvice } from '#lib/domain/scheduler-status.js';
import type { DeployCronState } from '#lib/server/app-settings.js';

const cron = (status: DeployCronState['status']): DeployCronState => ({
	status,
	code: status === 'unavailable' ? '10072' : null,
	updatedAt: new Date('2026-09-17T06:30:00Z')
});

const ticked = { ok: true, lastTickAt: new Date('2026-09-17T06:40:00Z'), stuckPublishing: 0 };
const never = { ok: false, lastTickAt: null, stuckPublishing: 0 };
const silent = { ok: false, lastTickAt: new Date('2026-09-17T00:00:00Z'), stuckPublishing: 0 };

describe('scheduler status line', () => {
	it('names the deploy reason when there is one', () => {
		expect(schedulerMessage(never, cron('unavailable'))).toContain('10072');
		expect(schedulerMessage(never, cron('disabled'))).toContain('no cron trigger');
		expect(schedulerMessage(never, null)).toContain('no tick yet');
	});

	it('separates on time from delayed', () => {
		expect(schedulerMessage(ticked, cron('attached'))).toBe('Scheduled publishing is on time');
		expect(schedulerMessage(silent, cron('attached'))).toContain('delayed');
	});

	it('leads with stuck posts, which need a human', () => {
		expect(schedulerMessage({ ...ticked, stuckPublishing: 2 }, null)).toContain('2 posts stuck');
		expect(schedulerMessage({ ...never, stuckPublishing: 1 }, cron('unavailable'))).toContain(
			'1 post stuck'
		);
	});
});

describe('tick advice', () => {
	it('warns when the deploy could not attach the trigger', () => {
		const advice = tickAdvice(never, cron('unavailable'));
		expect(advice.level).toBe('warn');
		expect(advice.message).toContain('10072');
		expect(advice.message).toContain('free a trigger slot');
	});

	it('warns when the config asks for no trigger', () => {
		const advice = tickAdvice(never, cron('disabled'));
		expect(advice.level).toBe('warn');
		expect(advice.message).toContain('tick URL');
	});

	it('stays informational when nothing has ticked yet and no deploy said why', () => {
		// Right after a deploy with a working trigger the first tick may still be
		// a minute away; that is not a problem to alarm anyone about.
		const advice = tickAdvice(never, cron('attached'));
		expect(advice.level).toBe('info');
		expect(tickAdvice(never, null).level).toBe('info');
	});

	it('warns when the scheduler went quiet after ticking', () => {
		const advice = tickAdvice(silent, cron('attached'));
		expect(advice.level).toBe('warn');
		expect(advice.message).toContain('Trigger events');
	});

	it('is quiet when ticks arrive', () => {
		expect(tickAdvice(ticked, cron('attached')).level).toBe('ok');
	});

	it('warns about stuck posts regardless of ticks', () => {
		expect(tickAdvice({ ...ticked, stuckPublishing: 3 }, cron('attached')).level).toBe('warn');
	});
});
