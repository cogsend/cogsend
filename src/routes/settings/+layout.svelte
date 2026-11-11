<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import SettingsNotice from '#lib/components/settings/SettingsNotice.svelte';
	import { createSettingsNotice } from '#lib/components/settings/settings-notice.svelte.js';
	import {
		SETTINGS_SECTIONS,
		settingsSectionFor,
		settingsSectionForAnchor
	} from '#lib/domain/settings-sections.js';

	let { children } = $props();

	const notice = createSettingsNotice();
	const current = $derived(settingsSectionFor(page.url.pathname));
	let nav = $state<HTMLElement>();

	// A message belongs to the section it came from.
	afterNavigate(({ from, to }) => {
		if (from?.url.pathname !== to?.url.pathname) notice.clear();
		void tick().then(showCurrentTab);
	});

	/**
	 * On a phone the tabs scroll sideways, and the later ones start out of view.
	 * Only the tab row moves: scrollIntoView would also scroll the page, undoing
	 * the position the browser restores on Back or a reload.
	 */
	function showCurrentTab() {
		const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!nav || !tab) return;
		const navBox = nav.getBoundingClientRect();
		const tabBox = tab.getBoundingClientRect();
		nav.scrollLeft += tabBox.left + tabBox.width / 2 - (navBox.left + navBox.width / 2);
	}

	onMount(() => {
		// Settings was one page, and links into it, such as the update notice in
		// older releases and bookmarks, point at a card on it. A hash never reaches
		// the server, so the move happens here.
		if (settingsSectionFor(page.url.pathname)?.href !== '/settings') return;
		const target = settingsSectionForAnchor(page.url.hash);
		if (target) void goto(target.href, { replaceState: true });
	});
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col">
	<h1 class="mb-6 text-3xl font-extrabold tracking-tight text-stone-900">Settings</h1>

	<nav
		bind:this={nav}
		aria-label="Settings sections"
		class="-mx-6 mb-8 [scrollbar-width:none] overflow-x-auto px-6 [&::-webkit-scrollbar]:hidden"
	>
		<ul class="flex w-max gap-0.5 rounded-xl bg-stone-200/50 p-1">
			{#each SETTINGS_SECTIONS as section (section.href)}
				<li>
					<a
						href={section.href}
						aria-current={current?.href === section.href ? 'page' : undefined}
						class="block rounded-lg px-4 py-1.5 text-[13px] font-bold whitespace-nowrap transition-all {current?.href ===
						section.href
							? 'bg-white text-stone-900 shadow-sm'
							: 'text-stone-500 hover:text-stone-900'}">{section.label}</a
					>
				</li>
			{/each}
		</ul>
	</nav>

	<SettingsNotice {notice} />

	<div class="grid gap-6">
		{@render children()}
	</div>
</div>
