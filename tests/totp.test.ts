import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, formatSecretGroups } from '#lib/domain/base32.js';
import { generateBackupCode, normalizeBackupCode } from '#lib/domain/backup-codes.js';
import { buildOtpauthUrl, hotp, totpAt, totpCounter, verifyTotp } from '#lib/domain/totp.js';

const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('base32', () => {
	it('round-trips without padding', () => {
		const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
		const enc = base32Encode(bytes);
		expect(enc.includes('=')).toBe(false);
		expect(base32Decode(enc)).toEqual(bytes);
	});

	it('groups secrets for manual entry', () => {
		expect(formatSecretGroups('MFRGGZDF')).toBe('MFRG GZDF');
	});
});

describe('RFC 6238 SHA-1 vectors (8-digit, then 6-digit tail)', () => {
	it('matches 8-digit appendix B at t=59', async () => {
		expect(await hotp(RFC_SECRET, totpCounter(59), 8)).toBe('94287082');
	});
	it('matches 8-digit at 1111111109', async () => {
		expect(await hotp(RFC_SECRET, totpCounter(1111111109), 8)).toBe('07081804');
	});
	it('matches 8-digit at 1111111111', async () => {
		expect(await hotp(RFC_SECRET, totpCounter(1111111111), 8)).toBe('14050471');
	});
	it('matches 8-digit at 1234567890', async () => {
		expect(await hotp(RFC_SECRET, totpCounter(1234567890), 8)).toBe('89005924');
	});
	it('6-digit is the last six of the 8-digit code', async () => {
		expect(await totpAt(RFC_SECRET, 59)).toBe('287082');
	});
});

describe('verifyTotp window and replay', () => {
	it('accepts current step', async () => {
		const now = new Date(1_111_111_111_000);
		const code = await totpAt(RFC_SECRET, 1_111_111_111);
		const r = await verifyTotp(RFC_SECRET, code, { now });
		expect(r.ok).toBe(true);
	});

	it('accepts adjacent window', async () => {
		const now = new Date(1_111_111_111_000);
		const prev = await totpAt(RFC_SECRET, 1_111_111_111 - 30);
		const r = await verifyTotp(RFC_SECRET, prev, { now });
		expect(r.ok).toBe(true);
	});

	it('rejects outside ±1 window', async () => {
		const now = new Date(1_111_111_111_000);
		const far = await totpAt(RFC_SECRET, 1_111_111_111 - 90);
		const r = await verifyTotp(RFC_SECRET, far, { now });
		expect(r.ok).toBe(false);
	});

	it('rejects replay of the same or earlier step', async () => {
		const now = new Date(1_111_111_111_000);
		const code = await totpAt(RFC_SECRET, 1_111_111_111);
		const first = await verifyTotp(RFC_SECRET, code, { now });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const again = await verifyTotp(RFC_SECRET, code, { now, lastStep: first.step });
		expect(again.ok).toBe(false);
	});
});

describe('otpauth URI', () => {
	it('uses SHA1 / 6 / 30 and issuer CogSend', () => {
		const url = buildOtpauthUrl({ email: 'admin@example.com', secretBase32: 'MFRGGZDFMZTWQ2LK' });
		expect(url.startsWith('otpauth://totp/')).toBe(true);
		expect(url).toContain('issuer=CogSend');
		expect(url).toContain('algorithm=SHA1');
		expect(url).toContain('digits=6');
		expect(url).toContain('period=30');
		expect(url).toContain('secret=MFRGGZDFMZTWQ2LK');
		expect(url).toContain(encodeURIComponent('admin@example.com'));
	});
});

describe('backup codes', () => {
	it('normalizes dashes and case', () => {
		expect(normalizeBackupCode('ab2d-efg3')).toBe('AB2DEFG3');
	});
	it('has xxxx-xxxx shape', () => {
		expect(generateBackupCode()).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
	});
});
