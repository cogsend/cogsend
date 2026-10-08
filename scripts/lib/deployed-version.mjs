/**
 * Which release the deployed Worker is running, read from the `workers/tag`
 * annotation every CogSend deploy now carries (`wrangler deploy --tag v<version>`
 * from a checkout, the same annotation from the in-app updater).
 *
 * It exists to stop a downgrade nobody asked for: an instance updated from
 * Settings is newer than the checkout or the Deploy-button copy it was first
 * deployed from, and deploying that older code again would roll the instance
 * back silently. So a deploy that would replace a newer release refuses,
 * unless told otherwise.
 *
 * Self-contained (node builtins only) because the Deploy-button repository
 * ships a copy of this file next to its own deploy script.
 */

const SEMVER = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/;

/**
 * True when `a` is a later release than `b`, in semver order, so that
 * `1.13.0-rc.1` < `1.13.0-rc.2` < `1.13.0`; false when either is unreadable.
 * Mirrors compareVersions in src/lib/domain/update-manifest.ts.
 *
 * @param {unknown} a @param {unknown} b
 */
export function isLaterVersion(a, b) {
	const x = SEMVER.exec(String(a ?? ''));
	const y = SEMVER.exec(String(b ?? ''));
	if (!x || !y) return false;
	for (let i = 1; i <= 3; i += 1) {
		if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
	}
	if (!x[4] || !y[4]) return !x[4] && Boolean(y[4]);
	const left = x[4].split('.');
	const right = y[4].split('.');
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		if (left[i] === undefined) return false;
		if (right[i] === undefined) return true;
		const ln = /^\d+$/.test(left[i]);
		const rn = /^\d+$/.test(right[i]);
		if (ln && rn && Number(left[i]) !== Number(right[i])) return Number(left[i]) > Number(right[i]);
		if (ln !== rn) return rn;
		if (!ln && left[i] !== right[i]) return left[i] > right[i];
	}
	return false;
}

/**
 * The tag on the version serving most of the traffic, or null with a reason
 * when it cannot be told (no deployment yet, no tag on it, wrangler failed).
 *
 * @param {(args: string[]) => { status: number | null, stdout: string }} wrangler
 *   runs `wrangler <args>` with whatever config/profile the caller uses
 * @returns {{ tag: string | null, reason?: string }}
 */
export function servingTag(wrangler) {
	const status = wrangler(['deployments', 'status', '--json']);
	if (status.status !== 0) return { tag: null, reason: 'no deployment to compare with' };
	let versionId;
	try {
		const deployment = JSON.parse(status.stdout);
		const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
		versionId = [...versions].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0]
			?.version_id;
	} catch {
		return { tag: null, reason: 'unreadable deployment status' };
	}
	if (!versionId) return { tag: null, reason: 'no serving version' };
	const view = wrangler(['versions', 'view', versionId, '--json']);
	if (view.status !== 0) return { tag: null, reason: 'could not read the serving version' };
	try {
		const tag = JSON.parse(view.stdout)?.annotations?.['workers/tag'];
		return typeof tag === 'string' && tag
			? { tag }
			: { tag: null, reason: 'the serving version has no tag' };
	} catch {
		return { tag: null, reason: 'unreadable version' };
	}
}

/**
 * Null when deploying `localVersion` is fine; otherwise the reason it would be
 * a downgrade.
 *
 * @param {string | null} serving the deployed tag, e.g. `v1.13.0`
 * @param {string} localVersion this checkout's version, e.g. `1.12.3`
 */
export function downgradeProblem(serving, localVersion) {
	if (!serving || !isLaterVersion(serving, localVersion)) return null;
	return (
		`The Worker runs ${serving}, newer than the ${localVersion} this would deploy ` +
		'(it was probably updated from Settings). Update this copy first, or pass ' +
		'--allow-downgrade (COGSEND_ALLOW_DOWNGRADE=1) to deploy the older version anyway.'
	);
}
