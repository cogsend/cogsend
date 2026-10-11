/**
 * Stands in for workerd's `cloudflare:workers` module in the unit tests, which
 * run in Node (vite.config.ts aliases the module here). The hook reads the
 * Worker's bindings and `waitUntil` from it, so a test that calls the hook
 * hands them over with useWorkerEnv() first.
 */
export const env = {} as Env;

let background: (promise: Promise<unknown>) => void = () => {};

export function waitUntil(promise: Promise<unknown>): void {
	background(promise);
}

/** The bindings the next hook call sees, and where its waitUntil work goes. */
export function useWorkerEnv(
	bindings: Record<string, unknown>,
	onWaitUntil: (promise: Promise<unknown>) => void = () => {}
): void {
	for (const key of Object.keys(env)) delete (env as unknown as Record<string, unknown>)[key];
	Object.assign(env, bindings);
	background = onWaitUntil;
}
