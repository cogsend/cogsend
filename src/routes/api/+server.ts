import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { docsLinks } from '#lib/domain/docs-links.js';

// This was an in-app reference page, and links to it are still out there.
export const GET: RequestHandler = () => redirect(302, docsLinks.api, { external: true });
