import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	blueskyLinkStyleFor,
	blueskyRichText,
	longestBlueskyLinkStyle,
	shortenBlueskyUrl
} from '#lib/domain/bluesky-links.js';
import { blueskyTextLength } from '#lib/domain/validation/text.js';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { blueskyProvider } from '#lib/server/providers/bluesky.js';
import { zernioProviderFor } from '#lib/server/providers/zernio.js';
import type { FetchLike } from '#lib/server/providers/types.js';
import { PATCH as connectionPATCH } from '../src/routes/api/connections/[id]/+server';
import { POST as blueskyPOST } from '../src/routes/api/connections/bluesky/+server';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const facetText = (text: string, facet: { index: { byteStart: number; byteEnd: number } }) =>
	decoder.decode(encoder.encode(text).slice(facet.index.byteStart, facet.index.byteEnd));

const ETSY = 'https://marktisdaleart.etsy.com/listing/1234567890/sunset-over-the-lake-print';

describe('compact Bluesky links', () => {
	it('keeps the site and drops the rest where Bluesky’s app would cut it', () => {
		expect(shortenBlueskyUrl(ETSY, 'compact')).toBe('marktisdaleart.etsy.com/...');
		expect(shortenBlueskyUrl(ETSY)).toBe('marktisdaleart.etsy.com/listing/1234...');
		expect(shortenBlueskyUrl('https://example.com/?utm_source=newsletter', 'compact')).toBe(
			'example.com/...'
		);
		expect(shortenBlueskyUrl('http://example.com:8080/0123456789abcdef', 'compact')).toBe(
			'example.com:8080/...'
		);
	});

	it('leaves a link Bluesky’s app shows whole as it is', () => {
		expect(shortenBlueskyUrl('https://linktr.ee/markonart', 'compact')).toBe('linktr.ee/markonart');
		expect(shortenBlueskyUrl('https://example.com/0123456789abcd', 'compact')).toBe(
			'example.com/0123456789abcd'
		);
		expect(shortenBlueskyUrl('https://bsky.app', 'compact')).toBe('bsky.app');
	});

	it('links the compact text to the full URL, by byte offsets', () => {
		const { text, facets } = blueskyRichText(`🎨 prints ${ETSY} and https://linktr.ee/markonart`, {
			links: 'compact'
		});
		expect(text).toBe('🎨 prints marktisdaleart.etsy.com/... and linktr.ee/markonart');
		expect(facets.map((f) => facetText(text, f))).toEqual([
			'marktisdaleart.etsy.com/...',
			'linktr.ee/markonart'
		]);
		expect(facets.map((f) => (f.features[0] as { uri: string }).uri)).toEqual([
			ETSY,
			'https://linktr.ee/markonart'
		]);
	});

	it('takes each account’s style from its meta, Zernio always in full', () => {
		expect(blueskyLinkStyleFor({})).toBe('short');
		expect(blueskyLinkStyleFor(null)).toBe('short');
		expect(blueskyLinkStyleFor({ compactLinks: true })).toBe('compact');
		expect(blueskyLinkStyleFor({ provider: 'zernio', compactLinks: true })).toBe('full');
	});

	it('counts a post for several accounts in the style that makes it longest', () => {
		expect(longestBlueskyLinkStyle(['compact', 'compact'])).toBe('compact');
		expect(longestBlueskyLinkStyle(['compact', 'short'])).toBe('short');
		expect(longestBlueskyLinkStyle(['compact', 'full', 'short'])).toBe('full');
		expect(longestBlueskyLinkStyle([])).toBe('short');
	});

	it('lets a compact account take a post the default style is too long for', () => {
		const post = `${'a'.repeat(270)} ${ETSY}`;
		expect(blueskyTextLength(post, { links: 'compact' })).toBe(271 + 27);
		expect(blueskyProvider.validate({ text: post }, { compactLinks: true })).toEqual([]);
		expect(blueskyProvider.validate({ text: post }, {}).map((i) => i.code)).toEqual(['max_length']);
		const zernio = zernioProviderFor('bluesky').validate({ text: post }, { compactLinks: true });
		expect(zernio.map((i) => i.code)).toEqual(['max_length']);
	});

	it('publishes the compact text with the full URL behind it', async () => {
		const records: Array<{ text: string; facets?: Array<{ features: Array<{ uri: string }> }> }> =
			[];
		const fetchImpl: FetchLike = async (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.includes('createSession')) {
				return Response.json({ accessJwt: 'a', refreshJwt: 'r', did: 'did:plc:x', handle: 'x' });
			}
			if (url.includes('createRecord')) {
				records.push(JSON.parse(String(init?.body)).record);
				return Response.json({
					uri: `at://did:plc:x/app.bsky.feed.post/${records.length}`,
					cid: `c${records.length}`
				});
			}
			return new Response('not mocked', { status: 404 });
		};
		await blueskyProvider.publish(
			{ text: `first ${ETSY}`, thread: [{ text: `first ${ETSY}` }, { text: `then ${ETSY}` }] },
			{ handle: 'x', appPassword: 'p' },
			{ compactLinks: true },
			fetchImpl
		);
		expect(records.map((r) => r.text)).toEqual([
			'first marktisdaleart.etsy.com/...',
			'then marktisdaleart.etsy.com/...'
		]);
		expect(records.map((r) => r.facets?.[0].features[0].uri)).toEqual([ETSY, ETSY]);
	});
});

