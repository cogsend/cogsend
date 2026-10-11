import { describe, expect, it } from 'vitest';
import { isBlockedInstanceHost, isPrivateIpv4 } from '#lib/domain/instance-host.js';

describe('isPrivateIpv4', () => {
	it('blocks RFC1918 and link-local', () => {
		expect(isPrivateIpv4('10.0.0.1')).toBe(true);
		expect(isPrivateIpv4('192.168.1.1')).toBe(true);
		expect(isPrivateIpv4('172.16.0.1')).toBe(true);
		expect(isPrivateIpv4('172.31.255.1')).toBe(true);
		expect(isPrivateIpv4('127.0.0.1')).toBe(true);
		expect(isPrivateIpv4('169.254.1.1')).toBe(true);
	});
	it('allows public', () => {
		expect(isPrivateIpv4('1.1.1.1')).toBe(false);
		expect(isPrivateIpv4('8.8.8.8')).toBe(false);
	});
});

describe('isBlockedInstanceHost', () => {
	it('blocks localhost and ipv6 loopback in production', () => {
		expect(isBlockedInstanceHost('localhost')).toBe(true);
		expect(isBlockedInstanceHost('127.0.0.1')).toBe(true);
		expect(isBlockedInstanceHost('::1')).toBe(true);
		expect(isBlockedInstanceHost('[::1]')).toBe(true);
	});
	it('blocks 172.16/12', () => {
		expect(isBlockedInstanceHost('172.20.0.5')).toBe(true);
	});
	it('allows public hosts', () => {
		expect(isBlockedInstanceHost('mastodon.social')).toBe(false);
	});
	it('allows localhost when allowLocal', () => {
		expect(isBlockedInstanceHost('localhost', { allowLocal: true })).toBe(false);
		expect(isBlockedInstanceHost('169.254.169.254', { allowLocal: true })).toBe(true);
	});
	it('blocks short and decimal IPv4 loopback', () => {
		expect(isBlockedInstanceHost('127.1')).toBe(true);
		expect(isBlockedInstanceHost('2130706433')).toBe(true);
	});
	it('blocks private IP embedded in a public-looking hostname', () => {
		expect(isBlockedInstanceHost('127.0.0.1.nip.io')).toBe(true);
		expect(isBlockedInstanceHost('169.254.169.254.example.com')).toBe(true);
	});
	it('blocks hex IPv4-mapped IPv6 loopback', () => {
		expect(isBlockedInstanceHost('::ffff:7f00:1')).toBe(true);
		// Same address, written out in full: the compressed-only matcher missed
		// this spelling entirely.
		expect(isBlockedInstanceHost('0:0:0:0:0:ffff:7f00:1')).toBe(true);
		expect(isBlockedInstanceHost('[0:0:0:0:0:ffff:7f00:1]')).toBe(true);
		expect(isBlockedInstanceHost('0:0:0:0:0:ffff:a00:1')).toBe(true);
		expect(isBlockedInstanceHost('::ffff:127.0.0.1')).toBe(true);
		// A public v4-mapped address stays allowed.
		expect(isBlockedInstanceHost('0:0:0:0:0:ffff:808:808')).toBe(false);
	});
	it('blocks octal and hex IPv4 loopback spellings', () => {
		expect(isBlockedInstanceHost('0177.0.0.1')).toBe(true);
		expect(isBlockedInstanceHost('0x7f.0.0.1')).toBe(true);
		expect(isBlockedInstanceHost('0x7f000001')).toBe(true);
		expect(isBlockedInstanceHost('8.8.8.8')).toBe(false);
	});
	it('blocks cloud metadata and internal DNS in every mode', () => {
		for (const opts of [{}, { allowLocal: true }]) {
			expect(isBlockedInstanceHost('metadata.google.internal', opts)).toBe(true);
			expect(isBlockedInstanceHost('metadata.google.internal.', opts)).toBe(true);
			expect(isBlockedInstanceHost('instance-data.compute.internal', opts)).toBe(true);
			expect(isBlockedInstanceHost('db.internal', opts)).toBe(true);
			expect(isBlockedInstanceHost('svc.cluster.local', opts)).toBe(true);
		}
		expect(isBlockedInstanceHost('mastodon.social')).toBe(false);
	});
	it('blocks wildcard-DNS helper domains', () => {
		expect(isBlockedInstanceHost('anything.nip.io')).toBe(true);
		expect(isBlockedInstanceHost('1.2.3.4.sslip.io')).toBe(true);
	});
	it('treats unspecified IPv6 as blocked', () => {
		expect(isBlockedInstanceHost('::')).toBe(true);
	});
});
