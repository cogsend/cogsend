<script lang="ts">
	import { onMount } from 'svelte';
	import { githubUpdateLinks, type GithubUpdateTarget } from '$lib/domain/github-update';
	import { UPDATE_TOKEN_URL } from '$lib/domain/update-manifest';

	/**
	 * Settings → Instance: install a release, or roll one back, without a
	 * checkout. The browser drives the server's steps in order (see
	 * $lib/server/updater/steps) and does the one check only a browser can do
	 * from outside the Worker: ask the new version, staged at 0%, for its
	 * health through a version-override header before any traffic moves.
	 *
	 * The Cloudflare token lives in this component's memory for one update and
	 * is sent with each step; it is never stored anywhere.
	 *
	 * Errors are shown whole rather than through humanizeError: they say what to
	 * do next, and its length cap would cut that off.
	 */
	let { latestTag = null }: { latestTag?: string | null } = $props();

	type Status = {
		version: string;
		install: 'button' | 'other';
		/** Known for button installs whose deploy recorded its repository. */
		github: GithubUpdateTarget | null;
		target: { accountId: string; scriptName: string } | null;
		previous: { version: string; replacedBy: string; schemaChange: boolean } | null;
		job: { tag: string; phase: string; expired: boolean } | null;
	};

	let status = $state<Status | null>(null);
	let open = $state(false);
	let token = $state('');
	let accountId = $state('');
	let scriptName = $state('');
	let accounts = $state<Array<{ id: string; name: string }> | null>(null);
	let scripts = $state<string[] | null>(null);
	let customTag = $state('');
	let busy = $state(false);
	let progress = $state<string[]>([]);
	let error = $state<string | null>(null);
	let offerSkipCheck = $state(false);
	let done = $state<string | null>(null);
	let confirmRollback = $state(false);
	let buildsNoticeHidden = $state(false);

	const BUILDS_NOTICE_KEY = 'cogsend.hideBuildsNotice';

	onMount(() => {
		try {
			buildsNoticeHidden = localStorage.getItem(BUILDS_NOTICE_KEY) === '1';
		} catch {
			buildsNoticeHidden = false;
		}
		void refresh();
	});

	async function refresh() {
		try {
			const res = await fetch('/api/update');
			if (res.ok) status = await res.json();
		} catch {
			// Settings stays usable without it; the panel just offers less.
		}
	}

	function hideBuildsNotice() {
		buildsNoticeHidden = true;
		try {
			localStorage.setItem(BUILDS_NOTICE_KEY, '1');
		} catch {
			// Not remembered across visits, which is fine.
		}
	}

	// A step Cloudflare cuts off (over its CPU time, error 1102) answers with an
	// HTML page rather than the app's JSON, as does a dropped connection. Every
	// step resumes where it stopped, so those are retried; the app's own errors
	// are not.
	async function step<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const res = await fetch(`/api/update/${name}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...body, token })
			}).catch(() => null);
			const data = res ? await res.json().catch(() => null) : null;
			if (res?.ok && data) return data as T;
			if (data?.error) throw new Error(data.error);
			if (attempt >= 3) {
				throw new Error(
					`The ${name} step did not finish${res ? ` (HTTP ${res.status})` : ''}. Press the button again: the update continues where it stopped.`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
		}
	}

	const say = (line: string) => (progress = [...progress, line]);

	/** True once this Worker is identified; otherwise the form asks. */
	async function ensureTarget(): Promise<boolean> {
		const result = await step<{
			target?: { scriptName: string };
			choose?: 'account' | 'script';
			accounts?: Array<{ id: string; name: string }>;
			scripts?: string[];
			accountId?: string;
		}>('target', {
			...(accountId ? { accountId } : {}),
			...(scriptName ? { scriptName } : {})
		});
		if (result.target) {
			say(`Found this Worker: ${result.target.scriptName}`);
			return true;
		}
		if (result.choose === 'account') {
			accounts = result.accounts ?? [];
			accountId = accounts[0]?.id ?? '';
			say('Pick the Cloudflare account below, then press the button again');
		}
		if (result.choose === 'script') {
			accountId = result.accountId ?? accountId;
			scripts = result.scripts ?? [];
			scriptName = scripts[0] ?? '';
			say('Could not tell which Worker this is: pick it below, then press the button again');
		}
		error = null;
		return false;
	}

	/** Ask the staged version directly; the old one keeps every other request. */
	async function newVersionAnswers(script: string, versionId: string, version: string) {
		for (let attempt = 0; attempt < 15; attempt += 1) {
			try {
				const res = await fetch('/api/health', {
					cache: 'no-store',
					headers: { 'Cloudflare-Workers-Version-Overrides': `${script}="${versionId}"` }
				});
				const data = await res.json().catch(() => null);
				if (res.ok && data?.version === version) return true;
			} catch {
				// Not reachable yet: Cloudflare says a new version can take a couple
				// of seconds to be available everywhere.
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		return false;
	}

	/** One `assets` step, retried a few times: a batch that failed is still
	 *  queued on the server, so trying again resumes where it stopped. */
	async function uploadBatch(): Promise<{ remainingBuckets: number; done: boolean }> {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await step('assets');
			} catch (e) {
				if (attempt >= 3) throw e;
				await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
			}
		}
	}

	async function install(tag: string) {
		busy = true;
		error = null;
		done = null;
		offerSkipCheck = false;
		progress = [];
		try {
			if (!(await ensureTarget())) return;
			const prepared = await step<{ version: string; assets: number; schemaChange: boolean }>(
				'prepare',
				{ tag }
			);
			say(`Downloaded and verified ${tag} (${prepared.assets} files)`);
			let assets = await uploadBatch();
			while (!assets.done) {
				say(`Uploading files… ${assets.remainingBuckets} batches left`);
				assets = await uploadBatch();
			}
			say('Uploaded the static files');
			await step('version');
			say('Uploaded the new version (not serving yet)');
			let staged: { scriptName: string; newVersionId: string; version: string };
			try {
				staged = await step('stage');
			} catch (e) {
				offerSkipCheck = true;
				throw e;
			}
			say('Staged it beside the current version, checking it…');
			if (!(await newVersionAnswers(staged.scriptName, staged.newVersionId, staged.version))) {
				throw new Error(
					`The new version did not answer its health check, so nothing changed. Abort to tidy up, or try again later.`
				);
			}
			await step('promote');
			done = `Updated to ${staged.version}. Reloading…`;
			token = '';
			setTimeout(() => window.location.reload(), 1500);
		} catch (e) {
			error = e instanceof Error ? e.message : 'The update failed';
		} finally {
			busy = false;
			void refresh();
		}
	}

	async function promoteWithoutCheck() {
		busy = true;
		error = null;
		try {
			const result = await step<{ version: string }>('promote', { skipStage: true });
			done = `Updated to ${result.version}. Reloading…`;
			token = '';
			setTimeout(() => window.location.reload(), 1500);
		} catch (e) {
			error = e instanceof Error ? e.message : 'The update failed';
		} finally {
			busy = false;
		}
	}

	async function abort() {
		busy = true;
		error = null;
		try {
			await step('abort');
			progress = [];
			say('Cancelled. The current version keeps serving.');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not cancel';
		} finally {
			busy = false;
			void refresh();
		}
	}

	async function rollback() {
		busy = true;
		error = null;
		confirmRollback = false;
		try {
			if (!(await ensureTarget())) return;
			const result = await step<{ version: string }>('rollback');
			done = `Rolled back to ${result.version}. Reloading…`;
			token = '';
			setTimeout(() => window.location.reload(), 1500);
		} catch (e) {
			error = e instanceof Error ? e.message : 'The rollback failed';
		} finally {
			busy = false;
		}
	}

	const installTag = $derived(customTag.trim() || latestTag || '');
	// Once the status loads: with no release pending, the panel is one quiet
	// link, still there for installing a specific (pre-)release.
	const visible = $derived(status !== null);
	const github = $derived(status?.github ? githubUpdateLinks(status.github) : null);
</script>

{#snippet tagField()}
	<label class="block">
		<span>Install a specific release tag (for example a pre-release)</span>
		<input
			type="text"
			placeholder={latestTag ?? 'v1.13.0'}
			bind:value={customTag}
			class="mt-1 w-full rounded-xl border border-stone-200/80 bg-white px-3 py-2 font-mono text-[12px]"
		/>
	</label>
{/snippet}

<!-- A button install that did not record its repository predates updates
     through GitHub: updating here, the copy Workers Builds holds goes stale. -->
{#if status?.install === 'button' && !status.github && !buildsNoticeHidden}
	<div
		class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] font-medium text-amber-900"
		data-testid="builds-notice"
	>
		Installed with the Deploy to Cloudflare button? Update from here, then disconnect the Git
		repository in the dashboard (Workers &amp; Pages → this Worker → Settings → Builds →
		Disconnect): while it is connected, a push to that copy would deploy its older version.
		<button type="button" onclick={hideBuildsNotice} class="ml-1 font-bold underline">Done</button>
	</div>
{/if}

{#if visible}
	<div class="rounded-xl border border-stone-200/80 bg-stone-50 p-4" data-testid="update-panel">
		{#if status?.job && !status.job.expired && !busy}
			<p class="mb-2 text-[12px] font-medium text-stone-600">
				An update to {status.job.tag} was started and not finished.
			</p>
		{/if}
		{#if github && status?.github && !open}
			<div
				class="mb-3 space-y-2 text-[12px] font-medium text-stone-600"
				data-testid="github-update"
			>
				<p>
					This instance updates through its GitHub repository,
					<span class="font-mono text-stone-800">{status.github.repo}</span>: run its
					<span class="font-bold text-stone-800">Update CogSend</span> Action, and Workers Builds deploys
					the release a couple of minutes later. No Cloudflare token needed.
				</p>
				<a
					href={github.run}
					target="_blank"
					rel="noreferrer"
					class="inline-block rounded-full bg-stone-900 px-5 py-2 text-[12px] font-bold text-white hover:bg-stone-800"
					>{latestTag ? `Update to ${latestTag} on GitHub` : 'Open the Update action on GitHub'}</a
				>
				<p>
					First time? <a
						href={github.enable}
						target="_blank"
						rel="noreferrer"
						class="font-bold text-stone-900 underline underline-offset-2"
						>Add the Update action to the repository</a
					>: GitHub opens with the file filled in, so commit it, then run the action with the tag
					left empty for the latest release.
				</p>
			</div>
		{/if}
		{#if !open}
			<div class="flex flex-wrap items-center gap-3">
				{#if latestTag && github}
					<button
						type="button"
						onclick={() => (open = true)}
						class="text-[12px] font-bold text-stone-600 underline underline-offset-2"
						>Or update here with a Cloudflare token</button
					>
				{:else if latestTag}
					<button
						type="button"
						onclick={() => (open = true)}
						class="rounded-full bg-stone-900 px-5 py-2 text-[12px] font-bold text-white hover:bg-stone-800"
						>Update to {latestTag} from here</button
					>
				{/if}
				{#if status?.previous}
					<button
						type="button"
						onclick={() => (open = true)}
						class="text-[12px] font-bold text-stone-600 underline underline-offset-2"
						>Roll back to {status.previous.version}</button
					>
				{/if}
				{#if !latestTag && !status?.previous}
					<button
						type="button"
						onclick={() => (open = true)}
						class="text-[12px] font-bold text-stone-600 underline underline-offset-2"
						>Install a specific release from here</button
					>
				{/if}
			</div>
		{:else}
			<div class="space-y-3 text-[12px] font-medium text-stone-600">
				<p>
					Updating needs a Cloudflare API token that may edit this Worker.
					<a
						href={UPDATE_TOKEN_URL}
						target="_blank"
						rel="noreferrer"
						class="font-bold text-stone-900 underline underline-offset-2">Create one</a
					>
					once (the permissions are filled in) and keep it in your password manager: the same token works
					for every update. CogSend uses it for this update only and never stores it.
				</p>
				<input
					type="password"
					autocomplete="off"
					spellcheck="false"
					placeholder="Cloudflare API token"
					aria-label="Cloudflare API token"
					bind:value={token}
					class="w-full rounded-xl border border-stone-200/80 bg-white px-3 py-2 font-mono text-[12px] text-stone-900 focus:border-stone-400 focus:outline-none pointer-coarse:text-base"
				/>
				{#if accounts}
					<label class="block">
						<span class="font-bold text-stone-700"
							>Which Cloudflare account runs this instance?</span
						>
						<select
							bind:value={accountId}
							class="mt-1 w-full rounded-xl border border-stone-200/80 bg-white px-3 py-2 text-[12px]"
						>
							{#each accounts as account (account.id)}
								<option value={account.id}>{account.name || account.id}</option>
							{/each}
						</select>
					</label>
				{/if}
				{#if scripts}
					<label class="block">
						<span class="font-bold text-stone-700">Which Worker is this instance?</span>
						<select
							bind:value={scriptName}
							class="mt-1 w-full rounded-xl border border-stone-200/80 bg-white px-3 py-2 text-[12px]"
						>
							{#each scripts as name (name)}
								<option value={name}>{name}</option>
							{/each}
						</select>
					</label>
				{/if}
				<!-- With no release on offer, the tag is the one thing left to fill in, so
				     it stays in view instead of under More options. -->
				{#if !latestTag}
					{@render tagField()}
				{/if}
				<details>
					<summary class="cursor-pointer font-bold text-stone-700">More options</summary>
					<div class="mt-2 space-y-2">
						{#if latestTag}
							{@render tagField()}
						{/if}
						<label class="block">
							<span>Account ID, if the token cannot list accounts</span>
							<input
								type="text"
								bind:value={accountId}
								class="mt-1 w-full rounded-xl border border-stone-200/80 bg-white px-3 py-2 font-mono text-[12px]"
							/>
						</label>
					</div>
				</details>

				<div class="flex flex-wrap items-center gap-3">
					{#if installTag}
						<button
							type="button"
							disabled={busy || !token.trim()}
							onclick={() => void install(installTag)}
							class="rounded-full bg-stone-900 px-5 py-2 text-[12px] font-bold text-white hover:bg-stone-800 disabled:opacity-50"
							>{busy ? 'Working…' : `Install ${installTag}`}</button
						>
					{/if}
					{#if status?.previous}
						{#if confirmRollback}
							<span class="text-stone-700">
								Send all traffic back to {status.previous.version}?
								{#if status.previous.schemaChange}
									{status.previous.replacedBy} changed the database, and older code may not expect that.
								{/if}
							</span>
							<button
								type="button"
								disabled={busy || !token.trim()}
								onclick={() => void rollback()}
								class="font-bold text-red-700 underline disabled:opacity-50">Roll back</button
							>
							<button
								type="button"
								onclick={() => (confirmRollback = false)}
								class="font-bold underline">Keep</button
							>
						{:else}
							<button
								type="button"
								disabled={busy || !token.trim()}
								onclick={() => (confirmRollback = true)}
								class="font-bold text-stone-600 underline underline-offset-2 disabled:opacity-50"
								>Roll back to {status.previous.version}</button
							>
						{/if}
					{/if}
					{#if status?.job}
						<button
							type="button"
							disabled={busy || !token.trim()}
							onclick={() => void abort()}
							class="font-bold text-stone-600 underline underline-offset-2 disabled:opacity-50"
							>Abort the unfinished update</button
						>
					{/if}
				</div>

				{#if progress.length}
					<ol
						class="list-inside list-decimal space-y-0.5 text-stone-700"
						data-testid="update-progress"
					>
						{#each progress as line, index (index)}
							<li>{line}</li>
						{/each}
					</ol>
				{/if}
				{#if error}
					<p class="font-bold text-red-600" role="alert">{error}</p>
				{/if}
				{#if offerSkipCheck && !busy}
					<p>
						Cloudflare would not stage the new version for a check.
						<button
							type="button"
							onclick={() => void promoteWithoutCheck()}
							class="font-bold underline">Switch to it without the check</button
						>
						— the dashboard's Deployments page can still roll it back.
					</p>
				{/if}
				{#if done}
					<p class="font-bold text-emerald-700" role="status">{done}</p>
				{/if}
			</div>
		{/if}
	</div>
{/if}
