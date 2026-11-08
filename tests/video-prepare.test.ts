import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
	const state = {
		disposed: 0,
		inits: 0,
		cancels: 0,
		ignoreCancel: false,
		// What a pending track read does: it waits for this to settle.
		trackRead: null as Promise<unknown> | null,
		execute: async (_target: { buffer: ArrayBuffer | null }) => {}
	};
	let rejectRead: ((err: Error) => void) | null = null;
	class Input {
		getPrimaryVideoTrack() {
			if (!state.trackRead) return Promise.resolve(videoTrack);
			return state.trackRead.then(() => videoTrack);
		}
		getPrimaryAudioTrack() {
			return Promise.resolve(null);
		}
		dispose() {
			state.disposed++;
			rejectRead?.(new Error('Input has been disposed.'));
		}
	}
	const videoTrack = {
		displayWidth: 3840,
		displayHeight: 2160,
		codec: 'hevc',
		computePacketStats: async () => ({ averagePacketRate: 30, averageBitrate: 1_000_000 }),
		canDecode: async () => true
	};
	class BufferTarget {
		buffer: ArrayBuffer | null = null;
	}
	class Output {
		target: BufferTarget;
		constructor(opts: { target: BufferTarget }) {
			this.target = opts.target;
		}
	}
	const Conversion = {
		init: async (opts: { output: Output }) => {
			state.inits++;
			let rejectRun: ((err: Error) => void) | null = null;
			return {
				isValid: true,
				onProgress: null as null | ((fraction: number) => void),
				execute: () =>
					new Promise<void>((resolve, reject) => {
						rejectRun = reject;
						state.execute(opts.output.target).then(resolve, reject);
					}),
				cancel: async () => {
					state.cancels++;
					if (!state.ignoreCancel) rejectRun?.(new Error('Conversion was canceled.'));
				}
			};
		}
	};
	return {
		state,
		pendingRead() {
			state.trackRead = new Promise((_, reject) => {
				rejectRead = reject;
			});
		},
		reset() {
			state.disposed = 0;
			state.inits = 0;
			state.cancels = 0;
			state.ignoreCancel = false;
			state.trackRead = null;
			state.execute = async () => {};
			rejectRead = null;
		},
		module: {
			Input,
			BlobSource: class {},
			ALL_FORMATS: [],
			Output,
			Mp4OutputFormat: class {},
			BufferTarget,
			Conversion,
			QUALITY_HIGH: 'high',
			canEncodeVideo: async () => true,
			canEncodeAudio: async () => true
		}
	};
});

vi.mock('mediabunny', () => fake.module);

const { prepareVideo, VideoPrepareError } = await import('../src/lib/components/video/prepare');

// Not an MP4, so it is always converted rather than sent as it is.
const movie = () => new File([new Uint8Array(64)], 'clip.mov', { type: 'video/quicktime' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('preparing a video', () => {
	afterEach(() => fake.reset());

	it('converts a file and frees what it read', async () => {
		fake.state.execute = async (target) => {
			target.buffer = new Uint8Array([1, 2, 3]).buffer;
		};
		const result = await prepareVideo(movie(), {
			signal: new AbortController().signal,
			onProgress: () => {}
		});
		expect(result.file.size).toBe(3);
		expect(fake.state.disposed).toBe(1);
	});

	it('stops at once when Cancel is pressed while the file is still being read', async () => {
		fake.pendingRead();
		const controller = new AbortController();
		const prepared = prepareVideo(movie(), { signal: controller.signal, onProgress: () => {} });
		await tick();
		controller.abort();
		await expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
		expect(fake.state.inits).toBe(0);
		expect(fake.state.disposed).toBeGreaterThan(0);
	});

	it('reports a cancel during the conversion as a cancel, not a failed conversion', async () => {
		let started!: () => void;
		const running = new Promise<void>((resolve) => (started = resolve));
		fake.state.execute = () => {
			started();
			return new Promise(() => {});
		};
		const controller = new AbortController();
		const prepared = prepareVideo(movie(), { signal: controller.signal, onProgress: () => {} });
		await running;
		controller.abort();
		const err = await prepared.catch((e: unknown) => e);
		expect(err).toMatchObject({ name: 'AbortError' });
		expect(err).not.toBeInstanceOf(VideoPrepareError);
		expect(fake.state.cancels).toBe(1);
	});

	// mediabunny ignores a cancel once the conversion is done.
	it('returns nothing for a conversion that finished just after Cancel', async () => {
		const controller = new AbortController();
		fake.state.ignoreCancel = true;
		fake.state.execute = async (target) => {
			target.buffer = new Uint8Array([1]).buffer;
			controller.abort();
		};
		const prepared = prepareVideo(movie(), { signal: controller.signal, onProgress: () => {} });
		await expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
	});
});
