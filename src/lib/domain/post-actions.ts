import { isThreadsAuthFailure } from './threads-error';

export type PostActionPlatform = {
	status?: string;
	targetId?: string;
	error?: string | null;
	connectionStatus?: string | null;
};

const AUTH_ERROR_PATTERN =
	/401|unauthorized|invalid credentials|createsession failed|reconnect|expired|forbidden|403/i;

export function isAuthError(message: string | null | undefined): boolean {
	if (!message) return false;
	return AUTH_ERROR_PATTERN.test(message);
}

export function needsReconnect(p: PostActionPlatform): boolean {
	if (p.connectionStatus && p.connectionStatus !== 'active') return true;
	if (isAuthError(p.error)) return true;
	// Same code-gated Threads shape as the server matchers: marker code
	// wins when present, otherwise the legacy permission-text rule applies.
	return isThreadsAuthFailure(p.error || '');
}

const SCHEDULED_STATUSES = new Set(['scheduled', 'pending', 'publishing']);

function idsOf(
	platforms: PostActionPlatform[],
	keep: (p: PostActionPlatform) => boolean
): string[] {
	return platforms
		.map((p) => p.targetId)
		.filter((id, i): id is string => Boolean(id) && keep(platforms[i]));
}

export function retryTargetIds(platforms: PostActionPlatform[]): string[] {
	return idsOf(platforms, (p) => p.status === 'failed');
}

export function rescheduleTargetIds(platforms: PostActionPlatform[]): string[] {
	return idsOf(platforms, (p) => SCHEDULED_STATUSES.has(p.status ?? ''));
}

export function cancelTargetIds(platforms: PostActionPlatform[]): string[] {
	return idsOf(platforms, () => true);
}

export type PostsTab = 'all' | 'scheduled' | 'published' | 'failed' | 'drafts';

export function emptyPostsHeading(tab: PostsTab): string {
	if (tab === 'all') return 'No posts';
	if (tab === 'drafts') return 'No drafts';
	return `No ${tab} posts`;
}

export function emptyPostsBody(tab: PostsTab): string {
	if (tab === 'all') {
		return "You don't have any posts yet. Write one in the composer.";
	}
	if (tab === 'drafts') {
		return "You don't have any drafts. A post you save without sending waits here.";
	}
	if (tab === 'failed') {
		return 'Nothing failed to publish.';
	}
	return `You don't have any ${tab} posts right now.`;
}
