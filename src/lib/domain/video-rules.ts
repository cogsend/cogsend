import { platformName } from './platforms';
import { X_MAX_CHARS } from './validation/text';
import { xLimitFor, type XLimitMeta } from './x-limits';

/**
 * What each platform takes in a video, from its own documentation, and the
 * check the composer and the providers share so the two cannot disagree.
 * Facts the server could not read are null and skip their check: the platform
 * still has the last word at publish.
 */
export interface VideoFacts {
	durationMs?: number | null;
	width?: number | null;
	height?: number | null;
	size?: number | null;
	videoCodec?: string | null;
	fps?: number | null;
	faststart?: boolean | null;
}

export interface VideoRuleMeta extends XLimitMeta {
	provider?: string | null;
	/** Mastodon: what the instance reports in `configuration.media_attachments`. */
	videoSizeLimit?: number | null;
	videoMatrixLimit?: number | null;
	videoFrameRateLimit?: number | null;
}

/** In every message about a parked video; the composer and Posts read it to say "Processing". */
export const PROCESSING_MARK = 'is processing the video';

/** The facts of a stored video as the API serializes it (draft media `meta`). */
export function factsOfMedia(m: {
	width?: number | null;
	height?: number | null;
	size?: number | null;
	meta?: {
		durationMs?: number | null;
		videoCodec?: string | null;
		fps?: number | null;
		faststart?: boolean | null;
	} | null;
}): VideoFacts {
	return {
		durationMs: m.meta?.durationMs ?? null,
		width: m.width ?? null,
		height: m.height ?? null,
		size: m.size ?? null,
		videoCodec: m.meta?.videoCodec ?? null,
		fps: m.meta?.fps ?? null,
		faststart: m.meta?.faststart ?? null
	};
}

export interface VideoIssue {
	level: 'error' | 'warn';
	message: string;
}

// Mastodon's own defaults, used when an instance has not reported its limits.
const MASTODON_VIDEO_BYTES = 99_000_000;
const MASTODON_VIDEO_MATRIX = 8_294_400;
const MASTODON_VIDEO_FPS = 120;

const X_FREE_MAX_MS = 140_000;
const X_PREMIUM_MAX_MS = 125 * 60_000;

