import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';
import { createTestAdmin, createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { newId } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets } from '#lib/server/db/schema.js';
import * as publish from '#lib/server/publish.js';
import { rotateApiKey, verifyApiKey } from '#lib/server/api-keys.js';
import { POST } from '../src/routes/api/mcp/+server';

const expectedTools = [
	'list_connections',
	'list_drafts',
	'get_draft',
	'create_draft',
	'update_draft',
	'duplicate_draft',
	'delete_draft',
	'set_draft_variant',
	'delete_draft_variant',
	'validate_post',
	'publish_draft',
	'schedule_draft',
	'list_queue',
	'cancel_delivery',
	'retry_delivery',
	'reschedule_delivery'
];

let db: Awaited<ReturnType<typeof createTestDb>>['db'];
let closeDb: (() => void) | undefined;
let user: {
	id: string;
	email: string;
	timezone: string;
	totpEnabled: boolean;
	mfaVerified: boolean;
};
let rawKey: string;
let client: Client;
let transport: StreamableHTTPClientTransport;

beforeEach(async () => {
	const testDb = await createTestDb();
	db = testDb.db;
	closeDb = testDb.close;
	const row = await createTestAdmin(db, { totpEnabled: true });
	user = {
		id: row.id,
		email: row.email,
		timezone: row.timezone,
		totpEnabled: true,
		mfaVerified: true
	};
	rawKey = (await rotateApiKey(db, user.id)).raw;
	transport = new StreamableHTTPClientTransport(new URL('https://cogsend.example/api/mcp'), {
		requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
			const verified = token ? await verifyApiKey(db, token) : null;
			if (!verified || verified.userId !== user.id) {
				return Response.json({ error: 'Unauthorized' }, { status: 401 });
			}
			const event = {
				request,
				url: new URL(request.url),
				locals: {
					user,
					apiKeyScopes: verified.scopes,
					authMethod: 'bearer',
					authCredential: 'personal_api_key',
					db,
					env: TEST_ENV,
					media: createTestMedia()
				}
			} as never;
			return POST(event);
		}
	});
	client = new Client(
		{ name: 'cogsend-test-client', version: '1.0.0' },
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
	);
	await client.connect(transport);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await client?.close();
	closeDb?.();
	closeDb = undefined;
});