describe('the compact links switch', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'bsky-compact@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	afterAll(() => close());

	async function account(platform: string, meta: Record<string, unknown> = {}) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle: 'someone.bsky.social',
			credentialsEncrypted: await encryptJson({ appPassword: 'p' }, TEST_ENV.APP_ENCRYPTION_KEY),
			metaJson: JSON.stringify({ did: 'did:plc:someone', ...meta }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}
	const metaOf = async (id: string) =>
		JSON.parse(
			(await db.select().from(connections).where(eq(connections.id, id)))[0].metaJson
		) as Record<string, unknown>;
	const locals = (authMethod: 'session' | 'bearer' = 'session') => ({
		db,
		env: TEST_ENV,
		authMethod,
		apiKeyScopes: null,
		user: {
			id: userId,
			email: 'bsky-compact@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});
	const patch = (id: string, body: unknown, authMethod: 'session' | 'bearer' = 'session') =>
		connectionPATCH({
			params: { id },
			locals: locals(authMethod),
			request: new Request('http://localhost/api/connections/' + id, {
				method: 'PATCH',
				body: JSON.stringify(body)
			})
		} as never) as Promise<Response>;

	it('turns compact links on and off on a Bluesky account', async () => {
		const id = await account('bluesky');
		const on = await patch(id, { compactLinks: true });
		expect(on.status).toBe(200);
		expect((await on.json()).connection.metaJson).toMatchObject({ compactLinks: true });
		expect(await metaOf(id)).toEqual({ did: 'did:plc:someone', compactLinks: true });
		expect((await patch(id, { compactLinks: false })).status).toBe(200);
		expect(await metaOf(id)).toEqual({ did: 'did:plc:someone' });
	});

	it('refuses API keys, other platforms, Zernio accounts and bad values', async () => {
		const id = await account('bluesky');
		expect((await patch(id, { compactLinks: true }, 'bearer')).status).toBe(401);
		expect((await patch(id, { compactLinks: 'yes' })).status).toBe(400);
		expect((await patch(id, { compactLinks: null })).status).toBe(400);
		expect((await patch(id, { compactLinks: true, longPosts: true })).status).toBe(400);
		expect((await patch(id, { longPosts: true })).status).toBe(400);
		const zernio = await account('bluesky', { provider: 'zernio', zernioAccountId: 'a' });
		expect((await patch(zernio, { compactLinks: true })).status).toBe(400);
		const x = await account('x');
		expect((await patch(x, { compactLinks: true })).status).toBe(400);
		expect((await metaOf(id)).compactLinks).toBeUndefined();
	});

	it('a reconnect keeps the switch', async () => {
		const id = await account('bluesky', {
			did: 'did:plc:reconnecting',
			pdsHost: 'https://bsky.social',
			compactLinks: true
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.includes('createSession')) {
					return Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:reconnecting',
						handle: 'someone.bsky.social'
					});
				}
				return Response.json({ displayName: 'Someone' });
			})
		);
		const res = (await blueskyPOST({
			locals: locals(),
			request: new Request('http://localhost/api/connections/bluesky', {
				method: 'POST',
				body: JSON.stringify({ handle: 'someone.bsky.social', appPassword: 'new-password' })
			})
		} as never)) as Response;
		expect(res.status).toBe(200);
		expect((await res.json()).connection.id).toBe(id);
		expect(await metaOf(id)).toMatchObject({ did: 'did:plc:reconnecting', compactLinks: true });
	});
});
