// A path after the short link (zernio.link/cogsend/pricing) does not resolve, so
// each Zernio page CogSend links to has its own short link in the Dub partner
// dashboard, and a new page needs one created there first.
const ZERNIO_LINKS = {
	'/': 'https://zernio.link/cogsend',
	'/pricing': 'https://zernio.link/cogsend-pricing'
} as const;

export function zernioLink({
	path = '/',
	placement
}: {
	path?: keyof typeof ZERNIO_LINKS;
	placement: string;
}): string {
	const url = new URL(ZERNIO_LINKS[path]);
	url.searchParams.set('utm_source', 'cogsend');
	url.searchParams.set('utm_medium', 'sponsorship');
	url.searchParams.set('utm_campaign', 'cogsend-integration');
	url.searchParams.set('utm_content', placement);
	return url.toString();
}
