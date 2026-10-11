import adapter from '@sveltejs/adapter-cloudflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

// Shown in Settings so a bug report can name the version it runs.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// The hook runs SvelteKit's cross-site check itself, so that a request
			// with its own credential and no Content-Type (an API script, a tick
			// pinger) is not refused; see src/lib/server/csrf.ts.
			csrf: { trustedOrigins: ['*'] },
			csp: {
				// 'auto' nonces the inline scripts SvelteKit emits for hydration,
				// which is why script-src needs no 'unsafe-inline' here.
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					// Server-rendered <img onload/onerror> gets Svelte's inline
					// `this.__e=event`, which records a load that finishes before
					// hydration so it can be replayed. Blocked, a cached image loads
					// unseen and its handler never runs. The hash admits that one
					// string and nothing else.
					'script-src': [
						'self',
						'unsafe-hashes',
						'sha256-7dQwUgLau1NFCCGjfn9FsYptB6ZtWxJin6VohGIu20I='
					],
					'base-uri': ['self'],
					'object-src': ['none'],
					'frame-ancestors': ['none'],
					'form-action': ['self'],
					// Svelte writes inline style attributes and Tailwind injects a
					// stylesheet at build time; style attributes need 'unsafe-inline'.
					'style-src': ['self', 'unsafe-inline'],
					// Avatars come from five different provider CDNs, preview images
					// from arbitrary hosts, and media from this origin or
					// MEDIA_PUBLIC_BASE_URL, so images are limited to https rather
					// than enumerated.
					'img-src': ['self', 'data:', 'blob:', 'https:'],
					'media-src': ['self', 'blob:', 'https:'],
					// Every fetch the app makes goes to its own origin.
					'connect-src': ['self'],
					'font-src': ['self', 'data:'],
					'manifest-src': ['self']
				}
			}
		})
	],
	define: { __APP_VERSION__: JSON.stringify(version) },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				// workerd's runtime module does not exist in Node.
				resolve: {
					alias: {
						'cloudflare:workers': fileURLToPath(
							new URL('./tests/cloudflare-workers.ts', import.meta.url)
						)
					}
				},
				test: {
					name: 'server',
					environment: 'node',
					// The developer's own Cloudflare profile and token must not reach
					// a spawned script; see tests/setup-env.ts.
					setupFiles: ['./tests/setup-env.ts'],
					include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
