/**
 * Whether, and how, strangers may create accounts on this instance.
 *
 * CogSend is single-user unless the operator opts in: `REGISTRATION` in the
 * Worker's environment is the master switch, and while it is unset (or `off`)
 * nothing here can open sign-up, whatever the database says. Once it is on, the
 * admin decides day to day from the Users page, and what they save there wins
 * over the environment's starting values.
 */
export const REGISTRATION_MODES = ['off', 'waitlist', 'open'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'pending' | 'unverified' | 'suspended';

/** Used when `MAX_ACTIVE_USERS` is unset: small, because every account shares
 *  one Worker's request budget, one D1 database and the provider apps' limits. */
export const DEFAULT_MAX_ACTIVE_USERS = 10;
export const MAX_ACTIVE_USERS_CEILING = 100_000;

export function parseRegistrationMode(raw: unknown): RegistrationMode | null {
	const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	return (REGISTRATION_MODES as readonly string[]).includes(value)
		? (value as RegistrationMode)
		: null;
}

/** A positive whole number of accounts, or null for anything else. */
export function parseUserCap(raw: unknown): number | null {
	const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
	if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVE_USERS_CEILING) return null;
	return value;
}

export interface RegistrationConfig {
	/** What sign-up does right now. */
	mode: RegistrationMode;
	/** False while the environment has not opted in: nothing can turn it on. */
	enabled: boolean;
	/** Active accounts (the admin included) before `open` falls back to the waitlist. */
	cap: number;
	/** Where each value came from, for the admin's settings card. */
	modeSource: 'env' | 'admin';
	capSource: 'env' | 'admin' | 'default';
}

export function resolveRegistration(input: {
	envMode?: string;
	envCap?: string;
	storedMode?: string | null;
	storedCap?: string | null;
}): RegistrationConfig {
	const envMode = parseRegistrationMode(input.envMode) ?? 'off';
	const envCap = parseUserCap(input.envCap);
	const storedCap = parseUserCap(input.storedCap);
	const cap = storedCap ?? envCap ?? DEFAULT_MAX_ACTIVE_USERS;
	const capSource = storedCap ? 'admin' : envCap ? 'env' : 'default';
	if (envMode === 'off') {
		return { mode: 'off', enabled: false, cap, modeSource: 'env', capSource };
	}
	const storedMode = parseRegistrationMode(input.storedMode);
	return {
		mode: storedMode ?? envMode,
		enabled: true,
		cap,
		modeSource: storedMode ? 'admin' : 'env',
		capSource
	};
}

/**
 * The status a new account starts in. Email verification comes first when the
 * instance can send mail; the rest is decided once the address is confirmed.
 * `activeCount` includes the admin. An invite skips both the waitlist and the
 * cap: the admin chose that person.
 */
export function initialStatus(opts: {
	mode: RegistrationMode;
	cap: number;
	activeCount: number;
	invited: boolean;
}): Exclude<UserStatus, 'unverified' | 'suspended'> | null {
	if (opts.mode === 'off') return null;
	if (opts.invited) return 'active';
	if (opts.mode === 'waitlist') return 'pending';
	return opts.activeCount < opts.cap ? 'active' : 'pending';
}

/** What the person signing in is told when their password was right but the
 *  account cannot be used yet. Only ever shown after the password checked out,
 *  so it confirms nothing a guesser could not already see. */
export function statusProblem(status: string | null | undefined): string | null {
	switch (status) {
		case undefined:
		case null:
		case 'active':
			return null;
		case 'pending':
			return 'Your account is on the waitlist. You can sign in once an admin approves it.';
		case 'unverified':
			return 'Confirm your email address first: use the link we sent you.';
		case 'suspended':
			return 'This account has been suspended. Contact the instance admin.';
		default:
			return 'This account cannot sign in.';
	}
}
