/**
 * Read the names of the secrets already set on a Worker.
 *
 * This is the one question `npm run setup` must never get wrong: it decides
 * whether APP_ENCRYPTION_KEY is uploaded again, and uploading a new one orphans
 * every stored provider credential and signs every session out. "I could not
 * read the list" and "there are no secrets" are therefore different answers, and
 * the caller has to treat them differently.
 *
 * Wrangler renamed the output flag: `secret list --json` is a hard error on 4.x
 * ("Unknown argument: json"), while the bare command already prints JSON and
 * `--format json` asks for it explicitly. Spelling this out in one place keeps
 * the setup path, `npm run doctor` and any future caller from each guessing.
 *
 * `readWorkerSecrets` returns:
 *
 *   { ok: true, names: [...] }                 the list was read
 *   { ok: true, names: [], missingWorker: true }  no Worker yet: no secrets
 *   { ok: false, reason }                      unreadable, and it is not that
 *
 * `missingWorker` is matched from wrangler's own message, because the exit code
 * is the same either way.
 */

/** Wrangler's wording for a Worker that does not exist yet (`secret list`). */
const MISSING_WORKER =
	/10007|script_not_found|worker(?:s\.api\.error\.script_not_found|[^.\n]*does not exist|[^.\n]*not found)|is a new Worker|run `wrangler deploy` first/i;

/**
 * @typedef {{ status: number, stdout?: string, stderr?: string, output?: string }} WranglerRun
 * @param {WranglerRun} result
 * @returns {string[] | null} secret names, or null when the output was not usable
 */
export function parseSecretNames(result) {
	const text = result.stdout || result.output || '';
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return null;
		const names = parsed.map((entry) => entry?.name).filter((name) => typeof name === 'string');
		// An empty array is a real answer ("no secrets"), so it is not a failure.
		return names;
	} catch {
		return null;
	}
}

/**
 * @param {{ run: (args: string[]) => WranglerRun }} deps
 * @returns {{ ok: boolean, names: string[], missingWorker?: boolean, reason?: string }}
 */
export function readWorkerSecrets({ run }) {
	// The bare command prints JSON on wrangler 4.x, and `--format json` is the
	// documented way to ask for it. Try both before falling back: the legacy
	// `--json` spelling is still what older 3.x releases accept.
	const attempts = [[], ['--format', 'json'], ['--json']];
	let lastReason = '';

	for (const extra of attempts) {
		const result = run(['secret', 'list', ...extra]);
		const names = parseSecretNames(result);
		if (names) return { ok: true, names };
		const text = `${result.stderr ?? ''}${result.stdout ?? ''}${result.output ?? ''}`;
		if (MISSING_WORKER.test(text)) return { ok: true, names: [], missingWorker: true };
		lastReason = text.trim().split('\n').pop()?.trim() || `wrangler exited ${result.status}`;
		// A flag the CLI does not know is the expected failure for the spellings
		// it does not accept, so move on to the next one.
	}

	// `names` is always present so callers can read it without narrowing; `ok`
	// is what says whether it means anything.
	return { ok: false, names: [], reason: lastReason.slice(0, 200) };
}
