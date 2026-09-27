/**
 * Terminal output for the operator scripts: what happened, not everything the
 * tools underneath said.
 *
 * Colour is decided once, from the stream this process writes to — a TTY with
 * no `NO_COLOR` (and no `--no-color`). CI, pipes and tests get plain text, which
 * is also what keeps the assertions in tests/ matching the strings a person
 * reads on screen.
 *
 * `--verbose` (or COGSEND_VERBOSE=1) inverts the default: the scripts then print
 * every command they run and the raw output it produced. A failure always shows
 * the raw output, because that is the one time the detail is the message.
 */

const env = process.env;

const wantsColor = (() => {
	if (process.argv.includes('--no-color') || env.COGSEND_NO_COLOR === '1') return false;
	if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
	// A test runner's stdout can still be a terminal: never colour assertions.
	if (env.VITEST || env.NODE_ENV === 'test') return false;
	if (env.NO_COLOR !== undefined) return false;
	return Boolean(process.stdout.isTTY) && env.TERM !== 'dumb';
})();

/**
 * One colour, as a function that leaves the text alone when colour is off.
 *
 * @param {number} open @param {number} [close]
 * @returns {(text: unknown) => string}
 */
const paint = (open, close = 39) => {
	const prefix = `\u001b[${open}m`;
	const suffix = `\u001b[${close}m`;
	return (text) => (wantsColor ? `${prefix}${text}${suffix}` : String(text));
};

export const bold = paint(1, 22);
export const dim = paint(2, 22);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const magenta = paint(35);
export const cyan = paint(36);

export const colorsEnabled = () => wantsColor;

/** A terminal, as opposed to a pipe, a CI log or a test harness. */
const isTty = Boolean(process.stdout.isTTY) && env.TERM !== 'dumb';
export const isTerminal = () => isTty;

/**
 * A step that takes seconds: `… building`, to be replaced in place by its
 * verdict. Silent in a pipe — a log wants one line per step, not two.
 *
 * @param {string} text
 */
export function progress(text) {
	if (isTty) process.stdout.write(`\r  ${dim(`… ${text}`)}   `);
}

/** Erase the progress line, so the verdict can take its place. */
export function clearProgress() {
	if (isTty) process.stdout.write('\r\u001b[2K');
}

/** Every command and its raw output, instead of one line per step. */
export const isVerbose = () =>
	process.argv.includes('--verbose') ||
	['1', 'true', 'yes'].includes(String(env.COGSEND_VERBOSE ?? '').toLowerCase());

/** Colour removed: for measuring, not for printing. Built from a code point so
 *  the regex itself carries no control character. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
/** @param {unknown} text */
export const stripAnsi = (text) => String(text).replace(ANSI, '');
/** @param {unknown} text */
export const visibleWidth = (text) => stripAnsi(text).length;

/* -------------------------------------------------------------------------- *
 * Printing
 * -------------------------------------------------------------------------- */

/** A body line. Everything inside a step is indented to match its heading.
 *  @param {unknown} [text] */
export const line = (text = '') => console.log(`  ${text}`);
/** @param {unknown} text */
export const ok = (text) => line(`${green('✔')} ${text}`);
/** @param {unknown} text */
export const warn = (text) => line(`${yellow('!')} ${text}`);
/** @param {unknown} text */
export const note = (text) => line(dim(text));
/** @param {unknown} text */
export const plan = (text) => line(`${cyan('~')} ${dim(text)}`);
/** @param {unknown} text */
export const headline = (text) => console.log(`\n  ${bold(text)}`);
/** @param {unknown} text */
export const error = (text) => console.error(`\n  ${red('✘')} ${text}`);
/** A step heading: `3. D1 database` becomes a coloured number and a bold label.
 *  @param {string} text */
export const step = (text) => {
	const match = /^(\d+)\.\s+(.*)$/.exec(text);
	console.log(match ? `\n  ${cyan(`${match[1]}.`)} ${bold(match[2])}` : `\n  ${bold(text)}`);
};

