import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import type { AppEnv } from '../env';
import { hashPassword } from '../crypto';
import { memoryMediaStore } from '../media';
import { users } from './schema';
import * as schema from './schema';
import type { AppDb } from './client';

const here = dirname(fileURLToPath(import.meta.url));

export const TEST_ENV: AppEnv = {
	APP_URL: 'http://localhost:5173',
	appUrlSource: 'configured',
	APP_NAME: 'CogSend',
	APP_ENCRYPTION_KEY: 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
	AUTH_SECRET: 'test-auth-secret-at-least-8',
	skipTotp: false,
	// The in-progress LinkedIn video path stays off in tests unless a test
	// opts in with { ...TEST_ENV, videoUploadEnabled: true }.
	videoUploadEnabled: false
};

/**
 * The account tests sign in as. `npm run setup` writes the same row into D1
 * before a deployment answers its first request, and tests seed it the same way,
 * with a real hash.
 */
export const TEST_ADMIN = { email: 'admin@localhost', password: 'admin123' };

export async function createTestAdmin(
	db: AppDb,
	{ email = TEST_ADMIN.email, password = TEST_ADMIN.password, totpEnabled = false } = {}
) {
	const now = new Date();
	const row = {
		id: crypto.randomUUID(),
		email: email.trim().toLowerCase(),
		passwordHash: await hashPassword(password),
		displayName: null,
		timezone: 'UTC',
		createdAt: now,
		updatedAt: now,
		totpEnabled,
		totpSecretEnc: null,
		totpEnrolledAt: null,
		totpLastStep: null,
		settingsJson: null
	};
	await db.insert(users).values(row);
	return row;
}

export interface TestDb {
	db: AppDb;
	close: () => void;
	/** Statements executed so far — D1's per-invocation budget is counted, not timed. */
	count: () => number;
	/** Largest bound-parameter list in any one statement — D1 rejects over 100. */
	maxParams: () => number;
	/** SQL text of the statements in the most recent batch. */
	lastBatchSql: () => string[];
	reset: () => void;
}

export async function createTestDb(): Promise<TestDb> {
	const client = createClient({ url: ':memory:' });
	const dir = join(here, '../../../../drizzle');
	const files = readdirSync(dir)
		.filter((name) => name.endsWith('.sql'))
		.sort();
	for (const file of files) {
		await client.executeMultiple(readFileSync(join(dir, file), 'utf8'));
	}
	await client.execute('PRAGMA foreign_keys = ON');
	// Count like D1 does: a batch counts as its statements, not one round trip.
	// Also track the largest bound-parameter list: D1 rejects any single
	// statement with more than 100, and libsql happily accepts them, so the
	// unit suite would otherwise miss that class of bug.
	let queries = 0;
	let maxParams = 0;
	let lastBatchSql: string[] = [];
	const noteParams = (statements: unknown[]) => {
		for (const statement of statements) {
			const args = (statement as { args?: unknown[] } | null)?.args;
			if (Array.isArray(args) && args.length > maxParams) maxParams = args.length;
		}
	};
	const orig = client.execute.bind(client);
	client.execute = (async (...args: Parameters<typeof orig>) => {
		queries += 1;
		noteParams(args as unknown[]);
		return orig(...args);
	}) as typeof orig;
	const batchOrig = client.batch.bind(client) as (stmts: unknown[]) => Promise<unknown>;
	(client as unknown as Record<string, unknown>).batch = (async (stmts: unknown[]) => {
		queries += (stmts as unknown[]).length;
		noteParams(stmts as unknown[]);
		lastBatchSql = (stmts as Array<{ sql?: string }>).map((s) => s?.sql ?? '');
		return batchOrig(stmts as never);
	}) as typeof batchOrig;
	const db = drizzle(client, { schema }) as unknown as AppDb;
	return {
		db,
		close: () => client.close(),
		count: () => queries,
		maxParams: () => maxParams,
		lastBatchSql: () => lastBatchSql,
		reset: () => {
			queries = 0;
			maxParams = 0;
			lastBatchSql = [];
		}
	};
}

export function createTestMedia() {
	return memoryMediaStore();
}
