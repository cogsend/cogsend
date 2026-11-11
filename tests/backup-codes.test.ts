import { describe, expect, it } from 'vitest';
import { backupCodesFile } from '#lib/domain/backup-codes.js';

describe('backupCodesFile', () => {
	it('names the instance and puts each code on its own line', () => {
		const text = backupCodesFile(['AAAA-1111', 'BBBB-2222'], 'social.example.com');
		const lines = text.split('\n');
		expect(lines[0]).toBe('Backup codes for social.example.com');
		expect(lines).toContain('AAAA-1111');
		expect(lines).toContain('BBBB-2222');
		expect(text.endsWith('\n')).toBe(true);
	});
});
