import { describe, expect, it } from 'vitest';
import { qrSvg } from '#lib/server/qr.js';

describe('qrSvg', () => {
	it('emits an svg with an explicit size so it cannot collapse', () => {
		const svg = qrSvg('otpauth://totp/CogSend:test@localhost?secret=ABC&issuer=CogSend');
		expect(svg.startsWith('<svg ')).toBe(true);
		expect(svg).toContain('width="192"');
		expect(svg).toContain('height="192"');
		expect(svg).toContain('viewBox=');
	});
});
