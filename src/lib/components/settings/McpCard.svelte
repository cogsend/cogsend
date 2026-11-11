<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { Check, Copy } from '@lucide/svelte';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import { docsLinks } from '#lib/domain/docs-links.js';
	import SettingsCard from './SettingsCard.svelte';
	import { useSettingsNotice } from './settings-notice.svelte.js';

	const notice = useSettingsNotice();
	let mcpCopied = $state<string | null>(null);
	let mcpCopiedTimer: ReturnType<typeof setTimeout> | null = null;
	let mcpClient = $state<'claude' | 'codex'>('claude');
	// Rendered with the address the Worker saw, then the browser's own: behind a
	// proxy the two can differ, and a client has to call the one in the browser.
	let origin = $state(page.url.origin);
	const mcpUrl = $derived(`${origin}/api/mcp`);
	const claudeMcpConfig = $derived(
		JSON.stringify(
			{
				mcpServers: {
					cogsend: {
						type: 'http',
						url: mcpUrl,
						headers: { Authorization: 'Bearer ${COGSEND_API_KEY}' }
					}
				}
			},
			null,
			2
		)
	);
	const codexMcpConfig = $derived(
		[
			'[mcp_servers.cogsend]',
			`url = "${mcpUrl}"`,
			'bearer_token_env_var = "COGSEND_API_KEY"',
			'default_tools_approval_mode = "prompt"'
		].join('\n')
	);
	const mcpClients = $derived([
		{
			id: 'claude' as const,
			label: 'Claude Code',
			file: '.mcp.json',
			what: 'config',
			text: claudeMcpConfig
		},
		{
			id: 'codex' as const,
			label: 'OpenAI Codex',
			file: '~/.codex/config.toml',
			what: 'config',
			text: codexMcpConfig
		}
	]);

	async function copyMcpExample(name: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			mcpCopied = name;
			if (mcpCopiedTimer) clearTimeout(mcpCopiedTimer);
			mcpCopiedTimer = setTimeout(() => (mcpCopied = null), 2000);
		} catch {
			notice.fail('Could not copy the example — select and copy it instead.');
		}
	}

	function mcpTabKey(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		const at = mcpClients.findIndex((client) => client.id === mcpClient);
		mcpClient = mcpClients[(at + step + mcpClients.length) % mcpClients.length].id;
		document.getElementById(`mcp-tab-${mcpClient}`)?.focus();
	}

	onMount(() => {
		origin = window.location.origin;
	});

	onDestroy(() => {
		if (mcpCopiedTimer) clearTimeout(mcpCopiedTimer);
	});
</script>

<SettingsCard
	title="Connect an MCP client"
	description="CogSend's stateless Streamable HTTP server lets coding agents work with drafts and publishing. Use an active personal API key; the endpoint does not use your browser session."
	testid="mcp-setup"
>
	<div
		class="flex items-center gap-3 rounded-xl border border-stone-200/80 bg-stone-50 py-1 pr-1 pl-3"
	>
		<span class="shrink-0 text-[12px] font-bold text-stone-500">Endpoint</span>
		<code
			class="min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto font-mono text-[12px] whitespace-nowrap text-stone-900 select-all"
			data-testid="mcp-endpoint">{mcpUrl}</code
		>
		<CopyButton value={mcpUrl} ariaLabel="Copy the MCP endpoint URL" />
	</div>

	<div class="mt-6 min-w-0">
		<div
			role="tablist"
			aria-label="MCP client"
			class="grid grid-cols-2 gap-1 rounded-full bg-stone-100 p-1 sm:inline-grid"
		>
			{#each mcpClients as client (client.id)}
				<button
					type="button"
					role="tab"
					id="mcp-tab-{client.id}"
					aria-selected={mcpClient === client.id}
					aria-controls="mcp-panel-{client.id}"
					tabindex={mcpClient === client.id ? 0 : -1}
					onclick={() => (mcpClient = client.id)}
					onkeydown={mcpTabKey}
					class="rounded-full px-1.5 py-1.5 text-[11px] font-bold whitespace-nowrap transition-colors sm:px-4 sm:text-[12px] {mcpClient ===
					client.id
						? 'bg-white text-stone-900 shadow-sm'
						: 'text-stone-500 hover:text-stone-900'}"
				>
					{client.label}
				</button>
			{/each}
		</div>

		{#each mcpClients as client (client.id)}
			<div
				role="tabpanel"
				id="mcp-panel-{client.id}"
				aria-labelledby="mcp-tab-{client.id}"
				hidden={mcpClient !== client.id}
				class="mt-3"
			>
				<div class="overflow-hidden rounded-xl bg-stone-950">
					<div
						class="flex items-center justify-between gap-3 border-b border-white/10 py-1.5 pr-1.5 pl-4"
					>
						<span class="truncate font-mono text-[11px] text-stone-400">{client.file}</span>
						<button
							type="button"
							onclick={() => copyMcpExample(client.id, client.text)}
							aria-label="Copy the {client.label} {client.what}"
							class="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-stone-300 transition-colors hover:bg-white/10 hover:text-white"
						>
							{#if mcpCopied === client.id}
								<Check class="h-3.5 w-3.5 text-emerald-400" /> Copied
							{:else}
								<Copy class="h-3.5 w-3.5" /> Copy
							{/if}
						</button>
					</div>
					<pre
						class="overflow-x-auto p-4 text-[12px] leading-relaxed text-stone-100 [color-scheme:dark]"><code
							>{client.text}</code
						></pre>
				</div>
				<p class="mt-2.5 max-w-prose text-[12px] leading-relaxed text-stone-500">
					{#if client.id === 'claude'}
						Add this to <code class="font-mono text-stone-900">.mcp.json</code>. Claude Code expands
						the environment variable in remote HTTP headers. Set
						<code class="font-mono text-stone-900">COGSEND_API_KEY</code> securely in the environment
						before starting Claude Code; never put its value in this file.
					{:else if client.id === 'codex'}
						Add this to <code class="font-mono text-stone-900">~/.codex/config.toml</code>. Codex
						reads the bearer value from the named environment variable. The prompt approval mode
						asks before tool calls.
					{/if}
				</p>
			</div>
		{/each}
	</div>

	<p class="mt-5 max-w-prose text-[12px] leading-relaxed text-stone-500">
		Give an agent a Read-only key unless it needs to change drafts or publish, and have your client
		ask before it publishes. Tools, scopes and Cloudflare Access headers are in the
		<a
			href={docsLinks.mcp}
			target="_blank"
			rel="noopener"
			class="font-bold text-stone-900 underline">MCP docs</a
		>.
	</p>
</SettingsCard>
