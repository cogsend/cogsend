#!/usr/bin/env node
/**
 * Generate the repository the Deploy to Cloudflare button copies
 * (github.com/cogsend/deploy): one release, already built, with nothing to
 * compile in the operator's account. Run by .github/workflows/release.yml after
 * the release bundle, from the same build.
 *
 * What it holds and why:
 *   worker/_worker.js   the bundled Worker, exactly what the release bundle carries
 *   assets/             the static files, exactly what the release bundle carries
 *   wrangler.jsonc      the app's own config with paths rewritten, `no_bundle`, an
 *                       empty database_id for the button to provision, and
 *                       COGSEND_INSTALL=button so Settings knows how it was installed
 *   .dev.vars.example   APP_ENCRYPTION_KEY alone: the button asks for every entry
 *                       in it, and treats each as required
 *   package.json        a pinned wrangler, the deploy script, and the field
 *                       descriptions the button shows
 *   deploy.mjs          tags the deploy, refuses a downgrade, survives a full set
 *                       of cron triggers (copies of this repository's helpers)
 *   drizzle/            the migrations, for a manual `wrangler d1 migrations apply`
 *
 * Usage:
 *   node scripts/deploy-repo.mjs [--worker .release/worker] [--assets .svelte-kit/cloudflare]
 *     [--out .release/deploy-repo] [--no-lock]
 */
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as ui from './lib/cli.mjs';
import { listAssets, readWorkerModules } from './lib/release-bundle.mjs';
import { parseJsonc } from './lib/wrangler-config.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const workerDir = flag('--worker', '.release/worker');
const assetsDir = flag('--assets', '.svelte-kit/cloudflare');
const outDir = flag('--out', '.release/deploy-repo');
const writeLock = !argv.includes('--no-lock');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { version } = pkg;
const wranglerVersion = JSON.parse(
	readFileSync('node_modules/wrangler/package.json', 'utf8')
).version;
const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));

/** The app's config, pointed at the prebuilt files. Everything else carries
 *  over, so a binding added upstream reaches the button's copies too. */
function deployRepoConfig(source) {
	const { main: _main, assets, vars, ...rest } = source;
	return {
		$schema: 'node_modules/wrangler/config-schema.json',
		...rest,
		main: `worker/${basename(source.main)}`,
		// Already bundled by the release build: uploading it as-is keeps the
		// button's copy byte-identical to the release.
		no_bundle: true,
		assets: { ...assets, directory: 'assets' },
		d1_databases: (rest.d1_databases ?? []).map((db) => ({ ...db, database_id: '' })),
		vars: { ...vars, COGSEND_INSTALL: 'button' }
	};
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'worker'), { recursive: true });
mkdirSync(join(outDir, 'assets'), { recursive: true });
mkdirSync(join(outDir, 'lib'), { recursive: true });

for (const m of readWorkerModules(workerDir))
	writeFileSync(join(outDir, 'worker', m.name), m.bytes);
for (const rel of [...listAssets(assetsDir), '_headers', '_redirects']) {
	const from = join(assetsDir, rel);
	if (!existsSync(from)) continue;
	mkdirSync(dirname(join(outDir, 'assets', rel)), { recursive: true });
	copyFileSync(from, join(outDir, 'assets', rel));
}

writeFileSync(
	join(outDir, 'wrangler.jsonc'),
	`${JSON.stringify(deployRepoConfig(config), null, '\t')}\n`
);

writeFileSync(
	join(outDir, '.dev.vars.example'),
	`# The one secret CogSend needs. It encrypts the account tokens CogSend stores,
# and you type it once more, on your first visit, to create your account.
# Generate one at https://cogsend.com/key/ and keep a copy somewhere safe.
APP_ENCRYPTION_KEY=
`
);

writeFileSync(
	join(outDir, 'package.json'),
	`${JSON.stringify(
		{
			name: 'cogsend',
			version,
			private: true,
			type: 'module',
			description: `CogSend ${version}, prebuilt for the Deploy to Cloudflare button.`,
			license: pkg.license,
			homepage: pkg.homepage,
			scripts: { deploy: 'node deploy.mjs' },
			devDependencies: { wrangler: wranglerVersion },
			engines: pkg.engines,
			cloudflare: {
				bindings: {
					APP_ENCRYPTION_KEY: {
						description:
							'Any random string of 32 characters or more. **Generate one at [cogsend.com/key](https://cogsend.com/key/) and keep a copy**: you type it again on your first visit to create your account, and losing it means reconnecting every account.'
					},
					DB: {
						description: 'The D1 database for posts, accounts and settings. Any name works.'
					},
					MEDIA: {
						description:
							'The R2 bucket for images and videos. R2 asks for a payment method on file, even on the free tier.'
					},
					COGSEND_INSTALL: {
						description: 'Leave as `button`: it tells Settings how this instance was installed.'
					}
				}
			}
		},
		null,
		'\t'
	)}\n`
);

