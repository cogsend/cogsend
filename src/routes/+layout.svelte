<script lang="ts">
	import './layout.css';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Settings,
		LogOut,
		ChevronDown,
		PenLine,
		Calendar,
		Users,
		ChartColumn
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import favicon from '$lib/assets/favicon.svg';
	import faviconDark from '$lib/assets/favicon-dark.svg';
	import logoGlyph from '$lib/assets/logo-glyph.svg';
	import { initialsOf } from '$lib/components/initials';
	import { menuNav } from '$lib/components/menu-nav';
	import { browserTimeZone } from '$lib/domain/time-zone';

	let workspaceTrigger: HTMLButtonElement | null = $state(null);
	let profileTrigger: HTMLButtonElement | null = $state(null);

	let { children, data } = $props();

	let showWorkspaceDropdown = $state(false);
	let showProfileDropdown = $state(false);

	const userEmail: string | null = $derived(data.user?.email ?? null);
	const displayName: string | null = $derived(data.displayName ?? null);
	const profilePictureUrl: string | null = $derived(data.profilePictureUrl ?? null);
	const avatarSrc = $derived(profilePictureUrl || null);
	// Initials stay underneath the picture. A failed URL (and only that URL)
	// drops the image; the next URL is tried again.
	let failedAvatarSrc = $state<string | null>(null);
	const isLoginRoute = $derived(page.url.pathname.startsWith('/login'));

	// Insights counts days in the account's zone, and nothing else knows it: the
	// browser does. Recorded in the background whenever the two disagree, so a
	// move or a trip follows along; a failure only means the next visit tries again.
	onMount(() => {
		const user = data.user;
		const zone = browserTimeZone();
		if (!user?.totpEnabled || !user.mfaVerified || !zone || zone === user.timezone) return;
		void fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timezone: zone })
		}).catch(() => {});
	});
	let logoutError = $state<string | null>(null);
	async function logout() {
		showProfileDropdown = false;
		logoutError = null;
		try {
			const res = await fetch('/api/auth/logout', { method: 'POST' });
			if (!res.ok) throw new Error(`Logout failed (${res.status})`);
			await invalidateAll();
			await goto('/login');
		} catch (err) {
			// Without this the redirect to /login bounces a still-signed-in user
			// back to the page they were on, and the button looks broken.
			await invalidateAll();
			logoutError =
				err instanceof Error && err.message.startsWith('Logout failed')
					? 'Could not sign out — try again'
					: 'Could not sign out — check your connection';
		}
	}

	// Close dropdowns when clicking outside
	function handleOutsideClick(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.workspace-dropdown-container')) {
			showWorkspaceDropdown = false;
		}
		if (!target.closest('.profile-dropdown-container')) {
			showProfileDropdown = false;
		}
	}

	function handleMenuKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			showWorkspaceDropdown = false;
			showProfileDropdown = false;
		}
	}
</script>

<svelte:head>
	<title>{data.appName} — write & schedule</title>
	<meta
		name="description"
		content="Minimal social scheduler for Mastodon, Bluesky, LinkedIn, Threads, and X"
	/>
	<link rel="icon" href={favicon} type="image/svg+xml" />
	<link rel="icon" href={faviconDark} type="image/svg+xml" media="(prefers-color-scheme: dark)" />
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
</svelte:head>

<svelte:window onclick={handleOutsideClick} onkeydown={handleMenuKeydown} />
<a
	href="#main-content"
	class="sr-only z-50 rounded-full bg-stone-900 px-4 py-2 text-sm font-bold text-white focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
	>Skip to content</a
>

