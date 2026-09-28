/**
 * An IANA time zone the runtime accepts, or null. The browser reports its zone
 * and a client can send any string: this keeps a typo or a crafted value out
 * of the database and out of the formatters that would throw on it.
 */
export function parseTimeZone(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const zone = raw.trim();
	if (!zone || zone.length > 64) return null;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return zone;
	} catch {
		return null;
	}
}

/** The zone this browser runs in, or null when it does not say. */
export function browserTimeZone(): string | null {
	try {
		return parseTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
	} catch {
		return null;
	}
}
