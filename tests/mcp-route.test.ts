import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';
import { createTestAdmin, createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { newId } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets } from '#lib/server/db/schema.js';
import { memoryMediaStore, thumbCacheKey } from '#lib/server/media.js';
import * as publish from '#lib/server/publish.js';
import { DELETE, GET, POST } from '../src/routes/api/mcp/+server';

const toolNames = [
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

const readAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false
};
const createAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false
};
const updateAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false
};
const deleteAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false
};
const publishAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true
};

type McpTool = {
	name: string;
	annotations: Record<string, unknown>;
	inputSchema: { properties?: Record<string, unknown>; required?: string[] };
};
type ToolCallResult = {
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
	content?: Array<{ text: string }>;
};
type McpPayload = {
	result?: ToolCallResult & { tools?: McpTool[] };
	error?: unknown;
};

let db: Awaited<ReturnType<typeof createTestDb>>['db'];
let closeDb: (() => void) | undefined;
let user: {
	id: string;
	email: string;
	timezone: string;
	totpEnabled: boolean;
	mfaVerified: boolean;
};

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
});

afterEach(() => {
	closeDb?.();
	closeDb = undefined;
	vi.restoreAllMocks();
});

function requestEvent(
	request: Request,
	overrides: Record<string, unknown> = {},
	waitUntil?: (promise: Promise<unknown>) => void
) {
	const locals = {
		user,
		apiKeyScopes: ['read', 'write'],
		db,
		env: TEST_ENV,
		media: createTestMedia(),
		...(waitUntil && { waitUntil }),
		...overrides
	};
	return { request, locals, url: new URL(request.url) } as never;
}

async function seedDraft(ownerId = user.id) {
	const id = newId();
	const now = new Date();
	await db.insert(drafts).values({
		id,
		userId: ownerId,
		title: 'MCP test draft',
		baseBody: 'Test body',
		status: 'draft',
		createdAt: now,
		updatedAt: now
	});
	return id;
}

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

async function postMcp(
	method: string,
	params: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
	{
		includeProtocolVersion = true,
		waitUntil
	}: {
		includeProtocolVersion?: boolean;
		waitUntil?: (promise: Promise<unknown>) => void;
	} = {}
) {
	const headers = new Headers({
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		'mcp-method': method
	});
	const wireParams = includeProtocolVersion
		? {
				...params,
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: '2026-07-28',
					[CLIENT_CAPABILITIES_META_KEY]: {}
				}
			}
		: params;
	if (includeProtocolVersion) headers.set('mcp-protocol-version', '2026-07-28');
	if (method === 'tools/call' && typeof params.name === 'string') {
		headers.set('mcp-name', params.name);
	}
	const request = new Request('https://cogsend.example/api/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: wireParams })
	});
	const response = await POST(requestEvent(request, overrides, waitUntil));
	return { response, payload: (await response.json()) as McpPayload };
}

