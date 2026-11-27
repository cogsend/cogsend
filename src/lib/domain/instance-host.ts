function stripBrackets(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

export function isPrivateIpv4(ip: string): boolean {
	const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}

// Parse one IPv4 part, accepting decimal, octal (leading 0) and hex (0x).
// Browsers historically accept all three, so the SSRF check must too:
// `0177.0.0.1` and `0x7f.0.0.1` both mean 127.0.0.1.
function parseIpv4Part(part: string): number | null {
	if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
	if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
	if (/^\d+$/.test(part)) return Number(part);
	return null;
}

function expandShortIpv4(host: string): string | null {
	// Single hex word (`0x7f000001`) is also a valid IPv4 literal.
	if (/^0x[0-9a-f]{1,8}$/i.test(host)) {
		const n = parseInt(host, 16);
		return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
	}
	if (!/^(?:0x[0-9a-f]+|0[0-7]*|\d+)(?:\.(?:0x[0-9a-f]+|0[0-7]*|\d+)){0,3}$/i.test(host))
		return null;
	const parsed = host.split('.').map(parseIpv4Part);
	if (parsed.some((n) => n === null || (n as number) < 0)) return null;
	const parts = parsed as number[];
	if (parts.length === 1) {
		const n = parts[0] as number;
		if (n > 0xffffffff) return null;
		return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
	}
	if (parts.length === 2) {
		if ((parts[0] as number) > 255 || (parts[1] as number) > 0xffffff) return null;
		const [a, b] = parts as [number, number];
		return [a, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
	}
	if (parts.length === 3) {
		const [a, b, c] = parts as [number, number, number];
		if (a > 255 || b > 255 || c > 0xffff) return null;
		return [a, b, (c >>> 8) & 255, c & 255].join('.');
	}
	if (parts.some((n) => n > 255)) return null;
	return parts.join('.');
}

function hexWordToBytePair(word: string): [number, number] {
	const n = parseInt(word, 16);
	return [(n >> 8) & 255, n & 255];
}

function mappedIpv6ToV4(host: string): string | null {
	// Match the `ffff` group wherever it sits, not only when the address starts
	// with it: the fully expanded `0:0:0:0:0:ffff:7f00:1` is the same address
	// as `::ffff:7f00:1` but a `^::ffff:` anchor never saw it.
	const dotted = host.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
	if (dotted) return dotted[1];
	const hex = host.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (!hex) return null;
	const [a, b] = hexWordToBytePair(hex[1]);
	const [c, d] = hexWordToBytePair(hex[2]);
	return `${a}.${b}.${c}.${d}`;
}

function isPrivateIpv6(ip: string): boolean {
	const h = ip.toLowerCase();
	if (h === '::1' || h === '::') return true;
	if (h.startsWith('fe80:')) return true;
	if (h.startsWith('fc') || h.startsWith('fd')) return true;
	return false;
}

// Hostnames that always resolve to cloud metadata or internal infra.
// Checked in BOTH modes: even dev allowLocal must not reach instance metadata.
function isBlockedHostname(host: string): boolean {
	// Normalize: lowercase, strip trailing dots (`metadata.google.internal.`).
	const h = host.toLowerCase().replace(/\.+$/, '');
	if (h === 'metadata.google.internal' || h === 'metadata.google.internal.') return true;
	if (h === 'instance-data.compute.internal') return true;
	if (h === 'metadata.goog' || h === 'metadata.aws' || h === 'instance-data') return true;
	if (h === 'kubernetes.default' || h.endsWith('.kubernetes.default')) return true;
	if (h === 'kubernetes.default.svc' || h.includes('.svc.cluster.local')) return true;
	if (h.endsWith('.internal') || h.endsWith('.cluster.local')) return true;
	if (h.endsWith('.localdomain') || h.endsWith('.lan') || h.endsWith('.home')) return true;
	// Wildcard-DNS helpers resolve any subdomain to an attacker-chosen IP or
	// loopback and defeat string checks via DNS rebinding; no legitimate instance lives here.
	const wildcardSuffixes = [
		'nip.io',
		'sslip.io',
		'xip.io',
		'localtest.me',
		'lvh.me',
		'vcap.me',
		'traefik.me'
	];
	if (wildcardSuffixes.some((d) => h === d || h.endsWith(`.${d}`))) return true;
	return false;
}

function hostnameEmbedsPrivateIpv4(host: string): boolean {
	const re = /(\d{1,3}(?:\.\d{1,3}){1,3})/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(host)) !== null) {
		const expanded = expandShortIpv4(m[1]);
		if (expanded && isPrivateIpv4(expanded)) return true;
	}
	return false;
}

export function isBlockedInstanceHost(
	hostname: string,
	opts: { allowLocal?: boolean } = {}
): boolean {
	const host = stripBrackets(hostname).replace(/\.+$/, '');

	// Cloud metadata / internal DNS: blocked in every mode.
	if (isBlockedHostname(host)) return true;

	if (opts.allowLocal) {
		return host === '169.254.169.254' || host === 'metadata.google.internal';
	}

	if (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '0.0.0.0' ||
		host === '::1' ||
		host === '0000:0000:0000:0000:0000:0000:0000:0001' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local')
	) {
		return true;
	}

	const mapped = mappedIpv6ToV4(host);
	if (mapped && isPrivateIpv4(mapped)) return true;

	const expanded = expandShortIpv4(host);
	if (expanded && isPrivateIpv4(expanded)) return true;

	if (host.includes(':') && isPrivateIpv6(host)) return true;

	if (hostnameEmbedsPrivateIpv4(host)) return true;

	return false;
}
