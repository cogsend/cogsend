import { goto } from '$app/navigation';

/**
 * A 401 on a cookie-authenticated call means the session is gone — not that a
 * social account needs reconnecting. Without this the UI reported "Account needs
 * reconnect — password or token expired" (the copy for a provider's 401) and the
 * user had no way to know they simply had to sign in again.
 *
 * Returns true when it handled the response, so callers can bail out.
 */
export function sessionExpiredIfUnauthorized(res: Response): boolean {
	if (res.status !== 401) return false;
	void goto('/login', { refreshAll: true });
	return true;
}