describe('MCP route', () => {
	it('exposes exactly the curated 16-tool catalog and the required annotations', async () => {
		const { response, payload } = await postMcp('tools/list');
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('content-type')).not.toContain('text/event-stream');
		expect(response.headers.get('mcp-session-id')).toBeNull();

		const tools = payload.result!.tools as McpTool[];
		expect(tools.map((tool) => tool.name)).toEqual(toolNames);

		const expectedParameters: Record<string, { fields: string[]; required: string[] }> = {
			list_connections: { fields: [], required: [] },
			list_drafts: { fields: ['limit'], required: [] },
			get_draft: { fields: ['draftId'], required: ['draftId'] },
			create_draft: { fields: ['title', 'baseBody', 'selectedConnectionIds'], required: [] },
			update_draft: {
				fields: ['draftId', 'title', 'baseBody', 'selectedConnectionIds'],
				required: ['draftId']
			},
			duplicate_draft: { fields: ['draftId'], required: ['draftId'] },
			delete_draft: { fields: ['draftId'], required: ['draftId'] },
			set_draft_variant: {
				fields: ['draftId', 'platform', 'body', 'options'],
				required: ['draftId', 'platform']
			},
			delete_draft_variant: { fields: ['draftId', 'platform'], required: ['draftId', 'platform'] },
			validate_post: { fields: ['text', 'platform', 'maxCharacters'], required: ['text'] },
			publish_draft: {
				fields: ['draftId', 'connectionIds'],
				required: ['draftId', 'connectionIds']
			},
			schedule_draft: {
				fields: ['draftId', 'connectionIds', 'runAt'],
				required: ['draftId', 'connectionIds', 'runAt']
			},
			list_queue: { fields: ['limit'], required: [] },
			cancel_delivery: { fields: ['targetId'], required: ['targetId'] },
			retry_delivery: { fields: ['targetId'], required: ['targetId'] },
			reschedule_delivery: { fields: ['targetId', 'runAt'], required: ['targetId', 'runAt'] }
		};
		for (const tool of tools) {
			const expected = expectedParameters[tool.name];
			expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
				[...expected.fields].sort()
			);
			expect([...(tool.inputSchema.required ?? [])].sort()).toEqual([...expected.required].sort());
		}

		const expectedAnnotations: Record<string, Record<string, boolean>> = {
			list_connections: readAnnotations,
			list_drafts: readAnnotations,
			get_draft: readAnnotations,
			create_draft: createAnnotations,
			update_draft: updateAnnotations,
			duplicate_draft: createAnnotations,
			delete_draft: deleteAnnotations,
			set_draft_variant: updateAnnotations,
			delete_draft_variant: deleteAnnotations,
			validate_post: readAnnotations,
			publish_draft: publishAnnotations,
			schedule_draft: updateAnnotations,
			list_queue: readAnnotations,
			cancel_delivery: deleteAnnotations,
			retry_delivery: publishAnnotations,
			reschedule_delivery: updateAnnotations
		};
		for (const tool of tools) expect(tool.annotations).toEqual(expectedAnnotations[tool.name]);

		for (const name of ['list_drafts', 'list_queue']) {
			const limit = tools.find((tool) => tool.name === name)?.inputSchema.properties?.limit;
			expect(limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
		}
	});

	it('returns JSON, not an SSE stream, for a legacy-classified POST', async () => {
		const { response } = await postMcp('tools/list', {}, {}, { includeProtocolVersion: false });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('content-type')).not.toContain('text/event-stream');
		expect(response.headers.get('mcp-session-id')).toBeNull();
	});

	it('rejects subscription streams instead of opening SSE', async () => {
		const { response, payload } = await postMcp('subscriptions/listen');
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('content-type')).not.toContain('text/event-stream');
		expect(payload.error).toEqual({ code: -32601, message: 'Method not found' });
	});

	it('enforces JSON content type before the subscription-stream guard', async () => {
		const request = new Request('https://cogsend.example/api/mcp', {
			method: 'POST',
			headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen' })
		});
		const response = await POST(requestEvent(request));
		const payload = (await response.json()) as { error: { message: string } };
		expect(response.status).toBe(415);
		expect(payload.error.message).toContain('Unsupported Media Type');
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('content-type')).not.toContain('text/event-stream');
	});

	it('returns structured tool results and enforces write scope', async () => {
		const success = await postMcp('tools/call', {
			name: 'create_draft',
			arguments: { title: 'From MCP', baseBody: 'Hello from the tool.' }
		});
		const successResult = success.payload.result!;
		expect(successResult.isError).not.toBe(true);
		expect(successResult.structuredContent!.draft).toMatchObject({
			title: 'From MCP',
			baseBody: 'Hello from the tool.'
		});
		expect(successResult.content![0].text).toContain('From MCP');

		const denied = await postMcp(
			'tools/call',
			{ name: 'create_draft', arguments: { title: 'Nope' } },
			{ apiKeyScopes: ['read'] }
		);
		expect(denied.payload.result!.isError).toBe(true);
		expect(denied.payload.result!.structuredContent).toEqual({
			error: 'Insufficient scope',
			status: 403
		});
	});

	it('requires read scope and an authenticated user for read tools', async () => {
		const scopeDenied = await postMcp(
			'tools/call',
			{ name: 'list_connections', arguments: {} },
			{ apiKeyScopes: [] }
		);
		expect(scopeDenied.payload.result!.structuredContent).toEqual({
			error: 'Insufficient scope',
			status: 403
		});

		const unauthenticated = await postMcp(
			'tools/call',
			{ name: 'list_connections', arguments: {} },
			{ user: null }
		);
		expect(unauthenticated.payload.result!.structuredContent).toEqual({
			error: 'Unauthorized',
			status: 401
		});
	});

	it('preserves ownership checks for fetched drafts', async () => {
		const otherUser = await createTestAdmin(db, {
			email: `other-${newId()}@localhost`,
			totpEnabled: true
		});
		const draftId = await seedDraft(otherUser.id);
		const { payload } = await postMcp('tools/call', {
			name: 'get_draft',
			arguments: { draftId }
		});
		expect(payload.result!.isError).toBe(true);
		expect(payload.result!.structuredContent).toEqual({ error: 'Not found', status: 404 });
	});

	it('deletes a draft with its media and cached thumbnails, like the REST route', async () => {
		const draftId = await seedDraft();
		const storageKey = `${Date.now()}-abcdef0123456789.png`;
		const store = new Map<string, { bytes: Uint8Array; mime: string }>();
		store.set(storageKey, { bytes: new Uint8Array([1]), mime: 'image/png' });
		store.set(thumbCacheKey(storageKey), { bytes: new Uint8Array([2]), mime: 'image/webp' });
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey,
			mime: 'image/png',
			size: 1,
			sortOrder: 0,
			segmentIndex: 0,
			createdAt: new Date()
		});

		const { payload } = await postMcp(
			'tools/call',
			{ name: 'delete_draft', arguments: { draftId } },
			{ media: memoryMediaStore(store) }
		);

		expect(payload.result!.structuredContent).toEqual({ ok: true });
		expect(store.size).toBe(0);
		expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toEqual([]);
	});

	it('preserves repeat-publish skips and schedule conflict details', async () => {
		const draftId = await seedDraft();
		const connectionId = await seedConnection();
		const now = new Date();
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId,
			status: 'published',
			remotePostId: 'remote-post-1',
			remoteUrl: 'https://mastodon.example/@test/1',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});

		const published = await postMcp('tools/call', {
			name: 'publish_draft',
			arguments: { draftId, connectionIds: [connectionId] }
		});
		const publishResult = published.payload.result!;
		const targetResults = publishResult.structuredContent!.results as Array<{
			status: string;
			skipped: boolean;
		}>;
		expect(targetResults).toMatchObject([{ status: 'published', skipped: true }]);

		const scheduled = await postMcp('tools/call', {
			name: 'schedule_draft',
			arguments: {
				draftId,
				connectionIds: [connectionId],
				runAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
			}
		});
		expect(scheduled.payload.result!.isError).toBe(true);
		expect(scheduled.payload.result!.structuredContent).toEqual({
			error: 'Already published',
			status: 409,
			alreadyPublished: [connectionId],
			inFlight: []
		});
	});

	it('preserves partial publish stop metadata without leaking internal errors', async () => {
		const draftId = await seedDraft();
		const connectionId = await seedConnection();
		const publishTarget = vi
			.spyOn(publish, 'publishTarget')
			.mockRejectedValueOnce(new Error('private database connection string'));
		const { payload } = await postMcp('tools/call', {
			name: 'publish_draft',
			arguments: { draftId, connectionIds: [connectionId] }
		});
		const result = payload.result!;
		const structured = result.structuredContent!;
		expect(publishTarget).toHaveBeenCalledOnce();
		expect(structured.stopped).toBe(true);
		expect(structured.stoppedError).toBe('Publishing stopped early — try again for the rest');
		expect(JSON.stringify(structured)).not.toContain('private database connection string');
		expect(result.content![0].text).toContain('stopped early');
	});

	it('redacts unknown server errors from tool content and structured output', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { payload } = await postMcp(
			'tools/call',
			{ name: 'get_draft', arguments: { draftId: 'draft-1' } },
			{
				db: {
					select: () => {
						throw new Error('private database connection string');
					}
				}
			}
		);
		const result = payload.result!;
		expect(result.isError).toBe(true);
		expect(result.content![0].text).toBe('Something went wrong on the server');
		expect(JSON.stringify(result.structuredContent)).not.toContain(
			'private database connection string'
		);
		expect(result.structuredContent!.status).toBe(500);
		expect(log).toHaveBeenCalledOnce();
	});

	it('keeps a retried publish alive with waitUntil, like the REST route', async () => {
		const draftId = await seedDraft();
		const connectionId = await seedConnection();
		const targetId = newId();
		const now = new Date();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId,
			status: 'failed',
			attemptCount: 5,
			createdAt: now,
			updatedAt: now
		});
		vi.spyOn(publish, 'publishTarget').mockResolvedValueOnce({
			status: 'published'
		} as never);
		const background: Promise<unknown>[] = [];
		const { payload } = await postMcp(
			'tools/call',
			{ name: 'retry_delivery', arguments: { targetId } },
			{},
			{ waitUntil: (promise) => background.push(promise) }
		);
		expect(payload.result!.isError).toBeFalsy();
		expect(background).toHaveLength(1);
		await expect(background[0]).resolves.toBeUndefined();
	});

	it('returns 405 for GET and DELETE without issuing session IDs', async () => {
		for (const handler of [GET, DELETE]) {
			const response = await handler(requestEvent(new Request('https://cogsend.example/api/mcp')));
			expect(response.status).toBe(405);
			expect(response.headers.get('allow')).toBe('POST');
			expect(response.headers.get('mcp-session-id')).toBeNull();
		}
	});
});