/** `2:20`, `1:02:05`. */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function megabytes(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

const CODEC_NAMES: Record<string, string> = { avc: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9' };

function codecName(codec: string): string {
	return CODEC_NAMES[codec] ?? codec;
}

interface Limits {
	minMs?: number;
	maxMs?: number;
	maxMsNote?: string;
	minBytes?: number;
	maxBytes?: number;
	codecs?: string[];
	/** Narrowest and widest width:height the platform accepts. */
	aspect?: [number, number, string];
	maxWidth?: number;
	maxPixels?: number;
	minFps?: number;
	maxFps?: number;
	faststart?: boolean;
}

function limitsFor(platform: string, meta: VideoRuleMeta | null | undefined): Limits | null {
	switch (platform) {
		case 'x': {
			// Zernio's X route is not the account's own, so its plan is unknown.
			const premium = meta?.provider !== 'zernio' && xLimitFor(meta) > X_MAX_CHARS;
			return {
				minMs: 500,
				maxMs: premium ? X_PREMIUM_MAX_MS : X_FREE_MAX_MS,
				maxMsNote: premium ? undefined : 'Accounts with X Premium can post longer ones.',
				maxBytes: 512_000_000,
				codecs: ['avc'],
				aspect: [1 / 3, 3, '1:3 and 3:1'],
				maxFps: 60
			};
		}
		case 'bluesky':
			return { maxMs: 10 * 60_000, maxBytes: 300_000_000 };
		case 'mastodon':
			return {
				maxBytes: meta?.videoSizeLimit || MASTODON_VIDEO_BYTES,
				maxPixels: meta?.videoMatrixLimit || MASTODON_VIDEO_MATRIX,
				maxFps: meta?.videoFrameRateLimit || MASTODON_VIDEO_FPS
			};
		case 'linkedin':
			return { minMs: 3_000, maxMs: 30 * 60_000, minBytes: 75_000, maxBytes: 500_000_000 };
		case 'threads':
			return {
				maxMs: 5 * 60_000,
				maxBytes: 1_000_000_000,
				codecs: ['avc', 'hevc'],
				maxWidth: 1920,
				minFps: 23,
				maxFps: 60,
				faststart: true
			};
		case 'instagram':
			// A Reel: Meta's published limits for media_type=REELS.
			return {
				minMs: 3_000,
				maxMs: 15 * 60_000,
				maxBytes: 300_000_000,
				codecs: ['avc', 'hevc'],
				aspect: [0.01, 10, '1:100 and 10:1'],
				maxWidth: 1920,
				minFps: 23,
				maxFps: 60,
				faststart: true
			};
		default:
			return null;
	}
}

/** Every rule this video breaks on one platform; empty when it fits. */
export function videoIssues(
	platform: string,
	facts: VideoFacts,
	meta?: VideoRuleMeta | null
): VideoIssue[] {
	const limits = limitsFor(platform, meta);
	if (!limits) return [];
	const name = platformName(platform);
	const issues: VideoIssue[] = [];
	const error = (message: string) => issues.push({ level: 'error', message });
	const { durationMs, size, videoCodec, fps, width, height } = facts;

	if (typeof durationMs === 'number' && durationMs > 0) {
		if (limits.maxMs && durationMs > limits.maxMs + 500) {
			const note = limits.maxMsNote ? `. ${limits.maxMsNote}` : '';
			error(
				`${name} takes videos up to ${formatDuration(limits.maxMs)} — this one is ${formatDuration(durationMs)}${note}`
			);
		}
		if (limits.minMs && durationMs < limits.minMs) {
			error(`${name} needs a video of at least ${limits.minMs / 1000} seconds`);
		}
	}
	if (typeof size === 'number' && size > 0) {
		if (limits.maxBytes && size > limits.maxBytes) {
			error(
				`${name} takes videos up to ${megabytes(limits.maxBytes)} — this one is ${megabytes(size)}`
			);
		}
		if (limits.minBytes && size < limits.minBytes) {
			error(`${name} needs a video of at least ${Math.round(limits.minBytes / 1000)} KB`);
		}
	}
	if (videoCodec && limits.codecs && !limits.codecs.includes(videoCodec)) {
		error(
			`${name} needs ${limits.codecs.map(codecName).join(' or ')} video — this one is ${codecName(videoCodec)}`
		);
	}
	if (width && height) {
		if (limits.aspect) {
			const ratio = width / height;
			const [min, max, label] = limits.aspect;
			if (ratio < min - 0.001 || ratio > max + 0.001) {
				error(`${name} takes videos between ${label} — this one is ${width}×${height}`);
			}
		}
		if (limits.maxWidth && width > limits.maxWidth) {
			error(`${name} takes videos up to ${limits.maxWidth} pixels wide — this one is ${width}`);
		}
		if (limits.maxPixels && width * height > limits.maxPixels) {
			const most =
				limits.maxPixels === MASTODON_VIDEO_MATRIX
					? '4K (3840×2160)'
					: `${(limits.maxPixels / 1_000_000).toFixed(1)} million pixels`;
			error(`${name} takes videos up to ${most} — this one is ${width}×${height}`);
		}
	}
	if (typeof fps === 'number' && fps > 0) {
		// Variable frame rates average a little off the nominal one.
		if (limits.maxFps && fps > limits.maxFps + 0.5) {
			error(
				`${name} takes videos up to ${limits.maxFps} frames a second — this one is ${Math.round(fps)}`
			);
		}
		if (limits.minFps && fps < limits.minFps - 0.5) {
			error(
				`${name} needs at least ${limits.minFps} frames a second — this one is ${Math.round(fps)}`
			);
		}
	}
	if (limits.faststart && facts.faststart === false) {
		error(
			`${name} needs the video's index at the start of the file — attach it again in the composer, which fixes this`
		);
	}
	return issues;
}

/** The first blocking problem, for one-line messages and provider validation. */
export function firstVideoError(
	platform: string,
	facts: VideoFacts,
	meta?: VideoRuleMeta | null
): string | null {
	return videoIssues(platform, facts, meta).find((i) => i.level === 'error')?.message ?? null;
}

export interface PlatformFit {
	platform: string;
	level: 'error' | 'warn';
	/** The worst problem, in the words the composer shows. */
	message: string;
}

/**
 * The platforms among `accounts` that would refuse or alter this video, one
 * row each. Two accounts on one platform can differ (X Premium and a free
 * account), so the stricter answer wins. Empty when every platform takes it.
 */
export function fitByPlatform(
	accounts: Iterable<{ platform: string; meta?: VideoRuleMeta | null }>,
	facts: VideoFacts
): PlatformFit[] {
	const worst = new Map<string, VideoIssue[]>();
	const weight = (list: VideoIssue[]) =>
		list.filter((i) => i.level === 'error').length * 100 + list.length;
	for (const account of accounts) {
		const issues = videoIssues(account.platform, facts, account.meta);
		const seen = worst.get(account.platform);
		if (!seen || weight(issues) > weight(seen)) worst.set(account.platform, issues);
	}
	const rows: PlatformFit[] = [];
	for (const [platform, issues] of worst) {
		const first = issues.find((i) => i.level === 'error') ?? issues[0];
		if (first) rows.push({ platform, level: first.level, message: first.message });
	}
	return rows;
}