// The migrations, for whoever wants `wrangler d1 migrations apply` later; the
// app builds and repairs its schema by itself, so a deploy does not need them.
for (const db of config.d1_databases ?? []) {
	if (!db.migrations_dir || !existsSync(db.migrations_dir)) continue;
	cpSync(db.migrations_dir, join(outDir, db.migrations_dir), { recursive: true });
}

copyFileSync('scripts/lib/deployed-version.mjs', join(outDir, 'lib/deployed-version.mjs'));
copyFileSync('scripts/lib/wrangler-config.mjs', join(outDir, 'lib/wrangler-config.mjs'));
writeFileSync(join(outDir, 'deploy.mjs'), DEPLOY_SCRIPT());
writeFileSync(join(outDir, '.gitignore'), 'node_modules\n.wrangler\n.dev.vars\n*.no-cron.jsonc\n');
writeFileSync(join(outDir, 'README.md'), README());

if (writeLock) {
	const lock = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
		cwd: outDir,
		encoding: 'utf8'
	});
	if (lock.status !== 0) {
		process.stderr.write(lock.stderr ?? '');
		ui.error('Could not write package-lock.json for the deploy repository');
		process.exit(1);
	}
}

ui.ok(`deploy repository for ${version} written to ${outDir}`);

function DEPLOY_SCRIPT() {
	return `#!/usr/bin/env node
/**
 * Deploy this prebuilt CogSend. Workers Builds runs it (\`npm run deploy\`) on
 * every push to this repository.
 *
 * - The deploy is tagged with this release, so Settings and later deploys can
 *   tell what is running.
 * - It refuses to replace a newer release: once you update from Settings, this
 *   copy is older than your instance, and pushing to it must not roll you back.
 *   COGSEND_ALLOW_DOWNGRADE=1 (a build variable) overrides that.
 * - An account with no cron-trigger slot left still deploys; Settings →
 *   Scheduled publishing then offers an external tick instead.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { downgradeProblem, servingTag } from './lib/deployed-version.mjs';
import {
	NO_CRON_CONFIG_NAME,
	cronFallbackWarning,
	isCronQuotaError,
	parseJsonc,
	withoutCronTriggers
} from './lib/wrangler-config.mjs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

function wrangler(args, { show = false } = {}) {
	const run = spawnSync('npx', ['wrangler', ...args], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (show) {
		process.stdout.write(run.stdout ?? '');
		process.stderr.write(run.stderr ?? '');
	}
	return { status: run.status, stdout: run.stdout ?? '', output: \`\${run.stdout}\\n\${run.stderr}\` };
}

const allowDowngrade = ['1', 'true', 'yes'].includes(
	(process.env.COGSEND_ALLOW_DOWNGRADE ?? '').toLowerCase()
);
if (!allowDowngrade) {
	const problem = downgradeProblem(servingTag(wrangler).tag, version);
	if (problem) {
		console.error(problem);
		process.exit(1);
	}
}

const deployArgs = ['deploy', '--tag', \`v\${version}\`, '--message', \`CogSend \${version}\`];
let result = wrangler(deployArgs, { show: true });
if (result.status !== 0 && isCronQuotaError(result.output)) {
	console.error(cronFallbackWarning());
	writeFileSync(
		NO_CRON_CONFIG_NAME,
		JSON.stringify(withoutCronTriggers(parseJsonc(readFileSync('wrangler.jsonc', 'utf8'))), null, '\\t')
	);
	try {
		result = wrangler([...deployArgs, '--config', NO_CRON_CONFIG_NAME], { show: true });
	} finally {
		rmSync(NO_CRON_CONFIG_NAME, { force: true });
	}
}
process.exit(result.status ?? 1);
`;
}

function README() {
	return `# CogSend ${version}, ready to deploy

This repository is [CogSend](https://github.com/cogsend/cogsend), a self-hosted social scheduler, prebuilt for one click. It is regenerated on every release; the source, issues and pull requests live in [cogsend/cogsend](https://github.com/cogsend/cogsend).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cogsend/deploy)

## Deploying

1. Press the button and sign in to Cloudflare. Your account needs R2 enabled, which asks for a payment method even on the free tier.
2. When the form asks for \`APP_ENCRYPTION_KEY\`, generate one at [cogsend.com/key](https://cogsend.com/key/) and save a copy.
3. Open the Worker's URL when the build finishes, enter the same key, and create your account.

The full guide is at [cogsend.com/docs/deploy](https://cogsend.com/docs/deploy/).

## Updating

Update from **Settings → Instance** in CogSend itself. Afterwards, disconnect this copy from Workers Builds (Workers & Pages → your Worker → Settings → Builds → Disconnect): while it is connected, a push to it would try to deploy the older release it holds, which its deploy script refuses.
`;
}