/** The one thing an operator is looking for in a wall of deploy output.
 *  @param {unknown} text */
export const url = (text) => bold(cyan(text));
/** @param {unknown} text */
export const value = (text) => bold(String(text));
/** @param {number} ms */
export const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * A rounded box around one or two highlighted lines — the closing summary. Rows
 * may carry colour: the padding is measured on the visible text.
 *
 * @param {string[]} rows @param {{ pad?: number }} [options]
 */
export function box(rows, { pad = 2 } = {}) {
	const inner = Math.max(...rows.map(visibleWidth)) + pad * 2;
	/** @param {string} left @param {string} right */
	const bar = (left, right) => `  ${dim(`${left}${'─'.repeat(inner)}${right}`)}`;
	const body = rows.map((row) => {
		const gap = ' '.repeat(Math.max(0, inner - pad - visibleWidth(row)));
		return `  ${dim('│')}${' '.repeat(pad)}${row}${gap}${dim('│')}`;
	});
	return [bar('╭', '╮'), ...body, bar('╰', '╯')].join('\n');
}

/* -------------------------------------------------------------------------- *
 * Reading what a tool said
 * -------------------------------------------------------------------------- */

/** Chrome only: the update banner, its rule, the telemetry notice, and
 *  wrangler's prompt fallbacks. */
const NOISE = [
	/^\s*⛅️?\s*wrangler\s+\d+\.\d+\.\d+.*$/i,
	/^\s*─{3,}\s*$/,
	/^\s*🤖 Using fallback value in non-interactive context:.*$/i,
	/^\s*🌀 To execute on your local development database.*$/i,
	/^\s*Resource location:.*$/i,
	/^\s*Cloudflare collects anonymous telemetry about your usage of Wrangler\..*$/i
];

/** Is this line wrangler's chrome rather than its answer?
 *  @param {unknown} text */
export const isToolNoise = (text) => NOISE.some((pattern) => pattern.test(String(text)));

/**
 * Drop those lines, and collapse the blank runs they leave behind.
 *
 * @param {unknown} text
 */
export function stripToolNoise(text) {
	const kept = String(text)
		.split('\n')
		.filter((line) => !isToolNoise(line));
	return kept
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * `✓ built in 5.21s` → 5210. Null when the build reported nothing.
 *
 * @param {string} text
 */
export function parseBuildMs(text) {
	const match = /built in ([\d.]+)\s*s\b/.exec(text);
	return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * The migration files a wrangler run listed, deduplicated: `0001_init.sql`, …
 *
 * @param {string} text
 * @returns {string[]}
 */
export function migrationNames(text) {
	const names = new Set();
	for (const match of String(text).matchAll(/(\d{4}_[a-z0-9_]+\.sql)/gi)) names.add(match[1]);
	return [...names];
}

/**
 * One line for a `wrangler d1 migrations apply` run.
 *
 * Wrangler reprints its whole table after every migration, so the names are
 * deduplicated; what is left is how many migrations that run touched.
 *
 * @param {string} text
 */
export function migrationsSummary(text) {
	if (/No migrations to apply/i.test(text)) return 'no pending migrations';
	const names = migrationNames(text);
	if (!names.length) return null;
	return `${names.length} migration${names.length === 1 ? '' : 's'} applied`;
}

/**
 * What `wrangler deploy` printed: the URL on a line of its own, the bindings it
 * attached, and the version id — enough to confirm the deploy without the asset
 * list.
 *
 * @param {string} text
 * @returns {{ url: string | null, bindings: string[], versionId: string | null, startupMs: number | null }}
 */
export function deployFacts(text) {
	const source = String(text);
	const found = /^\s*(https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)\s*$/im.exec(source);
	return {
		url: found?.[1] ?? null,
		bindings: [...new Set([...source.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]))],
		versionId: /Current Version ID:\s*([0-9a-f-]{16,})/i.exec(source)?.[1] ?? null,
		startupMs: Number(/Worker Startup Time:\s*(\d+)\s*ms/i.exec(source)?.[1] ?? 0) || null
	};
}
