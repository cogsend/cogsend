import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '#lib/domain/bytes.js';
import {
	decryptJson,
	decryptSecret,
	encryptJson,
	encryptSecret,
	hashPassword,
	verifyPassword
} from '#lib/server/crypto.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('hex', () => {
	it('round-trips a hex string', () => {
		expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
		expect(hexToBytes(' 00FF10 ')).toEqual(new Uint8Array([0, 255, 16]));
	});

	it('refuses anything that is not hex, rather than zeroing it', () => {
		// parseInt('zz', 16) is NaN and a Uint8Array stores that as 0, so a
		// garbage key used to come back as an all-zero key instead of an error.
		expect(() => hexToBytes('zzzz')).toThrow(/Invalid hex/);
		expect(() => hexToBytes('00ff1')).toThrow(/Invalid hex/);
		expect(() => hexToBytes('00 gg')).toThrow(/Invalid hex/);
		expect(hexToBytes('')).toEqual(new Uint8Array([]));
	});
});

describe('crypto', () => {
	it('round-trips secrets', async () => {
		const plain = 'super-secret-token';
		const enc = await encryptSecret(plain, KEY);
		expect(enc).not.toContain(plain);
		expect(await decryptSecret(enc, KEY)).toBe(plain);
	});

	it('round-trips json credentials', async () => {
		const creds = { accessToken: 'abc', instanceUrl: 'https://x' };
		const enc = await encryptJson(creds, KEY);
		expect(await decryptJson<typeof creds>(enc, KEY)).toEqual(creds);
	});

	it('rejects tampered payload', async () => {
		const enc = await encryptSecret('hello', KEY);
		await expect(decryptSecret(enc.slice(0, -2) + 'aa', KEY)).rejects.toThrow();
	});
});

describe('password hashes', () => {
	it('verifies the password it hashed and nothing else', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(hash.startsWith('pbkdf2$')).toBe(true);
		expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
		expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
		expect(await verifyPassword('', hash)).toBe(false);
	});

	it('salts every hash, so the same password never hashes the same way', async () => {
		const a = await hashPassword('same password');
		const b = await hashPassword('same password');
		expect(a).not.toBe(b);
		expect(await verifyPassword('same password', a)).toBe(true);
		expect(await verifyPassword('same password', b)).toBe(true);
	});

	it('refuses malformed or truncated stored values instead of throwing', async () => {
		for (const stored of [
			'',
			'not-a-hash',
			'pbkdf2$100000$aaaa',
			'pbkdf2$notanumber$aaaa$bbbb',
			'pbkdf2$0$aaaa$bbbb',
			'pbkdf2$100000$$bbbb'
		]) {
			expect(await verifyPassword('whatever', stored)).toBe(false);
		}
	});
});
