import { createMcpHandler, isJsonContentType, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { humanizedCause } from '#lib/domain/human-error.js';
import {
	cancelDelivery,
	createDraft,
	deleteDraft,
	deleteDraftVariant,
	duplicateDraft,
	getDraft,
	listConnections,
	listDrafts,
	listQueue,
	publishDraft,
	rescheduleDelivery,
	retryDelivery,
	scheduleDraft,
	setDraftVariant,
	updateDraft,
	validatePost
} from '#lib/server/api/operations.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import type { OperationContext } from '#lib/server/api/operations.js';

const id = z.string().min(1).max(128);
const boundedLimit = z.number().int().min(1).max(100).default(50);
const platform = z.enum(['mastodon', 'bluesky', 'linkedin', 'threads', 'x']);
const runAt = z.string().min(1).max(64);
const connectionIds = z.array(id).min(1).max(10);
const draftFields = {
	title: z.string().max(200).nullable().optional(),
	baseBody: z.string().max(100_000).optional(),
	selectedConnectionIds: z.array(id).max(10).nullable().optional()
};
const variantOptions = z
	.object({
		visibility: z.enum(['public', 'unlisted', 'private', 'direct']).optional(),
		spoilerText: z.string().max(100_000).optional(),
		langs: z.array(z.string().max(100)).max(100).optional(),
		poll: z
			.object({
				options: z.array(z.string().max(50)).min(2).max(4),
				expiresIn: z.number().int().min(300).max(604_800),
				multiple: z.boolean().optional(),
				hideTotals: z.boolean().optional()
			})
			.nullable()
			.optional(),
		threadSegments: z.array(z.string().max(100_000)).max(100).optional()
	})
	.strict()
	.optional();

const annotations = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	create: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false
	},
	update: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	delete: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false
	},
	publish: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	}
} as const;

const dateTime = () =>
	z.preprocess(
		(value) => (value instanceof Date ? value.toISOString() : value),
		z.string().datetime()
	);

const validationCheck = z
	.object({
		ok: z.boolean(),
		length: z.number(),
		max: z.number(),
		message: z.string().optional()
	})
	.passthrough();
const validationIssue = z
	.object({
		field: z.string().optional(),
		message: z.string(),
		code: z.string().optional()
	})
	.passthrough();
const connectionSchema = z
	.object({
		id: z.string(),
		platform: z.string(),
		displayName: z.string().nullable(),
		handle: z.string().nullable(),
		avatarUrl: z.string().nullable(),
		instanceUrl: z.string().nullable(),
		status: z.string(),
		metaJson: z.record(z.string(), z.unknown()),
		createdAt: dateTime()
	})
	.passthrough();
const connectionSummarySchema = z
	.object({
		id: z.string(),
		platform: z.string(),
		handle: z.string().nullable(),
		displayName: z.string().nullable().optional(),
		avatarUrl: z.string().nullable().optional(),
		status: z.string().optional()
	})
	.passthrough();
const variantSchema = z
	.object({
		id: z.string(),
		draftId: z.string(),
		platform: z.string(),
		body: z.string().nullable(),
		optionsJson: z.record(z.string(), z.unknown()),
		createdAt: dateTime(),
		updatedAt: dateTime()
	})
	.passthrough();
const mediaSchema = z
	.object({
		id: z.string(),
		draftId: z.string(),
		storageKey: z.string(),
		mime: z.string(),
		size: z.number(),
		width: z.number().nullable(),
		height: z.number().nullable(),
		altText: z.string().nullable(),
		sortOrder: z.number(),
		segmentIndex: z.number(),
		createdAt: dateTime()
	})
	.passthrough();
const targetSchema = z
	.object({
		id: z.string(),
		draftId: z.string(),
		connectionId: z.string(),
		variantId: z.string().nullable(),
		status: z.string(),
		scheduledFor: dateTime().nullable(),
		remotePostId: z.string().nullable(),
		remoteUrl: z.string().nullable(),
		errorMessage: z.string().nullable(),
		attemptCount: z.number(),
		jobId: z.string().nullable(),
		createdAt: dateTime(),
		updatedAt: dateTime(),
		connection: connectionSummarySchema.optional()
	})
	.passthrough();
