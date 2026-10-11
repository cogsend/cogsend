import { describe, expect, it } from 'vitest';
import { mastodonExchangeCode } from '#lib/server/providers/mastodon.js';
import type { FetchLike } from '#lib/server/providers/types.js';

const json = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('mastodon redirect guard', () => {
	it('refuses a redirect to a private host', async () => {
		const fetchImpl: FetchLike = async () =>
			new Response('', {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data/' }
			});
		await expect(
			mastodonExchangeCode(
				'https://mastodon.test',
				'cid',
				'csecret',
				'code',
				'https://app.test',
				fetchImpl
			)
		).rejects.toThrow(/host not allowed/i);
	});

	it('follows a public redirect and keeps the POST method and body', async () => {
		const seen: Array<{ method: string; url: string }> = [];
		const fetchImpl: FetchLike = async (input, init) => {
			const url = String(input);
			seen.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
			if (url === 'https://mastodon.test/oauth/token') {
				return new Response('', {
					status: 307,
					headers: { location: 'https://api.mastodon.test/oauth/token' }
				});
			}
			if (url === 'https://api.mastodon.test/oauth/token') return json({ access_token: 'tok' });
			if (url.endsWith('/api/v1/accounts/verify_credentials')) {
				return json({ username: 'me', display_name: 'Me', avatar: '', acct: 'me@mastodon.test' });
			}
			return json({ configuration: { statuses: { max_characters: 500 } } });
		};
		const result = await mastodonExchangeCode(
			'https://mastodon.test',
			'cid',
			'csecret',
			'code',
			'https://app.test',
			fetchImpl
		);
		expect(result.accessToken).toBe('tok');
		expect(seen[0]).toEqual({ method: 'POST', url: 'https://mastodon.test/oauth/token' });
		expect(seen[1]).toEqual({ method: 'POST', url: 'https://api.mastodon.test/oauth/token' });
	});
});
