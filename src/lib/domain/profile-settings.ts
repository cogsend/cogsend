export const MASTO_VISIBILITIES = ['public', 'unlisted', 'private', 'direct'] as const;
export type MastoVisibility = (typeof MASTO_VISIBILITIES)[number];

export const MASTO_VISIBILITY_LABELS: Record<MastoVisibility, string> = {
	public: 'Public',
	unlisted: 'Unlisted',
	private: 'Followers',
	direct: 'Direct'
};

export interface ProfileSettings {
	/** Default Mastodon visibility for new drafts. */
	mastoVisibility: MastoVisibility;
	/** Default selected account ids for new drafts (empty = all active). */
	defaultAccountIds: string[];
	/** Global profile picture URL (used in top navigation and editor main tab). */
	profilePictureUrl: string;
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
	mastoVisibility: 'public',
	defaultAccountIds: [],
	profilePictureUrl: ''
};

function isVisibility(v: unknown): v is MastoVisibility {
	return typeof v === 'string' && (MASTO_VISIBILITIES as readonly string[]).includes(v);
}

export const PROFILE_PICTURE_URL_MAX = 2000;
export const DEFAULT_ACCOUNT_ID_MAX = 128;

function sanitizeAccountIds(ids: unknown): string[] {
	if (!Array.isArray(ids)) return [];
	return ids.filter(
		(id): id is string =>
			typeof id === 'string' && id.length > 0 && id.length <= DEFAULT_ACCOUNT_ID_MAX
	);
}

/** True when the value is a non-empty https URL within the length cap. */
export function isValidProfilePictureUrl(raw: unknown): boolean {
	if (typeof raw !== 'string') return false;
	const s = raw.trim();
	if (!s || s.length > PROFILE_PICTURE_URL_MAX) return false;
	try {
		return new URL(s).protocol === 'https:';
	} catch {
		return false;
	}
}

/** Stored values: invalid URLs become empty so the UI falls back. */
export function sanitizeProfilePictureUrl(raw: unknown): string {
	const s = typeof raw === 'string' ? raw.trim() : '';
	return isValidProfilePictureUrl(s) ? s : '';
}

/** Parse stored settings defensively: unknown fields and bad values fall back. */
export function parseProfileSettings(raw: unknown): ProfileSettings {
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return { ...DEFAULT_PROFILE_SETTINGS };
		}
	}
	if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROFILE_SETTINGS };
	const r = raw as Record<string, unknown>;
	return {
		mastoVisibility: isVisibility(r.mastoVisibility) ? r.mastoVisibility : 'public',
		defaultAccountIds: sanitizeAccountIds(r.defaultAccountIds),
		profilePictureUrl: sanitizeProfilePictureUrl(r.profilePictureUrl)
	};
}

/** Validate a client-supplied settings payload. Returns normalized settings or an error. */
export function normalizeProfileSettings(
	input: unknown
): { ok: true; settings: ProfileSettings } | { ok: false; error: string } {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid settings' };
	const r = input as Record<string, unknown>;
	if (r.mastoVisibility !== undefined && !isVisibility(r.mastoVisibility)) {
		return { ok: false, error: 'Invalid visibility' };
	}
	if (r.defaultAccountIds !== undefined) {
		if (
			!Array.isArray(r.defaultAccountIds) ||
			r.defaultAccountIds.length > 50 ||
			r.defaultAccountIds.some(
				(id) => typeof id !== 'string' || id.length === 0 || id.length > DEFAULT_ACCOUNT_ID_MAX
			)
		) {
			return { ok: false, error: 'Invalid default accounts' };
		}
	}
	if (r.profilePictureUrl !== undefined) {
		if (typeof r.profilePictureUrl !== 'string') {
			return { ok: false, error: 'Invalid profile picture URL' };
		}
		const trimmed = r.profilePictureUrl.trim();
		if (trimmed.length > 0 && !isValidProfilePictureUrl(trimmed)) {
			return { ok: false, error: 'Invalid profile picture URL' };
		}
	}
	return { ok: true, settings: parseProfileSettings(input) };
}