const draftSchema = z
	.object({
		id: z.string(),
		userId: z.string(),
		title: z.string().nullable(),
		baseBody: z.string(),
		selectedConnectionIds: z.array(z.string()).nullable(),
		status: z.string(),
		createdAt: dateTime(),
		updatedAt: dateTime(),
		variants: z.array(variantSchema),
		media: z.array(mediaSchema),
		targets: z.array(targetSchema)
	})
	.passthrough();
const queueDraftSchema = z
	.object({
		id: z.string(),
		title: z.string().nullable(),
		baseBody: z.string(),
		status: z.string(),
		media: z.array(mediaSchema)
	})
	.passthrough();
const queueTargetSchema = z
	.object({
		id: z.string(),
		status: z.string(),
		scheduledFor: dateTime().nullable(),
		updatedAt: dateTime(),
		remoteUrl: z.string().nullable(),
		errorMessage: z.string().nullable(),
		draft: queueDraftSchema,
		connection: z
			.object({
				id: z.string(),
				platform: z.string(),
				handle: z.string().nullable(),
				displayName: z.string().nullable(),
				avatarUrl: z.string().nullable(),
				status: z.string()
			})
			.passthrough()
	})
	.passthrough();

const mcpOutputSchemas = {
	list_connections: z
		.object({
			connections: z.array(connectionSchema),
			configured: z
				.object({ linkedin: z.boolean(), threads: z.boolean(), x: z.boolean() })
				.passthrough(),
			appUrl: z.string()
		})
		.passthrough(),
	list_drafts: z.object({ drafts: z.array(draftSchema), hasMore: z.boolean() }).passthrough(),
	get_draft: z.object({ draft: draftSchema }).passthrough(),
	create_draft: z.object({ draft: draftSchema }).passthrough(),
	update_draft: z.object({ ok: z.literal(true) }).passthrough(),
	duplicate_draft: z.object({ draft: draftSchema }).passthrough(),
	delete_draft: z.object({ ok: z.literal(true) }).passthrough(),
	set_draft_variant: z.object({ variant: variantSchema }).passthrough(),
	delete_draft_variant: z.object({ ok: z.literal(true) }).passthrough(),
	validate_post: z
		.object({
			graphemes: z.number(),
			mastodonLength: z.number(),
			bluesky: validationCheck,
			mastodon: validationCheck,
			linkedin: validationCheck,
			threads: validationCheck,
			x: validationCheck,
			issues: z.array(validationIssue)
		})
		.passthrough(),
	publish_draft: z
		.object({
			results: z.array(
				z
					.object({
						targetId: z.string(),
						connectionId: z.string(),
						platform: z.string(),
						handle: z.string().nullable(),
						displayName: z.string().nullable(),
						status: z.string(),
						permalink: z.string().nullable(),
						error: z.string().nullable(),
						skipped: z.boolean(),
						inFlight: z.boolean().optional()
					})
					.passthrough()
			),
			stopped: z.boolean().optional(),
			stoppedError: z.string().optional(),
			draft: draftSchema.nullable()
		})
		.passthrough(),
	schedule_draft: z
		.object({ targets: z.array(targetSchema), scheduledFor: dateTime() })
		.passthrough(),
	list_queue: z.object({ targets: z.array(queueTargetSchema), hasMore: z.boolean() }).passthrough(),
	cancel_delivery: z.object({ target: targetSchema }).passthrough(),
	retry_delivery: z
		.object({
			status: z.string(),
			remotePostId: z.string().optional(),
			error: z.string().optional(),
			skipped: z.boolean().optional()
		})
		.passthrough(),
	reschedule_delivery: z.object({ ok: z.literal(true), scheduledFor: dateTime() }).passthrough()
} as const;

