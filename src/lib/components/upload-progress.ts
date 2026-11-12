export type UploadAnswer = { ok: boolean; status: number; data: Record<string, unknown> };

/**
 * POSTs a form and reports how much of it has gone, which `fetch` cannot do
 * for a request body. Answers like a fetch whose JSON was read; a dropped
 * connection rejects with "fetch failed", which humanizeError words as one.
 */
export function uploadWithProgress(
	url: string,
	body: FormData,
	onProgress: (fraction: number) => void
): Promise<UploadAnswer> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('POST', url);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
		};
		xhr.onload = () => {
			let data: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(xhr.responseText);
				if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
			} catch {
				// A body that isn't JSON (a proxy's error page) leaves only the status.
			}
			resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
		};
		xhr.onerror = () => reject(new Error('fetch failed'));
		xhr.ontimeout = () => reject(new Error('timed out'));
		xhr.send(body);
	});
}
