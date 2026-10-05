export function formatRelativeTime(iso: string | Date, now = new Date()): string {
	const t = typeof iso === 'string' ? new Date(iso) : iso;
	if (Number.isNaN(t.getTime())) return '';
	const diff = t.getTime() - now.getTime();
	const abs = Math.abs(diff);
	const sec = Math.round(abs / 1000);
	const min = Math.round(sec / 60);
	const hr = Math.round(min / 60);
	const day = Math.round(hr / 24);
	const future = diff > 0;
	const ago = (u: string) => (future ? `in ${u}` : `${u} ago`);
	if (sec < 45) return future ? 'in a moment' : 'just now';
	if (min < 60) return ago(`${min}m`);
	if (hr < 48) return ago(`${hr}h`);
	return ago(`${day}d`);
}

export function localTimezoneLabel(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
	} catch {
		return 'local time';
	}
}

// Cached formatters: Posts renders N cards, once per search keystroke, and
// constructing an Intl.DateTimeFormat is the expensive part. Safe to reuse
// because the locale and options never change at runtime.
let tzShortFormatter: Intl.DateTimeFormat | null = null;
let localDateTimeFormatter: Intl.DateTimeFormat | null = null;
let localTimeFormatter: Intl.DateTimeFormat | null = null;
let fullLocalFormatter: Intl.DateTimeFormat | null = null;
function getTzShortFormatter(): Intl.DateTimeFormat | null {
	if (tzShortFormatter) return tzShortFormatter;
	try {
		tzShortFormatter = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
		return tzShortFormatter;
	} catch {
		return null;
	}
}
function getLocalDateTimeFormatter(): Intl.DateTimeFormat | null {
	if (localDateTimeFormatter) return localDateTimeFormatter;
	try {
		localDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
		return localDateTimeFormatter;
	} catch {
		return null;
	}
}
function getLocalTimeFormatter(): Intl.DateTimeFormat | null {
	if (localTimeFormatter) return localTimeFormatter;
	try {
		localTimeFormatter = new Intl.DateTimeFormat(undefined, {
			hour: 'numeric',
			minute: '2-digit'
		});
		return localTimeFormatter;
	} catch {
		return null;
	}
}
function getFullLocalFormatter(): Intl.DateTimeFormat | null {
	if (fullLocalFormatter) return fullLocalFormatter;
	try {
		fullLocalFormatter = new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
			timeZoneName: 'short'
		});
		return fullLocalFormatter;
	} catch {
		return null;
	}
}
/** Short local timezone name (CET, EDT, GMT+5:30): always the viewer's own zone.
Uses the default locale — the same basis as every other displayed time — so
the label always matches the zone shown in full timestamps. A fixed locale
here (e.g. en-US) can disagree with toLocaleString elsewhere (GMT+5:30 vs
CET) and print two different zones for one instant. */
export function localTimezoneShort(now: Date = new Date()): string {
	try {
		const fmt = getTzShortFormatter();
		if (fmt) {
			const tz = fmt.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value;
			if (tz) return tz;
		}
	} catch {
		// Intl unavailable: fall back below
	}
	return localTimezoneLabel();
}

/**
 * Absolute date/time in the viewer's local timezone: "Sep 9, 2:30 PM".
 * datetime-local inputs, Date rendering and toLocaleString all share this
 * same local basis, so scheduled times never silently shift zones.
 */
export function formatLocalDateTime(iso: string | Date): string {
	const d = typeof iso === 'string' ? new Date(iso) : iso;
	if (Number.isNaN(d.getTime())) return '';
	try {
		const fmt = getLocalDateTimeFormatter();
		if (fmt) return fmt.format(d);
	} catch {
		// fall through to toLocaleString
	}
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

/** Absolute local date/time with explicit zone: "Sep 9, 2:30 PM CET". */
export function formatLocalDateTimeWithZone(iso: string | Date): string {
	const base = formatLocalDateTime(iso);
	if (!base) return '';
	return `${base} ${localTimezoneShort()}`;
}

/** Full local timestamp for tooltips: "Sep 9, 2026, 2:30:00 PM CET". */
export function formatFullLocalWithZone(iso: string | Date): string {
	const d = typeof iso === 'string' ? new Date(iso) : iso;
	if (Number.isNaN(d.getTime())) return '';
	try {
		const fmt = getFullLocalFormatter();
		if (fmt) return fmt.format(d);
	} catch {
		// fall through to toLocaleString
	}
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
		timeZoneName: 'short'
	});
}

function nearDayWord(d: Date, now: Date): 'Today' | 'Tomorrow' | 'Yesterday' | null {
	const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const diffDays = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
	if (diffDays === 0) return 'Today';
	if (diffDays === 1) return 'Tomorrow';
	if (diffDays === -1) return 'Yesterday';
	return null;
}

/**
 * Local date/time with no zone, for lists that name the zone once:
 * "Today, 2:30 PM", "Tomorrow, 9:00 AM", otherwise "Sep 9, 2:30 PM".
 */
export function formatDayTime(iso: string | Date, now = new Date()): string {
	const d = typeof iso === 'string' ? new Date(iso) : iso;
	if (Number.isNaN(d.getTime())) return '';
	const word = nearDayWord(d, now);
	if (!word) return formatLocalDateTime(d);
	try {
		const fmt = getLocalTimeFormatter();
		if (fmt) return `${word}, ${fmt.format(d)}`;
	} catch {
		// fall through to toLocaleTimeString
	}
	return `${word}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** Bucket label for a day-relative list: Today / Tomorrow / "Sat, Sep 12". */
export function dayGroupLabel(iso: string | Date, now = new Date()): string {
	const d = typeof iso === 'string' ? new Date(iso) : iso;
	if (Number.isNaN(d.getTime())) return '';
	const word = nearDayWord(d, now);
	if (word) return word;
	const sameYear = d.getFullYear() === now.getFullYear();
	return d.toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}
