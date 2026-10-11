import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	AUTH_GATE_MAX_FAILURES,
	PASSWORD_GATE_GLOBAL_MAX,
	assertPasswordGateOpen,
	clearPasswordGate,
	clientAddressBucket,
	recordPasswordFailure
} from '#lib/server/auth-gate.js';
import { mfaChallenges } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import type { AppDb } from '#lib/server/db/client.js';

describe('clientAddressBucket', () => {
	it('keeps IPv4 as is and groups IPv6 by its /64', () => {
		expect(clientAddressBucket('203.0.113.7')).toBe('203.0.113.7');
		expect(clientAddressBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
		expect(clientAddressBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
		expect(clientAddressBucket('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe(
			'2001:db8:1:2::/64'
		);
		expect(clientAddressBucket('2001:db8::')).toBe('2001:db8:0:0::/64');
		expect(clientAddressBucket('::1')).toBe('0:0:0:0::/64');
		expect(clientAddressBucket('')).toBeUndefined();
		expect(clientAddressBucket(null)).toBeUndefined();
	});
});

describe('password gate', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = (await createTestAdmin(db)).id;
	});
	beforeEach(async () => {
		await db.delete(mfaChallenges);
	});
	afterAll(() => close());

	async function fail(ip: string | null, times: number) {
		let locked = false;
		for (let i = 0; i < times; i++) {
			locked = (await recordPasswordFailure(db, TEST_ENV, userId, ip)).locked;
		}
		return locked;
	}

	it('locks only the address that guessed, so a guesser cannot lock the owner out', async () => {
		expect(await fail('198.51.100.1', AUTH_GATE_MAX_FAILURES)).toBe(true);
		await expect(assertPasswordGateOpen(db, TEST_ENV, userId, '198.51.100.1')).rejects.toThrow(
			/Too many attempts/
		);
		await expect(
			assertPasswordGateOpen(db, TEST_ENV, userId, '192.0.2.50')
		).resolves.toBeUndefined();
	});

	it('treats every address in one IPv6 /64 as one guesser', async () => {
		for (let i = 0; i < AUTH_GATE_MAX_FAILURES; i++) {
			await recordPasswordFailure(db, TEST_ENV, userId, `2001:db8:5:6::${i + 1}`);
		}
		await expect(
			assertPasswordGateOpen(db, TEST_ENV, userId, '2001:db8:5:6::ffff')
		).rejects.toThrow(/Too many attempts/);
	});

	it('still stops guessing spread over many addresses', async () => {
		for (let i = 0; i < PASSWORD_GATE_GLOBAL_MAX; i++) {
			await recordPasswordFailure(db, TEST_ENV, userId, `198.51.100.${i + 1}`);
		}
		await expect(assertPasswordGateOpen(db, TEST_ENV, userId, '203.0.113.99')).rejects.toThrow(
			/Too many attempts/
		);
	});

	it('without an address, counts per account exactly as before', async () => {
		expect(await fail(null, AUTH_GATE_MAX_FAILURES - 1)).toBe(false);
		expect(await fail(null, 1)).toBe(true);
		await expect(assertPasswordGateOpen(db, TEST_ENV, userId, null)).rejects.toThrow(
			/Too many attempts/
		);
	});

	it('a correct password clears its address and the account-wide count', async () => {
		await fail('198.51.100.9', AUTH_GATE_MAX_FAILURES - 1);
		for (let i = 0; i < PASSWORD_GATE_GLOBAL_MAX - AUTH_GATE_MAX_FAILURES; i++) {
			await recordPasswordFailure(db, TEST_ENV, userId, `192.0.2.${i + 1}`);
		}
		await clearPasswordGate(db, TEST_ENV, userId, '198.51.100.9');
		// A fresh run of failures from that address starts from zero again, and
		// the account-wide count no longer carries the earlier ones.
		expect(await fail('198.51.100.9', AUTH_GATE_MAX_FAILURES - 1)).toBe(false);
		await expect(
			assertPasswordGateOpen(db, TEST_ENV, userId, '203.0.113.1')
		).resolves.toBeUndefined();
	});
});