{#if isLoginRoute || !userEmail}
	{@render children()}
{:else}
	<div class="min-h-dvh bg-stone-50 font-sans text-stone-900 selection:bg-stone-200">
		<!-- TOP NAVIGATION (Floating Header) -->
		<header
			class="pointer-events-none fixed top-0 right-0 left-0 z-40 mx-auto flex w-full max-w-[800px] items-center justify-between px-4 py-6 sm:px-6"
		>
			<!-- Page content scrolls under the floating pills; this scrim keeps it legible. -->
			<div
				class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-28 bg-gradient-to-b from-stone-50 from-40% via-stone-50/80 to-transparent"
				aria-hidden="true"
			></div>
			<!-- landmark for AT: header is banner, nav gives primary pages -->
			<!-- LEFT: Workspace Dropdown (Pointer events re-enabled) -->
			<nav aria-label="Primary" class="workspace-dropdown-container pointer-events-auto relative">
				<button
					type="button"
					class="group flex items-center gap-3 rounded-full border border-stone-200/80 bg-white px-2.5 py-2 shadow-[0_4px_20px_-8px_rgb(28_25_23/0.08)] transition-all hover:border-stone-300 hover:shadow-[0_4px_24px_-8px_rgb(28_25_23/0.12)] focus:outline-none"
					bind:this={workspaceTrigger}
					onclick={() => (showWorkspaceDropdown = !showWorkspaceDropdown)}
					aria-haspopup="menu"
					aria-expanded={showWorkspaceDropdown}
					aria-controls="workspace-menu"
					aria-label="Workspace menu"
				>
					<img src={logoGlyph} alt="" class="h-7 w-7 p-1" aria-hidden="true" />
					<span class="text-[14px] font-extrabold tracking-tight text-stone-900"
						>{data.appName}</span
					>
					<ChevronDown
						class="mr-1 h-4 w-4 text-stone-500 transition-transform {showWorkspaceDropdown
							? 'rotate-180'
							: ''}"
					/>
				</button>

				<!-- NAVIGATION DROPDOWN -->
				{#if showWorkspaceDropdown}
					<div
						id="workspace-menu"
						class="absolute top-14 left-0 z-50 w-56 origin-top-left rounded-[1.5rem] border border-stone-200/80 bg-white p-2 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)]"
						transition:fly={{ y: -5, duration: 200, opacity: 0 }}
						role="menu"
						use:menuNav={{
							trigger: workspaceTrigger,
							onEscape: () => (showWorkspaceDropdown = false)
						}}
					>
						<a
							href="/compose"
							class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors {page
								.url.pathname === '/compose'
								? 'bg-stone-900 text-white shadow-md'
								: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
							onclick={() => (showWorkspaceDropdown = false)}
							role="menuitem"
						>
							<PenLine
								class="h-4 w-4 {page.url.pathname === '/compose' ? 'text-white' : 'text-stone-500'}"
							/> Compose
						</a>
						<a
							href="/posts"
							class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors {page
								.url.pathname === '/posts'
								? 'bg-stone-900 text-white shadow-md'
								: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
							onclick={() => (showWorkspaceDropdown = false)}
							role="menuitem"
						>
							<Calendar
								class="h-4 w-4 {page.url.pathname === '/posts' ? 'text-white' : 'text-stone-500'}"
							/> Posts
						</a>
						<a
							href="/insights"
							class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors {page
								.url.pathname === '/insights'
								? 'bg-stone-900 text-white shadow-md'
								: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
							onclick={() => (showWorkspaceDropdown = false)}
							role="menuitem"
						>
							<ChartColumn
								class="h-4 w-4 {page.url.pathname === '/insights'
									? 'text-white'
									: 'text-stone-500'}"
							/> Insights
						</a>
						<a
							href="/accounts"
							class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors {page
								.url.pathname === '/accounts'
								? 'bg-stone-900 text-white shadow-md'
								: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
							onclick={() => (showWorkspaceDropdown = false)}
							role="menuitem"
						>
							<Users
								class="h-4 w-4 {page.url.pathname === '/accounts'
									? 'text-white'
									: 'text-stone-500'}"
							/> Accounts
						</a>
					</div>
				{/if}
			</nav>

			<!-- RIGHT: Write Action & Profile (Pointer events re-enabled) -->
			<div class="pointer-events-auto flex items-center gap-3">
				<!-- Contextual Write Button (Hidden when on Compose page) -->
				{#if page.url.pathname !== '/compose'}
					<a
						href="/compose"
						class="flex h-11 w-11 items-center justify-center gap-2 rounded-full bg-stone-900 text-[13px] font-bold text-white shadow-[0_4px_16px_-4px_rgb(28_25_23/0.3)] transition-all hover:bg-stone-800 hover:shadow-[0_4px_20px_-4px_rgb(28_25_23/0.4)] sm:h-auto sm:w-auto sm:px-5 sm:py-2.5"
					>
						<PenLine class="h-4 w-4" />
						<span class="sr-only sm:not-sr-only">Write</span>
					</a>
				{/if}

				<!-- Profile Dropdown Container -->
				<div class="profile-dropdown-container relative">
					<button
						type="button"
						class="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-stone-200/80 bg-white shadow-[0_4px_20px_-8px_rgb(28_25_23/0.08)] transition-all hover:border-stone-300 hover:shadow-[0_4px_24px_-8px_rgb(28_25_23/0.12)] focus:outline-none"
						onclick={() => (showProfileDropdown = !showProfileDropdown)}
						aria-haspopup="menu"
						aria-expanded={showProfileDropdown}
						bind:this={profileTrigger}
						aria-controls="profile-menu"
						aria-label="Profile menu"
						title={userEmail}
					>
						<span
							class="flex h-full w-full items-center justify-center bg-stone-200 text-[11px] font-bold text-stone-700"
							aria-hidden="true"
						>
							{initialsOf(displayName, userEmail)}
						</span>
						{#if avatarSrc && failedAvatarSrc !== avatarSrc}
							<img
								src={avatarSrc}
								alt=""
								aria-hidden="true"
								referrerpolicy="no-referrer"
								class="absolute inset-0 h-full w-full object-cover"
								onerror={() => (failedAvatarSrc = avatarSrc)}
							/>
						{/if}
					</button>

					<!-- PROFILE DROPDOWN -->
					{#if showProfileDropdown}
						<div
							id="profile-menu"
							class="absolute top-14 right-0 z-50 w-56 origin-top-right rounded-[1.5rem] border border-stone-200/80 bg-white p-2 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)]"
							transition:fly={{ y: -5, duration: 200, opacity: 0 }}
							role="menu"
							aria-label="Profile"
							use:menuNav={{
								trigger: profileTrigger,
								onEscape: () => (showProfileDropdown = false)
							}}
						>
							<div class="mb-1 border-b border-stone-100 px-3 py-3">
								{#if displayName?.trim()}
									<p class="truncate text-[13px] font-extrabold text-stone-900">
										{displayName.trim()}
									</p>
									<p
										class="mt-0.5 truncate text-[11px] font-medium text-stone-500"
										title={userEmail}
									>
										{userEmail}
									</p>
								{:else}
									<p class="truncate text-[13px] font-extrabold text-stone-900" title={userEmail}>
										{userEmail}
									</p>
								{/if}
							</div>

							<div class="mt-1 p-1">
								<a
									href="/settings"
									class="flex items-center justify-between rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors {page
										.url.pathname === '/settings'
										? 'bg-stone-900 text-white shadow-md'
										: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
									onclick={() => (showProfileDropdown = false)}
									role="menuitem"
								>
									<div class="flex items-center gap-3">
										<Settings
											class="h-4 w-4 {page.url.pathname === '/settings'
												? 'text-white'
												: 'text-stone-500'}"
										/> Settings
									</div>
								</a>

								<a
									href="/api"
									class="flex items-center justify-between rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors {page
										.url.pathname === '/api'
										? 'bg-stone-900 text-white shadow-md'
										: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
									onclick={() => (showProfileDropdown = false)}
									role="menuitem"
								>
									<div class="flex items-center gap-3">
										<PenLine
											class="h-4 w-4 {page.url.pathname === '/api'
												? 'text-white'
												: 'text-stone-500'}"
										/> API docs
									</div>
								</a>
							</div>

							<div class="mx-2 my-1 h-px bg-stone-100"></div>

							<div class="p-1">
								<button
									type="button"
									class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] font-bold text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900"
									onclick={logout}
									role="menuitem"
								>
									<LogOut class="h-4 w-4 text-stone-500" /> Log out
								</button>
								{#if logoutError}
									<p
										class="px-3 pb-2 text-[11px] font-medium text-red-600"
										data-testid="logout-error"
									>
										{logoutError}
									</p>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			</div>
		</header>

		<!-- MAIN CONTENT AREA
		     No z-index on <main> on purpose: a stacking context here would trap
		     page dialogs (z-40/z-50) below the fixed header, so modal overlays
		     would show the header pills and scrim floating above them. -->
		<main
			id="main-content"
			tabindex="-1"
			class="relative mx-auto flex min-h-dvh w-full max-w-[800px] flex-col px-6 pt-32 pb-20 focus:outline-none"
		>
			{@render children()}
		</main>
	</div>
{/if}
