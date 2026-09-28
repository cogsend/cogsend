/**
 * The per-request subrequest budget.
 *
 * Cloudflare caps what one invocation may call: 50 subrequests on Workers Free,
 * 10,000 on Paid, and every D1 statement, R2 operation and outbound fetch counts
 * against it (https://developers.cloudflare.com/workers/platform/limits/). Once
 * it runs out, the next call throws. Publishing is where that hurts: if the
 * call that runs out is the write recording a post the platform already
 * accepted, the row is later reclaimed and the post goes out a second time.
 *
 * So the calls a request makes are counted here, and the loops that publish
 * several targets in one request (the tick, publish-now, bulk retry) check the
 * count before each target after the first, leaving the rest for the next tick
 * rather than starting one that may not finish. The plan cannot be read at
 * runtime, so the limit defaults to the Free plan's and `SUBREQUEST_LIMIT`
 * raises it on Paid.
 */
import type { MediaStore } from './providers/types';
import type { FetchLike } from './providers/types';

export const FREE_PLAN_SUBREQUESTS = 50;

export class SubrequestBudget {
	used = 0;

	constructor(readonly limit: number = FREE_PLAN_SUBREQUESTS) {}

	count(n = 1) {
		this.used += n;
	}

	get remaining(): number {
		return this.limit - this.used;
	}
}

/** `SUBREQUEST_LIMIT` (a secret or a var, so a string or a number), or the
 *  Free plan's 50 when unset or not a positive integer. */
export function parseSubrequestLimit(raw: unknown): number {
	if (raw === undefined || raw === null || raw === '') return FREE_PLAN_SUBREQUESTS;
	const n = Number(String(raw).trim());
	return Number.isInteger(n) && n > 0 ? n : FREE_PLAN_SUBREQUESTS;
}

/** Reached through a counting wrapper, so per-binding caches keep one key. */
const RAW_BINDING = Symbol.for('cogsend.rawBinding');

/** The binding a counting wrapper stands for (or the value itself). */
export function rawBinding<T>(value: T): T {
	const raw =
		value && typeof value === 'object'
			? (value as Record<symbol, unknown>)[RAW_BINDING]
			: undefined;
	return (raw as T | undefined) ?? value;
}

/**
 * Count every statement run through a D1 binding. Drizzle prepares each
 * statement it runs, batched ones included, so `prepare` is the count; `exec`
 * is one call. Methods are bound to the real binding: its internals are private
 * fields, which a Proxy receiver cannot reach.
 */
export function countingD1(d1: D1Database, budget: SubrequestBudget): D1Database {
	return new Proxy(d1 as unknown as Record<PropertyKey, unknown>, {
		get(target, prop) {
			if (prop === RAW_BINDING) return d1;
			const value = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			if (prop === 'prepare' || prop === 'exec') {
				return (...args: unknown[]) => {
					budget.count();
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			return (value as (...a: unknown[]) => unknown).bind(target);
		}
	}) as unknown as D1Database;
}

export function countingMediaStore(store: MediaStore, budget: SubrequestBudget): MediaStore {
	const counted: MediaStore = {
		get: (key) => {
			budget.count();
			return store.get(key);
		},
		put: (key, bytes, mime) => {
			budget.count();
			return store.put(key, bytes, mime);
		},
		delete: (key) => {
			budget.count();
			return store.delete(key);
		}
	};
	if (store.getRange) {
		const getRange = store.getRange.bind(store);
		counted.getRange = (key, start, end) => {
			budget.count();
			return getRange(key, start, end);
		};
	}
	if (store.size) {
		const size = store.size.bind(store);
		counted.size = (key) => {
			budget.count();
			return size(key);
		};
	}
	if (store.open) {
		const open = store.open.bind(store);
		counted.open = (key, range) => {
			budget.count();
			return open(key, range);
		};
	}
	if (store.deleteMany) {
		const deleteMany = store.deleteMany.bind(store);
		counted.deleteMany = (keys) => {
			budget.count();
			return deleteMany(keys);
		};
	}
	return counted;
}

export function countingFetch(fetchImpl: FetchLike, budget: SubrequestBudget): FetchLike {
	return (input, init) => {
		budget.count();
		return fetchImpl(input, init);
	};
}
