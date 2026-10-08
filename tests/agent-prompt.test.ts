import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '$lib/domain/agent-prompt';
import { PLATFORM_SETUP, callbackUri, type OAuthPlatformId } from '$lib/domain/platform-setup';

/**
 * The prompt an operator hands to a browser agent. It is only useful if the
 * agent cannot get the redirect URI wrong, and only safe if it keeps secrets out
 * of the chat and stops where a person has to act.
 */
describe('agent prompt', () => {
	const ids = Object.keys(PLATFORM_SETUP) as OAuthPlatformId[];

	it.each(ids)('gives %s the exact redirect URI and console', (id) => {
		const prompt = buildAgentPrompt(id, 'https://cogsend.example.workers.dev/', 'My Instance');
		expect(prompt).toContain(callbackUri(id, 'https://cogsend.example.workers.dev'));
		expect(prompt).not.toContain('workers.dev//');
		expect(prompt).toContain(PLATFORM_SETUP[id].consoleUrl);
		expect(prompt).toContain(PLATFORM_SETUP[id].redirectField);
		expect(prompt).toContain('https://cogsend.example.workers.dev/accounts');
		expect(prompt).toContain('My Instance');
	});

	it.each(ids)('keeps %s credentials out of the chat and stops for the person', (id) => {
		const prompt = buildAgentPrompt(id, 'https://a.example', 'CogSend');
		expect(prompt).toMatch(/Never paste, repeat or summarise any client secret/);
		expect(prompt).toContain('"Save and connect", and stop there');
		for (const step of ['signing in', 'phone verification', 'CAPTCHAs', 'costs money']) {
			expect(prompt).toContain(step);
		}
		// Field labels, never environment variable names: the agent types into a form.
		expect(prompt).not.toMatch(/[A-Z]+_(CLIENT|APP)_(ID|SECRET)/);
	});

	it('marks optional fields and carries the platform note', () => {
		const prompt = buildAgentPrompt('x', 'https://a.example', 'CogSend');
		expect(prompt).toContain('Client secret (optional)');
		expect(prompt).toContain('pay-per-use API credits');
		expect(prompt).toContain('Set up an X developer app');
		expect(buildAgentPrompt('linkedin', 'https://a.example', 'CogSend')).not.toContain(
			'(optional)'
		);
	});
});
