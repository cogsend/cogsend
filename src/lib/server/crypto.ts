import {
	base64ToBytes,
	bytesToBase64,
	bytesToHex,
	hexToBytes,
	randomBytes,
	timingSafeEqual,
	utf8Bytes
} from '$lib/domain/bytes';

/**
 * Workers Web Crypto rejects PBKDF2 iteration counts above 100_000 on every
 * plan — the ceiling is in the runtime, so Workers Paid does not lift it. 25k
 * keeps a login inside the Workers Free plan's 10 ms CPU slice: 100k alone used
 * all of it (measured ~11 ms) and the login failed with "exceeded CPU time" on
 * Free.
 *
 * That is the online half of the story only. A stolen hash is attacked offline,
 * where nothing here applies and 25k is weak; the defence for that case is that
 * the hash never leaves D1 (and the instance is one account, not a user table).
 * A stored hash carries its own count, so a hash written at a higher allowed
 * count still verifies — but counting above the runtime ceiling can never be
 * verified in a Worker, so setup refuses to write one.
 */
const PBKDF2_ITERS = 25_000;
/** workerd's PBKDF2 ceiling: a higher count throws NotSupportedError. */
const PBKDF2_MAX_ITERS = 100_000;
const TAG_BYTES = 16;

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

async function keyFromEnv(hexOrSecret: string): Promise<CryptoKey> {
	const raw = /^[0-9a-fA-F]{64}$/.test(hexOrSecret)
		? hexToBytes(hexOrSecret)
		: await sha256(utf8Bytes(hexOrSecret));
	return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

export async function encryptSecret(plaintext: string, encryptionKey: string): Promise<string> {
	const key = await keyFromEnv(encryptionKey);
	const iv = randomBytes(12);
	const packed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource },
			key,
			utf8Bytes(plaintext) as BufferSource
		)
	);
	const data = packed.subarray(0, packed.length - TAG_BYTES);
	const tag = packed.subarray(packed.length - TAG_BYTES);
	return `v1:${bytesToBase64(iv)}:${bytesToBase64(tag)}:${bytesToBase64(data)}`;
}

export async function decryptSecret(payload: string, encryptionKey: string): Promise<string> {
	const parts = payload.split(':');
	if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted payload');
	const [, ivB64, tagB64, dataB64] = parts;
	const key = await keyFromEnv(encryptionKey);
	const iv = base64ToBytes(ivB64);
	const tag = base64ToBytes(tagB64);
	const data = base64ToBytes(dataB64);
	const packed = new Uint8Array(data.length + tag.length);
	packed.set(data, 0);
	packed.set(tag, data.length);
	try {
		const dec = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource },
			key,
			packed as BufferSource
		);
		return new TextDecoder().decode(dec);
	} catch {
		throw new Error('Invalid encrypted payload');
	}
}

export async function encryptJson<T>(value: T, encryptionKey: string): Promise<string> {
	return encryptSecret(JSON.stringify(value), encryptionKey);
}

export async function decryptJson<T>(payload: string, encryptionKey: string): Promise<T> {
	return JSON.parse(await decryptSecret(payload, encryptionKey)) as T;
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await crypto.subtle.importKey(
		'raw',
		utf8Bytes(password) as BufferSource,
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERS },
		key,
		256
	);
	return `pbkdf2$${PBKDF2_ITERS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

/**
 * A 256-bit key from the account password, as the hex `encryptSecret` takes,
 * for a secret that must stay locked even to someone holding D1 and
 * APP_ENCRYPTION_KEY. Same iteration count as the login: the password hash in
 * D1 already lets an attacker guess at that cost, so more would only spend the
 * Free plan's CPU, and fewer would make this the cheaper thing to attack.
 */
export async function passwordKeyHex(password: string, salt: Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		utf8Bytes(password) as BufferSource,
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERS },
		key,
		256
	);
	return bytesToHex(new Uint8Array(bits));
}

/** Verify a `hashPassword` value. Constant-time on the derived bits. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
	const iterations = Number.parseInt(parts[1], 10);
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERS)
		return false;
	const salt = base64ToBytes(parts[2]);
	const expected = base64ToBytes(parts[3]);
	if (salt.length === 0 || expected.length === 0) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		utf8Bytes(password) as BufferSource,
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: 'PBKDF2',
				hash: 'SHA-256',
				salt: salt as BufferSource,
				iterations
			},
			key,
			expected.length * 8
		)
	);
	return timingSafeEqual(expected, bits);
}

const HMAC_KEY_CACHE_MAX = 32;
const hmacKeys = new Map<string, Promise<CryptoKey>>();

async function hmacKey(secret: string): Promise<CryptoKey> {
	const cached = hmacKeys.get(secret);
	if (cached) return cached;
	const pending = crypto.subtle
		.importKey('raw', utf8Bytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign'
		])
		.catch((err) => {
			hmacKeys.delete(secret);
			throw err;
		});
	hmacKeys.set(secret, pending);
	if (hmacKeys.size > HMAC_KEY_CACHE_MAX) {
		const oldest = hmacKeys.keys().next().value;
		if (oldest !== undefined && oldest !== secret) hmacKeys.delete(oldest);
	}
	return pending;
}

export async function hmacHex(secret: string, value: string): Promise<string> {
	const key = await hmacKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, utf8Bytes(value) as BufferSource);
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}
