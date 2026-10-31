import { describe, expect, it } from 'vitest';
import { GET } from '../src/routes/api/+server';

describe('GET /api', () => {
	it('sends a link to the old reference page to the docs', async () => {
		const thrown = await Promise.resolve()
			.then(() => GET({} as never))
			.catch((err: unknown) => err);
		expect(thrown).toMatchObject({ status: 302, location: 'https://cogsend.com/docs/api/' });
	});
});
