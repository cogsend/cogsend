/**
 * The static response headers, kept out of the hook so the policy is data that
 * can be asserted directly — the e2e suite runs over plain http, where the
 * https-only HSTS branch can only ever be shown to be *absent*.
 */
export function securityHeadersFor(path: string, secure: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		'X-Content-Type-Options': 'nosniff',
		// OAuth callbacks carry `code`/`state` in the URL and signed media URLs
		// carry `exp`/`sig`; nothing in the app needs a referrer, so send none.
		'Referrer-Policy': 'no-referrer',
		// The app uses none of these; saying so keeps a future dependency from
		// asking the browser for them. Clipboard access stays at its 'self'
		// default because the API-key copy button needs it.
		'Permissions-Policy':
			'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), midi=()'
	};
	if (secure) {
		// Only over https: pinning a plain-http local dev server to https would
		// break it in the browser for good.
		headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
	}
	if (!path.startsWith('/api/')) {
		headers['X-Frame-Options'] = 'DENY';
	}
	if (path.startsWith('/p/')) {
		// Preview links are unlisted, not secret from the people they are sent
		// to; a crawler that finds one in a chat log must still leave it out.
		headers['X-Robots-Tag'] = 'noindex, nofollow';
	}
	return headers;
}
