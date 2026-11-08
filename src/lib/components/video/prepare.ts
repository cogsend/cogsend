import { probeMp4 } from '#lib/domain/mp4-probe.js';

/**
 * Turns whatever video someone attaches into one file every platform takes:
 * MP4 with H.264 and AAC, at most 1920 pixels on the long edge and 60 frames a
 * second, with the index at the front. A file that already is that goes up
 * untouched; one that only sits in the wrong container (a phone's MOV) is
 * rewrapped without re-encoding; anything else is converted in the browser.
 */

export const MAX_EDGE = 1920;
export const MAX_FPS = 60;
const MAX_BITRATE = 25_000_000;

export type PreparePhase = 'reading' | 'converting';

export interface PreparedVideo {
	file: Blob;
	/** A frame near the start, used as the cover until one is chosen. */
	poster: Blob | null;
}

export class VideoPrepareError extends Error {}

const CANNOT_CONVERT =
	"This browser can't convert this video. Export it as MP4 (H.264) and attach it again.";

function blobReader(blob: Blob) {
	return async (start: number, end: number) =>
		new Uint8Array(await blob.slice(start, end + 1).arrayBuffer());
}

/** True when the file can go up exactly as it is. */
async function alreadyFits(file: File): Promise<boolean> {
	if (file.type !== 'video/mp4') return false;
	const facts = await probeMp4(blobReader(file), file.size).catch(() => null);
	// A fragmented file (some screen recorders) reads with no duration, and the
	// server refuses what it cannot time; converting writes a plain one.
	if (!facts || !facts.faststart || facts.videoCodec !== 'avc' || !facts.durationMs) return false;
	if (facts.audioCodec && facts.audioCodec !== 'aac') return false;
	if (Math.max(facts.width ?? 0, facts.height ?? 0) > MAX_EDGE) return false;
	if ((facts.fps ?? 0) > MAX_FPS + 0.5) return false;
	const bitrate = facts.durationMs ? (file.size * 8) / (facts.durationMs / 1000) : 0;
	return bitrate <= MAX_BITRATE;
}

function throwIfAborted(signal: AbortSignal) {
	if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}