type ToolSpec = {
	scope: 'read' | 'write';
	annotation: (typeof annotations)[keyof typeof annotations];
	description: string;
	outputSchema: z.ZodType;
};

function concise(name: string, result: Record<string, unknown>): string {
	const draft = result.draft as { id?: string; title?: string | null } | undefined;
	switch (name) {
		case 'list_drafts':
			return `${Array.isArray(result.drafts) ? result.drafts.length : 0} drafts${result.hasMore ? ' (more available)' : ''}`;
		case 'list_connections':
			return `${Array.isArray(result.connections) ? result.connections.length : 0} connections`;
		case 'list_queue':
			return `${Array.isArray(result.targets) ? result.targets.length : 0} delivery targets${result.hasMore ? ' (more available)' : ''}`;
		case 'validate_post':
			return `Validated ${String(result.graphemes ?? 0)} graphemes; ${Array.isArray(result.issues) ? result.issues.length : 0} platform-specific issues`;
		case 'publish_draft': {
			const results = Array.isArray(result.results) ? result.results : [];
			const succeeded = results.filter(
				(item) => (item as { status?: string }).status === 'published'
			).length;
			return `Published ${succeeded} of ${results.length} targets${result.stopped ? '; stopped early' : ''}`;
		}
		case 'schedule_draft':
			return `Scheduled ${Array.isArray(result.targets) ? result.targets.length : 0} delivery targets for ${String(result.scheduledFor ?? 'the requested time')}`;
		case 'cancel_delivery': {
			const target = result.target as { status?: string } | undefined;
			return `cancel_delivery: ${target?.status ?? 'done'}`;
		}
		case 'retry_delivery':
			return `retry_delivery: ${String(result.status ?? 'started')}${result.skipped ? ' (already published)' : ''}`;
		case 'reschedule_delivery':
			return `reschedule_delivery: scheduled for ${String(result.scheduledFor ?? 'the requested time')}`;
		case 'get_draft':
		case 'create_draft':
		case 'duplicate_draft':
			return `${name}: ${draft?.title || 'Draft'} (${draft?.id ?? 'saved'})`;
		case 'set_draft_variant':
			return 'set_draft_variant: variant saved';
		default:
			return `${name}: ${result.ok === true ? 'done' : 'completed'}`;
	}
}

function registerForEvent<T extends z.ZodType>(
	server: McpServer,
	event: RequestEvent,
	name: string,
	spec: ToolSpec,
	inputSchema: T,
	operation: (
		input: z.infer<T>,
		ctx: OperationContext,
		userId: string
	) => Promise<Record<string, unknown>> | Record<string, unknown>
) {
	server.registerTool(
		name,
		{
			description: spec.description,
			inputSchema,
			outputSchema: spec.outputSchema,
			annotations: spec.annotation
		} as never,
		(async (input: z.infer<T>) => {
			try {
				const user = requireUser(event.locals.user);
				requireScope(event.locals, spec.scope);
				// Publish and retry hand their provider calls to locals.waitUntil, as
				// the REST routes do, so a client that disconnects mid-call cannot cut
				// them off.
				const ctx: OperationContext = event.locals;
				const result = await operation(input as z.infer<T>, ctx, user.id);
				return {
					content: [{ type: 'text' as const, text: concise(name, result) }],
					structuredContent: result
				};
			} catch (error) {
				const rawStatus = Number((error as { status?: unknown })?.status ?? 500);
				let status: number;
				if (rawStatus >= 400 && rawStatus < 600) status = rawStatus;
				else if (rawStatus < 500) status = 400;
				else status = 500;
				const message = error instanceof Error ? error.message : 'Server error';
				let safeMessage = message;
				if (status === 401 && (!message || message === 'Server error'))
					safeMessage = 'Unauthorized';
				else if (status >= 500)
					safeMessage = humanizedCause(message) ?? 'Something went wrong on the server';
				const details =
					error instanceof ApiOperationError && status < 500 && status !== 401
						? error.details
						: undefined;
				const safe = { error: safeMessage, status, ...(details ?? {}) };
				if (status >= 500) console.error('[mcp] tool failed', error);
				return {
					isError: true,
					content: [{ type: 'text' as const, text: safeMessage }],
					structuredContent: safe
				};
			}
		}) as never
	);
}

