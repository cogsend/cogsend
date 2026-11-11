export type SettingsSection = { href: string; label: string; anchors: readonly string[] };

/**
 * Settings, one page per section. `anchors` are the ids cards had when Settings
 * was a single page, so an old `/settings#instance` link still lands on the
 * right section.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{ href: '/settings', label: 'Account', anchors: [] },
	{ href: '/settings/posting', label: 'Posting', anchors: [] },
	{ href: '/settings/scheduling', label: 'Scheduled publishing', anchors: [] },
	{ href: '/settings/api', label: 'API & MCP', anchors: [] },
	{ href: '/settings/instance', label: 'Instance', anchors: ['instance'] }
];

/** The section a path belongs to, or null outside Settings. */
export function settingsSectionFor(pathname: string): SettingsSection | null {
	const path = pathname.replace(/\/+$/, '') || '/';
	return SETTINGS_SECTIONS.find((section) => section.href === path) ?? null;
}

/** Where an old single-page link such as `/settings#instance` now lives, if it moved. */
export function settingsSectionForAnchor(hash: string): SettingsSection | null {
	const id = hash.replace(/^#/, '');
	if (!id) return null;
	return SETTINGS_SECTIONS.find((section) => section.anchors.includes(id)) ?? null;
}
