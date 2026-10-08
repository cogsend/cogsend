import { and, desc, eq, ne } from 'drizzle-orm';
import type { AppEnv } from './env';
import type { AppDb } from './db/client';
import { connections } from './db/schema';
import { platformCredentialStatus } from './platform-credentials';
import { serializeConnection } from './serialize';

/** Accounts the UI and `GET /api/connections` both show. Same payload either way. */
export async function listConnections(db: AppDb, env: AppEnv, userId: string) {
	const rows = await db
		.select({
			id: connections.id,
			platform: connections.platform,
			displayName: connections.displayName,
			handle: connections.handle,
			avatarUrl: connections.avatarUrl,
			instanceUrl: connections.instanceUrl,
			status: connections.status,
			metaJson: connections.metaJson,
			createdAt: connections.createdAt
		})
		.from(connections)
		.where(and(eq(connections.userId, userId), ne(connections.status, 'disconnected')))
		.orderBy(desc(connections.createdAt));
	const { configured, secrets, sources, savedClientIds } = await platformCredentialStatus(db, env);
	return {
		connections: rows.map(serializeConnection),
		configured,
		secrets,
		sources,
		savedClientIds,
		appUrl: env.APP_URL
	};
}