function createServer(event: RequestEvent) {
	const server = new McpServer({ name: 'cogsend', version: '1.0.0' });
	const register = <T extends z.ZodType>(
		server: McpServer,
		name: string,
		spec: ToolSpec,
		inputSchema: T,
		operation: (
			input: z.infer<T>,
			ctx: OperationContext,
			userId: string
		) => Promise<Record<string, unknown>> | Record<string, unknown>
	) => registerForEvent(server, event, name, spec, inputSchema, operation);
	const read = annotations.read;
	const write = annotations.update;
	register(
		server,
		'list_connections',
		{
			scope: 'read',
			annotation: read,
			description: 'List connected social accounts and provider configuration.',
			outputSchema: mcpOutputSchemas.list_connections
		},
		z.object({}).strict(),
		(_input, ctx, uid) => listConnections(ctx, uid)
	);
	register(
		server,
		'list_drafts',
		{
			scope: 'read',
			annotation: read,
			description: 'List drafts, newest updated first.',
			outputSchema: mcpOutputSchemas.list_drafts
		},
		z.object({ limit: boundedLimit }).strict(),
		(input, ctx, uid) => listDrafts(ctx, uid, input.limit)
	);
	register(
		server,
		'get_draft',
		{
			scope: 'read',
			annotation: read,
			description: 'Get one draft and its variants, media, and delivery targets.',
			outputSchema: mcpOutputSchemas.get_draft
		},
		z.object({ draftId: id }).strict(),
		(input, ctx, uid) => getDraft(ctx, uid, input.draftId)
	);
	register(
		server,
		'create_draft',
		{
			scope: 'write',
			annotation: annotations.create,
			description: 'Create a draft.',
			outputSchema: mcpOutputSchemas.create_draft
		},
		z.object(draftFields).strict(),
		(input, ctx, uid) => createDraft(ctx, uid, input)
	);
	register(
		server,
		'update_draft',
		{
			scope: 'write',
			annotation: write,
			description: 'Update a draft.',
			outputSchema: mcpOutputSchemas.update_draft
		},
		z.object({ draftId: id, ...draftFields }).strict(),
		(input, ctx, uid) => {
			const { draftId, ...patch } = input;
			return updateDraft(ctx, uid, draftId, patch);
		}
	);
	register(
		server,
		'duplicate_draft',
		{
			scope: 'write',
			annotation: annotations.create,
			description: 'Duplicate a draft and its supported media and variants.',
			outputSchema: mcpOutputSchemas.duplicate_draft
		},
		z.object({ draftId: id }).strict(),
		(input, ctx, uid) => duplicateDraft(ctx, uid, input.draftId)
	);
	register(
		server,
		'delete_draft',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Delete a draft.',
			outputSchema: mcpOutputSchemas.delete_draft
		},
		z.object({ draftId: id }).strict(),
		(input, ctx, uid) => deleteDraft(ctx, uid, input.draftId)
	);
	register(
		server,
		'set_draft_variant',
		{
			scope: 'write',
			annotation: write,
			description: 'Create or update a platform-specific draft variant.',
			outputSchema: mcpOutputSchemas.set_draft_variant
		},
		z
			.object({
				draftId: id,
				platform,
				body: z.string().max(100_000).nullable().optional(),
				options: variantOptions
			})
			.strict(),
		(input, ctx, uid) => setDraftVariant(ctx, uid, input.draftId, input)
	);
	register(
		server,
		'delete_draft_variant',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Delete a platform-specific draft variant.',
			outputSchema: mcpOutputSchemas.delete_draft_variant
		},
		z.object({ draftId: id, platform }).strict(),
		(input, ctx, uid) => deleteDraftVariant(ctx, uid, input.draftId, input.platform)
	);
	register(
		server,
		'validate_post',
		{
			scope: 'read',
			annotation: read,
			description: 'Validate post text against supported platform limits.',
			outputSchema: mcpOutputSchemas.validate_post
		},
		z
			.object({
				text: z.string().max(200_000),
				platform: platform.optional(),
				maxCharacters: z.number().int().min(1).max(100_000).optional()
			})
			.strict(),
		(input) => validatePost(input)
	);
	register(
		server,
		'publish_draft',
		{
			scope: 'write',
			annotation: annotations.publish,
			description: 'Publish a draft to selected connected accounts.',
			outputSchema: mcpOutputSchemas.publish_draft
		},
		z.object({ draftId: id, connectionIds }).strict(),
		(input, ctx, uid) =>
			publishDraft(ctx, uid, input.draftId, { connectionIds: input.connectionIds })
	);
	register(
		server,
		'schedule_draft',
		{
			scope: 'write',
			annotation: write,
			description: 'Schedule a draft for selected connected accounts.',
			outputSchema: mcpOutputSchemas.schedule_draft
		},
		z.object({ draftId: id, connectionIds, runAt }).strict(),
		(input, ctx, uid) => scheduleDraft(ctx, uid, input.draftId, input)
	);
	register(
		server,
		'list_queue',
		{
			scope: 'read',
			annotation: read,
			description: 'List scheduled and recent delivery targets.',
			outputSchema: mcpOutputSchemas.list_queue
		},
		z.object({ limit: boundedLimit }).strict(),
		(input, ctx, uid) => listQueue(ctx, uid, input.limit)
	);
	register(
		server,
		'cancel_delivery',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Cancel a pending delivery.',
			outputSchema: mcpOutputSchemas.cancel_delivery
		},
		z.object({ targetId: id }).strict(),
		(input, ctx, uid) => cancelDelivery(ctx, uid, input.targetId)
	);
	register(
		server,
		'retry_delivery',
		{
			scope: 'write',
			annotation: annotations.publish,
			description: 'Retry a delivery now.',
			outputSchema: mcpOutputSchemas.retry_delivery
		},
		z.object({ targetId: id }).strict(),
		(input, ctx, uid) => retryDelivery(ctx, uid, input.targetId)
	);
	register(
		server,
		'reschedule_delivery',
		{
			scope: 'write',
			annotation: write,
			description: 'Change a delivery scheduled time.',
			outputSchema: mcpOutputSchemas.reschedule_delivery
		},
		z.object({ targetId: id, runAt }).strict(),
		(input, ctx, uid) => rescheduleDelivery(ctx, uid, input.targetId, { runAt: input.runAt })
	);
	return server;
}

