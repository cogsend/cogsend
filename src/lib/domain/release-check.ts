/**
 * "Is a newer release out?" — the question every self-hoster eventually asks,
 * and the one the three install paths answer differently.
 *
 * Pure and dependency-free so both the app (Settings) and `npm run doctor` can
 * share it, and so the comparison is testable without a network. The repo is
 * hardcoded on purpose: a fork or a button-created copy still tracks this
 * project's releases, which is exactly what the operator wants to hear about.
 */
const RELEASE_REPO = 'cogsend/cogsend';
export const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;
export const TAGS_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/tags?per_page=100`;
/** Where a release's files live: `${RELEASE_DOWNLOAD_BASE}/<tag>/<file>`. */
export const RELEASE_DOWNLOAD_BASE = `https://github.com/${RELEASE_REPO}/releases/download`;

export interface ReleaseInfo {
	/** The tag as published, e.g. `v1.2.0`. */
	tag: string;
	/** The same tag without a leading `v`, e.g. `1.2.0`. */
	version: string;
	/** Release page, for the "what changed" link. */
	url: string;
	publishedAt: string | null;
}

/**
 * `v1.2.3` → `[1, 2, 3]`. Anything without a leading number (a branch name, a
 * dirty local build, an empty string) is null rather than a guess.
 */
export function parseVersion(raw: string | null | undefined): number[] | null {
	const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw ?? '');
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric comparison; a pre-release suffix (`1.2.0-rc.1`) counts as that
 *  release, which is the useful reading for "should I update?". */
export function isNewer(candidate: string, current: string): boolean {
	const a = parseVersion(candidate);
	const b = parseVersion(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i += 1) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return false;
}

/** The fields we need from GitHub's `releases/latest` document. */
export function parseRelease(json: unknown): ReleaseInfo | null {
	if (!json || typeof json !== 'object') return null;
	const data = json as Record<string, unknown>;
	const tag = typeof data.tag_name === 'string' ? data.tag_name.trim() : '';
	if (!tag) return null;
	return {
		tag,
		version: tag.replace(/^v/, ''),
		url: typeof data.html_url === 'string' && data.html_url ? data.html_url : RELEASES_URL,
		publishedAt: typeof data.published_at === 'string' ? data.published_at : null
	};
}

/**
 * The highest semver tag from a `/tags` listing.
 *
 * Not every project publishes GitHub releases — this one shipped a `v1.0.0`
 * tag before it had a release object — and `/releases/latest` answers 404 in
 * that case. The tags endpoint has no ordering guarantee, so the versions are
 * compared rather than trusted in the order they arrive.
 */
export function highestVersionTag(json: unknown): ReleaseInfo | null {
	if (!Array.isArray(json)) return null;
	let best: { tag: string; parts: number[] } | null = null;
	for (const entry of json) {
		const name =
			typeof (entry as Record<string, unknown>)?.name === 'string'
				? ((entry as Record<string, unknown>).name as string).trim()
				: '';
		const parts = parseVersion(name);
		if (!parts) continue;
		if (!best || isNewer(parts.join('.'), best.parts.join('.'))) best = { tag: name, parts };
	}
	if (!best) return null;
	return {
		tag: best.tag,
		version: best.tag.replace(/^v/, ''),
		url: `${RELEASES_URL}/tag/${best.tag}`,
		publishedAt: null
	};
}

export interface ReleaseCheck {
	/** The version this deployment runs. */
	current: string;
	/** Null when GitHub could not be asked (offline, rate-limited, no release yet). */
	latest: ReleaseInfo | null;
	updateAvailable: boolean;
	/** When the answer was fetched, for the "checked 3 hours ago" line. */
	checkedAt: string | null;
	error?: string;
}

/** Fold the fetched release into the shape the UI and doctor both use. */
export function releaseCheckResult(
	current: string,
	latest: ReleaseInfo | null,
	checkedAt: string | null,
	error?: string
): ReleaseCheck {
	return {
		current,
		latest,
		updateAvailable: Boolean(latest && isNewer(latest.version, current)),
		checkedAt,
		...(error ? { error } : {})
	};
}
