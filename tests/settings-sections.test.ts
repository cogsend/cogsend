import { describe, expect, it } from 'vitest';
import {
	SETTINGS_SECTIONS,
	settingsSectionFor,
	settingsSectionForAnchor
} from '#lib/domain/settings-sections.js';

describe('settings sections', () => {
	it('finds the section for each settings path, with or without a trailing slash', () => {
		for (const section of SETTINGS_SECTIONS) {
			expect(settingsSectionFor(section.href)).toBe(section);
			expect(settingsSectionFor(`${section.href}/`)).toBe(section);
		}
		expect(settingsSectionFor('/settings/instance')?.label).toBe('Instance');
	});

	it('is null outside Settings and for an unknown section', () => {
		expect(settingsSectionFor('/')).toBeNull();
		expect(settingsSectionFor('/accounts')).toBeNull();
		expect(settingsSectionFor('/settings/nope')).toBeNull();
		expect(settingsSectionFor('/settingsx')).toBeNull();
	});

	it('sends an old single-page anchor to the section that now holds it', () => {
		expect(settingsSectionForAnchor('#instance')?.href).toBe('/settings/instance');
		expect(settingsSectionForAnchor('instance')?.href).toBe('/settings/instance');
	});

	it('leaves an empty or unknown anchor where it is', () => {
		expect(settingsSectionForAnchor('')).toBeNull();
		expect(settingsSectionForAnchor('#')).toBeNull();
		expect(settingsSectionForAnchor('#profile-picture')).toBeNull();
	});
});
