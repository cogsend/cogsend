const SECTIONS: [prefix: string, name: string][] = [
	['/compose', 'Compose'],
	['/posts', 'Posts'],
	['/insights', 'Insights'],
	['/accounts', 'Accounts'],
	['/settings', 'Settings'],
	['/login/setup-2fa', 'Set up authenticator'],
	['/login', 'Sign in']
];

/**
 * The tab's title: the section first, so several open tabs can be told apart.
 * A preview link (`/p/…`) names itself, so it gets none here.
 */
export function pageTitle(pathname: string, appName: string): string | null {
	if (pathname.startsWith('/p/')) return null;
	const section = SECTIONS.find(
		([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
	return section ? `${section[1]} · ${appName}` : `${appName} — write & schedule`;
}
