import { base32Encode } from './base32';
import { randomBytes } from './bytes';

export const BACKUP_CODE_COUNT = 10;

export function generateBackupCode(): string {
	const raw = base32Encode(randomBytes(5)).replace(/=+$/g, '').slice(0, 8);
	return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
	const set = new Set<string>();
	while (set.size < count) set.add(generateBackupCode());
	return [...set];
}

export function normalizeBackupCode(raw: string): string {
	return raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

/** The text of a saved backup-codes file: where they sign in, then one code a line. */
export function backupCodesFile(codes: readonly string[], host: string): string {
	return [
		`Backup codes for ${host}`,
		'Each code signs in once, in place of the authenticator.',
		'',
		...codes,
		''
	].join('\n');
}
