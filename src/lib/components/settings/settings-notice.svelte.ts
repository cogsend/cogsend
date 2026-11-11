import { getContext, onDestroy, setContext } from 'svelte';
import { humanizeError } from '#lib/domain/human-error.js';
import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';

/**
 * The one message line a settings page shows above its cards. Each card reports
 * into it instead of keeping its own, so a page never shows two at once. It is
 * per page through context, not a module singleton, which the server would share
 * between requests.
 */
export type SettingsNotice = {
	readonly msg: string | null;
	readonly err: string | null;
	ok(text: string): void;
	fail(text: string): void;
	clearError(): void;
	clear(): void;
};

const KEY = Symbol('settings-notice');

export function createSettingsNotice(): SettingsNotice {
	const state = $state<{ msg: string | null; err: string | null }>({ msg: null, err: null });
	const notice: SettingsNotice = {
		get msg() {
			return state.msg;
		},
		get err() {
			return state.err;
		},
		ok(text) {
			state.msg = text;
		},
		fail(text) {
			state.err = text;
		},
		clearError() {
			state.err = null;
		},
		clear() {
			state.msg = null;
			state.err = null;
		}
	};
	setContext(KEY, notice);
	return notice;
}

/**
 * The page's notice, as one card may use it. A request that settles after the
 * user has moved to another section would otherwise put this card's message on
 * that section, so once the card is gone it says nothing.
 */
export function useSettingsNotice(): SettingsNotice {
	const notice = getContext<SettingsNotice | undefined>(KEY);
	if (!notice) throw new Error('A settings card needs createSettingsNotice() on its page');
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});
	return {
		get msg() {
			return notice.msg;
		},
		get err() {
			return notice.err;
		},
		ok(text) {
			if (mounted) notice.ok(text);
		},
		fail(text) {
			if (mounted) notice.fail(text);
		},
		clearError() {
			if (mounted) notice.clearError();
		},
		clear() {
			if (mounted) notice.clear();
		}
	};
}

/**
 * GET `url` for a card. A 401 sends the user to sign in and a network failure
 * says so in the notice; either way the card gets `null`. Any other answer is
 * returned for the card to judge, since only it knows what a failure means.
 */
export async function settingsGet(url: string, notice: SettingsNotice): Promise<Response | null> {
	try {
		const res = await fetch(url);
		if (sessionExpiredIfUnauthorized(res)) {
			notice.fail('Your session expired — sign in again');
			return null;
		}
		return res;
	} catch {
		notice.fail(humanizeError('fetch failed'));
		return null;
	}
}