export async function prepareVideo(
	file: File,
	opts: {
		signal: AbortSignal;
		onProgress: (phase: PreparePhase, fraction: number) => void;
	}
): Promise<PreparedVideo> {
	const { signal } = opts;
	opts.onProgress('reading', 0);
	if (await alreadyFits(file)) {
		throwIfAborted(signal);
		return { file, poster: await capturePoster(file).catch(() => null) };
	}
	// Loaded only when a video needs it, so the composer stays light.
	const mb = await import('mediabunny');
	throwIfAborted(signal);
	const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
	let conversion: Awaited<ReturnType<typeof mb.Conversion.init>> | null = null;
	// Reading the tracks can take a while on a long file, and only disposing
	// the input stops it; once the conversion runs, cancelling it stops both.
	const abort = () => {
		if (conversion) void conversion.cancel();
		else input.dispose();
	};
	signal.addEventListener('abort', abort, { once: true });
	try {
		let video: Awaited<ReturnType<typeof input.getPrimaryVideoTrack>>;
		try {
			video = await input.getPrimaryVideoTrack();
		} catch {
			throw new VideoPrepareError('This file could not be read as a video.');
		}
		throwIfAborted(signal);
		if (!video) throw new VideoPrepareError('This file has no video in it.');
		const audio = await input.getPrimaryAudioTrack();
		const stats = await video.computePacketStats(100).catch(() => null);
		throwIfAborted(signal);
		const longEdge = Math.max(video.displayWidth, video.displayHeight);
		const tooBig = longEdge > MAX_EDGE;
		const tooFast = (stats?.averagePacketRate ?? 0) > MAX_FPS + 0.5;
		const tooDense = (stats?.averageBitrate ?? 0) > MAX_BITRATE;
		const reencodeVideo = video.codec !== 'avc' || tooBig || tooFast || tooDense;
		const reencodeAudio = Boolean(audio && audio.codec !== 'aac');

		if (reencodeVideo && (!(await video.canDecode()) || !(await mb.canEncodeVideo('avc')))) {
			throw new VideoPrepareError(CANNOT_CONVERT);
		}
		if (
			reencodeAudio &&
			audio &&
			(!(await audio.canDecode()) || !(await mb.canEncodeAudio('aac')))
		) {
			throw new VideoPrepareError(CANNOT_CONVERT);
		}
		throwIfAborted(signal);

		const output = new mb.Output({
			format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
			target: new mb.BufferTarget()
		});
		conversion = await mb.Conversion.init({
			input,
			output,
			tracks: 'primary',
			showWarnings: false,
			video: {
				codec: 'avc',
				...(tooBig
					? video.displayWidth >= video.displayHeight
						? { width: MAX_EDGE }
						: { height: MAX_EDGE }
					: {}),
				...(tooFast ? { frameRate: MAX_FPS } : {}),
				...(reencodeVideo ? { quality: mb.QUALITY_HIGH, forceTranscode: true } : {})
			},
			audio: { codec: 'aac', ...(reencodeAudio ? { forceTranscode: true } : {}) }
		});
		throwIfAborted(signal);
		if (!conversion.isValid) throw new VideoPrepareError(CANNOT_CONVERT);
		conversion.onProgress = (fraction) => opts.onProgress('converting', fraction);
		try {
			await conversion.execute();
		} catch (err) {
			throw new VideoPrepareError(
				err instanceof Error && err.message ? `${CANNOT_CONVERT} (${err.message})` : CANNOT_CONVERT
			);
		}
		throwIfAborted(signal);
		const buffer = output.target.buffer;
		if (!buffer) throw new VideoPrepareError(CANNOT_CONVERT);
		const prepared = new Blob([buffer], { type: 'video/mp4' });
		return { file: prepared, poster: await capturePoster(prepared).catch(() => null) };
	} catch (err) {
		// Whatever a disposed input threw on the way out, a cancel is a cancel.
		throwIfAborted(signal);
		throw err;
	} finally {
		signal.removeEventListener('abort', abort);
		input.dispose();
	}
}

/** A JPEG of the frame at `atSeconds` (clamped to the video), drawn at most 1280 wide. */
export function captureFrame(source: Blob | string, atSeconds = 1): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const url = typeof source === 'string' ? source : URL.createObjectURL(source);
		const el = document.createElement('video');
		el.muted = true;
		el.playsInline = true;
		el.preload = 'auto';
		const done = (err?: unknown, blob?: Blob | null) => {
			if (typeof source !== 'string') URL.revokeObjectURL(url);
			el.removeAttribute('src');
			el.load();
			if (err || !blob) reject(err ?? new Error('No frame'));
			else resolve(blob);
		};
		el.addEventListener('error', () => done(new Error('Could not read the video')), { once: true });
		el.addEventListener(
			'loadedmetadata',
			() => {
				el.currentTime = Math.min(atSeconds, Math.max(0, (el.duration || 0) - 0.05));
			},
			{ once: true }
		);
		el.addEventListener(
			'seeked',
			() => {
				drawFrame(el)
					.then((blob) => done(undefined, blob))
					.catch(done);
			},
			{ once: true }
		);
		el.src = url;
	});
}

/** The frame a <video> is showing, as a JPEG at most 1280 wide. */
export function drawFrame(el: HTMLVideoElement): Promise<Blob | null> {
	const scale = Math.min(1, 1280 / (el.videoWidth || 1));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
	canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
	const ctx = canvas.getContext('2d');
	if (!ctx) return Promise.resolve(null);
	ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
	return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

function capturePoster(file: Blob): Promise<Blob> {
	return captureFrame(file, 1);
}