const eventByRequest = new WeakMap<Request, RequestEvent>();
const handler = createMcpHandler(
	({ requestInfo }) => {
		if (!requestInfo) throw new Error('Missing MCP request information');
		const event = eventByRequest.get(requestInfo);
		if (!event) throw new Error('Missing authenticated MCP request context');
		return createServer(event);
	},
	{
		legacy: 'reject',
		responseMode: 'json'
	}
);

export const POST: RequestHandler = async (event) => {
	const parsedBody = isJsonContentType(event.request.headers.get('content-type'))
		? await event.request.json().catch(() => undefined)
		: undefined;
	if (
		parsedBody &&
		typeof parsedBody === 'object' &&
		'method' in parsedBody &&
		parsedBody.method === 'subscriptions/listen'
	) {
		const requestId = 'id' in parsedBody ? parsedBody.id : undefined;
		if (requestId === undefined) return new Response(null, { status: 202 });
		const safeId =
			typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
		return Response.json({
			jsonrpc: '2.0',
			id: safeId,
			error: { code: -32601, message: 'Method not found' }
		});
	}
	eventByRequest.set(event.request, event);
	try {
		return await handler.fetch(event.request, { parsedBody });
	} finally {
		eventByRequest.delete(event.request);
	}
};

export const GET: RequestHandler = async () =>
	new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
export const DELETE: RequestHandler = async () =>
	new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