async function seedConnection(ownerId = user.id) {
	const id = newId();
	const now = new Date();
	await db.insert(connections).values({
		id,
		userId: ownerId,
		platform: 'mastodon',
		handle: 'test@mastodon.example',
		instanceUrl: 'https://mastodon.example',
		credentialsEncrypted: '{}',
		metaJson: '{}',
		status: 'active',
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function seedDraft(ownerId = user.id, title = 'MCP client draft') {
	const id = newId();
	const now = new Date();
	await db.insert(drafts).values({
		id,
		userId: ownerId,
		title,
		baseBody: 'Client test body',
		status: 'draft',
		createdAt: now,
		updatedAt: now
	});
	return id;
}

function structured(result: { structuredContent?: unknown }) {
	return result.structuredContent as Record<string, unknown>;
}

const expectedOutputFields: Record<string, string[]> = {
	list_connections: ['connections', 'configured', 'appUrl'],
	list_drafts: ['drafts', 'hasMore'],
	get_draft: ['draft'],
	create_draft: ['draft'],
	update_draft: ['ok'],
	duplicate_draft: ['draft'],
	delete_draft: ['ok'],
	set_draft_variant: ['variant'],
	delete_draft_variant: ['ok'],
	validate_post: [
		'graphemes',
		'mastodonLength',
		'bluesky',
		'mastodon',
		'linkedin',
		'threads',
		'instagram',
		'x',
		'issues'
	],
	publish_draft: ['results', 'stopped', 'stoppedError', 'draft'],
	schedule_draft: ['targets', 'scheduledFor'],
	list_queue: ['targets', 'hasMore'],
	cancel_delivery: ['target'],
	retry_delivery: ['status', 'remotePostId', 'error', 'skipped'],
	reschedule_delivery: ['ok', 'scheduledFor']
};

describe('MCP protocol client through the deployed route handler', () => {
	it('initializes, checks unsupported ping, and exposes the exact catalog and annotations', async () => {
		const pingRequest = new Request('https://cogsend.example/api/mcp', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'mcp-method': 'ping',
				'mcp-protocol-version': '2026-07-28'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 42,
				method: 'ping',
				params: {
					_meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} }
				}
			})
		});
		const pingResponse = await POST({
			request: pingRequest,
			url: new URL(pingRequest.url),
			locals: {
				user,
				apiKeyScopes: ['read', 'write'],
				db,
				env: TEST_ENV,
				media: createTestMedia()
			}
		} as never);
		const pingPayload = await pingResponse.json();
		// The pinned 2026-07-28 SDK wire era no longer defines ping requests.
		expect(pingResponse.status).toBe(404);
		expect(pingPayload).toMatchObject({ jsonrpc: '2.0', id: 42, error: { code: -32601 } });
		expect(client.getServerVersion()).toMatchObject({ name: 'cogsend', version: '1.0.0' });
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(expectedTools);
		for (const tool of tools) {
			const outputSchema = tool.outputSchema as {
				type?: string;
				properties?: Record<string, unknown>;
			};
			expect(outputSchema).toBeDefined();
			expect(outputSchema.type).toBe('object');
			expect(Object.keys(outputSchema.properties ?? {}).sort()).toEqual(
				[...expectedOutputFields[tool.name]].sort()
			);
		}
		const annotationByName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
		const read = {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		};
		const create = {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false
		};
		const update = {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false
		};
		const remove = {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		};
		const publish = {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true
		};
		expect(annotationByName).toEqual({
			list_connections: read,
			list_drafts: read,
			get_draft: read,
			create_draft: create,
			update_draft: update,
			duplicate_draft: create,
			delete_draft: remove,
			set_draft_variant: update,
			delete_draft_variant: remove,
			validate_post: read,
			publish_draft: publish,
			schedule_draft: update,
			list_queue: read,
			cancel_delivery: remove,
			retry_delivery: publish,
			reschedule_delivery: update
		});
	});

	it('executes representative behavior for all 16 tools, with bounds, ownership, and state restrictions', async () => {
		const connectionId = await seedConnection();
		const created = structured(
			await client.callTool({
				name: 'create_draft',
				arguments: { title: 'SDK-created', baseBody: 'hello' }
			})
		);
		const createdDraft = created.draft as Record<string, unknown>;
		const draftId = createdDraft.id as string;
		expect(createdDraft).toMatchObject({ title: 'SDK-created', baseBody: 'hello' });
		expect(
			structured(await client.callTool({ name: 'list_connections', arguments: {} })).connections
		).toEqual(expect.arrayContaining([expect.objectContaining({ id: connectionId })]));
		expect(
			structured(await client.callTool({ name: 'list_drafts', arguments: { limit: 1 } })).drafts
		).toHaveLength(1);
		expect(
			(
				structured(await client.callTool({ name: 'get_draft', arguments: { draftId } }))
					.draft as Record<string, unknown>
			).id
		).toBe(draftId);
		expect(
			structured(
				await client.callTool({
					name: 'update_draft',
					arguments: { draftId, title: 'SDK-updated' }
				})
			)
		).toEqual({ ok: true });
		const duplicate = structured(
			await client.callTool({ name: 'duplicate_draft', arguments: { draftId } })
		);
		expect(duplicate.draft).toMatchObject({ title: 'SDK-updated', baseBody: 'hello' });
		const variant = structured(
			await client.callTool({
				name: 'set_draft_variant',
				arguments: { draftId, platform: 'mastodon', body: 'variant text' }
			})
		);
		expect(variant.variant).toMatchObject({ platform: 'mastodon', body: 'variant text' });
		expect(
			(
				structured(await client.callTool({ name: 'get_draft', arguments: { draftId } }))
					.draft as Record<string, unknown>
			).variants
		).toEqual(expect.arrayContaining([expect.objectContaining({ platform: 'mastodon' })]));
		expect(
			structured(
				await client.callTool({
					name: 'delete_draft_variant',
					arguments: { draftId, platform: 'mastodon' }
				})
			)
		).toEqual({ ok: true });
		expect(
			structured(
				await client.callTool({
					name: 'validate_post',
					arguments: { text: 'hello', platform: 'mastodon' }
				})
			).graphemes
		).toBe(5);

		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const scheduled = structured(
			await client.callTool({
				name: 'schedule_draft',
				arguments: { draftId, connectionIds: [connectionId], runAt: future }
			})
		);
		expect(scheduled.targets).toHaveLength(1);
		const queued = structured(
			await client.callTool({ name: 'list_queue', arguments: { limit: 1 } })
		);
		expect(queued.targets).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: 'scheduled' })])
		);
		const targetId = (scheduled.targets as Array<{ id: string }>)[0].id;
		expect(
			structured(
				await client.callTool({
					name: 'reschedule_delivery',
					arguments: { targetId, runAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() }
				})
			).scheduledFor
		).toBeTruthy();
		expect(
			(
				structured(await client.callTool({ name: 'cancel_delivery', arguments: { targetId } }))
					.target as Record<string, unknown>
			).status
		).toBe('cancelled');
		const cancelledReschedule = await client.callTool({
			name: 'reschedule_delivery',
			arguments: { targetId, runAt: future }
		});
		expect(cancelledReschedule.isError).toBe(true);
		expect(structured(cancelledReschedule)).toMatchObject({
			error: 'Cancelled — retry instead',
			status: 400
		});
		const retry = await client.callTool({ name: 'retry_delivery', arguments: { targetId } });
		expect(structured(retry)).toMatchObject({ status: 'scheduled' });
		const [retriedTarget] = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.id, targetId));
		expect(retriedTarget.status).toBe('scheduled');

		const other = await createTestAdmin(db, {
			email: `other-${newId()}@localhost`,
			totpEnabled: true
		});
		const foreignId = await seedDraft(other.id, 'Foreign');
		const foreign = await client.callTool({ name: 'get_draft', arguments: { draftId: foreignId } });
		expect(foreign.isError).toBe(true);
		expect(structured(foreign)).toMatchObject({ error: 'Not found', status: 404 });
		const publishedDraftId = await seedDraft(user.id, 'Previously published');
		const now = new Date();
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: publishedDraftId,
			connectionId,
			status: 'published',
			remotePostId: 'remote-post',
			remoteUrl: 'https://mastodon.example/@test/1',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const skippedPublish = structured(
			await client.callTool({
				name: 'publish_draft',
				arguments: { draftId: publishedDraftId, connectionIds: [connectionId] }
			})
		);
		expect((skippedPublish.results as Array<Record<string, unknown>>)[0]).toMatchObject({
			status: 'published',
			skipped: true
		});
		const scheduleConflict = await client.callTool({
			name: 'schedule_draft',
			arguments: { draftId: publishedDraftId, connectionIds: [connectionId], runAt: future }
		});
		expect(scheduleConflict.isError).toBe(true);
		expect(structured(scheduleConflict)).toMatchObject({
			status: 409,
			alreadyPublished: [connectionId]
		});
		const publishedTargetId = (skippedPublish.results as Array<{ targetId: string }>)[0].targetId;
		const retryPublished = structured(
			await client.callTool({
				name: 'retry_delivery',
				arguments: { targetId: publishedTargetId }
			})
		);
		expect(retryPublished).toMatchObject({ status: 'published', skipped: true });
		const publishedCancel = await client.callTool({
			name: 'cancel_delivery',
			arguments: { targetId: publishedTargetId }
		});
		expect(publishedCancel.isError).toBe(true);
		expect(structured(publishedCancel)).toMatchObject({ error: 'Already published', status: 400 });
		const publishedReschedule = await client.callTool({
			name: 'reschedule_delivery',
			arguments: { targetId: publishedTargetId, runAt: future }
		});
		expect(publishedReschedule.isError).toBe(true);
		expect(structured(publishedReschedule)).toMatchObject({
			error: 'Already published',
			status: 409
		});
		const tooMany = await client.callTool({
			name: 'publish_draft',
			arguments: { draftId, connectionIds: Array(11).fill(connectionId) }
		});
		expect(tooMany.isError).toBe(true);
		expect(tooMany.content?.some((item) => item.type === 'text' && item.text.length > 0)).toBe(
			true
		);
		const duplicateDraft = duplicate.draft as Record<string, unknown>;
		expect(
			(await client.callTool({ name: 'delete_draft', arguments: { draftId: duplicateDraft.id } }))
				.isError
		).not.toBe(true);
		expect(
			structured(
				await client.callTool({ name: 'get_draft', arguments: { draftId: duplicateDraft.id } })
			).error
		).toBe('Not found');
	});

	it('preserves a successful publish when a later destination fails', async () => {
		const draftId = await seedDraft(user.id, 'Partial publish');
		const connectionIds = [await seedConnection(), await seedConnection()];
		const permalink = 'https://mastodon.example/@test/partial';
		vi.spyOn(publish, 'publishTarget')
			.mockImplementationOnce(async (_db, _env, _store, targetId) => {
				await db
					.update(publishTargets)
					.set({ status: 'published', remotePostId: 'remote-partial', remoteUrl: permalink })
					.where(eq(publishTargets.id, targetId));
				return { status: 'published', remotePostId: 'remote-partial' };
			})
			.mockRejectedValueOnce(new Error('private database connection string'));

		const response = await client.callTool({
			name: 'publish_draft',
			arguments: { draftId, connectionIds }
		});
		expect(response.isError).not.toBe(true);
		const result = structured(response);
		expect(result.results).toHaveLength(1);
		expect(result.results).toMatchObject([{ status: 'published', permalink, skipped: false }]);
		expect(result).toMatchObject({
			stopped: true,
			stoppedError: 'Publishing stopped early — try again for the rest'
		});
		expect(JSON.stringify(result)).not.toContain('private database connection string');
	});

	it('rejects schema-invalid calls and returns safe application errors', async () => {
		const badLimit = await client.callTool({ name: 'list_drafts', arguments: { limit: 101 } });
		expect(badLimit.isError).toBe(true);
		const missing = await client.callTool({ name: 'get_draft', arguments: { draftId: 'missing' } });
		expect(missing.isError).toBe(true);
		expect(structured(missing)).toMatchObject({ error: 'Not found', status: 404 });
	});

	it('uses JSON-RPC errors for unknown tools and malformed JSON-RPC messages', async () => {
		const send = async (body: string) => {
			const request = new Request('https://cogsend.example/api/mcp', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${rawKey}`,
					'mcp-protocol-version': '2026-07-28'
				},
				body
			});
			return POST({
				request,
				url: new URL(request.url),
				locals: {
					user,
					apiKeyScopes: ['read', 'write'],
					db,
					env: TEST_ENV,
					media: createTestMedia()
				}
			} as never);
		};
		const unknown = await send(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 9,
				method: 'tools/call',
				params: { name: 'not_a_tool', arguments: {} }
			})
		);
		expect((await unknown.json()).error).toMatchObject({ code: -32602 });
		const malformed = await send('{"jsonrpc":');
		expect(malformed.status).toBeGreaterThanOrEqual(400);
		expect(malformed.headers.get('content-type')).toContain('application/json');
	});
});
