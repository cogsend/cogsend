/**
 * Two letters for an avatar with no picture: from the display name, else the
 * email's local part. Drawn here rather than fetched from an avatar service,
 * which would send the owner's name to a third party on every page.
 */
export function initialsOf(name: string | null | undefined, email?: string | null): string {
	const source = (name?.trim() || email?.split('@')[0] || '?').replace(/^@/, '');
	const parts = source.split(/[\s._-]+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return source.slice(0, 2).toUpperCase();
}
