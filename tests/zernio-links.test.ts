import { describe, expect, it } from 'vitest';
import { zernioLink } from '$lib/domain/zernio-links';

describe('zernioLink', () => {
	it('sends a plain link through the CogSend short link, tagged with the UTMs and placement', () => {
		const url = new URL(zernioLink({ placement: 'readme-sponsor' }));
		expect(url.origin + url.pathname).toBe('https://zernio.link/cogsend');
		expect(url.searchParams.get('utm_source')).toBe('cogsend');
		expect(url.searchParams.get('utm_medium')).toBe('sponsorship');
		expect(url.searchParams.get('utm_campaign')).toBe('cogsend-integration');
		expect(url.searchParams.get('utm_content')).toBe('readme-sponsor');
	});

	it('sends a deep link through that page’s own short link', () => {
		const url = new URL(zernioLink({ path: '/pricing', placement: 'docs' }));
		expect(url.origin + url.pathname).toBe('https://zernio.link/cogsend-pricing');
		expect(url.searchParams.get('utm_content')).toBe('docs');
	});
});
